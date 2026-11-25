-- The courier's own database: the book and the records. Eleven tables: orders,
-- stop_messages, stops, lanes, crosses, legs, events, conditions, accounts,
-- runs, games.
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
  -- Empty while the order is live as far as the courier itself knows; else how it ended here: a stop on record;
  -- expired at the final block; or what a read of the chain showed, marked by the request that read it at the block
  -- it read (ended_block): cancelled, the quote cancelled, at a version the account has left, under its floor at its
  -- version, or under a grant that is gone (the account's own acts, or its grant's own end), or filled, less than a
  -- lot of its stake left (a fill through another courier; this courier's own fills are the sender build's, which
  -- marks filled too). The relay dropped is read at a block and not stored: not an end of the quote, and undone by
  -- the account itself.
  ended           text CHECK (ended IN ('stopped', 'expired', 'filled', 'cancelled')),
  ended_at        timestamptz,
  -- The block the chain read that marked the quote cancelled or filled was made at: number and hash, so a later
  -- build can tell a mark whose block is no longer on the chain. Empty for the other marks: a stop has its message,
  -- and the expiry mark is against the final block's time.
  ended_block     numeric(78, 0),
  ended_block_hash text CHECK (ended_block_hash ~ '^0x[0-9a-f]{64}$'),
  -- For a bet, where it stands. A quote has none.
  bet_state       text CHECK (bet_state IN ('waiting', 'held', 'sent', 'refused', 'lapsed')),
  CONSTRAINT orders_side_is_position_type CHECK (side = position_type),
  CONSTRAINT orders_ended_whole CHECK ((ended IS NULL) = (ended_at IS NULL)),
  CONSTRAINT orders_ended_block_whole CHECK (
    (ended_block IS NULL) = (ended_block_hash IS NULL)
    AND (ended_block IS NULL OR ended IS NOT NULL)
    AND (ended IS NULL OR ended NOT IN ('cancelled', 'filled') OR ended_block IS NOT NULL)),
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
-- asked once about sixteen and the ones it shows cancelled, at a version the account has left, under its floor at
-- its version, or under a grant that is gone are marked here, so the records never hold more than sixteen unended
-- quotes of an account on a side except where the chain has not yet been asked about them. Again a count of rows
-- returned; what the database passes over to return them is the paragraph above.
CREATE INDEX IF NOT EXISTS orders_live_quotes_per_account
  ON orders (account, market_key, side, expiry DESC)
  WHERE role = 'rest' AND ended IS NULL;

-- The markets of a game that hold a quote the courier has not marked ended, for the game's page of the book: the
-- (market, side) pairs of ONE game, walked one index probe a pair from the page's cursor, at most two a market of
-- the page plus one. A page's work is the page's, whatever the book holds on other games. Without this index the
-- walk was along the book's index over every pair the whole book holds, and the game was kept afterwards.
CREATE INDEX IF NOT EXISTS orders_markets_of_game
  ON orders (game_id, scorer, line_ticks, side)
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

-- Whether a mark's block is shown to be on the final block's chain. A mark made at a block that is not yet final (the
-- bet's check at its block, the door and a market's page at the block they read) is written false and read again once
-- the final block reaches its height: shown on the final chain, it stands, now final; not, the order is read at the
-- final block, and the mark is written again there, lifted, or set stopped where a stop stands. A mark made at the
-- final block, and the expiry mark, which is made against the final block's time, are written true. Every mark that
-- stood before this column is false, so the first read of the final block checks each.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ended_final boolean NOT NULL DEFAULT false;

-- The marks still to be read again, by their block: each read of the final block finds the ones at or under its
-- height along it. It holds only those, and a mark leaves it once its block is shown on the final chain.
CREATE INDEX IF NOT EXISTS orders_marks_not_final
  ON orders (ended_block)
  WHERE ended_block IS NOT NULL AND NOT ended_final;

