import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach } from 'node:test';
import pg from 'pg';
import { isAddress, type Hex } from 'viem';
import type { HoldPoint } from '../../courier/check/hooks';
import { allJournals, type JournalEntry } from './journal';
import { testKeystoreFor } from './keystore';

// The courier under test, started as its own process through its real entry
// (courier/server.ts), against the chain and the database the test names. The
// tests speak to it over HTTP, as the maker and a bettor would.

const ROOT = new URL('../../', import.meta.url);

export interface CourierProcess {
  port: number;
  url: string;
  lines: string[];
  process: ChildProcess;
  /** Resolves with the exit code once the process has exited. */
  exited: Promise<number | null>;
  stop(): Promise<number | null>;
}

export interface CourierEnv {
  DATABASE_URL: string;
  POLYGON_RPC_URL: string;
  SIGNPOST_ADDRESS: string;
  BETTING_ENTRY_ID: string;
  COURIER_ADDRESS: string;
  PORT?: string;
  COURIER_LOW_POL?: string;
  PUBLISHED_REPORTERS_FILE?: string;
  /**
   * The key's two settings. Left out, the child is given the run's test keystore for COURIER_ADDRESS, where that is
   * one of the local chain's test accounts (tests/support/keystore.ts); given, even empty, they are used as given.
   */
  COURIER_KEYSTORE_JSON?: string;
  COURIER_KEYSTORE_PASSWORD?: string;
}

/** The key's two settings for the child alone: the run's test keystore for the courier's address, unless the test gave its own. */
function keystoreSettings(env: CourierEnv): Record<string, string> {
  if ('COURIER_KEYSTORE_JSON' in env || 'COURIER_KEYSTORE_PASSWORD' in env) return {};
  let store: ReturnType<typeof testKeystoreFor> = null;
  try {
    store = isAddress(env.COURIER_ADDRESS) ? testKeystoreFor(env.COURIER_ADDRESS) : null;
  } catch {
    store = null;
  }
  return store === null ? {} : { COURIER_KEYSTORE_JSON: store.json, COURIER_KEYSTORE_PASSWORD: store.password };
}

/** Starts the courier; resolves when it listens, or rejects with its refusal line when it does not start. */
export async function startCourier(env: CourierEnv): Promise<CourierProcess> {
  return launch('courier/server.ts', env, false);
}

/** A hold point reached by the courier under test: where, for which bet, and its number, which `go` lets on. */
export interface Held {
  held: number;
  point: HoldPoint;
  bet: Hex | null;
}

/** The test's side of the lane's hooks, over the IPC channel to the courier started through the tests' start file. */
export interface HookControl {
  /** Arms a hold point for its next `times` reaches (or every one); resolves once the courier has it. */
  arm(point: HoldPoint, times?: number | 'all'): Promise<void>;
  disarm(point: HoldPoint): Promise<void>;
  /** The next hold reached, at this point where one is named, in the order they were reached. */
  reached(point?: HoldPoint): Promise<Held>;
  /** Lets the check held there go on. */
  go(held: Held): Promise<void>;
  /**
   * Plants the test faults: a skew of one quote's predicted pull, quotes taken as live, a lower ceiling on one
   * transaction's gas; an order of the ready Cross changed before it is sealed; and the signer's seams.
   */
  fault(f: {
    skewPull?: Record<string, bigint>;
    listAsLive?: string[];
    transactionGasCap?: bigint | null;
    unhashBeforeSeal?: boolean;
    signer?: { substitute?: 'look-alike' | 'earlier' | null; tamper?: 'reorder' | 'swap' | 'gas' | null; envelope?: { to?: string; value?: bigint } | null };
  }): Promise<void>;
  /** What the check observed at the boundary between the candidates and the listing, in order. */
  observed: Array<{ what: 'candidates' | 'walk input'; hashes: string[] }>;
  /** Every transaction the signer signed in this process, refused, dropped and unmined ones included, in the order signed: its bytes, held in this memory only. */
  signed: Hex[];
  /**
   * The same attempts, each beside the fields of the sealed send the signer was handed for it (its nonce, gas limit,
   * fee cap and tip, as text), as the signer's seams saw them; null where what it was handed had no such fields.
   */
  attempts: Array<{ raw: Hex; sealed: { nonce: string; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string } | null }>;
  /** Each try the signer's seam made at changing a sealed send in place, and what came of it. */
  tampered: Array<{ how: string; result: string }>;
}

