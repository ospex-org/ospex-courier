import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { applySchema, missingSchema, openPool, TABLES } from '../courier/records/store';
import { testServer } from './support/database';

// db/schema.sql against a real Postgres: applied twice, the ten tables, the
// indexes the plan names with their conditions, and the rules the tables keep
// by themselves, each proved by a row written by hand.

const db = testServer();
let pool: pg.Pool;
let url: string;

const hex = (n: number, seed: string) => seed.repeat(n).slice(0, n);
const HASH = (seed: string) => `0x${hex(64, seed)}`;
const ADDRESS = (seed: string) => `0x${hex(40, seed)}`;
const SIGNATURE = (seed: string) => `0x${hex(130, seed)}`;

async function insertOrder(hash: string, role: 'rest' | 'take', overrides: Record<string, unknown> = {}): Promise<void> {
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
    bet_state: role === 'take' ? 'waiting' : null,
    ...overrides,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO orders (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
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
  const open = def('crosses_one_open_per_lane');
  assert.match(open, /^CREATE UNIQUE INDEX/);
  assert.match(open, /\(lane\)/);
  assert.match(open, /WHERE \(state <> ALL/);
  assert.match(def('conditions_one_open_per_key'), /^CREATE UNIQUE INDEX .* \(key\) WHERE \(cleared_at IS NULL\)/);
  assert.match(def('events_report_lines'), /\(number\) WHERE \(kind = ANY/);
  assert.match(def('orders_bets_waiting'), /\(record_number\) WHERE \(\(role = 'take'::text\) AND \(bet_state = ANY \(ARRAY\['waiting'::text, 'held'::text\]\)\) AND \(ended IS NULL\)\)$/);
  assert.match(def('orders_record_number_key'), /UNIQUE INDEX .* \(record_number\)/);
  assert.match(def('crosses_tx_hash_key'), /UNIQUE INDEX .* \(tx_hash\)/);
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

test('the courier\'s own budget row and an account\'s both fit the accounts table, and nothing else does', async () => {
  await pool.query("INSERT INTO accounts (account, budget) VALUES ('courier', 2400)");
  await pool.query('INSERT INTO accounts (account, budget) VALUES ($1, 240)', [ADDRESS('a')]);
  await refused(pool.query("INSERT INTO accounts (account, budget) VALUES ('maker', 240)"), '23514', 'a name that is not an address');
});