-- ──────────────────────────── stop messages ───────────────────────────────
-- One row per stop message that stopped at least one order hash: the signed
-- payload exactly, kept once however many hashes it stopped. `message` is
-- {account, orderHashes} and nothing else, never an order's signed original;
-- beside it the signature, the signer the signature recovered to (the account,
-- or its agent), and the block the chain was read at to judge the message,
-- where it was read: number, hash and time together, or none of the three (a
-- stop of carried orders signed by the account's own key reads no chain). A
-- message that stopped nothing has no row.
CREATE TABLE IF NOT EXISTS stop_messages (
  id           bigserial PRIMARY KEY,
  account      text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  signer       text NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),
  message      jsonb NOT NULL,
  signature    text NOT NULL CHECK (signature ~ '^0x[0-9a-f]{130}$'),
  received_at  timestamptz NOT NULL DEFAULT now(),
  block_number numeric(78, 0),
  block_hash   text CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_time   numeric(78, 0),
  CONSTRAINT stop_messages_block_whole CHECK ((block_number IS NULL) = (block_hash IS NULL) AND (block_number IS NULL) = (block_time IS NULL))
);

-- ──────────────────────────── stops ───────────────────────────────────────
-- One row per order hash a stop stopped, keyed by the hash: the account, the
-- time, and the message that stopped it (message_id; the message itself is
-- kept once, above). A stop is permanent for its hash: the row is written once
-- and never removed. For a stop recorded ahead of its order (`ahead`), three
-- more, together or not at all: the order's signed original, which is kept
-- here and nowhere else and is read by nothing that lists or fills; the number
-- of the grant it was signed under, 0 for one its account signed itself; and
-- original_expiry, the second from which the original can fill no more: its
-- own expiry, or its grant's end where that comes first.
CREATE TABLE IF NOT EXISTS stops (
  hash            text PRIMARY KEY CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  account         text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  received_at     timestamptz NOT NULL DEFAULT now(),
  ahead           boolean NOT NULL DEFAULT false,
  message_id      bigint NOT NULL REFERENCES stop_messages (id),
  original        jsonb,
  original_expiry numeric(78, 0),
  -- A grant's number is a uint32 on chain, which a four-byte integer here does not hold.
  grant_number    bigint,
  CONSTRAINT stops_ahead_whole CHECK (ahead = (original IS NOT NULL) AND ahead = (original_expiry IS NOT NULL) AND ahead = (grant_number IS NOT NULL))
);

-- A stops table made before the message was kept once held the message and its signature on every row, and had
-- neither message_id nor grant_number; IF NOT EXISTS above leaves such a table as it stands, so it is brought to
-- this shape here. No courier had been released when this was written, so the only such tables were empty ones.
-- On a table that holds a row the second statement fails, since an existing row has no message to point at, and
-- the release fails with it and changes nothing: that is the right outcome, and no message is made up for a stop
-- that stands.
ALTER TABLE stops DROP COLUMN IF EXISTS message, DROP COLUMN IF EXISTS signature;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS message_id bigint NOT NULL REFERENCES stop_messages (id), ADD COLUMN IF NOT EXISTS grant_number bigint;
ALTER TABLE stops DROP CONSTRAINT IF EXISTS stops_original_when_ahead;

-- The rule that a stop ahead is whole, on a table that stood before it. The rule is added only where the table does
-- not hold a constraint of its name: adding it reads every row of the table, and a release that dropped and added it
-- each time would read the table whole at every release, more with every stop kept. Where a constraint of the name
-- stands, the catalog alone is read: it must be this check, validated, as the database states it, or the release
-- fails and changes nothing. A name alone proves no shape, so a constraint of the name that is another rule, or one
-- not validated, is not adopted, and is not dropped and added again either: it is a state nobody intended, to be
-- looked at by a person. This block is constant text; nothing of the data is in it.
DO $$
DECLARE
  standing record;
