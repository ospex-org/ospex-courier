import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { applySchema, missingSchema, openPool, TABLES } from '../courier/records/store';
import { testServer } from './support/database';

// db/schema.sql against a real Postgres: applied twice, the eleven tables, the
// indexes the plan names with their conditions, and the rules the tables keep
// by themselves, each proved by a row written by hand.

const db = testServer();
let pool: pg.Pool;
let url: string;

const hex = (n: number, seed: string) => seed.repeat(n).slice(0, n);
const HASH = (seed: string) => `0x${hex(64, seed)}`;
const ADDRESS = (seed: string) => `0x${hex(40, seed)}`;
const SIGNATURE = (seed: string) => `0x${hex(130, seed)}`;

async function insertOrder(hash: string, role: 'rest' | 'take', overrides: Record<string, unknown> = {}, on: pg.Pool = pool): Promise<void> {
  const row: Record<string, unknown> = {
    hash,
    role,
    account: ADDRESS('a'),
    game_id: '1',
    scorer: ADDRESS('b'),
    line_ticks: 0,
    position_type: 0,
    odds_tick: 204,
    risk_amount: '100000',
    nonce: '1',
    expiry: '1794268800',
    min_fill: '0',
    signature: SIGNATURE('c'),
    market_key: HASH('d'),
    side: 0,
    received_block: '100',
    received_hash: HASH('e'),
    received_time: '1794268000',
    bet_state: role === 'take' ? 'waiting' : null,
    ...overrides,
  };
  const columns = Object.keys(row);
  await on.query(`INSERT INTO orders (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
}

async function refused(work: Promise<unknown>, code: string, what: string): Promise<void> {
  await assert.rejects(work, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code, `${what}: ${(err as Error).message}`);
    return true;
  });
}

before(async () => {
  const made = await db.createWithSchema('schema');
  url = made.url;
  pool = openPool(url, null);
});

after(async () => {
  await pool.end();
  await db.end();
});

test('applied again, the schema is the same schema, and nothing is missing', async () => {
  await applySchema(pool);
  await applySchema(pool);
  const { rows } = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1");
  assert.deepEqual(rows.map((r) => r.table_name), [...TABLES].sort());
  assert.deepEqual(await missingSchema(pool), []);
});

test('a database without the schema is named table by table', async () => {
  const name = await db.createDatabase('empty');
  const empty = openPool(db.urlFor(name), null);
  try {
    assert.deepEqual(await missingSchema(empty), [...TABLES]);
  } finally {
    await empty.end();
  }
});

test('the indexes the plan names are there, with their conditions', async () => {
  const { rows } = await pool.query<{ indexname: string; indexdef: string }>('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()');
  const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? assert.fail(`no index ${name}`);
  const book = def('orders_book');
  assert.match(book, /\(market_key, side, odds_tick, record_number\)/);
  assert.match(book, /WHERE \(\(role = 'rest'::text\) AND \(ended IS NULL\)\)/);
  const live = def('orders_live_quotes_per_account');
  assert.match(live, /\(account, market_key, side, expiry DESC\)/);
  assert.match(live, /WHERE \(\(role = 'rest'::text\) AND \(ended IS NULL\)\)/);
  const markets = def('orders_markets_of_game');
  assert.match(markets, /\(game_id, scorer, line_ticks, side\)/);
  assert.match(markets, /WHERE \(\(role = 'rest'::text\) AND \(ended IS NULL\)\)/);
  const open = def('crosses_one_open_per_lane');
  assert.match(open, /^CREATE UNIQUE INDEX/);
  assert.match(open, /\(lane\)/);
  assert.match(open, /WHERE \(state <> ALL/);
  assert.match(def('conditions_one_open_per_key'), /^CREATE UNIQUE INDEX .* \(key\) WHERE \(cleared_at IS NULL\)/);
  assert.match(def('events_report_lines'), /\(number\) WHERE \(kind = ANY/);
  assert.match(def('orders_bets_waiting'), /\(record_number\) WHERE \(\(role = 'take'::text\) AND \(bet_state = ANY \(ARRAY\['waiting'::text, 'held'::text\]\)\) AND \(ended IS NULL\)\)$/);
  assert.match(def('orders_record_number_key'), /UNIQUE INDEX .* \(record_number\)/);
  assert.match(def('crosses_tx_hash_key'), /UNIQUE INDEX .* \(tx_hash\)/);
  assert.match(def('stops_ahead_by_account'), /^CREATE INDEX stops_ahead_by_account ON \S*stops USING btree \(account, original_expiry DESC\) WHERE ahead$/);
});

test('record numbers rise and are never reused', async () => {
  await insertOrder(HASH('1'), 'rest');
  await insertOrder(HASH('2'), 'rest');
  const first = await pool.query<{ hash: string; record_number: string }>('SELECT hash, record_number FROM orders ORDER BY record_number');
  const [a, b] = first.rows;
  assert.ok(a && b && BigInt(b.record_number) > BigInt(a.record_number));
  await pool.query('DELETE FROM orders WHERE hash = $1', [HASH('2')]);
  await insertOrder(HASH('3'), 'rest');
  const { rows } = await pool.query<{ record_number: string }>('SELECT record_number FROM orders WHERE hash = $1', [HASH('3')]);
  assert.ok(BigInt(rows[0]?.record_number ?? '0') > BigInt(b.record_number), 'the deleted number was reused');
});

test('an order keeps the contract\'s own rules: the price range, whole lots, the minimum under the stake, a bet state for bets only', async () => {
  await refused(insertOrder(HASH('f1'), 'rest', { odds_tick: 100 }), '23514', 'a price under 101');
  await refused(insertOrder(HASH('f2'), 'rest', { odds_tick: 10101 }), '23514', 'a price over 10100');
  await refused(insertOrder(HASH('f3'), 'rest', { risk_amount: '150' }), '23514', 'a stake not in lots');
  await refused(insertOrder(HASH('f4'), 'rest', { min_fill: '100100' }), '23514', 'a minimum above the stake');
  await refused(insertOrder(HASH('f5'), 'rest', { bet_state: 'waiting' }), '23514', 'a quote with a bet state');
  await refused(insertOrder(HASH('f6'), 'take', { bet_state: null }), '23514', 'a bet with no state');
  await refused(insertOrder(HASH('f7'), 'rest', { side: 1 }), '23514', 'a side that is not the position type');
  await refused(insertOrder(HASH('f8'), 'rest', { role: 'maker' }), '23514', 'a role that is not rest or take');
  await refused(insertOrder(HASH('f9'), 'rest', { account: ADDRESS('A') }), '23514', 'an address in upper case');
  // The control: a bet with its state is taken.
  await insertOrder(HASH('f0'), 'take', { bet_state: 'waiting' });
});

test('a mark is whole: cancelled carries the block the chain was read at, number and hash together; a block without a mark, or an end the schema does not list, is refused', async () => {
  const at = new Date();
  await refused(insertOrder(HASH('e1'), 'rest', { ended: 'cancelled', ended_at: at }), '23514', 'cancelled with no block');
  await refused(insertOrder(HASH('e2'), 'rest', { ended: 'cancelled', ended_at: at, ended_block: '5' }), '23514', 'cancelled with a block number and no hash');
  await refused(insertOrder(HASH('e3'), 'rest', { ended_block: '5', ended_block_hash: HASH('b') }), '23514', 'a block with no mark');
  await refused(insertOrder(HASH('e4'), 'rest', { ended: 'expired', ended_at: at, ended_block_hash: HASH('b') }), '23514', 'a hash with no number');
  await refused(insertOrder(HASH('e5'), 'rest', { ended: 'gone', ended_at: at }), '23514', 'an end the schema does not list');
  await refused(insertOrder(HASH('e6'), 'rest', { ended: 'cancelled' }), '23514', 'a mark with no time');
  await refused(insertOrder(HASH('e9'), 'rest', { ended: 'filled', ended_at: at }), '23514', 'filled with no block');
  // The controls: a cancelled mark and a filled mark with their block; an expiry mark with none.
  await insertOrder(HASH('e7'), 'rest', { ended: 'cancelled', ended_at: at, ended_block: '5', ended_block_hash: HASH('b') });
  await insertOrder(HASH('ea'), 'rest', { ended: 'filled', ended_at: at, ended_block: '6', ended_block_hash: HASH('b') });
  await insertOrder(HASH('e8'), 'rest', { ended: 'expired', ended_at: at });
});

test('one bet, one Cross; one transaction hash; one open Cross a lane', async () => {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO runs DEFAULT VALUES RETURNING id');
  const run = Number(rows[0]?.id);
  await pool.query('INSERT INTO lanes (sender, epoch, owner_run) VALUES ($1, 1, $2)', [ADDRESS('9'), run]);
  await insertOrder(HASH('b1'), 'take');
  await insertOrder(HASH('b2'), 'take');
  await insertOrder(HASH('b3'), 'take');
  const cross = (bet: string, state: string, tx: string | null) =>
    pool.query(
      `INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, state, tx_hash)
       VALUES ($1, $2, 1, 1, 100, $3, 1794268800, $4, $5)`,
      [bet, ADDRESS('9'), HASH('e'), state, tx],
    );
  await cross(HASH('b1'), 'sent', HASH('71'));
  await refused(cross(HASH('b1'), 'intent', null), '23505', 'a second Cross for one bet');
  await refused(cross(HASH('b2'), 'intent', HASH('71')), '23505', 'a second Cross with one transaction hash');
  await refused(cross(HASH('b2'), 'intent', null), '23505', 'a second open Cross on one lane');
  // A Cross that is final leaves the lane free for the next.
  await pool.query('UPDATE crosses SET state = $2 WHERE bet_hash = $1', [HASH('b1'), 'confirmed']);
  await cross(HASH('b2'), 'intent', null);
  await refused(cross(HASH('b3'), 'intent', null), '23505', 'a third Cross while the second is open');
  // A leg names its place, under forty.
  await refused(pool.query('INSERT INTO legs (bet_hash, position, order_hash, expected_maker_risk, expected_taker_risk) VALUES ($1, 40, $2, 100, 104)', [HASH('b2'), HASH('1')]), '23514', 'a leg at position 40');
  await pool.query('INSERT INTO legs (bet_hash, position, order_hash, expected_maker_risk, expected_taker_risk) VALUES ($1, 39, $2, 100, 104)', [HASH('b2'), HASH('1')]);
});

test('events are append-only: no update, no delete, no truncate, and only the kinds the plan lists', async () => {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO runs DEFAULT VALUES RETURNING id');
  const run = Number(rows[0]?.id);
  const written = await pool.query<{ number: string }>("INSERT INTO events (run, kind, reason) VALUES ($1, 'run started', 'test') RETURNING number", [run]);
  const number = written.rows[0]?.number;
  await refused(pool.query("UPDATE events SET reason = 'changed' WHERE number = $1", [number]), '23514', 'an update');
  await refused(pool.query('DELETE FROM events WHERE number = $1', [number]), '23514', 'a delete');
  // A plain truncate is refused by the conditions table's reference to events before the trigger is reached
  // (feature_not_supported); a truncate that cascades reaches the trigger.
  await refused(pool.query('TRUNCATE events'), '0A000', 'a truncate');
  await refused(pool.query('TRUNCATE events CASCADE'), '23514', 'a cascading truncate');
  await refused(pool.query("INSERT INTO events (run, kind) VALUES ($1, 'heartbeat')", [run]), '23514', 'a kind the plan does not list');
  const { rows: still } = await pool.query("SELECT reason FROM events WHERE number = $1", [number]);
  assert.equal(still[0]?.reason, 'test');
});

test('one condition of a key is open at a time; a cleared one lets the next open', async () => {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO runs DEFAULT VALUES RETURNING id');
  const run = Number(rows[0]?.id);
  const line = async () => Number((await pool.query<{ number: string }>("INSERT INTO events (run, kind, reason) VALUES ($1, 'condition opened', 'chain-unreachable') RETURNING number", [run])).rows[0]?.number);
  await pool.query('INSERT INTO conditions (key, opened_line) VALUES ($1, $2)', ['chain-unreachable', await line()]);
  await refused(pool.query('INSERT INTO conditions (key, opened_line) VALUES ($1, $2)', ['chain-unreachable', await line()]), '23505', 'a second open condition of one key');
  await refused(pool.query('INSERT INTO conditions (key, opened_line) VALUES ($1, $2)', ['bet-lapsed', await line()]), '23514', 'an incident as a condition');
  await pool.query('UPDATE conditions SET cleared_at = now(), cleared_line = $1 WHERE key = $2 AND cleared_at IS NULL', [await line(), 'chain-unreachable']);
  await pool.query('INSERT INTO conditions (key, opened_line) VALUES ($1, $2)', ['chain-unreachable', await line()]);
  await refused(pool.query('UPDATE conditions SET cleared_at = now() WHERE key = $1 AND cleared_at IS NULL', ['chain-unreachable']), '23514', 'a clearing with no line');
});

test("a legs table that holds the skip reasons' check as it stood before GrantGone is brought to this schema by applying it: the check read back names the eight reasons, a leg skipped for its grant is taken where it was refused, an unlisted reason is still refused, and a table this schema made by itself holds the same check", async () => {
  const made = await db.createWithSchema('legs');
  const legs = openPool(made.url, null);
  try {
    const check = async (on: pg.Pool): Promise<string[]> =>
      (await on.query<{ definition: string }>("SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conrelid = 'legs'::regclass AND c.conname = 'legs_skip_reason_check'")).rows.map((r) => r.definition);
    // The table as the schema before this one left it: the same check under the same name, with seven reasons.
    await legs.query('ALTER TABLE legs DROP CONSTRAINT legs_skip_reason_check');
    await legs.query("ALTER TABLE legs ADD CONSTRAINT legs_skip_reason_check CHECK (skip_reason IN ('NoCourier', 'Cancelled', 'Expired', 'NoRoom', 'NothingFits', 'UnderMinFill', 'PullRefused'))");
    const seven = "CHECK ((skip_reason = ANY (ARRAY['NoCourier'::text, 'Cancelled'::text, 'Expired'::text, 'NoRoom'::text, 'NothingFits'::text, 'UnderMinFill'::text, 'PullRefused'::text])))";
    assert.deepEqual(await check(legs), [seven], 'the older check, as the database states it');

    // A Cross to hang legs on, and a leg under each kind of reason.
    const { rows } = await legs.query<{ id: string }>('INSERT INTO runs DEFAULT VALUES RETURNING id');
    await legs.query('INSERT INTO lanes (sender, epoch, owner_run) VALUES ($1, 1, $2)', [ADDRESS('9'), Number(rows[0]?.id)]);
    await insertOrder(HASH('b1'), 'take', {}, legs);
    await insertOrder(HASH('1'), 'rest', {}, legs);
    await legs.query("INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, state) VALUES ($1, $2, 1, 1, 100, $3, 1794268800, 'intent')", [HASH('b1'), ADDRESS('9'), HASH('e')]);
    const leg = (position: number, reason: string) =>
      legs.query('INSERT INTO legs (bet_hash, position, order_hash, expected_maker_risk, expected_taker_risk, skip_reason) VALUES ($1, $2, $3, 100, 104, $4)', [HASH('b1'), position, HASH('1'), reason]);
    await leg(0, 'PullRefused');
    await refused(leg(1, 'GrantGone'), '23514', 'the older table refuses the eighth reason');

    // This schema applied over it: the check is the eight, and the row that stood still stands under it.
    await applySchema(legs);
    const eight = "CHECK ((skip_reason = ANY (ARRAY['NoCourier'::text, 'Cancelled'::text, 'Expired'::text, 'NoRoom'::text, 'NothingFits'::text, 'UnderMinFill'::text, 'PullRefused'::text, 'GrantGone'::text])))";
    assert.deepEqual(await check(legs), [eight], 'the check after this schema is applied over the older table');
    await leg(1, 'GrantGone');
    await refused(leg(2, 'Gone'), '23514', 'a reason the schema does not list');
    assert.deepEqual((await legs.query<{ skip_reason: string }>('SELECT l.skip_reason FROM legs l ORDER BY l.position')).rows.map((r) => r.skip_reason), ['PullRefused', 'GrantGone']);
    // Applied again it is the same check; and the table this schema made by itself, with no older one under it, holds it too.
    await applySchema(legs);
    assert.deepEqual(await check(legs), [eight]);
    assert.deepEqual(await check(pool), [eight], 'a table made by this schema alone');
  } finally {
    await legs.end();
  }
});

// ──────────────────────────── the stops and their messages ────────────────────────────

const ORIGINAL = JSON.stringify({ order: { account: ADDRESS('a'), nonce: '1' }, signature: SIGNATURE('c') });

async function insertMessage(on: pg.Pool, overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    account: ADDRESS('a'),
    signer: ADDRESS('a'),
    message: JSON.stringify({ account: ADDRESS('a'), orderHashes: [HASH('5')] }),
    signature: SIGNATURE('c'),
    ...overrides,
  };
  const columns = Object.keys(row);
  const { rows } = await on.query<{ id: string }>(`INSERT INTO stop_messages (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row));
  return rows[0]?.id ?? assert.fail('the message was given no id');
}

