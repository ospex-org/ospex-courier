import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { HDAccount } from 'viem/accounts';
import { BOUNDS } from '../courier/http/limits';
import { CANDIDATES_SQL, MARK_ENDED_AT_FINAL_SQL } from '../courier/records/orders';
import { closeEach } from './support/close';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { startStack, type Stack } from './support/stack';

// One sent bet's statements, measured. Each statement the courier's own sessions run, from the bet's post to its
// outcome and the outcome's marks, comes with its own EXPLAIN (ANALYZE, BUFFERS): the database's auto_explain makes it
// as the statement runs, set for this file's database alone, and sends it to the courier's session as a notice, which
// the stack's database relay reads as it passes. The bet is sent end to end on each of the three books the cost page
// names (docs/COST.md), each in a market of its own: ten live quotes; 50,000 and 500,000 orders ended by the mark,
// ahead of ten live quotes; and 50,000 and 500,000 expired quotes not yet marked, behind the bet's live quote, first
// with the final block held behind their expiry while the bet is checked, so that F has not passed them, then with F
// past them. Each book is measured before vacuum, with the dead versions its marking leaves, and after VACUUM. On the
// books of 500,000 no statement reads more of the orders table by a sequential scan than a request's own bound of rows;
// at 50,000 the planner may read the whole table where that costs less than walking an index a row at a time, and each
// such read is reported. After vacuum, each statement whose plan walks the same indexes at both sizes reads at 500,000
// what it reads at 50,000, within one page a level of each index for each walk it makes of it; a statement planned
// otherwise at the two sizes is reported. The books are the orders table, so the statements held to the two sizes are
// the ones that read it. The figures are printed for docs/COST.md, and read there as this machine's.

let stack: Stack;
/** The test's own sessions: auto_explain is off in them, so that only the courier's statements are planned and sent. */
let pool: pg.Pool;
const url = () => stack.courier.url;

let nextAddress = 0;
const postOrder = (...a: Parameters<typeof postOrderFrom>) => {
  const n = nextAddress++;
  return postOrderFrom(a[0], a[1], a[2], a[3], a[4], { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` });
};

before(async () => {
  stack = await startStack('cost_sent', { blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2, options: '-c auto_explain.log_min_duration=-1' });
  assert.match(stack.databaseName, /^[a-z0-9_]+$/);
  const su = await pool.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  assert.equal(su.rows[0]?.rolsuper, true, "auto_explain's settings for a database are the server superuser's, as the tests' server gives");
  // Every statement of the courier's own sessions planned, run and measured by auto_explain, its plan sent to the
  // session as a notice.
  const settings: Array<[string, string]> = [
    ['session_preload_libraries', 'auto_explain'],
    ['auto_explain.log_min_duration', '0'],
    ['auto_explain.log_analyze', 'on'],
    ['auto_explain.log_buffers', 'on'],
    ['auto_explain.log_timing', 'on'],
    ['auto_explain.log_format', 'json'],
    ['auto_explain.log_level', 'notice'],
  ];
  const c = await pool.connect();
  try {
    await c.query(`LOAD 'auto_explain'`);
    for (const [k, v] of settings) await c.query(`ALTER DATABASE ${stack.databaseName} SET ${k} = '${v}'`);
  } finally {
    c.release();
  }
  // The maintenance states are made here, by hand, and measured as made.
  await pool.query('ALTER TABLE orders SET (autovacuum_enabled = false)');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgstattuple');
  // The courier's sessions opened again, so that each loads auto_explain.
  await stack.restartCourier();
});

const report: Record<string, Record<string, unknown>> = {};

after(() =>
  closeEach(
    () => console.log(`# one sent bet, by book and state: ${JSON.stringify(report)}`),
    () => pool?.end(),
    () => stack?.close(),
  ),
);

let nextAccount = 40;
async function fresh(): Promise<HDAccount> {
  const who = stack.rig.account(nextAccount++);
  await stack.rig.fund(who);
  return who;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];
const stateOf = async (bet: string) => (await pool.query<{ state: string }>('SELECT state FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()])).rows[0]?.state ?? null;

interface Book {
  name: string;
  gameId: bigint;
  market: string;
  side: number;
  scorer: string;
  lineTicks: number;
}

/** A book in a market of its own: a game of its own, and `live` real quotes of 9,600 at tick 204 posted through the door by one maker. */
async function bookOf(name: string, live: number): Promise<Book> {
  const gameId = await stack.rig.createGame({ startWritten: true });
  const M = await fresh();
  const T = await stack.rig.time();
  let first = '';
  for (let i = 0; i < live; i++) {
    const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 3_600n, oddsTick: 204, riskAmount: 9_600n, minFill: 0n, gameId }), positionType: 0 };
    const posted = await postOrder(url(), stack.rig, M, 'rest', q);
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    if (i === 0) first = posted.body.orderHash as string;
  }
  const row = (await pool.query<{ market_key: string; side: number; scorer: string; line_ticks: number }>('SELECT market_key, side, scorer, line_ticks FROM orders WHERE hash = $1', [first.toLowerCase()])).rows[0];
  assert.ok(row);
  return { name, gameId, market: row.market_key, side: Number(row.side), scorer: row.scorer, lineTicks: Number(row.line_ticks) };
}

