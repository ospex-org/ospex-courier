import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { getAddress } from 'viem';
import { BOUNDS } from '../courier/http/limits';
import { SCAN_SQL, scanParams, type ScanArgs } from '../courier/records/orders';
import { openPool } from '../courier/records/store';
import { testServer } from './support/database';

// The physical-work contract, measured: the book's scan, the statement the
// courier runs, against three books, two of them at two sizes, each in two
// maintenance states. Every figure is read from that statement's own
// EXPLAIN (ANALYZE, BUFFERS), named by the node it comes from; none from a
// cumulative counter. The plan must be the named index's scan. The counts are
// exact in both states; the scan node's shared buffer accesses are the same at
// both sizes, within one page a level of the index, after vacuum only; before
// vacuum they are reported, beside the dead versions planted, and held to
// nothing.

const db = testServer();
const SIZES = [50_000, 500_000] as const;
const MARKET = '0x' + 'a1'.repeat(32);
const SCORER = '0x' + '0c'.repeat(20);
const ACCOUNT = '0x' + '0a'.repeat(20);
/** The chain's clock in these books: the latest block's time, and the final block's, as the request names them. */
const T = 2_000n;
const F_PAST = 2_000n;
const F_BEHIND = 500n;
/** The history's expiry: expired at T and at F_PAST, not at F_BEHIND. */
const EXPIRED_AT = 1_000n;

interface Measured {
  plan: string;
  indexName: string | null;
  innerRows: number;
  removedByFilter: number;
  passedFilter: number;
  marked: number;
  /** The scan node's shared buffer accesses: hit + read, non-distinct, index and table together. */
  buffers: number;
  /**
   * How the book index's cumulative counters moved across this statement: entries the index returned
   * (idx_tup_read) and live rows fetched by them (idx_tup_fetch). Read as a negative control only, never as the
   * figure: a dead entry the scan visits, once an earlier scan has marked it dead, is counted by neither.
   */
  counters: { read: number; fetch: number };
  last: { tick: number; record: number } | null;
}

/** The book index's cumulative counters, flushed first so this session's own statements are in them. */
async function indexCounters(client: pg.PoolClient): Promise<{ read: number; fetch: number }> {
  await client.query('SELECT pg_stat_force_next_flush()');
  const { rows } = await client.query<{ read: string; fetch: string }>(`SELECT idx_tup_read::text AS read, idx_tup_fetch::text AS fetch FROM pg_stat_user_indexes WHERE indexrelname = 'orders_book'`);
  return { read: Number(rows[0]?.read ?? 0), fetch: Number(rows[0]?.fetch ?? 0) };
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

/**
 * Runs the courier's own statement under EXPLAIN (ANALYZE, BUFFERS) and reads
 * the figures from its nodes. The statement runs: it marks. The inner scan is
 * the one node that reads the orders table; on the measured books it must be
 * the named index's scan, which the callers assert; on a table of ten rows
 * the planner reads the table whole, and the figures are the small book's.
 */
async function measure(client: pg.PoolClient, args: ScanArgs): Promise<Measured> {
  const params = scanParams(args);
  const countersBefore = await indexCounters(client);
  const { rows } = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SCAN_SQL}`, params);
  const countersAfter = await indexCounters(client);
  const counters = { read: countersAfter.read - countersBefore.read, fetch: countersAfter.fetch - countersBefore.fetch };
  const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
  assert.ok(root, 'a plan');
  const nodes = [...walk(root)];
  const scan = nodes.find((n) => (n['Node Type'] === 'Index Scan' || n['Node Type'] === 'Seq Scan') && n['Relation Name'] === 'orders' && n['Parent Relationship'] !== 'Inner');
  assert.ok(scan, `the inner scan reads orders; nodes: ${nodes.map((n) => `${n['Node Type']}${n['Index Name'] ? ` ${n['Index Name']}` : ''}`).join(', ')}`);
  const liveFilter = nodes.find((n) => n['Node Type'] === 'CTE Scan' && typeof n.Filter === 'string' && /expiry\s*>/.test(n.Filter as string));
  assert.ok(liveFilter, 'the outer filter on the expiry');
  const update = nodes.find((n) => n['Node Type'] === 'ModifyTable');
  assert.ok(update, 'the update');
  return {
    plan: String(scan['Node Type']),
    indexName: (scan['Index Name'] as string | undefined) ?? null,
    innerRows: Number(scan['Actual Rows']),
    removedByFilter: Number(liveFilter['Rows Removed by Filter'] ?? 0),
    passedFilter: Number(liveFilter['Actual Rows']),
    marked: Number(update['Actual Rows']),
    buffers: Number(scan['Shared Hit Blocks'] ?? 0) + Number(scan['Shared Read Blocks'] ?? 0),
    counters,
    last: null,
  };
}

/** The plan is the named index's scan: asserted on each measurement, before anything else is read of the index. */
function plan(m: Measured, what: string): void {
  assert.equal(m.indexName, 'orders_book', `${what}: the plan is the named index's scan, not ${m.plan}`);
}