/**
 * Starts the courier through the tests' start file (tests/support/hooked-server.ts), the same service with the lane's
 * hooks passed in, driven over the IPC channel. `holds` arms points before the service starts, as `point:count`
 * pieces joined by commas (count `all` for every reach).
 */
export async function startHookedCourier(env: CourierEnv, holds = ''): Promise<CourierProcess & { hooks: HookControl }> {
  const courier = await launch('tests/support/hooked-server.ts', { ...env, ...(holds === '' ? {} : { COURIER_TEST_HOLDS: holds }) }, true);
  return courier as CourierProcess & { hooks: HookControl };
}

async function launch(entry: string, env: CourierEnv & { COURIER_TEST_HOLDS?: string }, ipc: boolean): Promise<CourierProcess> {
  // The key's two settings are set here, for this child alone: never from this machine's environment.
  const childEnv: Record<string, string | undefined> = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: '0', ...keystoreSettings(env), ...env };
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: ROOT,
    env: childEnv,
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  // When each line arrived, for the print of a failed case alone: the lines themselves are what the tests read.
  const times: number[] = [];
  const record: Started = { number: started.length + 1, entry, child, lines, times, url: null, databaseUrl: childEnv.DATABASE_URL, launchedAt: Date.now(), listeningAt: null, checkPrinted: false, from: 0, withheld: withheldOf(childEnv) };
  started.push(record);
  const hooks = ipc ? control(child, () => lines) : null;
  // The courier never outlives the test process; the listener leaves with the child, so a file that starts many
  // couriers does not pile listeners on the process.
  const onExit = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once('exit', onExit);
  child.once('exit', () => process.off('exit', onExit));
  let buffer = '';
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    const kept = parts.filter((l) => l !== '');
    lines.push(...kept);
    for (let i = 0; i < kept.length; i += 1) times.push(Date.now());
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

  const port = await new Promise<number>((resolve, reject) => {
    const look = () => {
      const listening = lines.find((l) => /^courier: listening on port (\d+)/.test(l));
      if (listening) return resolve(Number(/port (\d+)/.exec(listening)?.[1]));
      const refused = lines.find((l) => l.startsWith('courier did not start:'));
      if (refused) return reject(new CourierDidNotStart(refused, lines));
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
    exited.then(() => reject(new CourierDidNotStart(lines.find((l) => l.startsWith('courier did not start:')) ?? `the process exited with ${child.exitCode}`, lines)));
    setTimeout(() => reject(new Error(`the courier did not listen within 60 seconds; its lines: ${lines.join(' | ')}`)), 60_000).unref();
  });
  record.url = `http://127.0.0.1:${port}`;
  record.listeningAt = Date.now();

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    lines,
    process: child,
    exited,
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      timer.unref();
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
    ...(hooks === null ? {} : { hooks }),
  };
}

// A failed case prints its couriers. For each courier this test process started: the lines it wrote since the case
// before this one ended (the first case gets its start's lines), each with the time it arrived; and, while it still
// runs, what its status address says of its node check and its lane: the parts of the check that did not pass,
// whether the lane takes bets, and the line that shut it, read whole from the courier's database. So a post answered
// 503 NODE_UNUSABLE or NOT_TAKING_BETS where the case expected otherwise says why. Where the check failed, the first
// failed case prints it whole, every part with its verdict, and the requests it made, each with its times and the
// block it named. From the courier's database: each lane's row (its held bet, reservation, epoch and watermark), and
// each Cross made in the case or open in a lane, with the nonce proof its send recorded. From each chain proxy's
// journal (tests/support/journal.ts): every change of its rules in the case, the final block it held by number and by
// hash, and any request that crossed a change; and, in order, the courier's reads of the key's count, of a block's
// header and of a receipt: the block each named, and the number, hash or count each answer gave. All of it is read
// after the case has failed, never during a case: no case's requests, waits or expected values change, and a case
// that passes prints nothing. The print fails no case.