/**
 * `n` quotes laid in the book's market by statement, of a maker of their own, each its own hash from `base`, at
 * `tick`, expiring at `expiry`: laid after the book's live quotes, so behind them at the same tick and ahead of them
 * at a better one.
 */
async function lay(book: Book, n: number, tick: number, expiry: bigint, base: number): Promise<void> {
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, bet_state, received_time)
     SELECT '0x' || lpad(to_hex($1::bigint + g), 64, '0'), 'rest', '0x' || repeat('0a', 20), $2::numeric, $3, $4::integer, 0, $5::integer, 9600, g, $6::numeric, 0, '0x' || repeat('11', 65), $7, $8::smallint, 1, '0x' || lpad(to_hex(2), 64, '0'), NULL, 1
     FROM generate_series(1, $9::integer) AS g`,
    [base, book.gameId.toString(), book.scorer, book.lineTicks, tick, expiry.toString(), book.market, book.side, n],
  );
  await pool.query('ANALYZE orders');
}

/**
 * The laid quotes taken out again, the table vacuumed and its indexes built again, so the next book is measured on a
 * table of its own size: a B-tree keeps its depth after its rows are gone, until it is built again.
 */
async function clear(base: number): Promise<void> {
  await pool.query(`DELETE FROM orders WHERE hash > '0x' || lpad(to_hex($1::bigint), 64, '0') AND hash <= '0x' || lpad(to_hex($1::bigint + 99999999), 64, '0')`, [base]);
  await pool.query('VACUUM (INDEX_CLEANUP ON) orders');
  await pool.query('REINDEX TABLE orders');
}

/** The orders table's indexes, each with its depth. */
async function levels(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ name: string }>(`SELECT indexrelname AS name FROM pg_stat_user_indexes WHERE relname = 'orders' ORDER BY indexrelname`);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.name] = Number((await pool.query<{ tree_level: number }>('SELECT tree_level FROM pgstatindex($1)', [r.name])).rows[0]?.tree_level ?? 0);
  return out;
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

/**
 * One statement as auto_explain measured it: its text, the plan's shared buffer accesses, index and table together, its
 * scans (a scan the executor never ran is named so), and each sequential scan of the orders table that ran, with its
 * rows and its own buffers.
 */
interface Planned {
  text: string;
  buffers: number;
  /** The shared buffer accesses of its scans of tables, added, as the cost page measures a statement: a write's own accesses (the heap's free-space search, index entries, page splits) are in `buffers` and not here. */
  scanBuffers: number;
  /** Each index's walks from its root: an index scan's loops, added by index. */
  walks: Record<string, number>;
  /** The scans of tables in its plan. */
  scanNodes: number;
  scans: string[];
  seqOrders: Array<{ loops: number; rows: number; buffers: number }>;
}

const normal = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const RELATION_SCANS = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan']);
const accesses = (n: PlanNode) => Number(n['Shared Hit Blocks'] ?? 0) + Number(n['Shared Read Blocks'] ?? 0);

function planned(message: string): Planned | null {
  const i = message.indexOf('{');
  if (!message.startsWith('duration:') || i < 0) return null;
  const doc = JSON.parse(message.slice(i)) as { 'Query Text': string; Plan: PlanNode };
  const top = doc.Plan;
  return {
    text: normal(doc['Query Text']),
    buffers: accesses(top),
    scanBuffers: [...walk(top)].filter((n) => RELATION_SCANS.has(String(n['Node Type']))).reduce((sum, n) => sum + accesses(n), 0),
    walks: [...walk(top)]
      .filter((n) => typeof n['Index Name'] === 'string')
      .reduce<Record<string, number>>((w, n) => ({ ...w, [String(n['Index Name'])]: (w[String(n['Index Name'])] ?? 0) + Number(n['Actual Loops'] ?? 0) }), {}),
    scanNodes: [...walk(top)].filter((n) => RELATION_SCANS.has(String(n['Node Type']))).length,
    scans: [...walk(top)]
      .filter((n) => /Scan/.test(String(n['Node Type'])))
      .map((n) => `${String(n['Node Type'])}${n['Index Name'] === undefined ? '' : ` ${String(n['Index Name'])}`} on ${String(n['Relation Name'] ?? n['CTE Name'] ?? '?')}${Number(n['Actual Loops'] ?? 0) === 0 ? ' (never executed)' : ''}`),
    seqOrders: [...walk(top)]
      .filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'orders' && Number(n['Actual Loops'] ?? 0) > 0)
      .map((n) => ({ loops: Number(n['Actual Loops']), rows: Number(n['Actual Rows'] ?? 0) + Number(n['Rows Removed by Filter'] ?? 0), buffers: Number(n['Shared Hit Blocks'] ?? 0) + Number(n['Shared Read Blocks'] ?? 0) })),
  };
}

/** One sent bet's statements, by their text: how often each ran, its largest figure, and its scans. */
interface Measured {
  bet: string;
  statements: Record<string, { calls: number; buffers: number; scanBuffers: number; walks: Record<string, number>; scanNodes: number; scans: string[]; seqOrders: Array<{ loops: number; rows: number; buffers: number }> }>;
  calls: number;
  buffers: number;
}

/** The named statements, by the code's own text where it exports it, and by a fragment of it where it does not. */
const NAMED: Record<string, (text: string) => boolean> = {
  "the bet's candidate statement": (t) => t === normal(CANDIDATES_SQL),
  "the outcome's marks": (t) => t === normal(MARK_ENDED_AT_FINAL_SQL),
  "the nonce's floor": (t) => t.includes('FROM crosses c WHERE c.sender = $1 AND c.nonce >= $2'),
  "the marks' read": (t) => t.includes('o.ended_block IS NOT NULL AND NOT o.ended_final AND o.ended_block <= $1'),
};

/** One bet sent end to end on the book's market, against the live quote at its head; its statements, from its post to its outcome. */
async function sendOne(book: Book, during?: { sent: () => void }): Promise<Measured> {
  const B = await fresh();
  const T = await stack.rig.time();
  const bet: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, gameId: book.gameId }), positionType: 1 };
  stack.dbRelay.takeNotices();
  const taken = await postOrder(url(), stack.rig, B, 'take', bet);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  const hash = taken.body.orderHash as string;
  if (during !== undefined) {
    await until(() => stateOf(hash), (s) => s !== null && s !== 'intent' && s !== 'signed' && s !== 'handing off', 60_000, `${book.name}: the Cross handed off`);
    during.sent();
  }
  const state = await until(() => stateOf(hash), (s) => s !== null && FINAL.includes(s), 90_000, `${book.name}: the Cross`);
  assert.equal(state, 'confirmed', `${book.name}: the bet sent and filled`);
  const out: Measured = { bet: hash, statements: {}, calls: 0, buffers: 0 };
  for (const n of stack.dbRelay.takeNotices()) {
    const p = planned(n.message);
    if (p === null) continue;
    const s = (out.statements[p.text] ??= { calls: 0, buffers: 0, scanBuffers: 0, walks: {}, scanNodes: 0, scans: [], seqOrders: [] });
    s.calls += 1;
    s.buffers = Math.max(s.buffers, p.buffers);
    // The call whose scans read most is the statement's figure, with its walks and its scans.
    if (p.scanBuffers >= s.scanBuffers) Object.assign(s, { scanBuffers: p.scanBuffers, walks: p.walks, scanNodes: p.scanNodes });
    for (const x of p.scans) if (!s.scans.includes(x)) s.scans.push(x);
    s.seqOrders.push(...p.seqOrders);
    out.calls += 1;
    out.buffers += p.buffers;
  }
  assert.ok(out.calls > 0, `${book.name}: auto_explain's plans reached the relay`);
  for (const [name, is] of Object.entries(NAMED)) assert.ok(Object.keys(out.statements).some(is), `${book.name}: ${name} among the bet's statements`);
  return out;
}

