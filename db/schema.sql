-- The courier's own database: the book and the records. Ten tables: orders,
-- stops, lanes, crosses, legs, events, conditions, accounts, runs, games.
--
-- Applied by the release step on every deploy (scripts/apply-schema.ts), so
-- every statement here is safe to run again. IF NOT EXISTS matches names only,
-- so a change to a table that already exists is added below its CREATE as its
-- own statements, which bring an existing table and a new one to the same
-- shape. At start-up the courier reads every column it uses and refuses to
-- start if one is missing.
--
-- Amounts in the coin's smallest unit, nonces, expiries and game ids are
-- uint256 on chain and numeric(78, 0) here. Addresses are lowercase hex text;
-- hashes are 0x and 64 lowercase hex characters.

BEGIN;

-- A release that has to wait this long for a lock gives up instead of holding
-- the courier's requests behind it; the deploy then fails and can be run again.
SET LOCAL lock_timeout = '10s';

-- ──────────────────────────── runs ────────────────────────────────────────
-- One row per start of the process: when it started, and when and how it
-- stopped if the process wrote that itself. A process that dies writes
-- nothing, and no later start writes it for it. The uptime history.
CREATE TABLE IF NOT EXISTS runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at  timestamptz,
  stop_reason text,
  CONSTRAINT runs_stop_whole CHECK ((stopped_at IS NULL) = (stop_reason IS NULL))
);

-- ──────────────────────────── orders ──────────────────────────────────────
-- One row per order the courier admitted, keyed by the order's hash, kept
-- after the order dies. The ten signed fields as received; the role the
-- poster named, which is not signed; the market key and the side, for the
-- book's index; record_number, the tie-breaker of the fill-priority rule.
CREATE SEQUENCE IF NOT EXISTS orders_record_number;

CREATE TABLE IF NOT EXISTS orders (
  hash            text PRIMARY KEY CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  role            text NOT NULL CHECK (role IN ('rest', 'take')),
  -- The ten fields, as the contract's order has them.
  account         text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  game_id         numeric(78, 0) NOT NULL,
  scorer          text NOT NULL CHECK (scorer ~ '^0x[0-9a-f]{40}$'),
  line_ticks      integer NOT NULL,
  position_type   smallint NOT NULL CHECK (position_type IN (0, 1)),
  odds_tick       integer NOT NULL CHECK (odds_tick BETWEEN 101 AND 10100),
  risk_amount     numeric(78, 0) NOT NULL CHECK (risk_amount > 0 AND risk_amount % 100 = 0),
  nonce           numeric(78, 0) NOT NULL,
  expiry          numeric(78, 0) NOT NULL,
  min_fill        numeric(78, 0) NOT NULL CHECK (min_fill >= 0 AND min_fill <= risk_amount),
  signature       text NOT NULL CHECK (signature ~ '^0x[0-9a-f]{130}$'),
  -- The market's key, keccak256(abi.encode(gameId, scorer, lineTicks)) as the contract computes it, and the
  -- side, which is position_type: the two the book's index is on.
  market_key      text NOT NULL CHECK (market_key ~ '^0x[0-9a-f]{64}$'),
  side            smallint NOT NULL CHECK (side IN (0, 1)),
  -- The order in which the database took the orders in. Numbers rise and are never reused, so no two orders
  -- share one and the list is the same after a restart. The tie-breaker between two quotes at one price.
  record_number   bigint NOT NULL UNIQUE DEFAULT nextval('orders_record_number'),
  received_at     timestamptz NOT NULL DEFAULT now(),
  received_block  numeric(78, 0) NOT NULL,
  received_hash   text NOT NULL CHECK (received_hash ~ '^0x[0-9a-f]{64}$'),
  -- The receipt block's time: the chain's time the order was taken at, which the first answer carries and a repeat
  -- post is answered from, with no chain read.
  received_time   numeric(78, 0) NOT NULL,
  -- Empty while the order is live as far as the courier itself knows; else how it ended here: a stop on record,
  -- expired at the final block, filled by this courier's own Cross, or cancelled: a read of the chain showed the
  -- quote cancelled or under its account's floor for the market, both the maker's own act, and the request that
  -- read it marked it, at the block it read (ended_block). A fill by another courier and the relay dropped are read
  -- at a block and not stored: neither is the maker's act on the quote, and a fill at the head can still be undone.
  ended           text CHECK (ended IN ('stopped', 'expired', 'filled', 'cancelled')),
  ended_at        timestamptz,
  -- The block the chain read that marked the quote cancelled was made at: number and hash. Empty for the other
  -- marks: a stop has its message, and the expiry mark is against the final block's time.
  ended_block     numeric(78, 0),
  ended_block_hash text CHECK (ended_block_hash ~ '^0x[0-9a-f]{64}$'),
  -- For a bet, where it stands. A quote has none.
  bet_state       text CHECK (bet_state IN ('waiting', 'held', 'sent', 'refused', 'lapsed')),
  CONSTRAINT orders_side_is_position_type CHECK (side = position_type),
  CONSTRAINT orders_ended_whole CHECK ((ended IS NULL) = (ended_at IS NULL)),
  CONSTRAINT orders_ended_block_whole CHECK (
    (ended_block IS NULL) = (ended_block_hash IS NULL)
    AND (ended_block IS NULL OR ended IS NOT NULL)
    AND (ended IS DISTINCT FROM 'cancelled' OR ended_block IS NOT NULL)),
  CONSTRAINT orders_bet_state_for_bets CHECK ((role = 'take') = (bet_state IS NOT NULL))
);