interface Started {
  number: number;
  entry: string;
  child: ChildProcess;
  lines: string[];
  times: number[];
  /** Its address, once it listens. */
  url: string | null;
  /** The database it was given, where the line that shut its lane is read. */
  databaseUrl: string | undefined;
  /** When it was started, and when it listened: its node check is made between the two. */
  launchedAt: number;
  listeningAt: number | null;
  /** Whether its failed node check has been printed whole. */
  checkPrinted: boolean;
  /** How many of its lines there were when the last case ended. */
  from: number;
  /** The values it was handed that a print never carries, each with the name printed in its place. */
  withheld: Array<[string, string]>;
}

const started: Started[] = [];

/** Of one courier's lines in one case, at most the first so many and the last so many are printed. */
const PRINT_FIRST = 40;
const PRINT_LAST = 160;
/** A longer line is cut, saying so. */
const PRINT_WIDTH = 2_000;

/** What the print reads of a case's context: whether the case passed (Node 22's TestContext.passed), and its diagnostic. */
interface CaseContext {
  passed?: unknown;
  diagnostic?: (message: string) => void;
}

/** When the case before this one ended: the window of a failed case's print starts there. */
let caseFrom = Date.now();

afterEach(async (context) => {
  const t = context as unknown as CaseContext;
  const ends = started.map((s) => s.lines.length);
  const now = Date.now();
  try {
    if (t.passed === false) {
      const say = (m: string) => t.diagnostic?.(m);
      const databases = new Set<string>();
      for (const s of started) {
        if ((await printCourier(say, s)) && s.databaseUrl !== undefined) databases.add(s.databaseUrl);
      }
      for (const url of databases) await printRecords(say, url, caseFrom, started.find((s) => s.databaseUrl === url)?.withheld ?? []);
      await printJournals(say, caseFrom, now);
    }
  } catch (err) {
    try {
      t.diagnostic?.(`the couriers' print failed (${err instanceof Error ? err.name : typeof err}); the case's own failure stands`);
    } catch {
      // Nothing more is said.
    }
  } finally {
    started.forEach((s, i) => {
      s.from = ends[i] ?? s.lines.length;
    });
    caseFrom = Date.now();
  }
});

/** One courier's print for a failed case: its lines since the case before ended, and its status while it runs. Says whether it printed. */
async function printCourier(say: (message: string) => void, s: Started): Promise<boolean> {
  const running = s.child.exitCode === null && s.child.signalCode === null;
  const from = s.from <= s.lines.length ? s.from : 0;
  const end = s.lines.length;
  if (end === from && !running) return false;
  const state = running ? 'running' : `exited (${s.child.signalCode ?? s.child.exitCode})`;
  say(`the courier ${s.number} (${s.entry}, process ${s.child.pid ?? 'without an id'}, ${state}): ${end - from} line${end - from === 1 ? '' : 's'} since the case before this one ended`);
  const cut = end - from > PRINT_FIRST + PRINT_LAST;
  const headEnd = cut ? from + PRINT_FIRST : end;
  const tailStart = cut ? end - PRINT_LAST : end;
  const show = (i: number) => say(`  ${clock(s.times[i])} ${printable(s.lines[i] ?? '', s.withheld)}`);
  for (let i = from; i < headEnd; i += 1) show(i);
  if (cut) say(`  … ${tailStart - headEnd} lines left out …`);
  for (let i = tailStart; i < end; i += 1) show(i);
  if (running && s.url !== null) {
    const status = await statusOf(s.url);
    say(`the courier ${s.number}'s status: ${printable(status.text, s.withheld)}`);
    if (status.shutLines.length > 0) say(`the courier ${s.number}'s lane shut by: ${printable(await linesOf(s.databaseUrl, status.shutLines), s.withheld)}`);
    if (status.node !== null && status.node.usable === false && !s.checkPrinted) {
      s.checkPrinted = true;
      printCheckWhole(say, s, status.node);
    }
  }
  return true;
}