const summary = (m: Measured) => ({
  statements: Object.keys(m.statements).length,
  calls: m.calls,
  buffers: m.buffers,
  scanBuffers: Object.values(m.statements).reduce((sum, s) => sum + s.scanBuffers, 0),
  named: Object.fromEntries(Object.entries(NAMED).map(([name, is]) => [name, Object.entries(m.statements).filter(([t]) => is(t)).map(([, s]) => ({ calls: s.calls, buffers: s.buffers, scanBuffers: s.scanBuffers, scans: s.scans }))])),
  largest: Object.entries(m.statements).sort((a, b) => b[1].buffers - a[1].buffers).slice(0, 3).map(([t, s]) => ({ statement: t.slice(0, 90), buffers: s.buffers, scanBuffers: s.scanBuffers, scans: s.scans })),
  seqOrders: Object.entries(m.statements).filter(([, s]) => s.seqOrders.length > 0).map(([t, s]) => ({ statement: t.slice(0, 90), ran: s.seqOrders })),
});
/** No statement reads more of the orders table by a sequential scan than a request's own bound of rows: on the books of 500,000, the table is never read whole. */
const noSeqScanOnOrders = (m: Measured, what: string) => {
  for (const [t, s] of Object.entries(m.statements)) {
    const over = s.seqOrders.filter((r) => r.rows > BOUNDS.scanRows);
    assert.equal(over.length, 0, `${what}: a statement read more of the orders table by a sequential scan than ${BOUNDS.scanRows} rows: ${t.slice(0, 160)} ${JSON.stringify({ scans: s.scans, ran: s.seqOrders })}`);
  }
};