/** Runs the statement plain, for its own summary: what it scanned, marked and where it ended. */
async function run(client: pg.PoolClient, args: ScanArgs): Promise<{ scanned: number; marked: number; live: number; lastTick: number | null; lastRecord: string | null }> {
  const { rows } = await client.query<{ scanned: number; marked: number; live: number; last_tick: number | null; last_record: string | null }>(SCAN_SQL, scanParams(args));
  const r = rows[0];
  assert.ok(r);
  return { scanned: r.scanned, marked: r.marked, live: r.live, lastTick: r.last_tick, lastRecord: r.last_record };
}

/** Lays rows: live quotes or history, in record order, so that what a scan returns sits on the same pages at both sizes. */
async function lay(client: pg.PoolClient, n: number, tick: number, expiry: bigint, from: number): Promise<void> {
  await client.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT '0x' || lpad(to_hex(i), 64, '0'), 'rest', $1, 1, $2, 0, 0, $3, 1000000, i, $4, 0, '0x' || repeat('ab', 65), $5, 0, 1, '0x' || repeat('cd', 32), 1
     FROM generate_series($6::bigint, $7::bigint) AS i`,
    [ACCOUNT, SCORER, tick, expiry.toString(), MARKET, from, from + n - 1],
  );
}

interface VacuumReport {
  /** Dead versions still whole on their pages, removed by this vacuum. */
  tuplesRemoved: number;
  /** Dead versions already pruned to a dead item identifier by an earlier access of the page (an update or a scan), whose identifiers and index entries this vacuum removed. */
  deadItemsRemoved: number;
  /** The two together: every dead version the vacuum cleared. */
  removed: number;
  remain: number;
  notYetRemovable: number;
  /** The book's index, as the report describes it. */
  bookIndex: string | null;
}

/**
 * VACUUM (VERBOSE, INDEX_CLEANUP ON) of the table, with no other transaction
 * open, and its own report read from its notices. A dead version is cleared in
 * one of two ways and the report counts them apart: a version still whole on
 * its page is a tuple removed; one an earlier access of the page already pruned
 * to a dead item identifier is counted among the dead item identifiers removed,
 * and its entries leave the indexes here. INDEX_CLEANUP ON, because a vacuum
 * left to itself skips the indexes when the dead items are under two per cent
 * of the table's pages, and leaves their entries standing; the table's own
 * setting in db/schema.sql (vacuum_index_cleanup = on) makes autovacuum do
 * the same as this.
 */
async function vacuum(client: pg.PoolClient): Promise<VacuumReport> {
  const notices: string[] = [];
  client.on('notice', (msg) => {
    notices.push(msg.message ?? '');
  });
  try {
    await client.query('VACUUM (VERBOSE, INDEX_CLEANUP ON) orders');
  } finally {
    client.removeAllListeners('notice');
  }
  const text = notices.join('\n');
  const tuples = /tuples: (\d+) removed, (\d+) remain, (\d+) are dead but not yet removable/.exec(text);
  assert.ok(tuples, `the vacuum's report names the tuples removed; got: ${text.slice(0, 800)}`);
  const items = /had (\d+) dead item identifiers removed/.exec(text);
  const bookIndex = /index "orders_book": ([^\n]+)/.exec(text);
  const tuplesRemoved = Number(tuples[1]);
  const deadItemsRemoved = items === null ? 0 : Number(items[1]);
  return { tuplesRemoved, deadItemsRemoved, removed: tuplesRemoved + deadItemsRemoved, remain: Number(tuples[2]), notYetRemovable: Number(tuples[3]), bookIndex: bookIndex?.[1] ?? null };
}

async function treeLevel(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ tree_level: number }>(`SELECT tree_level FROM pgstatindex('orders_book')`);
  return Number(rows[0]?.tree_level ?? 0);
}