/** The node check made at the courier's start, whole: every part with its verdict, the passing ones too; and the requests it made, each with its times and the block it named. */
function printCheckWhole(say: (message: string) => void, s: Started, node: Record<string, unknown> & { verdicts?: unknown }): void {
  const part = (v: unknown) => (typeof v === 'object' && v !== null ? `${(v as { ok?: unknown }).ok === true ? 'passed' : 'FAILED'}: ${String((v as { saw?: unknown }).saw)}` : String(v));
  say(`the courier ${s.number}'s node check, whole: usable ${String(node.usable)}; made at ${String(node.checkedAt)}; latest ${JSON.stringify(node.latest)}; back ${JSON.stringify(node.back)}`);
  for (const v of Array.isArray(node.verdicts) ? (node.verdicts as Array<Record<string, unknown>>) : []) {
    say(`  ${String(v.request)}: at latest ${part(v.atLatest)}; at the block back ${part(v.atBlockBack)}; at the unknown hash ${part(v.atUnknownHash)}`);
  }
  for (const name of ['relaySenderSlot', 'overrideTaken', 'timedCall', 'finalized', 'baseFee', 'tip', 'trace']) say(`  ${name}: ${part(node[name])}`);
  const to = s.listeningAt ?? Date.now();
  for (const j of allJournals()) {
    const made = j.entries.filter((e) => e.arrivedAt >= s.launchedAt && e.arrivedAt <= to);
    if (made.length === 0) continue;
    say(`the requests the courier ${s.number} made at its start, through ${j.label}, from ${clock(s.launchedAt)} to ${clock(to)}: ${made.length}`);
    for (const e of made.slice(0, 120)) say(`  ${entryLine(e)}`);
    if (made.length > 120) say(`  … ${made.length - 120} more left out …`);
  }
}

/** One request of a journal, as printed: its number, times, method, the block or transaction it named, how, and what its answer said. */
function entryLine(e: JournalEntry): string {
  return printable(`#${e.n} ${clock(e.arrivedAt)} to ${e.answeredAt === null ? 'not answered' : clock(e.answeredAt)} ${e.method}${e.named === null ? '' : ` at ${e.named}`}: ${e.how}${e.answer === null ? '' : `, ${e.answer}`}`, []);
}

/** The reads a failed case prints from each journal, in order: the key's count, a block's header, and a receipt. */
const READS = new Set(['eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionReceipt']);

/** Each proxy's journal in the case's window: its rule changes, with any request that crossed one, and the courier's reads. */
async function printJournals(say: (message: string) => void, from: number, to: number): Promise<void> {
  for (const j of allJournals()) {
    const changes = j.rules.filter((r) => r.at >= from && r.at <= to);
    const reads = j.entries.filter((e) => e.arrivedAt >= from && e.arrivedAt <= to && READS.has(e.method));
    if (changes.length === 0 && reads.length === 0) continue;
    say(`${j.label}: ${changes.length} change${changes.length === 1 ? '' : 's'} of its rules and ${reads.length} read${reads.length === 1 ? '' : 's'} of a count, a header or a receipt in the case`);
    for (const r of changes) {
      const held = r.finalNumber === undefined ? '' : `; block ${r.finalNumber}'s hash on the chain now: ${(await j.blockHash(r.finalNumber)) ?? 'not read'}`;
      say(printable(`  ${clock(r.at)} the rule changed: ${r.what}${held}`, []));
      for (const e of j.entries.filter((x) => x.arrivedAt < r.at && (x.answeredAt === null || x.answeredAt > r.at))) say(`    crossed it: ${entryLine(e)}`);
    }
    const cut = reads.length > PRINT_FIRST + PRINT_LAST;
    const shown = cut ? [...reads.slice(0, PRINT_FIRST), null, ...reads.slice(reads.length - PRINT_LAST)] : reads;
    for (const e of shown) say(e === null ? `  … ${reads.length - PRINT_FIRST - PRINT_LAST} reads left out …` : `  ${entryLine(e)}`);
  }
}