test('one sent bet on the small book: ten live quotes, before and after vacuum; printed for the cost page', async () => {
  const book = await bookOf('ten live quotes', 10);
  const before = await sendOne(book);
  // After vacuum: the whole database, with no other transaction open.
  await pool.query('VACUUM (INDEX_CLEANUP ON)');
  const after_ = await sendOne(book);
  report.small = { before: summary(before), after: summary(after_) };
});

/**
 * The after-vacuum figures at the two sizes, statement by statement, by the cost page's measure, its scans' shared
 * buffer accesses: the same, within one page a level of each index for each walk the statement makes of it from its
 * root, and one page a scan. A statement that looks up a row at a time walks an index once a row, so its figure grows
 * by the index's new level once a row, and by nothing else. A write's own accesses are reported beside them, and not
 * held to this.
 */
function sameAtBothSizes(what: string, small: Measured, large: Measured, levelsSmall: Record<string, number>, levelsLarge: Record<string, number>, otherwise: unknown[]): Array<{ statement: string; at50000: [number, number]; at500000: [number, number]; walks: Record<string, number>; allowed: number }> {
  const deeper = (index: string) => Math.max(0, (levelsLarge[index] ?? 0) - (levelsSmall[index] ?? 0));
  const both: Array<{ statement: string; at50000: [number, number]; at500000: [number, number]; walks: Record<string, number>; allowed: number }> = [];
  const paths = (s: { scans: string[] }) => s.scans.filter((x) => !/^(CTE|Function) Scan/.test(x)).map((x) => x.replace(' (never executed)', '')).sort().join('; ');
  const readsTheBook = (s: { scans: string[] }) => s.scans.some((x) => / on orders( |$)/.test(x));
  for (const [t, s] of Object.entries(large.statements)) {
    const at = small.statements[t];
    // The books are the orders table: a statement that reads no part of it does not read the book.
    if (at === undefined || !readsTheBook(s)) continue;
    if (paths(at) !== paths(s)) {
      otherwise.push({ statement: t.slice(0, 90), at50000: { scans: at.scans, scanBuffers: at.scanBuffers, readWhole: at.seqOrders }, at500000: { scans: s.scans, scanBuffers: s.scanBuffers } });
      continue;
    }
    const allowed = Object.entries(s.walks).reduce((sum, [index, walks]) => sum + walks * deeper(index), 0) + s.scanNodes + 1;
    both.push({ statement: t.slice(0, 90), at50000: [at.scanBuffers, at.buffers], at500000: [s.scanBuffers, s.buffers], walks: s.walks, allowed });
  }
  for (const b of both) assert.ok(b.at500000[0] - b.at50000[0] <= b.allowed, `${what}: after vacuum, its scans read ${b.at500000[0]} buffers at 500,000 against ${b.at50000[0]} at 50,000, beyond one page a level of each index a walk (${b.allowed}; walks ${JSON.stringify(b.walks)}, levels ${JSON.stringify(levelsSmall)} to ${JSON.stringify(levelsLarge)}): ${b.statement}`);
  return both.sort((a, b) => b.at500000[1] - b.at50000[1] - (a.at500000[1] - a.at50000[1]));
}