async function freshBook(prefix: string): Promise<{ pool: pg.Pool; client: pg.PoolClient }> {
  const { url } = await db.createWithSchema(prefix);
  const pool = openPool(url, null);
  const client = await pool.connect();
  // Autovacuum off for the fixture: the two maintenance states are made here, by hand, and measured as made.
  await client.query('ALTER TABLE orders SET (autovacuum_enabled = false)');
  await client.query('CREATE EXTENSION IF NOT EXISTS pgstattuple');
  return { pool, client };
}

const report: Record<string, unknown> = {};

before(() => undefined);
after(async () => {
  console.log(`# cost: ${JSON.stringify(report)}`);
  await db.end();
});

const args = (page: number, finalTime: bigint, after: ScanArgs['after'] = null): ScanArgs => ({ marketKey: MARKET as `0x${string}`, side: 0, after, blockTime: T, finalTime, page });

test('the small book: ten live quotes; every row returned is live, nothing marked', async () => {
  const { pool, client } = await freshBook('cost_small');
  try {
    await lay(client, 10, 200, T + 3_600n, 1);
    await client.query('ANALYZE orders');
    const m = await measure(client, args(50, F_PAST));
    assert.deepEqual({ inner: m.innerRows, removed: m.removedByFilter, passed: m.passedFilter, marked: m.marked }, { inner: 10, removed: 0, passed: 10, marked: 0 });
    report.small = { plan: m.plan, buffers: m.buffers };
  } finally {
    client.release();
    await pool.end();
  }
});

test('the book with 50,000 and with 500,000 orders ended by the mark: the counts exact in both states; the scan node\'s shared buffer accesses the same at both sizes after vacuum, within one page a level of the index; before vacuum, reported beside the dead versions planted', async () => {
  const figures: Record<number, { before: Measured; after: Measured; vacuumReport: VacuumReport; level: number; marks: number }> = {};
  for (const n of SIZES) {
    const { pool, client } = await freshBook(`cost_marked_${n}`);
    try {
      // The live quotes first, so they are the same rows on the same pages at both sizes; then the history at a
      // better price, expired, which the courier's own statement marks, 2,000 a request, planting real dead
      // versions in the table and the index.
      await lay(client, 10, 200, T + 3_600n, 1);
      await lay(client, n, 150, EXPIRED_AT, 100);
      await client.query('ANALYZE orders');
      let marks = 0;
      for (;;) {
        const r = await run(client, args(0, F_PAST));
        marks += r.marked;
        if (r.marked === 0) break;
      }
      assert.equal(marks, n, 'the whole history was marked, by the statement');
      const before = await measure(client, args(50, F_PAST));
      plan(before, `${n} before vacuum`);
      const vacuumReport = await vacuum(client);
      const level = await treeLevel(client);
      const after_ = await measure(client, args(50, F_PAST));
      plan(after_, `${n} after vacuum`);
      figures[n] = { before, after: after_, vacuumReport, level, marks };
      for (const [state, m] of [['before', before], ['after', after_]] as Array<[string, Measured]>) {
        assert.deepEqual({ inner: m.innerRows, removed: m.removedByFilter, passed: m.passedFilter, marked: m.marked }, { inner: 10, removed: 0, passed: 10, marked: 0 }, `${n} ${state}: the counts`);
      }
      assert.ok(vacuumReport.removed >= n, `the vacuum cleared the planted versions, whole or already pruned: ${JSON.stringify(vacuumReport)}`);
      assert.equal(vacuumReport.notYetRemovable, 0, 'none dead but not yet removable');
      // The two negative controls, asserted on the evidence itself. The dead cost is seen: the measurement before
      // vacuum reads more buffers than the one after; a run after vacuum alone would show no difference. And the
      // index's cumulative counters are not the figure: they move by the same amounts across the two measurements
      // (the ten entries returned, the ten rows fetched) while the buffers differ by the dead planted, because a
      // dead entry the scan visits, once an earlier scan has marked it dead, is counted by neither counter. Neither
      // assertion is an equality or a ceiling on the before-vacuum figure.
      assert.ok(before.buffers > after_.buffers, `${n}: the dead versions planted are seen before vacuum (${before.buffers}) and gone after (${after_.buffers})`);
      assert.deepEqual(before.counters, after_.counters, `${n}: the cumulative counters moved the same before vacuum (${JSON.stringify(before.counters)}) and after (${JSON.stringify(after_.counters)}), seeing none of the ${n} dead entries the scan visited`);
    } finally {
      client.release();
      await pool.end();
    }
  }
  const small = figures[SIZES[0]] as (typeof figures)[number];
  const large = figures[SIZES[1]] as (typeof figures)[number];
  const tolerance = Math.max(small.level, large.level) + 1;
  assert.ok(
    Math.abs(large.after.buffers - small.after.buffers) <= tolerance,
    `after vacuum, the scan's buffer accesses at ${SIZES[1]} (${large.after.buffers}) and at ${SIZES[0]} (${small.after.buffers}) differ by more than ${tolerance} pages`,
  );
  assert.ok(large.before.buffers > small.before.buffers, `before vacuum the dead cost grows with the dead planted: ${large.before.buffers} at ${SIZES[1]}, ${small.before.buffers} at ${SIZES[0]}`);
  report.markedHistory = Object.fromEntries(Object.entries(figures).map(([n, f]) => [n, { beforeVacuum: f.before.buffers, afterVacuum: f.after.buffers, countersBeforeVacuum: f.before.counters, countersAfterVacuum: f.after.counters, deadPlanted: f.marks, vacuum: f.vacuumReport, indexLevel: f.level }]));
});