/** From a courier's database: each lane's row, and each Cross made since `from` or open or held in a lane, with the nonce proof its send recorded. */
async function printRecords(say: (message: string) => void, databaseUrl: string, from: number, withheld: Array<[string, string]>): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  try {
    await client.connect();
    const lanes = await client.query(
      `SELECT sender, epoch::text AS epoch, owner_run::text AS owner_run, held_bet, reservation::text AS reservation, open_cross, reserved_at, shut_line::text AS shut_line,
              verified_nonce_to::text AS verified_nonce_to, verified_block_number::text AS verified_block_number, verified_block_hash
       FROM lanes ORDER BY sender`,
    );
    for (const r of lanes.rows) say(printable(`the lane, from the courier's database: ${JSON.stringify(r)}`, withheld));
    const crosses = await client.query(
      `SELECT bet_hash, lane, epoch::text AS epoch, reservation::text AS reservation, state, nonce::text AS nonce, tx_hash, hand_offs, node_answer,
              block_number::text AS pre_check_block, block_hash AS pre_check_hash, checked -> 'send' -> 'nonce' AS nonce_proof,
              receipt_block_number::text AS receipt_block, receipt_block_hash, final_block_number::text AS final_block, final_block_hash, not_sent_reason, created_at
       FROM crosses
       WHERE created_at >= to_timestamp($1::double precision / 1000)
          OR bet_hash IN (SELECT open_cross FROM lanes WHERE open_cross IS NOT NULL UNION SELECT held_bet FROM lanes WHERE held_bet IS NOT NULL)
       ORDER BY created_at LIMIT 10`,
      [from],
    );
    for (const r of crosses.rows) say(printable(`a Cross, from the courier's database: ${JSON.stringify(r)}`, withheld));
    if (crosses.rows.length === 0) say("no Cross was made in the case, and none is open or held in a lane, by the courier's database");
  } catch (err) {
    say(`the courier's database not read: ${err instanceof Error ? err.name : typeof err}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The time a line arrived, UTC, to the millisecond. */
function clock(ms: number | undefined): string {
  return ms === undefined ? '--:--:--.---' : new Date(ms).toISOString().slice(11, 23);
}

/** A courier's key settings, as the print withholds them: only values long enough not to be found by chance. */
function withheldOf(env: Record<string, string | undefined>): Array<[string, string]> {
  const named: Array<[string, string | undefined]> = [
    ['the keystore', env.COURIER_KEYSTORE_JSON],
    ['the keystore password', env.COURIER_KEYSTORE_PASSWORD],
  ];
  return named.filter((n): n is [string, string] => typeof n[1] === 'string' && n[1].length >= 8);
}

/**
 * A line as printed. CI's log is public: a value the courier was handed for its key never goes into it, nor a URL's
 * user and password, though no line of the courier's is known to carry either.
 */
function printable(line: string, withheld: Array<[string, string]>): string {
  let out = line;
  for (const [name, value] of withheld) out = out.split(value).join(`<${name}>`);
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<user and password>@');
  return out.length > PRINT_WIDTH ? `${out.slice(0, PRINT_WIDTH)} … (${out.length - PRINT_WIDTH} characters cut)` : out;
}

/** What the print reads of the status: the node check, and the lane. */
interface StatusRead {
  node?: (Record<string, unknown> & { verdicts?: unknown }) | null;
  sender?: { lane?: unknown; lanes?: unknown; restoreHold?: unknown };
}

/**
 * The status address, read once with a wait of 5 seconds: the node check's parts that did not pass, and the lane; and
 * the numbers of the lines that shut a lane, or the database, where any did.
 */
async function statusOf(url: string): Promise<{ text: string; shutLines: number[]; node: (Record<string, unknown> & { verdicts?: unknown }) | null }> {
  let answered: number | null = null;
  try {
    const res = await fetch(`${url}/v1/status`, { signal: AbortSignal.timeout(5_000) });
    answered = res.status;
    const text = await res.text();
    let body: StatusRead;
    try {
      body = JSON.parse(text) as StatusRead;
    } catch {
      return { text: `answered ${answered}, not as JSON: ${text.slice(0, 300)}`, shutLines: [], node: null };
    }
    const lineOf = (v: unknown): number | null => {
      const line = typeof v === 'object' && v !== null ? (v as { line?: unknown }).line : undefined;
      return typeof line === 'number' && Number.isSafeInteger(line) ? line : null;
    };
    const lanesRead = body.sender?.lanes;
    const lanes = Array.isArray(lanesRead) ? (lanesRead as unknown[]) : [];
    const shutLines = [...new Set([...lanes.map((l) => lineOf(typeof l === 'object' && l !== null ? (l as { shut?: unknown }).shut : null)), lineOf(body.sender?.restoreHold)])].filter((n): n is number => n !== null);
    const node = body.node ?? null;
    const notOk = (v: unknown): boolean => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
    const nodeCheck =
      node === null
        ? null
        : {
            usable: node.usable,
            checkedAt: node.checkedAt,
            latest: node.latest,
            back: node.back,
            failing: {
              ...Object.fromEntries(Object.entries(node).filter(([, v]) => notOk(v))),
              verdicts: (Array.isArray(node.verdicts) ? (node.verdicts as unknown[]) : []).filter((v) => typeof v === 'object' && v !== null && Object.values(v as Record<string, unknown>).some(notOk)),
            },
          };
    return { text: JSON.stringify({ answered, nodeCheck, lane: body.sender?.lane ?? null, lanes: body.sender?.lanes ?? null, restoreHold: body.sender?.restoreHold ?? null }), shutLines, node };
  } catch (err) {
    return { text: `not read${answered === null ? '' : ` (answered ${answered})`}: ${err instanceof Error ? err.name : typeof err}`, shutLines: [], node: null };
  }
}

/** The lines of these numbers, read whole from the courier's database with a wait of 5 seconds: when, what, why, and their facts. */
async function linesOf(databaseUrl: string | undefined, numbers: number[]): Promise<string> {
  if (databaseUrl === undefined) return 'not read: the courier was given no database';
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  try {
    await client.connect();
    // Ordered by the column itself, a number: the text output has a name of its own, so the order is never by text.
    const { rows } = await client.query<{ line: string; at: Date; kind: string; reason: string | null; facts: unknown }>(
      'SELECT number::text AS line, at, kind, reason, facts FROM events WHERE number = ANY($1::bigint[]) ORDER BY number',
      [numbers],
    );
    return JSON.stringify(rows.map((r) => ({ line: Number(r.line), at: r.at.toISOString(), kind: r.kind, reason: r.reason, facts: r.facts })));
  } catch (err) {
    return `not read: ${err instanceof Error ? err.name : typeof err}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The test's end of the hooks' channel. */
function control(child: ChildProcess, lines: () => readonly string[]): HookControl {
  let id = 0;
  const acks = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  const helds: Held[] = [];
  const waiters: Array<{ point: HoldPoint | undefined; resolve: (h: Held) => void; reject: (err: Error) => void }> = [];
  const observed: HookControl['observed'] = [];
  const signed: Hex[] = [];
  const attempts: HookControl['attempts'] = [];
  const tampered: HookControl['tampered'] = [];
  // A courier that exits while the test waits on it fails the wait at once, saying how it exited and its last lines:
  // a hold it can no longer reach, or an acknowledgement it can no longer send, is never waited for.
  let gone: Error | null = null;
  child.once('exit', (code, signal) => {
    const err = new Error(`the courier exited (${signal ?? code}) while the test waited on it; its last lines: ${lines().slice(-8).join(' | ')}`);
    gone = err;
    for (const w of waiters.splice(0)) w.reject(err);
    for (const a of acks.values()) a.reject(err);
    acks.clear();
  });
  child.on('message', (raw: unknown) => {
    const m = raw as {
      type: string;
      id?: number;
      held?: number;
      point?: HoldPoint;
      bet?: Hex | null;
      what?: 'candidates' | 'walk input';
      hashes?: string[];
      raw?: Hex;
      sealed?: HookControl['attempts'][number]['sealed'];
      how?: string;
      result?: string;
    };
    if (m.type === 'signed' && m.raw !== undefined) {
      signed.push(m.raw);
      attempts.push({ raw: m.raw, sealed: m.sealed ?? null });
    } else if (m.type === 'tampered') {
      tampered.push({ how: m.how ?? '', result: m.result ?? '' });
    } else if (m.type === 'ack' && m.id !== undefined) {
      acks.get(m.id)?.resolve();
      acks.delete(m.id);
    } else if (m.type === 'held') {
      const h: Held = { held: m.held as number, point: m.point as HoldPoint, bet: m.bet ?? null };
      const w = waiters.findIndex((x) => x.point === undefined || x.point === h.point);
      if (w >= 0) waiters.splice(w, 1)[0]?.resolve(h);
      else helds.push(h);
    } else if (m.type === 'observe') {
      observed.push({ what: m.what as 'candidates' | 'walk input', hashes: m.hashes ?? [] });
    }
  });
  const ask = (m: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      if (gone !== null) return reject(gone);
      const n = ++id;
      acks.set(n, { resolve, reject });
      child.send({ ...m, id: n }, (err) => {
        if (err !== null) {
          acks.delete(n);
          reject(err);
        }
      });
    });
  return {
    arm: (point, times = 1) => ask({ type: 'arm', point, times }),
    disarm: (point) => ask({ type: 'disarm', point }),
    reached(point) {
      const i = helds.findIndex((h) => point === undefined || h.point === point);
      if (i >= 0) return Promise.resolve(helds.splice(i, 1)[0] as Held);
      if (gone !== null) return Promise.reject(gone);
      return new Promise<Held>((resolve, reject) => waiters.push({ point, resolve, reject }));
    },
    go: (held) => ask({ type: 'go', held: held.held }),
    fault: (f) =>
      ask({
        type: 'fault',
        ...(f.skewPull === undefined ? {} : { skewPull: Object.fromEntries(Object.entries(f.skewPull).map(([k, v]) => [k, v.toString()])) }),
        ...(f.listAsLive === undefined ? {} : { listAsLive: f.listAsLive }),
        ...(f.transactionGasCap === undefined ? {} : { transactionGasCap: f.transactionGasCap === null ? null : f.transactionGasCap.toString() }),
        ...(f.unhashBeforeSeal === undefined ? {} : { unhashBeforeSeal: f.unhashBeforeSeal }),
        ...(f.signer === undefined
          ? {}
          : {
              signer: {
                ...(f.signer.substitute === undefined ? {} : { substitute: f.signer.substitute }),
                ...(f.signer.tamper === undefined ? {} : { tamper: f.signer.tamper }),
                ...(f.signer.envelope === undefined
                  ? {}
                  : { envelope: f.signer.envelope === null ? null : { ...(f.signer.envelope.to === undefined ? {} : { to: f.signer.envelope.to }), ...(f.signer.envelope.value === undefined ? {} : { value: f.signer.envelope.value.toString() }) } }),
              },
            }),
      }),
    observed,
    signed,
    attempts,
    tampered,
  };
}

export class CourierDidNotStart extends Error {
  constructor(
    readonly line: string,
    readonly lines: string[],
  ) {
    super(line);
    this.name = 'CourierDidNotStart';
  }
}

/** GET a path on the courier, from this machine. */
export async function get(url: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${url}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: res.headers };
}