const ENDED: Record<number, { after: Measured; levels: Record<string, number> }> = {};
for (const [k, n] of [50_000, 500_000].entries()) {
  test(`one sent bet on the book of ${n.toLocaleString('en-US')} orders ended by the mark, ahead of ten live quotes: before vacuum, with the dead versions the mark leaves, and after; through the indexes${n === 500_000 ? ', and after vacuum the same at both sizes within one page a level of each index' : ''}; printed for the cost page`, async () => {
    const base = 100_000_000 * (k + 1);
    const book = await bookOf(`ended ${n}`, 10);
    // At a better price, expired, then marked as the courier's own statement marks: one dead version a quote, in the
    // table and in the book's index, ahead of the live quotes.
    await lay(book, n, 200, 1n, base);
    const marked = await pool.query(`UPDATE orders SET ended = 'expired', ended_at = now() WHERE market_key = $1 AND odds_tick = 200 AND ended IS NULL`, [book.market]);
    assert.equal(marked.rowCount, n);
    const before = await sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(before, `ended ${n}, before vacuum`);
    // After vacuum: the whole database, with no other transaction open.
    await pool.query('VACUUM (INDEX_CLEANUP ON)');
    const after_ = await sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(after_, `ended ${n}, after vacuum`);
    ENDED[n] = { after: after_, levels: await levels() };
    report[`ended ${n}`] = { before: summary(before), after: summary(after_), levels: ENDED[n]?.levels };
    if (n === 500_000) {
      const otherwise: unknown[] = [];
      (report[`ended ${n}`] as Record<string, unknown>).bothSizesAfterVacuum = sameAtBothSizes('ended', (ENDED[50_000] as { after: Measured }).after, after_, (ENDED[50_000] as { levels: Record<string, number> }).levels, ENDED[n]?.levels ?? {}, otherwise);
      (report[`ended ${n}`] as Record<string, unknown>).plannedOtherwise = otherwise;
    }
    await clear(base);
  });
}

const BACKLOG: Record<number, { after: Measured; levels: Record<string, number> }> = {};
for (const [k, n] of [50_000, 500_000].entries()) {
  test(`one sent bet on the book of ${n.toLocaleString('en-US')} expired quotes not yet marked, behind the bet's live quote: with the final block held behind them while the bet is checked, then past them, before vacuum and after; through the indexes${n === 500_000 ? ', and after vacuum the same at both sizes within one page a level of each index' : ''}; printed for the cost page`, async () => {
    const base = 100_000_000 * (k + 3);
    const book = await bookOf(`backlog ${n}`, 3);
    // F held at the head; the backlog expires after F's time, so that F has not passed it, and is expired at the
    // latest block before the bet is checked.
    const head = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
    stack.proxy.finalFollows(null);
    stack.proxy.setFinal(head);
    let held: Measured;
    try {
      const at = BigInt(((await stack.rig.rpc('eth_getBlockByNumber', [`0x${head.toString(16)}`, false])) as { timestamp: string }).timestamp);
      await lay(book, n, 204, at + 3n, base);
      await until(() => stack.rig.time(), (t) => t > at + 3n, 30_000, 'the backlog expired at the latest block');
      held = await sendOne(book, {
        sent: () => {
          stack.proxy.setFinal(null);
          stack.proxy.finalFollows(1n);
        },
      });
    } finally {
      stack.proxy.setFinal(null);
      stack.proxy.finalFollows(1n);
    }
    // Nothing of the backlog marked while F had not passed it: the bet's request passed it by.
    const notMarked = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM orders WHERE market_key = $1 AND odds_tick = 204 AND ended IS NULL AND hash > '0x' || lpad(to_hex($2::bigint), 64, '0') AND hash <= '0x' || lpad(to_hex($2::bigint + 99999999), 64, '0')`, [book.market, base]);
    assert.equal(Number(notMarked.rows[0]?.n ?? 0), n, `backlog ${n}: nothing of it marked while F had not passed it`);
    if (n === 500_000) noSeqScanOnOrders(held, `backlog ${n}, F held behind it`);
    const before = await sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(before, `backlog ${n}, F past it, before vacuum`);
    // After vacuum: the whole database, with no other transaction open.
    await pool.query('VACUUM (INDEX_CLEANUP ON)');
    const after_ = await sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(after_, `backlog ${n}, after vacuum`);
    BACKLOG[n] = { after: after_, levels: await levels() };
    report[`backlog ${n}`] = { heldBehind: summary(held), before: summary(before), after: summary(after_), levels: BACKLOG[n]?.levels };
    if (n === 500_000) {
      const otherwise: unknown[] = [];
      (report[`backlog ${n}`] as Record<string, unknown>).bothSizesAfterVacuum = sameAtBothSizes('backlog', (BACKLOG[50_000] as { after: Measured }).after, after_, (BACKLOG[50_000] as { levels: Record<string, number> }).levels, BACKLOG[n]?.levels ?? {}, otherwise);
      (report[`backlog ${n}`] as Record<string, unknown>).plannedOtherwise = otherwise;
    }
    await clear(base);
  });
}