interface BacklogFigures {
  heldBehind: number;
  beforeVacuum: number;
  afterVacuum: number;
  deadAhead: number;
  /** The cumulative counters' movement across each measurement, reported beside the buffers and held to nothing: on this book the 2,000 dead ahead, not yet marked dead in the index by any scan, are returned by the index once and counted that once. */
  counters: Record<'heldBehind' | 'beforeVacuum' | 'afterVacuum', { read: number; fetch: number }>;
  vacuum: VacuumReport;
  indexLevel: number;
}

test('the book with 50,000 and with 500,000 expired quotes not yet marked, at better prices than one live quote: one request is returned the bound and no more, marks what it was returned where the final block has passed it, and the next request is not returned those again; held behind, it marks none and is returned the same rows', async () => {
  const figures: Record<number, BacklogFigures> = {};
  for (const n of SIZES) {
    const { pool, client } = await freshBook(`cost_backlog_${n}`);
    try {
      // The first 4,000 of the history first, in index order, so the rows two requests return sit on the same
      // pages at both sizes; then the live quote; then the rest.
      await lay(client, 4_000, 150, EXPIRED_AT, 1);
      await lay(client, 1, 200, T + 3_600n, 5_000);
      if (n > 4_000) await lay(client, n - 4_000, 150, EXPIRED_AT, 10_000);
      await client.query('ANALYZE orders');

      // Held behind: nothing marked, the same rows twice, the bound each time.
      const held1 = await run(client, args(50, F_BEHIND));
      const held2 = await run(client, args(50, F_BEHIND));
      assert.deepEqual({ scanned: held1.scanned, marked: held1.marked, live: held1.live }, { scanned: BOUNDS.scanRows, marked: 0, live: 0 }, `${n}: held behind`);
      assert.deepEqual(held2, held1, `${n}: the same rows again`);
      const heldMeasured = await measure(client, args(50, F_BEHIND));
      plan(heldMeasured, `${n} held behind`);
      assert.deepEqual({ inner: heldMeasured.innerRows, removed: heldMeasured.removedByFilter, passed: heldMeasured.passedFilter, marked: heldMeasured.marked }, { inner: BOUNDS.scanRows, removed: BOUNDS.scanRows, passed: 0, marked: 0 });

      // Past: the first request marks what it was returned; the second is returned the next 2,000, visiting the
      // 2,000 dead ahead of them: the before-vacuum state.
      const first = await run(client, args(50, F_PAST));
      assert.deepEqual({ scanned: first.scanned, marked: first.marked, live: first.live }, { scanned: BOUNDS.scanRows, marked: BOUNDS.scanRows, live: 0 }, `${n}: marks what it was returned`);
      const before = await measure(client, args(50, F_PAST));
      plan(before, `${n} before vacuum`);
      assert.deepEqual({ inner: before.innerRows, removed: before.removedByFilter, passed: before.passedFilter, marked: before.marked }, { inner: BOUNDS.scanRows, removed: BOUNDS.scanRows, passed: 0, marked: BOUNDS.scanRows }, `${n}: the second request`);
      const vacuumReport = await vacuum(client);
      // Two requests marked 2,000 each: the first batch, pruned on the pages the second request's scan read, is
      // among the dead item identifiers; the second is whole. Together they are what was planted.
      assert.ok(vacuumReport.removed >= 2 * BOUNDS.scanRows, JSON.stringify(vacuumReport));
      assert.equal(vacuumReport.notYetRemovable, 0);
      const level = await treeLevel(client);
      // After vacuum: the next 2,000, with no dead ahead of them.
      const after_ = await measure(client, args(50, F_PAST));
      plan(after_, `${n} after vacuum`);
      assert.deepEqual({ inner: after_.innerRows, removed: after_.removedByFilter, passed: after_.passedFilter, marked: after_.marked }, { inner: BOUNDS.scanRows, removed: BOUNDS.scanRows, passed: 0, marked: BOUNDS.scanRows }, `${n}: after vacuum`);
      // The dead cost is seen: the 2,000 dead ahead cost the before-vacuum measurement more than the held-behind
      // one, with none dead yet, and more than the one after vacuum; a run after vacuum alone would show neither.
      // No equality or ceiling is put on the before-vacuum figure.
      assert.ok(before.buffers > heldMeasured.buffers, `${n}: the 2,000 dead ahead are seen (${before.buffers}) against none yet (${heldMeasured.buffers})`);
      assert.ok(before.buffers > after_.buffers, `${n}: the 2,000 dead ahead are seen (${before.buffers}) and gone after vacuum (${after_.buffers})`);
      figures[n] = { heldBehind: heldMeasured.buffers, beforeVacuum: before.buffers, afterVacuum: after_.buffers, deadAhead: BOUNDS.scanRows, counters: { heldBehind: heldMeasured.counters, beforeVacuum: before.counters, afterVacuum: after_.counters }, vacuum: vacuumReport, indexLevel: level };
    } finally {
      client.release();
      await pool.end();
    }
  }
  const small = figures[SIZES[0]] as BacklogFigures;
  const large = figures[SIZES[1]] as BacklogFigures;
  const tolerance = Math.max(small.indexLevel, large.indexLevel) + 1;
  assert.ok(Math.abs(large.afterVacuum - small.afterVacuum) <= tolerance, `after vacuum: ${large.afterVacuum} at ${SIZES[1]} and ${small.afterVacuum} at ${SIZES[0]}, tolerance ${tolerance}`);
  assert.ok(Math.abs(large.heldBehind - small.heldBehind) <= tolerance, `held behind, no dead yet: ${large.heldBehind} and ${small.heldBehind}`);
  report.backlog = figures;
});