BEGIN
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO standing
  FROM pg_constraint c WHERE c.conrelid = 'stops'::regclass AND c.conname = 'stops_ahead_whole';
  IF NOT FOUND THEN
    ALTER TABLE stops ADD CONSTRAINT stops_ahead_whole CHECK (ahead = (original IS NOT NULL) AND ahead = (original_expiry IS NOT NULL) AND ahead = (grant_number IS NOT NULL));
  ELSIF standing.contype <> 'c' OR NOT standing.convalidated
     OR standing.definition <> 'CHECK (((ahead = (original IS NOT NULL)) AND (ahead = (original_expiry IS NOT NULL)) AND (ahead = (grant_number IS NOT NULL))))' THEN
    RAISE EXCEPTION 'the stops table holds a constraint named stops_ahead_whole that is not the validated check this schema makes: %', standing.definition
      USING ERRCODE = 'invalid_table_definition';
  END IF;
END
$$;

-- The stop route's count of an account's stops ahead that still count against its bound of 32: the stops ahead of
-- one account, the latest original_expiry first, so the count reads the ones whose originals have not expired and
-- no further, whatever the account stopped ahead before and has since let expire.
CREATE INDEX IF NOT EXISTS stops_ahead_by_account
  ON stops (account, original_expiry DESC)
  WHERE ahead;

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
  -- When the lane took the bet it holds: the reservation's transaction time, a timestamp that decides nothing.
  reserved_at timestamptz,
  CONSTRAINT lanes_reservation_with_bet CHECK ((held_bet IS NULL) = (reservation IS NULL))
);

-- The reservation's time, on a lanes table that stood before it. No lane had a row before the bet's check was built.
ALTER TABLE lanes ADD COLUMN IF NOT EXISTS reserved_at timestamptz;

-- The numbers of the reservations: each one a lane takes a bet under is new, and never reused.
CREATE SEQUENCE IF NOT EXISTS lane_reservations;

-- A lane that holds a bet holds its reservation's time with it, and one that holds none holds no time: the bet, the
-- reservation and the time are emptied together. Added only where no constraint of its name stands, as the stops'
-- rule above is, and for the same reason: a release reads the catalog, not the table.
DO $$
DECLARE
  standing record;
BEGIN
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO standing
  FROM pg_constraint c WHERE c.conrelid = 'lanes'::regclass AND c.conname = 'lanes_reserved_at_with_bet';
  IF NOT FOUND THEN
    ALTER TABLE lanes ADD CONSTRAINT lanes_reserved_at_with_bet CHECK ((held_bet IS NULL) = (reserved_at IS NULL));
  ELSIF standing.contype <> 'c' OR NOT standing.convalidated
     OR standing.definition <> 'CHECK (((held_bet IS NULL) = (reserved_at IS NULL)))' THEN
    RAISE EXCEPTION 'the lanes table holds a constraint named lanes_reserved_at_with_bet that is not the validated check this schema makes: %', standing.definition
      USING ERRCODE = 'invalid_table_definition';
  END IF;
END
$$;

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
  -- Why a Cross was closed not sent; empty for every other state: a stop found at the gate (STOPPED_AT_GATE); the
  -- courier restarted, or another of its processes took over, before the gate (COURIER_RESTARTED); the node refused
  -- the one hand-off by name (NODE_REFUSED).
  not_sent_reason      text,
  -- The check's figures: the final block and the time the candidate statement ran; the estimate, the limit and
  -- each step of the search for a shorter fill; the key's nonce, its POL and its coin, and the relay's coin, at the
  -- check's block; the comparison's verdict, or that it was skipped for want of an override; the pulls and
  -- pay-backs predicted, and the pay-backs refused at the block; the quotes left out after the coin refused one;
  -- what is left unfilled.
  checked              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The reason and the figures, on a crosses table that stood before them. No Cross had a row before this build.
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS not_sent_reason text;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS checked jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The sender's figures, on a crosses table that stood before them. The six times decide nothing: when the intent, the
-- signed record, the gate, the node's answer, the first sight of a receipt and the outcome were written. The gas the
-- receipt used and the price it paid, so what the Cross cost. A revert's evidence, the node's trace of the
-- transaction or unavailable, and the trace's output, whole bytes of hex, kept to 32,768 hex digits, enough for a
-- refusal that lists forty legs. Whether the transaction that took a replaced Cross's nonce is the courier's own. What
-- the receipt recorded: each account's pulls, pay-backs and refused pay-backs, the totals, and the bet's filled amount
-- at the outcome's final block, beside the check's figures.
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS intent_at timestamptz;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS signed_at timestamptz;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS gate_at timestamptz;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS answered_at timestamptz;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS receipt_seen_at timestamptz;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS outcome_at timestamptz;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS gas_used numeric(78, 0);
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS effective_gas_price numeric(78, 0);
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS revert_evidence text CHECK (revert_evidence IN ('trace', 'unavailable'));
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS revert_data text CHECK (revert_data ~ '^0x([0-9a-f]{2})*$' AND length(revert_data) <= 32770);
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS replaced_by_ours boolean;
ALTER TABLE crosses ADD COLUMN IF NOT EXISTS recorded jsonb;

