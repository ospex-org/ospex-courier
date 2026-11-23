import type { Hex } from 'viem';
import { HOLD_POINTS, type HoldPoint, type LaneHooks } from '../../courier/check/hooks';
import { StartupRefused, startService } from '../../courier/startup';

// The tests' start file: the courier's own entry (courier/server.ts), with the
// lane's hooks passed into the same service. The production start file passes
// none. The test that started this process drives the hooks over the IPC
// channel: it arms a hold point, is told when the check reaches it, and lets
// the check go on, or ends the process there. A point armed in the setting
// COURIER_TEST_HOLDS (`point:count,point:count`, count `all` for every time)
// is armed before the service starts, so the runner can be held at its first
// reach of it: the take's wake. The faults are planted over the channel too.

type Message =
  | { type: 'arm'; id: number; point: HoldPoint; times: number | 'all' }
  | { type: 'disarm'; id: number; point: HoldPoint }
  | { type: 'go'; id: number; held: number }
  | { type: 'fault'; id: number; skewPull?: Record<string, string>; listAsLive?: string[]; transactionGasCap?: string | null };

const send = (m: Record<string, unknown>) => process.send?.(m);

const armed = new Map<HoldPoint, number>();
for (const part of (process.env.COURIER_TEST_HOLDS ?? '').split(',').filter((p) => p !== '')) {
  const [point, count] = part.split(':') as [HoldPoint, string | undefined];
  if (!HOLD_POINTS.includes(point)) throw new Error(`COURIER_TEST_HOLDS names no hold point: ${point}`);
  armed.set(point, count === undefined ? 1 : count === 'all' ? Number.POSITIVE_INFINITY : Number(count));
}
const waiting = new Map<number, () => void>();
let heldCount = 0;
const skew = new Map<string, bigint>();
const live = new Set<string>();
let gasCap: bigint | undefined;

process.on('message', (raw: unknown) => {
  const m = raw as Message;
  if (m.type === 'arm') armed.set(m.point, m.times === 'all' ? Number.POSITIVE_INFINITY : m.times);
  else if (m.type === 'disarm') armed.delete(m.point);
  else if (m.type === 'go') {
    waiting.get(m.held)?.();
    waiting.delete(m.held);
  } else if (m.type === 'fault') {
    if (m.skewPull !== undefined) {
      skew.clear();
      for (const [q, d] of Object.entries(m.skewPull)) skew.set(q.toLowerCase(), BigInt(d));
    }
    if (m.listAsLive !== undefined) {
      live.clear();
      for (const q of m.listAsLive) live.add(q.toLowerCase());
    }
    if (m.transactionGasCap !== undefined) gasCap = m.transactionGasCap === null ? undefined : BigInt(m.transactionGasCap);
  }
  send({ type: 'ack', id: m.id });
});

const hooks: LaneHooks = {
  at(point: HoldPoint, bet: Hex | null): Promise<void> {
    const left = armed.get(point) ?? 0;
    if (left <= 0) return Promise.resolve();
    armed.set(point, left - 1);
    const held = ++heldCount;
    return new Promise<void>((resolve) => {
      waiting.set(held, resolve);
      send({ type: 'held', held, point, bet });
    });
  },
  skewPull: (quote) => skew.get(quote.toLowerCase()) ?? null,
  listAsLive: (quote) => live.has(quote.toLowerCase()),
  get transactionGasCap() {
    return gasCap;
  },
  observe: (what, hashes) => {
    send({ type: 'observe', what, hashes });
  },
};

const FORCED_EXIT_MS = 10_000;

startService(process.env, { hooks }).then(
  (service) => {
    console.log(`courier: listening on port ${service.port}, run ${service.run.id}`);
    const stop = (signal: string) => {
      console.log(`courier: stopping on ${signal}`);
      const forced = setTimeout(() => process.exit(1), FORCED_EXIT_MS);
      forced.unref();
      service.close(signal.toLowerCase()).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
    // The channel to the test must not keep this process alive past its own stop.
    process.channel?.unref();
  },
  (err: unknown) => {
    console.log(`courier did not start: ${err instanceof StartupRefused ? err.message : err instanceof Error ? err.name : String(err)}`);
    process.exitCode = 1;
    process.disconnect?.();
  },
);