-- The book's index: for a bet, the quotes on one side of one market the courier has not marked ended, in
-- fill-priority order, best price for the bettor first (the lowest tick), then the record number. The
-- candidate query is one scan along it with a bound on the rows it is returned, 2,000 to start. That bound is
-- a count of ROWS RETURNED, which is what LIMIT counts, and not of the index entries the scan visits, the rows
-- it fetches from the table to judge them, or the pages it reads for either: an expired quote not yet marked
-- is still in this index and is returned, and a quote that was marked leaves the index's range but leaves its
-- old version in the table and its entry in the index until vacuum removes them. That physical work is
-- measured against the statement's own EXPLAIN (ANALYZE, BUFFERS), and nothing here bounds it.
CREATE INDEX IF NOT EXISTS orders_book
  ON orders (market_key, side, odds_tick, record_number)
  WHERE role = 'rest' AND ended IS NULL;

-- The door's count of an account's quotes on one side of one market the courier has not marked ended: one page
-- of the unexpired ones, at most 17 rows, whatever the account has posted. Sixteen or more standing, the chain is
-- asked once about sixteen and the ones it shows cancelled or under the floor are marked here, so the records
-- never hold more than sixteen unended quotes of an account on a side except where the chain has not yet been
-- asked about them. Again a count of rows returned; what the database passes over to return them is the
-- paragraph above.
CREATE INDEX IF NOT EXISTS orders_live_quotes_per_account
  ON orders (account, market_key, side, expiry DESC)
  WHERE role = 'rest' AND ended IS NULL;

-- The door's count of the bets waiting their turn (two an account, 32 in all), and later the pre-check's next bet:
-- the bets not yet final, in record order. The count is of rows returned along this index, bounded by the counts it
-- enforces; without it the count would be a scan of every order ever kept, and the plan has a post, a bet and a
-- read each go through an index made for the lookup.
CREATE INDEX IF NOT EXISTS orders_bets_waiting
  ON orders (record_number)
  WHERE role = 'take' AND bet_state IN ('waiting', 'held') AND ended IS NULL;

-- The table's maintenance, chosen with the measurement in view (docs/COST.md). The mark of an expired quote, a
-- stop or a fill leaves a dead version in the table and an entry in the index until vacuum removes them, and a
-- scan along the book's index visits the dead entries that stand in its range ahead of the rows it returns. At
-- Postgres's defaults a table is due for vacuum once its dead versions pass 50 plus a fifth of its rows, which is
-- a number history sets: the dead a scan can meet would grow with the orders kept. Here the table is due once
-- 2,000 dead versions have gathered, whatever its size. 2,000 is a chosen batch, the bound of rows one request is
-- returned and so the most one request marks; it is not a measured optimum, and the threshold is when the table
-- becomes due, not a ceiling on its dead versions: autovacuum's workers can be busy elsewhere, and a version an
-- older transaction can still see is not removed until it cannot. A vacuum left to itself may skip the indexes
-- when the pages holding dead items are under two per cent of the table's pages, and leave the dead index
-- entries a scan visits standing; vacuum_index_cleanup = on makes each vacuum of this table clean its indexes,
-- which is where the scan's cost lives. What the measurement shows is the state after a vacuum with the cleanup
-- forced on; it does not show what the default (auto) or off would have left standing here, nor how long
-- production's autovacuum takes to come round: those are read from the live table's statistics once it runs. The
-- status address serves these settings as the database holds them.
ALTER TABLE orders SET (
  autovacuum_vacuum_threshold = 2000,
  autovacuum_vacuum_scale_factor = 0,
  autovacuum_analyze_threshold = 2000,
  autovacuum_analyze_scale_factor = 0,
  vacuum_index_cleanup = on
);