-- The reasons a Cross is closed not sent, and that it has one exactly when it is: each added only where no
-- constraint of its name stands, as the stops' rule above is. The reasons are the sender's three. A table made by the
-- earlier build holds the check with its one reason, SENDER_NOT_BUILT, the reason of a build that sent nothing: that
-- check is dropped and added again under its name with the three, as the legs' reasons are below, once, and a later
-- release reads the catalog alone and takes the three-reason check as it stands. A table that holds a row closed for
-- SENDER_NOT_BUILT is refused, with the count, and nothing is changed: no such row is made up into another reason.
DO $$
DECLARE
  standing record;
  earlier bigint;
BEGIN
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO standing
  FROM pg_constraint c WHERE c.conrelid = 'crosses'::regclass AND c.conname = 'crosses_not_sent_reasons';
  IF NOT FOUND THEN
    ALTER TABLE crosses ADD CONSTRAINT crosses_not_sent_reasons CHECK (not_sent_reason IN ('STOPPED_AT_GATE', 'COURIER_RESTARTED', 'NODE_REFUSED'));
  ELSIF standing.contype = 'c' AND standing.convalidated
     AND standing.definition = 'CHECK ((not_sent_reason = ANY (ARRAY[''STOPPED_AT_GATE''::text, ''COURIER_RESTARTED''::text, ''NODE_REFUSED''::text])))' THEN
    NULL;
  ELSIF standing.contype = 'c' AND standing.convalidated
     AND standing.definition = 'CHECK ((not_sent_reason = ''SENDER_NOT_BUILT''::text))' THEN
    SELECT count(*) INTO earlier FROM crosses WHERE not_sent_reason = 'SENDER_NOT_BUILT';
    IF earlier > 0 THEN
      RAISE EXCEPTION 'the crosses table holds % Cross rows closed not sent for SENDER_NOT_BUILT, the reason of a build that sent nothing; this schema has no such reason, and makes up no other for them', earlier
        USING ERRCODE = 'check_violation';
    END IF;
    ALTER TABLE crosses DROP CONSTRAINT crosses_not_sent_reasons;
    ALTER TABLE crosses ADD CONSTRAINT crosses_not_sent_reasons CHECK (not_sent_reason IN ('STOPPED_AT_GATE', 'COURIER_RESTARTED', 'NODE_REFUSED'));
  ELSE
    RAISE EXCEPTION 'the crosses table holds a constraint named crosses_not_sent_reasons that is not the validated check this schema makes: %', standing.definition
      USING ERRCODE = 'invalid_table_definition';
  END IF;
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO standing
  FROM pg_constraint c WHERE c.conrelid = 'crosses'::regclass AND c.conname = 'crosses_not_sent_with_reason';
  IF NOT FOUND THEN
    ALTER TABLE crosses ADD CONSTRAINT crosses_not_sent_with_reason CHECK ((state = 'not sent') = (not_sent_reason IS NOT NULL));
  ELSIF standing.contype <> 'c' OR NOT standing.convalidated
     OR standing.definition <> 'CHECK (((state = ''not sent''::text) = (not_sent_reason IS NOT NULL)))' THEN
    RAISE EXCEPTION 'the crosses table holds a constraint named crosses_not_sent_with_reason that is not the validated check this schema makes: %', standing.definition
      USING ERRCODE = 'invalid_table_definition';
  END IF;
  -- The record says only what happened. A transaction's hash from the signed record on: every state but the intent,
  -- a Cross closed not sent (before its signed record, or after), and a restored intent closed expired unmined on the
  -- chain's proof, which no transaction of the courier's was found for. Handed to the node once from the gate on: none
  -- before it; one for a Cross handing off, sent or unknown, and for the node's named refusal; none for a stop found
  -- at the gate or a restart before it. After a restore the count is the evidence the copy kept and no more: a restored
  -- Cross settled later from the chain keeps it, so a final state holds either.
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO standing
  FROM pg_constraint c WHERE c.conrelid = 'crosses'::regclass AND c.conname = 'crosses_hash_once_signed';
  IF NOT FOUND THEN
    ALTER TABLE crosses ADD CONSTRAINT crosses_hash_once_signed CHECK (tx_hash IS NOT NULL OR state IN ('intent', 'not sent', 'expired unmined'));
  ELSIF standing.contype <> 'c' OR NOT standing.convalidated
     OR standing.definition <> 'CHECK (((tx_hash IS NOT NULL) OR (state = ANY (ARRAY[''intent''::text, ''not sent''::text, ''expired unmined''::text]))))' THEN
    RAISE EXCEPTION 'the crosses table holds a constraint named crosses_hash_once_signed that is not the validated check this schema makes: %', standing.definition
      USING ERRCODE = 'invalid_table_definition';
  END IF;
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO standing
  FROM pg_constraint c WHERE c.conrelid = 'crosses'::regclass AND c.conname = 'crosses_hand_offs_by_state';
  IF NOT FOUND THEN
    ALTER TABLE crosses ADD CONSTRAINT crosses_hand_offs_by_state CHECK (
      (state IN ('intent', 'signed') AND hand_offs = 0)
      OR (state IN ('handing off', 'sent', 'unknown') AND hand_offs = 1)
      OR (state = 'not sent' AND ((not_sent_reason = 'NODE_REFUSED' AND hand_offs = 1) OR (not_sent_reason <> 'NODE_REFUSED' AND hand_offs = 0)))
      OR state IN ('pending', 'confirmed', 'reverted', 'expired unmined', 'replaced'));
  ELSIF standing.contype <> 'c' OR NOT standing.convalidated
     OR standing.definition <> 'CHECK ((((state = ANY (ARRAY[''intent''::text, ''signed''::text])) AND (hand_offs = 0)) OR ((state = ANY (ARRAY[''handing off''::text, ''sent''::text, ''unknown''::text])) AND (hand_offs = 1)) OR ((state = ''not sent''::text) AND (((not_sent_reason = ''NODE_REFUSED''::text) AND (hand_offs = 1)) OR ((not_sent_reason <> ''NODE_REFUSED''::text) AND (hand_offs = 0)))) OR (state = ANY (ARRAY[''pending''::text, ''confirmed''::text, ''reverted''::text, ''expired unmined''::text, ''replaced''::text]))))' THEN
    RAISE EXCEPTION 'the crosses table holds a constraint named crosses_hand_offs_by_state that is not the validated check this schema makes: %', standing.definition
      USING ERRCODE = 'invalid_table_definition';
  END IF;
