import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { getAddress } from 'viem';
import { BOUNDS } from '../courier/http/limits';
import { CANDIDATES_SQL, candidatesParams, SCAN_SQL, scanParams, type ScanArgs } from '../courier/records/orders';
import { openPool } from '../courier/records/store';
import { testServer } from './support/database';

// The bet's candidate statement, measured: the courier's own text against two
// of the cost file's books (tests/cost.test.ts), each at two sizes, each figure
// read from that statement's own EXPLAIN (ANALYZE, BUFFERS) and named by the
// node it comes from. A file of its own, so that neither file runs near the
// test's time-out on a busy machine; the books, the sizes and the figures are
// the cost file's.

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
const SENDER = '0x' + '0b'.repeat(20);

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
 * VACUUM (VERBOSE, INDEX_CLEANUP ON) of the table, with no other transaction open, and its own report read from its
 * notices, as the cost file runs it.
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

after(async () => {
  console.log(`# cost: ${JSON.stringify(report)}`);
  await db.end();
});

const args = (page: number, finalTime: bigint, after: ScanArgs['after'] = null): ScanArgs => ({ marketKey: MARKET as `0x${string}`, side: 0, after, blockTime: T, finalTime, page });

/**
 * Scans the book from its start, as a page does, until a scan's own counters see none of the dead entries it
 * passes: each has been marked dead by an earlier scan. Failed by name when that is not reached in two minutes.
 */
