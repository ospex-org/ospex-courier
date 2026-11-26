import assert from 'node:assert/strict';
import pg from 'pg';
import type { HDAccount } from 'viem/accounts';
import { BOUNDS } from '../../courier/http/limits';
import { CANDIDATES_SQL, MARK_ENDED_AT_FINAL_SQL } from '../../courier/records/orders';
import { closeEach } from './close';
import { orderOn, postOrder as postOrderFrom, type Order } from './orders';
import { startStack, type Stack } from './stack';

// One sent bet's statements, measured: the stack and the measures the sent bet's cost files share
// (tests/cost-sent.test.ts, tests/cost-sent-ended.test.ts). Each statement the courier's own sessions run, from the
// bet's post to its outcome and the outcome's marks, comes with its own EXPLAIN (ANALYZE, BUFFERS): the database's
// auto_explain makes it as the statement runs, set for that file's database alone, and sends it to the courier's
// session as a notice, which the stack's database relay reads as it passes.

/** A book in a market of its own. */
export interface Book {
  name: string;
  gameId: bigint;
  market: string;
  side: number;
  scorer: string;
  lineTicks: number;
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
export interface Measured {
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

export const summary = (m: Measured) => ({
  statements: Object.keys(m.statements).length,
  calls: m.calls,
  buffers: m.buffers,
  scanBuffers: Object.values(m.statements).reduce((sum, s) => sum + s.scanBuffers, 0),
  named: Object.fromEntries(Object.entries(NAMED).map(([name, is]) => [name, Object.entries(m.statements).filter(([t]) => is(t)).map(([, s]) => ({ calls: s.calls, buffers: s.buffers, scanBuffers: s.scanBuffers, scans: s.scans }))])),
  largest: Object.entries(m.statements).sort((a, b) => b[1].buffers - a[1].buffers).slice(0, 3).map(([t, s]) => ({ statement: t.slice(0, 90), buffers: s.buffers, scanBuffers: s.scanBuffers, scans: s.scans })),
  seqOrders: Object.entries(m.statements).filter(([, s]) => s.seqOrders.length > 0).map(([t, s]) => ({ statement: t.slice(0, 90), ran: s.seqOrders })),
});

/** No statement reads more of the orders table by a sequential scan than a request's own bound of rows: on the books of 500,000, the table is never read whole. */
export const noSeqScanOnOrders = (m: Measured, what: string) => {
  for (const [t, s] of Object.entries(m.statements)) {
    const over = s.seqOrders.filter((r) => r.rows > BOUNDS.scanRows);
    assert.equal(over.length, 0, `${what}: a statement read more of the orders table by a sequential scan than ${BOUNDS.scanRows} rows: ${t.slice(0, 160)} ${JSON.stringify({ scans: s.scans, ran: s.seqOrders })}`);
  }
};

/**
 * The after-vacuum figures at the two sizes, statement by statement, by the cost page's measure, its scans' shared
 * buffer accesses: the same, within one page a level of each index for each walk the statement makes of it from its
 * root, and one page a scan. A statement that looks up a row at a time walks an index once a row, so its figure grows
 * by the index's new level once a row, and by nothing else. A write's own accesses are reported beside them, and not
 * held to this.
 */
export function sameAtBothSizes(what: string, small: Measured, large: Measured, levelsSmall: Record<string, number>, levelsLarge: Record<string, number>, otherwise: unknown[]): Array<{ statement: string; at50000: [number, number]; at500000: [number, number]; walks: Record<string, number>; allowed: number }> {
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

/** A sent bet's cost file's own stack, with auto_explain set for its database, and what it measures with. */
export interface SentCost {
  stack: Stack;
  /** The test's own sessions: auto_explain is off in them, so that only the courier's statements are planned and sent. */
  pool: pg.Pool;
  /** What the file prints for the cost page at its close. */
  report: Record<string, Record<string, unknown>>;
  bookOf(name: string, live: number): Promise<Book>;
  lay(book: Book, n: number, tick: number, expiry: bigint, base: number): Promise<void>;
  clear(base: number): Promise<void>;
  levels(): Promise<Record<string, number>>;
  until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T>;
  sendOne(book: Book, during?: { sent: () => void }): Promise<Measured>;
  close(): Promise<void>;
}

export async function openSentCost(prefix: string): Promise<SentCost> {
  const stack = await startStack(prefix, { blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  const pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2, options: '-c auto_explain.log_min_duration=-1' });
  const report: Record<string, Record<string, unknown>> = {};
  const url = () => stack.courier.url;
  let nextAddress = 0;
  const postOrder = (...a: Parameters<typeof postOrderFrom>) => {
    const n = nextAddress++;
    return postOrderFrom(a[0], a[1], a[2], a[3], a[4], { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` });
  };
  let nextAccount = 40;
  const fresh = async (): Promise<HDAccount> => {
    const who = stack.rig.account(nextAccount++);
    await stack.rig.fund(who);
    return who;
  };
  const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (done(v)) return v;
      if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];
  const stateOf = async (bet: string) => (await pool.query<{ state: string }>('SELECT state FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()])).rows[0]?.state ?? null;

  try {
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
  } catch (err) {
    await closeEach(
      () => pool.end(),
      () => stack.close(),
    ).catch(() => undefined);
    throw err;
  }

  return {
    stack,
    pool,
    report,
    until,
    /** A book in a market of its own: a game of its own, and `live` real quotes of 9,600 at tick 204 posted through the door by one maker. */
    async bookOf(name, live) {
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
    },
    /**
     * `n` quotes laid in the book's market by statement, of a maker of their own, each its own hash from `base`, at
     * `tick`, expiring at `expiry`: laid after the book's live quotes, so behind them at the same tick and ahead of them
     * at a better one.
     */
    async lay(book, n, tick, expiry, base) {
      await pool.query(
        `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, bet_state, received_time)
         SELECT '0x' || lpad(to_hex($1::bigint + g), 64, '0'), 'rest', '0x' || repeat('0a', 20), $2::numeric, $3, $4::integer, 0, $5::integer, 9600, g, $6::numeric, 0, '0x' || repeat('11', 65), $7, $8::smallint, 1, '0x' || lpad(to_hex(2), 64, '0'), NULL, 1
         FROM generate_series(1, $9::integer) AS g`,
        [base, book.gameId.toString(), book.scorer, book.lineTicks, tick, expiry.toString(), book.market, book.side, n],
      );
      await pool.query('ANALYZE orders');
    },
    /**
     * The laid quotes taken out again, the table vacuumed and its indexes built again, so the next book is measured on a
     * table of its own size: a B-tree keeps its depth after its rows are gone, until it is built again.
     */
    async clear(base) {
      await pool.query(`DELETE FROM orders WHERE hash > '0x' || lpad(to_hex($1::bigint), 64, '0') AND hash <= '0x' || lpad(to_hex($1::bigint + 99999999), 64, '0')`, [base]);
      await pool.query('VACUUM (INDEX_CLEANUP ON) orders');
      await pool.query('REINDEX TABLE orders');
    },
    /** The orders table's indexes, each with its depth. */
    async levels() {
      const { rows } = await pool.query<{ name: string }>(`SELECT indexrelname AS name FROM pg_stat_user_indexes WHERE relname = 'orders' ORDER BY indexrelname`);
      const out: Record<string, number> = {};
      for (const r of rows) out[r.name] = Number((await pool.query<{ tree_level: number }>('SELECT tree_level FROM pgstatindex($1)', [r.name])).rows[0]?.tree_level ?? 0);
      return out;
    },
    /** One bet sent end to end on the book's market, against the live quote at its head; its statements, from its post to its outcome. */
    async sendOne(book, during) {
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
    },
    close: () =>
      closeEach(
        () => console.log(`# one sent bet, by book and state (${prefix}): ${JSON.stringify(report)}`),
        () => pool.end(),
        () => stack.close(),
      ),
  };
}
