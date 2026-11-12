import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
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
  last: { tick: number; record: number } | null;
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
  const { rows } = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SCAN_SQL}`, params);
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
  report.markedHistory = Object.fromEntries(Object.entries(figures).map(([n, f]) => [n, { beforeVacuum: f.before.buffers, afterVacuum: f.after.buffers, deadPlanted: f.marks, vacuum: f.vacuumReport, indexLevel: f.level }]));
});

interface BacklogFigures {
  heldBehind: number;
  beforeVacuum: number;
  afterVacuum: number;
  deadAhead: number;
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

test('the growth: the bytes an order row and an event line take with their indexes, read from the database', async () => {
  const { pool, client } = await freshBook('cost_growth');
  try {
    await lay(client, 100_000, 200, T + 3_600n, 1);
    await client.query(`INSERT INTO runs DEFAULT VALUES`);
    await client.query(
      `INSERT INTO events (run, kind, order_hash, account, game_id, reason, facts)
       SELECT 1, 'order received', '0x' || lpad(to_hex(i), 64, '0'), $1, 1, NULL, '{"role":"rest","block":"1","recordNumber":1,"chainTime":"2000"}'::jsonb FROM generate_series(1, 100000) AS i`,
      [ACCOUNT],
    );
    await client.query('VACUUM ANALYZE orders');
    await client.query('VACUUM ANALYZE events');
    const { rows } = await client.query<{ table: string; bytes: string }>(`SELECT relname AS table, pg_total_relation_size(oid)::text AS bytes FROM pg_class WHERE relname IN ('orders', 'events')`);
    const bytes = Object.fromEntries(rows.map((r) => [r.table, Math.round(Number(r.bytes) / 100_000)]));
    assert.ok((bytes.orders ?? 0) > 0 && (bytes.events ?? 0) > 0);
    report.bytesPerRow = bytes;
  } finally {
    client.release();
    await pool.end();
  }
});