END
$$;

-- A key's Crosses by nonce: the nonce's floor and the search for what used a nonce read a key's handful along it.
CREATE INDEX IF NOT EXISTS crosses_sender_nonce
  ON crosses (sender, nonce)
  WHERE nonce IS NOT NULL;

-- A Cross's row is written five or six times, from its intent to its outcome: the orders table's maintenance, above,
-- for the same reason.
ALTER TABLE crosses SET (
  autovacuum_vacuum_threshold = 2000,
  autovacuum_vacuum_scale_factor = 0,
  autovacuum_analyze_threshold = 2000,
  autovacuum_analyze_scale_factor = 0,
  vacuum_index_cleanup = on
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
                        'NoCourier', 'Cancelled', 'Expired', 'NoRoom', 'NothingFits', 'UnderMinFill', 'PullRefused',
                        'GrantGone')),
  PRIMARY KEY (bet_hash, position)
);

-- The eighth reason, GrantGone, came with the contracts' approved agent: a quote signed under a grant that is no
-- longer its account's current one, or that has ended. A table made before it holds the check with seven names, and
-- IF NOT EXISTS above leaves a table that stands as it is; so the check is dropped and added again here, under the
-- name the CREATE gives it, and a table that stood and one just made hold the same rule. The add holds the table's
-- rows to the rule, which is one read of the table at each release; the table has no row before the sender's build.
ALTER TABLE legs DROP CONSTRAINT IF EXISTS legs_skip_reason_check;
ALTER TABLE legs ADD CONSTRAINT legs_skip_reason_check CHECK (skip_reason IN (
  'NoCourier', 'Cancelled', 'Expired', 'NoRoom', 'NothingFits', 'UnderMinFill', 'PullRefused', 'GrantGone'));

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