async function markedDead(client: pg.PoolClient, n: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const countersBefore = await indexCounters(client);
    const r = await run(client, args(0, F_PAST));
    const countersAfter = await indexCounters(client);
    assert.equal(r.marked, 0, `${n}: nothing is left to mark`);
    const dead = countersAfter.read - countersBefore.read - r.scanned;
    if (dead <= 0) return;
    if (Date.now() - started > 120_000) {
      assert.fail(`${n}: ${dead} dead entries are still not marked dead after two minutes of scans: a transaction somewhere on the server is older than the marks that ended them`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ──────────────────────────── the bet's candidate statement ────────────────────────────

interface CandidateMeasured {
  indexName: string | null;
  /** Rows the book index's scan node returned. */
  innerRows: number;
  /** That node's shared buffer accesses: hit + read, index and table together. */
  buffers: number;
  /** Rows the statement marked expired. */
  marked: number;
  /** What the statement itself answered: rows scanned, the live rows of others it would hand the walk. */
  scanned: number;
  others: number;
}

/**
 * The bet's candidate statement, the courier's own text, under EXPLAIN (ANALYZE, BUFFERS): the book index's scan
 * node's rows and buffers, and the update's rows. It runs, and marks. Then the same statement plain, for its answer.
 */
async function measureCandidates(client: pg.PoolClient, finalTime: bigint): Promise<CandidateMeasured> {
  const params = candidatesParams({ marketKey: MARKET as `0x${string}`, side: 0, betTick: 200, bettor: getAddress(SENDER), blockTime: T, finalTime });
  const { rows } = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${CANDIDATES_SQL}`, params);
  const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
  assert.ok(root, 'a plan');
  const nodes = [...walk(root)];
  const scan = nodes.find((n) => n['Relation Name'] === 'orders' && (n['Node Type'] === 'Index Scan' || n['Node Type'] === 'Seq Scan' || n['Node Type'] === 'Bitmap Heap Scan') && (n['Index Name'] === 'orders_book' || n['Node Type'] === 'Seq Scan'));
  assert.ok(scan, `the scan of the book; nodes: ${nodes.map((n) => `${n['Node Type']}${n['Index Name'] ? ` ${n['Index Name']}` : ''}`).join(', ')}`);
  const update = nodes.find((n) => n['Node Type'] === 'ModifyTable');
  return {
    indexName: (scan['Index Name'] as string | undefined) ?? null,
    innerRows: Number(scan['Actual Rows']),
    buffers: Number(scan['Shared Hit Blocks'] ?? 0) + Number(scan['Shared Read Blocks'] ?? 0),
    marked: Number(update?.['Actual Rows'] ?? 0),
    scanned: -1,
    others: -1,
  };
}

/** The statement plain: its own answer. */
async function candidatesRun(client: pg.PoolClient, finalTime: bigint): Promise<{ scanned: number; marked: number; own: number; others: number; rows: number }> {
  const params = candidatesParams({ marketKey: MARKET as `0x${string}`, side: 0, betTick: 200, bettor: getAddress(SENDER), blockTime: T, finalTime });
  const { rows } = await client.query<{ scanned: number; marked: number; own: number; others: number; rows: unknown[] }>(CANDIDATES_SQL, params);
  const r = rows[0];
  assert.ok(r);
  return { scanned: r.scanned, marked: r.marked, own: r.own, others: r.others, rows: r.rows.length };
}

test("the bet's candidate statement, measured on the two books at 50,000 and 500,000: on the book of orders ended by the mark, it reads the ten live quotes and no more, the same buffers at both sizes after vacuum; on the backlog not yet marked, it is returned the bound and no more, marks none with the final block behind and the bound with it past, the same buffers at both sizes for each", async () => {
  const marked: Record<number, { before: CandidateMeasured; after: CandidateMeasured; level: number }> = {};
  const backlog: Record<number, { heldBehind: CandidateMeasured; past: CandidateMeasured; level: number }> = {};
  for (const n of SIZES) {
    {
      const { pool, client } = await freshBook(`cost_candidates_marked_${n}`);
      try {
        await lay(client, 10, 200, T + 3_600n, 1);
        await lay(client, n, 150, EXPIRED_AT, 100);
        await client.query('ANALYZE orders');
        for (;;) if ((await run(client, args(0, F_PAST))).marked === 0) break;
        await markedDead(client, n);
        const before = await measureCandidates(client, F_PAST);
        await vacuum(client);
        const level = await treeLevel(client);
        const after_ = await measureCandidates(client, F_PAST);
        const answer = await candidatesRun(client, F_PAST);
        for (const [state, m] of [['before', before], ['after', after_]] as Array<[string, CandidateMeasured]>) {
          assert.deepEqual({ index: m.indexName, inner: m.innerRows, marked: m.marked }, { index: 'orders_book', inner: 10, marked: 0 }, `${n} ${state} vacuum`);
        }
        assert.deepEqual(answer, { scanned: 10, marked: 0, own: 0, others: 10, rows: 10 }, `${n}: the statement's own answer`);
        assert.ok(before.buffers > after_.buffers, `${n}: the dead versions are seen before vacuum (${before.buffers}) and gone after (${after_.buffers})`);
        marked[n] = { before, after: after_, level };
      } finally {
        client.release();
        await pool.end();
      }
    }
    {
      const { pool, client } = await freshBook(`cost_candidates_backlog_${n}`);
      try {
        await lay(client, 4_000, 150, EXPIRED_AT, 1);
        await lay(client, 1, 200, T + 3_600n, 5_000);
        if (n > 4_000) await lay(client, n - 4_000, 150, EXPIRED_AT, 10_000);
        await client.query('ANALYZE orders');
        const heldBehind = await measureCandidates(client, F_BEHIND);
        assert.deepEqual({ index: heldBehind.indexName, inner: heldBehind.innerRows, marked: heldBehind.marked }, { index: 'orders_book', inner: BOUNDS.scanRows, marked: 0 }, `${n}: held behind`);
        const past = await measureCandidates(client, F_PAST);
        assert.deepEqual({ index: past.indexName, inner: past.innerRows, marked: past.marked }, { index: 'orders_book', inner: BOUNDS.scanRows, marked: BOUNDS.scanRows }, `${n}: past`);
        const level = await treeLevel(client);
        backlog[n] = { heldBehind, past, level };
      } finally {
        client.release();
        await pool.end();
      }
    }
  }
  const [s, l] = [SIZES[0], SIZES[1]];
  const tolerance = (a: number, b: number) => Math.max(a, b) + 1;
  const m0 = marked[s] as (typeof marked)[number];
  const m1 = marked[l] as (typeof marked)[number];
  assert.ok(Math.abs(m1.after.buffers - m0.after.buffers) <= tolerance(m0.level, m1.level), `ended by the mark, after vacuum: ${m1.after.buffers} at ${l}, ${m0.after.buffers} at ${s}`);
  const b0 = backlog[s] as (typeof backlog)[number];
  const b1 = backlog[l] as (typeof backlog)[number];
  assert.ok(Math.abs(b1.heldBehind.buffers - b0.heldBehind.buffers) <= tolerance(b0.level, b1.level), `the backlog held behind: ${b1.heldBehind.buffers} at ${l}, ${b0.heldBehind.buffers} at ${s}`);
  assert.ok(Math.abs(b1.past.buffers - b0.past.buffers) <= tolerance(b0.level, b1.level), `the backlog, the final block past: ${b1.past.buffers} at ${l}, ${b0.past.buffers} at ${s}`);
  report.candidates = {
    markedHistory: Object.fromEntries(Object.entries(marked).map(([n, f]) => [n, { beforeVacuum: f.before.buffers, afterVacuum: f.after.buffers, indexLevel: f.level }])),
    backlog: Object.fromEntries(Object.entries(backlog).map(([n, f]) => [n, { heldBehind: f.heldBehind.buffers, finalPast: f.past.buffers, indexLevel: f.level }])),
  };
});
