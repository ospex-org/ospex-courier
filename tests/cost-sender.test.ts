import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { testServer } from './support/database';

// The sender's own statements, measured: each run under EXPLAIN (ANALYZE,
// BUFFERS) on a history of the key's Crosses at two sizes, and with a backlog
// of marks the final block has not passed among the orders. The ordinary reads
// (the nonce proof's range from the lane's watermark, a nonce's Crosses, the
// restore's hold, the gate's read of the stops, the marks waiting for F) go
// through their indexes, and their shared buffer accesses stay the same as the
// history grows, within one page a level of the index. The figures are printed
// for docs/COST.md, and read there as this machine's.

const db = testServer();
let pool: pg.Pool;
const KEY = `0x${'15'.repeat(20)}`;

before(async () => {
  const { url } = await db.createWithSchema('cost_sender');
  pool = new pg.Pool({ connectionString: url, max: 1 });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgstattuple');
});

after(async () => {
  await pool?.end();
  await db.end();
});

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

/** One statement under EXPLAIN (ANALYZE, BUFFERS): the scans it made, each with its index and its shared buffer accesses, and the time. */
async function measure(sql: string, params: unknown[]): Promise<{ scans: Array<{ node: string; index: string | null; relation: string | null; buffers: number; rows: number }>; buffers: number; ms: number }> {
  const { rows } = await pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const top = rows[0]?.['QUERY PLAN'][0];
  assert.ok(top);
  const scans = [...walk(top.Plan)]
    .filter((n) => /Scan/.test(String(n['Node Type'])))
    .map((n) => ({ node: String(n['Node Type']), index: (n['Index Name'] as string | undefined) ?? null, relation: (n['Relation Name'] as string | undefined) ?? null, buffers: Number(n['Shared Hit Blocks'] ?? 0) + Number(n['Shared Read Blocks'] ?? 0), rows: Number(n['Actual Rows'] ?? 0) }));
  return { scans, buffers: Number(top.Plan['Shared Hit Blocks'] ?? 0) + Number(top.Plan['Shared Read Blocks'] ?? 0), ms: top['Execution Time'] };
}

async function treeLevel(index: string): Promise<number> {
  const { rows } = await pool.query<{ tree_level: number }>('SELECT tree_level FROM pgstatindex($1)', [index]);
  return Number(rows[0]?.tree_level ?? 0);
}

/**
 * A history of `n` Crosses of the key, each confirmed at its own nonce, with its bet; the lane's watermark at `n`,
 * anchored. And `marks` quotes marked at blocks the final block has passed, not yet read again, among `quotes`.
 */
async function lay(n: number, quotes: number, marks: number): Promise<void> {
  await pool.query('TRUNCATE legs, crosses, stops, stop_messages, orders, lanes, conditions RESTART IDENTITY CASCADE');
  await pool.query('INSERT INTO runs (id) VALUES (1) ON CONFLICT DO NOTHING');
  const orderCols = `hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, bet_state, received_time`;
  const hex = (expr: string) => `'0x' || lpad(to_hex(${expr}), 64, '0')`;
  await pool.query(
    `INSERT INTO orders (${orderCols})
     SELECT ${hex('g')}, 'take', '0x' || repeat('0b', 20), 1, '0x' || repeat('0c', 20), 0, 1, 196, 10000, g, 2000000000, 0, '0x' || repeat('11', 65), ${hex('1')}, 1, 1, ${hex('2')}, 'sent', 1
     FROM generate_series(1, $1) AS g`,
    [n],
  );
  await pool.query(
    `INSERT INTO orders (${orderCols}, ended, ended_at, ended_block, ended_block_hash, ended_final)
     SELECT ${hex('10000000 + g')}, 'rest', '0x' || repeat('0a', 20), 1, '0x' || repeat('0c', 20), 0, 0, 204, 9600, g, 2000000000, 0, '0x' || repeat('11', 65), ${hex('1')}, 0, 1, ${hex('2')}, NULL, 1,
            CASE WHEN g <= $2 THEN 'cancelled' END, CASE WHEN g <= $2 THEN now() END, CASE WHEN g <= $2 THEN 50 END, CASE WHEN g <= $2 THEN ${hex('50')} END, false
     FROM generate_series(1, $1) AS g`,
    [quotes, marks],
  );
  await pool.query(`INSERT INTO lanes (sender, epoch, verified_nonce_to, verified_block_number, verified_block_hash) VALUES ($1, 1, $2, 100, ${hex('100')})`, [KEY, n]);
  await pool.query(
    `INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, state, hand_offs, sender, nonce, gas_limit, max_fee_per_gas, max_priority_fee, tx_hash,
                          receipt_block_number, receipt_block_hash, final_block_number, final_block_hash)
     SELECT ${hex('g')}, $2, 1, g, 90, ${hex('90')}, 900, 'confirmed', 1, $2, g - 1, 500000, 200, 30, ${hex('20000000 + g')}, 95, ${hex('95')}, 99, ${hex('99')}
     FROM generate_series(1, $1) AS g`,
    [n, KEY],
  );
  await pool.query('ANALYZE');
}