async function insertStop(on: pg.Pool, hash: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const row: Record<string, unknown> = { hash, account: ADDRESS('a'), ...overrides };
  const columns = Object.keys(row);
  await on.query(`INSERT INTO stops (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
}

/** The stops table as the catalog states it: its columns by name, and every constraint with its definition. */
async function stopsShape(on: pg.Pool): Promise<{ columns: string[]; constraints: string[] }> {
  const columns = await on.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT c.column_name, c.data_type, c.is_nullable FROM information_schema.columns c WHERE c.table_schema = current_schema() AND c.table_name = 'stops' ORDER BY c.column_name",
  );
  const constraints = await on.query<{ conname: string; contype: string; convalidated: boolean; definition: string }>(
    "SELECT c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conrelid = 'stops'::regclass ORDER BY c.conname",
  );
  return {
    columns: columns.rows.map((r) => `${r.column_name} ${r.data_type} ${r.is_nullable === 'YES' ? 'null' : 'not null'}`),
    constraints: constraints.rows.map((r) => `${r.conname} ${r.contype} ${r.convalidated ? 'validated' : 'NOT VALIDATED'} ${r.definition}`),
  };
}

/** The rule that a stop ahead is whole, as the database states it; and the oid of the constraint that holds it. */
const AHEAD_WHOLE = 'CHECK (((ahead = (original IS NOT NULL)) AND (ahead = (original_expiry IS NOT NULL)) AND (ahead = (grant_number IS NOT NULL))))';
async function aheadWhole(on: pg.Pool): Promise<Array<{ oid: string; validated: boolean; definition: string }>> {
  const { rows } = await on.query<{ oid: string; validated: boolean; definition: string }>(
    "SELECT c.oid::text AS oid, c.convalidated AS validated, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conrelid = 'stops'::regclass AND c.conname = 'stops_ahead_whole'",
  );
  return rows;
}

/** The stops table as the schema before this one made it: the message and its signature on every row, no message_id, no grant_number, the older rule under its older name. */
const STOPS_BEFORE = `CREATE TABLE stops (
  hash            text PRIMARY KEY CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  account         text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  message         jsonb NOT NULL,
  signature       text NOT NULL CHECK (signature ~ '^0x[0-9a-f]{130}$'),
  received_at     timestamptz NOT NULL DEFAULT now(),
  ahead           boolean NOT NULL DEFAULT false,
  original        jsonb,
  original_expiry numeric(78, 0),
  CONSTRAINT stops_original_when_ahead CHECK (ahead = (original IS NOT NULL) AND ahead = (original_expiry IS NOT NULL))
)`;

/**
 * Applies the schema on a connection of its own and ends it. The schema is one transaction; an apply the database
 * refuses leaves its connection inside that failed transaction, holding its locks, until the connection closes. The
 * release step is a process that ends; here the pool is ended, so what is read afterwards is read after the rollback.
 */
async function applyOnce(databaseUrl: string): Promise<void> {
  const on = openPool(databaseUrl, null, 1);
  try {
    await applySchema(on);
  } finally {
    await on.end();
  }
}

test("a stop's rows keep their own rules: a stop points at a message that is there; a stop ahead holds its original, the original's expiry and its grant number together, and a carried stop none of the three; a message's block is number, hash and time together or none; one stop a hash", async () => {
  const id = await insertMessage(pool);
  const ahead = { ahead: true, original: ORIGINAL, original_expiry: '1794268800', grant_number: 0 };
  // The controls: a carried stop; a stop ahead, whole; one under a grant whose number is the top of a uint32.
  await insertStop(pool, HASH('51'), { message_id: id });
  await insertStop(pool, HASH('52'), { message_id: id, ...ahead });
  await insertStop(pool, HASH('53'), { message_id: id, ...ahead, grant_number: '4294967295' });
  // A stop ahead short of one of its three.
  await refused(insertStop(pool, HASH('54'), { message_id: id, ahead: true, original: ORIGINAL, original_expiry: '1794268800' }), '23514', 'a stop ahead without its grant number');
  await refused(insertStop(pool, HASH('55'), { message_id: id, ahead: true, original: ORIGINAL, grant_number: 0 }), '23514', "a stop ahead without its original's expiry");
  await refused(insertStop(pool, HASH('56'), { message_id: id, ahead: true, original_expiry: '1794268800', grant_number: 0 }), '23514', 'a stop ahead without its original');
  // A carried stop with one of them.
  await refused(insertStop(pool, HASH('57'), { message_id: id, original: ORIGINAL }), '23514', 'a carried stop with an original');
  await refused(insertStop(pool, HASH('58'), { message_id: id, original_expiry: '1794268800' }), '23514', "a carried stop with an original's expiry");
  await refused(insertStop(pool, HASH('59'), { message_id: id, grant_number: 0 }), '23514', 'a carried stop with a grant number');
  // The message a stop points at.
  await refused(insertStop(pool, HASH('5a'), { message_id: '987654321' }), '23503', 'a stop pointing at a message that is not there');
  await refused(insertStop(pool, HASH('5b')), '23502', 'a stop with no message');
  await refused(insertStop(pool, HASH('51'), { message_id: id }), '23505', 'a second stop of one hash');
  // A message's block: whole or absent.
  await refused(insertMessage(pool, { block_number: '5' }), '23514', 'a message with a block number and no hash');
  await refused(insertMessage(pool, { block_number: '5', block_hash: HASH('b') }), '23514', 'a message with a block and no time');
  await refused(insertMessage(pool, { block_time: '1794268800' }), '23514', 'a message with a time and no block');
  await refused(insertMessage(pool, { signer: ADDRESS('A') }), '23514', 'a signer in upper case');
  await insertMessage(pool, { block_number: '5', block_hash: HASH('b'), block_time: '1794268800' });
  const { rows } = await pool.query<{ hash: string; ahead: boolean; grant_number: string | null }>('SELECT s.hash, s.ahead, s.grant_number FROM stops s ORDER BY s.hash');
  assert.deepEqual(rows, [
    { hash: HASH('51'), ahead: false, grant_number: null },
    { hash: HASH('52'), ahead: true, grant_number: '0' },
    { hash: HASH('53'), ahead: true, grant_number: '4294967295' },
  ]);
});

test("a stops table that holds the message on every row, as the schema before this one made it, is brought to this schema by applying it: the columns and every constraint read back from the catalog are those of a table this schema made by itself; applied again nothing changes, and the rule that a stop ahead is whole is the same constraint, not one dropped and added again", async () => {
  const fresh = await stopsShape(pool);
  assert.deepEqual(fresh.columns, [
    'account text not null',
    'ahead boolean not null',
    'grant_number bigint null',
    'hash text not null',
    'message_id bigint not null',
    'original jsonb null',
    'original_expiry numeric null',
    'received_at timestamp with time zone not null',
  ], 'the table this schema makes by itself');
  assert.ok(fresh.constraints.includes(`stops_ahead_whole c validated ${AHEAD_WHOLE}`), fresh.constraints.join(' | '));
  assert.ok(fresh.constraints.includes('stops_message_id_fkey f validated FOREIGN KEY (message_id) REFERENCES stop_messages(id)'), fresh.constraints.join(' | '));
  assert.ok(!fresh.constraints.some((c) => c.startsWith('stops_original_when_ahead')), 'the older rule is not on a table this schema made');

  const name = await db.createDatabase('stops_before');
  const before = openPool(db.urlFor(name), null);
  try {
    await before.query(STOPS_BEFORE);
    const older = await stopsShape(before);
    assert.ok(older.columns.includes('message jsonb not null') && older.columns.includes('signature text not null') && !older.columns.some((c) => c.startsWith('message_id') || c.startsWith('grant_number')), older.columns.join(' | '));
    assert.ok(older.constraints.some((c) => c.startsWith('stops_original_when_ahead c validated')), older.constraints.join(' | '));
    assert.deepEqual(await aheadWhole(before), [], 'the older table has no rule of the new name');

    // Applied over it: the same shape as the table this schema makes by itself, column for column and constraint for constraint.
    await applySchema(before);
    assert.deepEqual(await stopsShape(before), fresh, 'the older table, brought to this shape');
    const first = await aheadWhole(before);
    assert.deepEqual(first.map((c) => ({ validated: c.validated, definition: c.definition })), [{ validated: true, definition: AHEAD_WHOLE }]);
    // It keeps the rules: a stop ahead short of its grant number is refused, and a whole one is taken.
    const id = await insertMessage(before);
    await refused(insertStop(before, HASH('61'), { message_id: id, ahead: true, original: ORIGINAL, original_expiry: '1794268800' }), '23514', 'the converged table refuses a stop ahead without its grant number');
    await insertStop(before, HASH('62'), { message_id: id, ahead: true, original: ORIGINAL, original_expiry: '1794268800', grant_number: 2 });
    await insertStop(before, HASH('63'), { message_id: id });

    // Applied a second and a third time: the same shape, and the same constraint. Its oid is the catalog's identity
    // of the constraint, so one dropped and added again, which reads every row of the table, would show another.
    await applySchema(before);
    const second = await aheadWhole(before);
    await applySchema(before);
    const third = await aheadWhole(before);
    assert.deepEqual(await stopsShape(before), fresh);
    assert.deepEqual(second, first, 'the second apply left the constraint as the first made it');
    assert.deepEqual(third, second, 'and the third: nothing dropped, nothing added again');
    assert.equal((await before.query<{ n: number }>('SELECT count(*)::int AS n FROM stops')).rows[0]?.n, 2, 'the rows stand through the applies');
    // The table this schema made by itself is left alone by a further apply too.
    const own = await aheadWhole(pool);
    await applySchema(pool);
    assert.deepEqual(await aheadWhole(pool), own);
  } finally {
    await before.end();
  }
});

test('a constraint that stands under the name of the rule and is not the rule is not adopted: with another rule under the name, or the right rule not validated, applying the schema fails and changes nothing; with the name free it is added, and the schema applies', async () => {
  const made = await db.createWithSchema('stops_named');
  const named = openPool(made.url, null);
  try {
    const cases: Array<{ what: string; add: string; stands: string }> = [
      { what: 'another rule under the name', add: 'ALTER TABLE stops ADD CONSTRAINT stops_ahead_whole CHECK (ahead = (original IS NOT NULL))', stands: 'CHECK ((ahead = (original IS NOT NULL)))' },
      {
        what: 'the right rule, not validated',
        add: 'ALTER TABLE stops ADD CONSTRAINT stops_ahead_whole CHECK (ahead = (original IS NOT NULL) AND ahead = (original_expiry IS NOT NULL) AND ahead = (grant_number IS NOT NULL)) NOT VALID',
        stands: `${AHEAD_WHOLE} NOT VALID`,
      },
    ];
    for (const c of cases) {
      await named.query('ALTER TABLE stops DROP CONSTRAINT stops_ahead_whole');
      await named.query(c.add);
      const standing = await aheadWhole(named);
      assert.equal(standing[0]?.definition, c.stands, c.what);
      await assert.rejects(applyOnce(made.url), (err: unknown) => {
        assert.equal((err as { code?: string }).code, '42P16', `${c.what}: ${(err as Error).message}`);
        assert.match((err as Error).message, /stops_ahead_whole that is not the validated check this schema makes/, c.what);
        return true;
      });
      assert.deepEqual(await aheadWhole(named), standing, `${c.what}: left as it stood, the same constraint, neither adopted as the rule nor dropped`);
    }
    // The name free again: the rule is added, validated, and the schema applies.
    await named.query('ALTER TABLE stops DROP CONSTRAINT stops_ahead_whole');
    await applyOnce(made.url);
    assert.deepEqual((await aheadWhole(named)).map((c) => ({ validated: c.validated, definition: c.definition })), [{ validated: true, definition: AHEAD_WHOLE }]);
  } finally {
    await named.end();
  }
});

test('a stops table of the older shape that holds a row is not brought to this schema: applying it fails, since the row has no message to point at, and changes nothing; the row stands whole, with its message, and no message is made for it', async () => {
  const name = await db.createDatabase('stops_held');
  const url_ = db.urlFor(name);
  const held = openPool(url_, null);
  try {
    await held.query(STOPS_BEFORE);
    await held.query('INSERT INTO stops (hash, account, message, signature) VALUES ($1, $2, $3, $4)', [HASH('71'), ADDRESS('a'), JSON.stringify({ account: ADDRESS('a'), orderHashes: [HASH('71')] }), SIGNATURE('c')]);
    const whole = async () => (await held.query('SELECT s.xmin::text AS row_version, s.* FROM stops s')).rows;
    const rowBefore = await whole();
    const shapeBefore = await stopsShape(held);
    assert.equal(rowBefore.length, 1);
    await assert.rejects(applyOnce(url_), (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23502', (err as Error).message);
      assert.match((err as Error).message, /message_id/);
      return true;
    });
    assert.deepEqual(await whole(), rowBefore, 'the row as it was, its message and its signature with it, and its row version unchanged');
    assert.deepEqual(await stopsShape(held), shapeBefore, 'the table as it was: the columns that would have gone are there, the ones that would have come are not');
    const tables = (await held.query<{ table_name: string }>("SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema = current_schema() ORDER BY t.table_name")).rows.map((r) => r.table_name);
    assert.deepEqual(tables, ['stops'], 'nothing else of the schema stands either: no table of messages, and so no message made up for the row');
  } finally {
    await held.end();
  }
});

/** A table's columns and constraints, as the catalog states them: the shape two databases are compared by. */
async function tableShape(on: pg.Pool, table: string): Promise<{ columns: string[]; constraints: string[] }> {
  const columns = await on.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    'SELECT c.column_name, c.data_type, c.is_nullable, c.column_default FROM information_schema.columns c WHERE c.table_schema = current_schema() AND c.table_name = $1 ORDER BY c.column_name',
    [table],
  );
  const constraints = await on.query<{ conname: string; contype: string; convalidated: boolean; definition: string }>(
    'SELECT c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conrelid = $1::regclass ORDER BY c.conname',
    [table],
  );
  return {
    columns: columns.rows.map((r) => `${r.column_name} ${r.data_type} ${r.is_nullable === 'YES' ? 'null' : 'not null'}${r.column_default === null ? '' : ` default ${r.column_default}`}`),
    constraints: constraints.rows.map((r) => `${r.conname} ${r.contype} ${r.convalidated ? 'validated' : 'NOT VALIDATED'} ${r.definition}`),
  };
}

/** The three rules the lane's build adds, with the oid of the constraint that holds each: the catalog's identity, which a drop and an add again would change. */
async function laneRules(on: pg.Pool): Promise<Array<{ name: string; oid: string; validated: boolean; definition: string }>> {
  const { rows } = await on.query<{ name: string; oid: string; validated: boolean; definition: string }>(
    `SELECT c.conname AS name, c.oid::text AS oid, c.convalidated AS validated, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
     WHERE c.conname IN ('lanes_reserved_at_with_bet', 'crosses_not_sent_reasons', 'crosses_not_sent_with_reason') ORDER BY c.conname`,
  );
  return rows;
}

/** What the lane's build adds, taken away again: the lanes, crosses and events tables as the schema before it made them. */
const BEFORE_THE_LANE = `
  ALTER TABLE lanes DROP CONSTRAINT lanes_reserved_at_with_bet;
  ALTER TABLE lanes DROP COLUMN reserved_at;
  ALTER TABLE crosses DROP CONSTRAINT crosses_not_sent_reasons;
  ALTER TABLE crosses DROP CONSTRAINT crosses_not_sent_with_reason;
  ALTER TABLE crosses DROP COLUMN not_sent_reason;
  ALTER TABLE crosses DROP COLUMN checked;
  DROP INDEX events_bet_lines;
  DROP SEQUENCE lane_reservations;`;

test("lanes and crosses as the schema before the lane made them, and events without the bet's index, are named by the start's probe and brought to this schema by applying it: the columns, the constraints, the index and the sequence read back as a database this schema made by itself; applied again, each new rule is the same constraint; and the rules hold", async () => {
  const fresh = { lanes: await tableShape(pool, 'lanes'), crosses: await tableShape(pool, 'crosses') };
  assert.ok(fresh.lanes.constraints.includes('lanes_reserved_at_with_bet c validated CHECK (((held_bet IS NULL) = (reserved_at IS NULL)))'), fresh.lanes.constraints.join(' | '));
  assert.ok(fresh.crosses.constraints.includes("crosses_not_sent_reasons c validated CHECK ((not_sent_reason = 'SENDER_NOT_BUILT'::text))"), fresh.crosses.constraints.join(' | '));
  assert.ok(fresh.crosses.constraints.includes("crosses_not_sent_with_reason c validated CHECK (((state = 'not sent'::text) = (not_sent_reason IS NOT NULL)))"), fresh.crosses.constraints.join(' | '));
  const name = await db.createDatabase('lane_before');
  const older = openPool(db.urlFor(name), null);
  try {
    await applySchema(older);
    await older.query(BEFORE_THE_LANE);
    // The start's probe names what this build reads that the older tables lack.
    assert.deepEqual((await missingSchema(older)).sort(), ['crosses.checked', 'crosses.not_sent_reason', 'lanes.reserved_at']);
    await applySchema(older);
    assert.deepEqual(await missingSchema(older), []);
    assert.deepEqual({ lanes: await tableShape(older, 'lanes'), crosses: await tableShape(older, 'crosses') }, fresh, 'the older tables, brought to this shape');
    const index = await older.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'events_bet_lines'");
    assert.match(index.rows[0]?.indexdef ?? '', /\(bet_hash, number\) WHERE \(bet_hash IS NOT NULL\)$/);
    const seq = await older.query<{ n: string }>("SELECT nextval('lane_reservations')::text AS n");
    assert.equal(seq.rows[0]?.n, '1', 'the sequence is there, from 1');
    // Applied a second time: each rule is the constraint the first apply made, by its oid.
    const first = await laneRules(older);
    assert.equal(first.length, 3);
    await applySchema(older);
    assert.deepEqual(await laneRules(older), first, 'nothing dropped, nothing added again');
    // The rules hold on the converged tables.
    await insertOrder(HASH('b1'), 'take', { bet_state: 'held' }, older);
    await older.query(`INSERT INTO lanes (sender) VALUES ($1)`, [ADDRESS('c')]);
    await refused(older.query('UPDATE lanes SET held_bet = $1, reservation = 1 WHERE sender = $2', [HASH('b1'), ADDRESS('c')]), '23514', 'a lane that holds a bet holds its reservation\'s time');
    await older.query('UPDATE lanes SET held_bet = $1, reservation = 1, reserved_at = now() WHERE sender = $2', [HASH('b1'), ADDRESS('c')]);
    await refused(older.query('UPDATE lanes SET held_bet = NULL, reservation = NULL WHERE sender = $1', [ADDRESS('c')]), '23514', 'a lane freed is freed of its time too');
    const cross = (state: string, reason: string | null) =>
      older.query(
        `INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, state, not_sent_reason) VALUES ($1, $2, 1, 1, 1, $3, 1, $4, $5)`,
        [HASH('b1'), ADDRESS('c'), HASH('d'), state, reason],
      );
    await refused(cross('not sent', null), '23514', 'a Cross not sent has its reason');
    await refused(cross('intent', 'SENDER_NOT_BUILT'), '23514', 'only a Cross not sent has a reason');
    await refused(cross('not sent', 'THE_NODE_SAID_NO'), '23514', 'a reason this build does not have');
    await cross('not sent', 'SENDER_NOT_BUILT');
    const checked = await older.query<{ checked: unknown }>('SELECT checked FROM crosses WHERE bet_hash = $1', [HASH('b1')]);
    assert.deepEqual(checked.rows[0]?.checked, {}, 'the figures start empty');
  } finally {
    await older.end();
  }
});

test('the courier\'s own budget row and an account\'s both fit the accounts table, and nothing else does', async () => {
  await pool.query("INSERT INTO accounts (account, budget) VALUES ('courier', 2400)");
  await pool.query('INSERT INTO accounts (account, budget) VALUES ($1, 240)', [ADDRESS('a')]);
  await refused(pool.query("INSERT INTO accounts (account, budget) VALUES ('maker', 240)"), '23514', 'a name that is not an address');
});