/**
 * The fixture rows of the three shapes the orders build does not yet write, in the frozen schema's shape, so that
 * the bytes they take can be measured now; the figures are to be read again from real rows once the stop build
 * and the sender build write them. How many of each are laid: enough rows that a table's size is many pages.
 */
const FIXTURE = {
  /** Stops of 100 carried hashes: 100 rows each, every row carrying the message as received, 100 hashes, and its signature. */
  stopsOf100: 20,
  /** Stops ahead of 16 originals: 16 rows each, with the signed original and its expiry beside the message. */
  stopsAheadOf16: 100,
  /** Crosses confirmed with 40 legs each, and their bets. */
  crosses: 1_000,
  /** Lines of each kind laid to measure a line's bytes. */
  lines: 3_000,
} as const;
const SIGNATURE = '0x' + 'ab'.repeat(65);
const SENDER = '0x' + '0b'.repeat(20);
const hashes = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => `0x${(from + i).toString(16).padStart(64, '0')}`);

async function totalSize(client: pg.PoolClient, table: string): Promise<number> {
  await client.query(`VACUUM ANALYZE ${table}`);
  const { rows } = await client.query<{ bytes: string }>(`SELECT pg_total_relation_size($1::regclass)::text AS bytes`, [table]);
  return Number(rows[0]?.bytes);
}