-- ──────────────────────────── stops ───────────────────────────────────────
-- One row per order hash a stop stopped, keyed by the hash: the account, the
-- stop message as received and its signature, the time; for a stop recorded
-- ahead of its order, the signed original and its expiry. A stop is permanent
-- for its hash.
CREATE TABLE IF NOT EXISTS stops (
  hash            text PRIMARY KEY CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  account         text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  message         jsonb NOT NULL,
  signature       text NOT NULL CHECK (signature ~ '^0x[0-9a-f]{130}$'),
  received_at     timestamptz NOT NULL DEFAULT now(),
  ahead           boolean NOT NULL DEFAULT false,
  original        jsonb,
  original_expiry numeric(78, 0),
  CONSTRAINT stops_original_when_ahead CHECK (ahead = (original IS NOT NULL) AND ahead = (original_expiry IS NOT NULL))
);

-- ──────────────────────────── lanes ───────────────────────────────────────
-- One row for each sender key the courier has used. Owning a lane is a
-- number: every step of a send locks this row and commits only if the epoch
-- is the one the process took. A process that has lost the epoch can complete
-- none of them.
CREATE TABLE IF NOT EXISTS lanes (
  sender      text PRIMARY KEY CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  epoch       bigint NOT NULL DEFAULT 0,
  owner_run   bigint REFERENCES runs (id),
  -- The bet the lane holds, and under which reservation; empty when it holds none.
  held_bet    text REFERENCES orders (hash),
  reservation bigint,
  -- The bet hash of the Cross the lane has open (a crosses row); empty when none.
  open_cross  text,
  CONSTRAINT lanes_reservation_with_bet CHECK ((held_bet IS NULL) = (reservation IS NULL))
);