const STATEMENTS = {
  /** The nonce proof's read: the key's Crosses from the lane's watermark up. */
  nonceRange: `SELECT bet_hash, nonce, state FROM crosses c WHERE c.sender = $1 AND c.nonce >= $2 ORDER BY c.nonce, c.bet_hash`,
  /** A nonce's Crosses: a replacement's fees, a search's find. */
  atNonce: `SELECT bet_hash, state FROM crosses c WHERE c.sender = $1 AND c.nonce = $2 ORDER BY c.bet_hash`,
  /** The restore's hold. */
  hold: `SELECT e.number FROM lanes l JOIN events e ON e.number = l.shut_line WHERE e.kind = 'incident' AND e.reason = 'RESTORE_SHUT' ORDER BY e.number LIMIT 1`,
  /** The gate's read of the stops on the hashes it locked. */
  gateStops: `SELECT hash FROM orders WHERE hash = ANY($1::text[]) AND ended = 'stopped' UNION SELECT hash FROM stops WHERE hash = ANY($1::text[])`,
  /** The marks waiting for F: one pass's worth. */
  marksWaiting: `SELECT o.hash FROM orders o WHERE o.ended_block IS NOT NULL AND NOT o.ended_final AND o.ended_block <= $1 ORDER BY o.ended_block LIMIT 200`,
} as const;

test("the ordinary reads stay the same size as the key's history grows: the nonce proof's range, a nonce's Crosses, the restore's hold and the gate's read of the stops, at 1,000 and at 100,000 Crosses, each through its index, within one page a level of it; printed for the cost page", async () => {
  const figures: Record<string, Record<string, { buffers: number; ms: number; scans: string }>> = {};
  for (const n of [1_000, 100_000]) {
    await lay(n, 10, 0);
    const level = await treeLevel('crosses_sender_nonce');
    const at = (m: Awaited<ReturnType<typeof measure>>) => ({ buffers: m.scans.reduce((s, x) => s + x.buffers, 0), ms: Math.round(m.ms * 1000) / 1000, scans: m.scans.map((x) => `${x.node}${x.index === null ? '' : ` ${x.index}`}`).join(', ') });
    const range = await measure(STATEMENTS.nonceRange, [KEY, n]);
    assert.ok(range.scans.some((s) => s.index === 'crosses_sender_nonce'), JSON.stringify(range.scans));
    const one = await measure(STATEMENTS.atNonce, [KEY, n - 1]);
    const hold = await measure(STATEMENTS.hold, []);
    const gate = await measure(STATEMENTS.gateStops, [[`0x${'00'.repeat(31)}01`, `0x${'00'.repeat(31)}02`]]);
    figures[String(n)] = { nonceRange: at(range), atNonce: at(one), hold: at(hold), gateStops: at(gate), level: { buffers: level, ms: 0, scans: 'crosses_sender_nonce tree level' } };
  }
  const small = figures['1000'] as Record<string, { buffers: number }>;
  const large = figures['100000'] as Record<string, { buffers: number }>;
  const level = (large.level as { buffers: number }).buffers;
  for (const k of ['nonceRange', 'atNonce', 'hold', 'gateStops']) {
    assert.ok(((large[k] as { buffers: number }).buffers - (small[k] as { buffers: number }).buffers) <= level + 1, `${k}: ${JSON.stringify(figures)}`);
  }
  console.log(`# the sender's ordinary reads, by history: ${JSON.stringify(figures)}`);
});

test('the marks waiting for the final block: one pass reads at most 200 of a backlog of 10,000 among 100,000 quotes, through its partial index', async () => {
  await lay(10, 100_000, 10_000);
  const m = await measure(STATEMENTS.marksWaiting, [99]);
  assert.ok(m.scans.some((s) => s.index === 'orders_marks_not_final'), JSON.stringify(m.scans));
  assert.ok(m.scans.every((s) => s.rows <= 200), `one pass reads at most 200 entries: ${JSON.stringify(m.scans)}`);
  console.log(`# the marks waiting for F, a backlog of 10,000 among 100,000 quotes: ${JSON.stringify({ buffers: m.scans.reduce((s, x) => s + x.buffers, 0), ms: m.ms, scans: m.scans })}`);
});