test('the growth: the bytes an order row and an event line take with their indexes, read from the database; and, from fixture rows of the frozen schema\'s shape, a stop of 100 carried hashes, a stop ahead of 16 originals and a 40-leg Cross', async () => {
  const { pool, client } = await freshBook('cost_growth');
  try {
    await lay(client, 100_000, 200, T + 3_600n, 1);
    await client.query(`INSERT INTO runs DEFAULT VALUES`);
    await client.query(
      `INSERT INTO events (run, kind, order_hash, account, game_id, reason, facts)
       SELECT 1, 'order received', '0x' || lpad(to_hex(i), 64, '0'), $1, 1, NULL, '{"role":"rest","block":"1","recordNumber":1,"chainTime":"2000"}'::jsonb FROM generate_series(1, 100000) AS i`,
      [ACCOUNT],
    );
    const ordersBytes = await totalSize(client, 'orders');
    const eventsBytes = await totalSize(client, 'events');
    const bytes = { orders: Math.round(ordersBytes / 100_000), events: Math.round(eventsBytes / 100_000) };
    assert.ok(bytes.orders > 0 && bytes.events > 0);
    report.bytesPerRow = bytes;

    // Stops of 100 carried hashes: a row for each hash stopped, each carrying the whole message and its signature.
    const account = getAddress(ACCOUNT);
    for (let s = 0; s < FIXTURE.stopsOf100; s++) {
      const stopped = hashes(1 + s * 100, 100);
      await client.query(
        `INSERT INTO stops (hash, account, message, signature) SELECT h, $1, $2::jsonb, $3 FROM unnest($4::text[]) AS h`,
        [ACCOUNT, JSON.stringify({ account, orderHashes: stopped }), SIGNATURE, stopped],
      );
    }
    const carriedRows = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM stops WHERE NOT ahead`)).rows[0]?.n);
    assert.equal(carriedRows, FIXTURE.stopsOf100 * 100, 'the rows of the carried stops');
    const short = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM stops WHERE NOT ahead AND jsonb_array_length(message -> 'orderHashes') <> 100`)).rows[0]?.n);
    assert.equal(short, 0, 'every row of a carried stop carries the message of 100 hashes');
    const stopsCarriedBytes = await totalSize(client, 'stops');

    // Stops ahead of 16 originals: a row for each, the signed original and its expiry beside the message.
    for (let s = 0; s < FIXTURE.stopsAheadOf16; s++) {
      const ahead = hashes(10_000_000 + s * 16, 16);
      const original = {
        order: { account, gameId: '1', scorer: getAddress(SCORER), lineTicks: 0, positionType: 0, oddsTick: 200, riskAmount: '1000000', nonce: String(5_000_000 + s), expiry: String(T + 3_600n), minFill: '0' },
        signature: SIGNATURE,
      };
      await client.query(
        `INSERT INTO stops (hash, account, message, signature, ahead, original, original_expiry) SELECT h, $1, $2::jsonb, $3, true, $5::jsonb, $6 FROM unnest($4::text[]) AS h`,
        [ACCOUNT, JSON.stringify({ account, orderHashes: ahead }), SIGNATURE, ahead, JSON.stringify(original), (T + 3_600n).toString()],
      );
    }
    const aheadRows = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM stops WHERE ahead AND original IS NOT NULL`)).rows[0]?.n);
    assert.equal(aheadRows, FIXTURE.stopsAheadOf16 * 16, 'the rows of the stops ahead, each with its original');
    const stopsAheadBytes = (await totalSize(client, 'stops')) - stopsCarriedBytes;

    // Crosses: a bet each, confirmed, with 40 legs recorded against the quotes laid above.
    await client.query(
      `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time, bet_state)
       SELECT '0x' || lpad(to_hex(20000000 + i), 64, '0'), 'take', $1, 1, $2, 0, 1, 200, 4000000, 7000000 + i, $3, 0, $4, $5, 1, 1, '0x' || repeat('cd', 32), 1, 'sent'
       FROM generate_series(1, ${FIXTURE.crosses}) AS i`,
      [ACCOUNT, SCORER, (T + 30n).toString(), SIGNATURE, MARKET],
    );
    await client.query(`INSERT INTO lanes (sender, epoch, owner_run) VALUES ($1, 1, 1)`, [SENDER]);
    await client.query(
      `INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, sender, nonce, gas_limit, max_fee_per_gas, max_priority_fee,
         tx_hash, state, hand_offs, node_answer, receipt_block_number, receipt_block_hash, final_block_number, final_block_hash)
       SELECT '0x' || lpad(to_hex(20000000 + i), 64, '0'), $1, 1, i, 1000 + i, '0x' || lpad(to_hex(30000000 + i), 64, '0'), 2000 + i, $1, i, 900000, 60000000000, 30000000000,
         '0x' || lpad(to_hex(40000000 + i), 64, '0'), 'confirmed', 1, jsonb_build_object('result', '0x' || lpad(to_hex(40000000 + i), 64, '0')),
         1001 + i, '0x' || lpad(to_hex(50000000 + i), 64, '0'), 1005 + i, '0x' || lpad(to_hex(60000000 + i), 64, '0')
       FROM generate_series(1, ${FIXTURE.crosses}) AS i`,
      [SENDER],
    );
    await client.query(
      `INSERT INTO legs (bet_hash, position, order_hash, expected_maker_risk, expected_taker_risk, recorded_maker_risk, recorded_taker_risk)
       SELECT '0x' || lpad(to_hex(20000000 + i), 64, '0'), p, '0x' || lpad(to_hex(((i * 40 + p) % 100000) + 1), 64, '0'), 100000, 104000, 100000, 104000
       FROM generate_series(1, ${FIXTURE.crosses}) AS i, generate_series(0, 39) AS p`,
    );
    const crossRows = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM crosses WHERE state = 'confirmed' AND tx_hash IS NOT NULL`)).rows[0]?.n);
    assert.equal(crossRows, FIXTURE.crosses, 'the Crosses, each confirmed with its transaction');
    const legsPerCross = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM (SELECT bet_hash FROM legs GROUP BY bet_hash HAVING count(*) = 40) AS whole`);
    assert.equal(Number(legsPerCross.rows[0]?.n), FIXTURE.crosses, 'every Cross has its 40 legs');
    const crossesBytes = await totalSize(client, 'crosses');
    const legsBytes = await totalSize(client, 'legs');

    // The lines: a stop's one line, and a Cross's three (sent, pending, confirmed), each laid in a batch of its own.
    const eventsBefore = await totalSize(client, 'events');
    await client.query(
      `INSERT INTO events (run, kind, account, facts)
       SELECT 1, 'stop received', $1, jsonb_build_object('hashes', 100, 'ahead', false, 'block', (1000 + i)::text) FROM generate_series(1, ${FIXTURE.lines}) AS i`,
      [ACCOUNT],
    );
    const eventsWithStopLines = await totalSize(client, 'events');
    await client.query(
      `INSERT INTO events (run, kind, bet_hash, account, game_id, facts)
       SELECT 1, (ARRAY['cross sent', 'cross pending', 'cross confirmed'])[(i % 3) + 1], '0x' || lpad(to_hex(20000000 + (i / 3) + 1), 64, '0'), $1, 1,
         jsonb_build_object('txHash', '0x' || lpad(to_hex(40000000 + i), 64, '0'), 'block', (1000 + i)::text, 'legs', 40)
       FROM generate_series(0, ${FIXTURE.lines - 1}) AS i`,
      [ACCOUNT],
    );
    const eventsWithCrossLines = await totalSize(client, 'events');
    const stopLine = Math.round((eventsWithStopLines - eventsBefore) / FIXTURE.lines);
    const crossLine = Math.round((eventsWithCrossLines - eventsWithStopLines) / FIXTURE.lines);
    const stopOf100 = { rows: 100, bytesRows: Math.round(stopsCarriedBytes / FIXTURE.stopsOf100), lines: 1, bytesLine: stopLine };
    const stopAheadOf16 = { rows: 16, bytesRows: Math.round(stopsAheadBytes / FIXTURE.stopsAheadOf16), lines: 1, bytesLine: stopLine };
    const cross40 = { crossRow: Math.round(crossesBytes / FIXTURE.crosses), legs: 40, bytesLegs: Math.round((legsBytes / FIXTURE.crosses)), lines: 3, bytesLines: 3 * crossLine };
    report.fixtureShapes = {
      stopOf100Hashes: { ...stopOf100, bytes: stopOf100.bytesRows + stopOf100.bytesLine },
      stopAheadOf16Originals: { ...stopAheadOf16, bytes: stopAheadOf16.bytesRows + stopAheadOf16.bytesLine },
      cross40Legs: { ...cross40, bytes: cross40.crossRow + cross40.bytesLegs + cross40.bytesLines, note: 'the bet\'s own row and line are the order\'s figures above' },
    };
    assert.ok(stopOf100.bytesRows > 0 && stopAheadOf16.bytesRows > 0 && cross40.crossRow > 0 && cross40.bytesLegs > 0 && stopLine > 0 && crossLine > 0);
  } finally {
    client.release();
    await pool.end();
  }
});
