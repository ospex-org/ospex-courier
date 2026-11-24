import { spawn, type ChildProcess } from 'node:child_process';
import type { Hex } from 'viem';
import type { HoldPoint } from '../../courier/check/hooks';

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
  /** Plants the test faults: a skew of one quote's predicted pull, quotes taken as live, a lower ceiling on one transaction's gas. */
  fault(f: { skewPull?: Record<string, bigint>; listAsLive?: string[]; transactionGasCap?: bigint | null }): Promise<void>;
  /** What the check observed at the boundary between the candidates and the listing, in order. */
  observed: Array<{ what: 'candidates' | 'walk input'; hashes: string[] }>;
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
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: '0', ...env },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
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
    lines.push(...parts.filter((l) => l !== ''));
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

/** The test's end of the hooks' channel. */
function control(child: ChildProcess, lines: () => readonly string[]): HookControl {
  let id = 0;
  const acks = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  const helds: Held[] = [];
  const waiters: Array<{ point: HoldPoint | undefined; resolve: (h: Held) => void; reject: (err: Error) => void }> = [];
  const observed: HookControl['observed'] = [];
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
    const m = raw as { type: string; id?: number; held?: number; point?: HoldPoint; bet?: Hex | null; what?: 'candidates' | 'walk input'; hashes?: string[] };
    if (m.type === 'ack' && m.id !== undefined) {
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
      }),
    observed,
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
