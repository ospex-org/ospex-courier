import { spawn, type ChildProcess } from 'node:child_process';

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
  PORT?: string;
  COURIER_LOW_POL?: string;
  PUBLISHED_REPORTERS_FILE?: string;
}

/** Starts the courier; resolves when it listens, or rejects with its refusal line when it does not start. */
export async function startCourier(env: CourierEnv): Promise<CourierProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'courier/server.ts'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The courier never outlives the test process; the listener leaves with the child, so a file that starts many
  // couriers does not pile listeners on the process.
  const onExit = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once('exit', onExit);
  child.once('exit', () => process.off('exit', onExit));
  const lines: string[] = [];
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