-- A bet's lines, by the bet's hash and in order: what GET /v1/orders/{hash} reads a bet's verdict along. The lines the
-- bet's check writes carry the bet's hash in bet_hash.
CREATE INDEX IF NOT EXISTS events_bet_lines
  ON events (bet_hash, number)
  WHERE bet_hash IS NOT NULL;

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
-- of a key is open at a time; a key that opens again is a new row. A row open
-- means the last decision the records made for the key was an opening; a row
-- cleared means it was a clearing. The records apply outcomes in the order
-- they process them, not in the order the chain was observed, and neither an
-- open row nor a cleared one says the chain is up or down this instant. The
-- times here, and a line's `at`, are the writing transaction's time: they are
-- diagnostics, not the order the chain was observed in, and no time decides a
-- transition.
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

-- ──────────────────────────── the sender's columns of lanes ───────────────────
-- Below the events table, since one of them names a line.
--
-- The line that shut the lane, while it is shut: the opening of cross-unreconciled (the key's nonce used by a
-- transaction the records do not hold, or a search the node could not answer), or the incident a restore's shut
-- wrote. Empty while the lane is open. The reservation and the door's check 17 require it empty. The operator's
-- clear empties it for a lane shut for the first reason and refuses one shut at a restore; nothing else empties it.
ALTER TABLE lanes ADD COLUMN IF NOT EXISTS shut_line bigint REFERENCES events (number);

-- The key's nonces explained: every nonce below verified_nonce_to is explained, at the final block named beside it,
-- by a transaction of this key shown on that block's chain. It rises only at a final block, and the block's number
-- and hash are its anchor; 0, with no anchor, before the first.
ALTER TABLE lanes ADD COLUMN IF NOT EXISTS verified_nonce_to bigint NOT NULL DEFAULT 0;
ALTER TABLE lanes ADD COLUMN IF NOT EXISTS verified_block_number numeric(78, 0);
ALTER TABLE lanes ADD COLUMN IF NOT EXISTS verified_block_hash text CHECK (verified_block_hash ~ '^0x[0-9a-f]{64}$');

-- The watermark is whole: an anchor's number and hash together, and one wherever a nonce is explained. Added only
-- where no constraint of its name stands, as the lanes' rule above is.
DO $$
DECLARE
  standing record;
BEGIN
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO standing
  FROM pg_constraint c WHERE c.conrelid = 'lanes'::regclass AND c.conname = 'lanes_watermark_anchored';
  IF NOT FOUND THEN
    ALTER TABLE lanes ADD CONSTRAINT lanes_watermark_anchored CHECK (
      (verified_block_number IS NULL) = (verified_block_hash IS NULL) AND (verified_nonce_to = 0 OR verified_block_number IS NOT NULL));
  ELSIF standing.contype <> 'c' OR NOT standing.convalidated
     OR standing.definition <> 'CHECK ((((verified_block_number IS NULL) = (verified_block_hash IS NULL)) AND ((verified_nonce_to = 0) OR (verified_block_number IS NOT NULL))))' THEN
    RAISE EXCEPTION 'the lanes table holds a constraint named lanes_watermark_anchored that is not the validated check this schema makes: %', standing.definition
      USING ERRCODE = 'invalid_table_definition';
  END IF;
END
$$;

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