-- ──────────────────────────── crosses ─────────────────────────────────────
-- One row per Cross, keyed by its bet's hash: one bet, one Cross. The lane,
-- epoch and reservation it was made under; the pre-check's block; what was
-- signed; the transaction's hash; its state; the node's answer; the blocks it
-- was proved under; and how it ended.
CREATE TABLE IF NOT EXISTS crosses (
  bet_hash             text PRIMARY KEY REFERENCES orders (hash),
  lane                 text NOT NULL REFERENCES lanes (sender),
  epoch                bigint NOT NULL,
  reservation          bigint NOT NULL,
  -- The pre-check's block: number, hash and time.
  block_number         numeric(78, 0) NOT NULL,
  block_hash           text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_time           numeric(78, 0) NOT NULL,
  -- What was signed: the key, the nonce, the gas and the fees. Empty until the signed record.
  sender               text CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  nonce                bigint,
  gas_limit            numeric(78, 0),
  max_fee_per_gas      numeric(78, 0),
  max_priority_fee     numeric(78, 0),
  -- The transaction's hash: unique, and kept whatever became of it.
  tx_hash              text UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  state                text NOT NULL CHECK (state IN (
                         'intent', 'signed', 'handing off', 'sent', 'pending',
                         'confirmed', 'reverted', 'unknown', 'not sent', 'expired unmined', 'replaced')),
  -- How many times the signed transaction was handed to the node: 0 or 1, never more.
  hand_offs            smallint NOT NULL DEFAULT 0 CHECK (hand_offs IN (0, 1)),
  node_answer          jsonb,
  -- The receipt's block, by number and hash, and the final block it was proved under.
  receipt_block_number numeric(78, 0),
  receipt_block_hash   text CHECK (receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
  final_block_number   numeric(78, 0),
  final_block_hash     text CHECK (final_block_hash ~ '^0x[0-9a-f]{64}$'),
  -- For a Cross that was replaced, the transaction that took its nonce; for one that reverted, the reason.
  replaced_by          text CHECK (replaced_by ~ '^0x[0-9a-f]{64}$'),
  revert_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- A second lock on the same door as the lane's epoch, and not what ownership rests on: at most one Cross per
-- sender key in a state that is not final.
CREATE UNIQUE INDEX IF NOT EXISTS crosses_one_open_per_lane
  ON crosses (lane)
  WHERE state NOT IN ('confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced');

-- ──────────────────────────── legs ────────────────────────────────────────
-- One row for each quote listed in a Cross, in order: the stakes the pre-check
-- expected, and the stakes the chain recorded or the reason it skipped the
-- quote. At most 40 to a Cross.
CREATE TABLE IF NOT EXISTS legs (
  bet_hash            text NOT NULL REFERENCES crosses (bet_hash),
  position            smallint NOT NULL CHECK (position >= 0 AND position < 40),
  order_hash          text NOT NULL REFERENCES orders (hash),
  expected_maker_risk numeric(78, 0) NOT NULL,
  expected_taker_risk numeric(78, 0) NOT NULL,
  recorded_maker_risk numeric(78, 0),
  recorded_taker_risk numeric(78, 0),
  -- The contract's own name for the skip, where it skipped the quote.
  skip_reason         text CHECK (skip_reason IN (
                        'NoCourier', 'Cancelled', 'Expired', 'NoRoom', 'NothingFits', 'UnderMinFill', 'PullRefused')),
  PRIMARY KEY (bet_hash, position)
);

-- ──────────────────────────── events ──────────────────────────────────────
-- One line per event: a number, the time, the run, the kind, and the order,
-- Cross, account, game and reason it concerns. Append-only: each line is
-- written in the same transaction as the change it records, and nothing is
-- written when nothing happens. The numbers rise and are not reused, so a
-- reader's cursor is a number.
CREATE TABLE IF NOT EXISTS events (
  number     bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  run        bigint NOT NULL REFERENCES runs (id),
  kind       text NOT NULL CHECK (kind IN (
               'order received', 'order refused', 'stop received', 'stop refused', 'start unreadable',
               'bet refused', 'bet lapsed',
               'cross sent', 'cross pending', 'cross confirmed', 'cross reverted', 'cross unknown',
               'cross not sent', 'cross expired unmined', 'cross replaced',
               'condition opened', 'condition cleared', 'incident', 'run started', 'run stopped')),
  order_hash text CHECK (order_hash ~ '^0x[0-9a-f]{64}$'),
  bet_hash   text CHECK (bet_hash ~ '^0x[0-9a-f]{64}$'),
  account    text CHECK (account ~ '^0x[0-9a-f]{40}$'),
  game_id    numeric(78, 0),
  reason     text,
  facts      jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- The report lines, for GET /v1/incidents: a condition's opening or clearing, or an incident, read by number.
CREATE INDEX IF NOT EXISTS events_report_lines
  ON events (number)
  WHERE kind IN ('condition opened', 'condition cleared', 'incident');

-- Nothing changes or removes a line once written.
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is refused', TG_OP USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE TRIGGER events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

CREATE OR REPLACE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();

-- ──────────────────────────── conditions ──────────────────────────────────
-- The standing conditions of the reports: a key, when it opened and the line
-- that says so, when it cleared and that line, and the facts. One condition
-- of a key is open at a time; a key that opens again is a new row.
CREATE TABLE IF NOT EXISTS conditions (
  id           bigserial PRIMARY KEY,
  key          text NOT NULL CHECK (key IN (
                 'cross-unreconciled', 'wallet-low', 'sender-not-our-key', 'chain-unreachable', 'courier-fault')),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  opened_line  bigint NOT NULL REFERENCES events (number),
  cleared_at   timestamptz,
  cleared_line bigint REFERENCES events (number),
  facts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT conditions_cleared_whole CHECK ((cleared_at IS NULL) = (cleared_line IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS conditions_one_open_per_key
  ON conditions (key)
  WHERE cleared_at IS NULL;

-- ──────────────────────────── accounts ────────────────────────────────────
-- One row for each account that was ever admitted: its budget, a bucket and
-- when it was last refilled, and its count of requests refused over it. One
-- more row, keyed 'courier', holds the courier's own budget for all accounts
-- together. A refusal over a budget is a number here, not a line.
CREATE TABLE IF NOT EXISTS accounts (
  account         text PRIMARY KEY CHECK (account ~ '^0x[0-9a-f]{40}$' OR account = 'courier'),
  budget          numeric(12, 6) NOT NULL,
  budget_at       timestamptz NOT NULL DEFAULT now(),
  refused         bigint NOT NULL DEFAULT 0,
  last_refused_at timestamptz,
  first_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- ──────────────────────────── games ───────────────────────────────────────
-- One row per game seen: its start once written, whether its reporters are
-- the published list, and the time a start could first not be read.
CREATE TABLE IF NOT EXISTS games (
  game_id             numeric(78, 0) PRIMARY KEY,
  start               numeric(78, 0),
  reporters_published boolean,
  start_unreadable_at timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now()
);

COMMIT;
