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

/** What the signer's seams do, as a test plants it: hand on another object, change the envelope, or nothing. */
interface SignerFault {
  /** Hand the signer a plain copy of the sealed send, which carries no mark; or the sealed send of an earlier reservation, kept here. */
  substitute?: 'look-alike' | 'earlier' | null;
  /** Try to change the sealed send in place before the signer reads it: its listed quotes reordered, one swapped for another, its gas. */
  tamper?: 'reorder' | 'swap' | 'gas' | null;
  /** The envelope's target or value, changed inside the signing path with every other input valid. */
  envelope?: { to?: string; value?: string } | null;
}

type Message =
  | { type: 'arm'; id: number; point: HoldPoint; times: number | 'all' }
  | { type: 'disarm'; id: number; point: HoldPoint }
  | { type: 'go'; id: number; held: number }
  | { type: 'fault'; id: number; skewPull?: Record<string, string>; listAsLive?: string[]; transactionGasCap?: string | null; unhashBeforeSeal?: boolean; signer?: SignerFault };

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
let unhash = false;
let signerFault: SignerFault = {};
/** The sealed sends the signer was handed, in order: the earlier one a substitution hands on. */
const handed: unknown[] = [];
/** The send the signer goes on with in its current attempt, as the seam handed it on: what that attempt's bytes are compared with. */
let signing: unknown = null;

/** The fields of a sealed send that its signed bytes must carry, as text, or null where the object has none of that shape. */
function sealedFields(x: unknown): { nonce: string; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string } | null {
  const s = x as { nonce?: unknown; gas?: { limit?: unknown }; maxFeePerGas?: unknown; maxPriorityFeePerGas?: unknown } | null;
  if (s === null || typeof s !== 'object') return null;
  const { nonce, maxFeePerGas, maxPriorityFeePerGas } = s;
  const limit = s.gas?.limit;
  if (typeof nonce !== 'bigint' || typeof limit !== 'bigint' || typeof maxFeePerGas !== 'bigint' || typeof maxPriorityFeePerGas !== 'bigint') return null;
  return { nonce: nonce.toString(), gasLimit: limit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString() };
}

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
    if (m.unhashBeforeSeal !== undefined) unhash = m.unhashBeforeSeal;
    if (m.signer !== undefined) signerFault = m.signer;
  }
  send({ type: 'ack', id: m.id });
});

/**
 * A try at changing the sealed send in place: each change is made as a caller would, and a frozen object refuses it.
 * Judged by its effect: 'changed' only where the send reads otherwise after the try.
 */
function tamperWith(checked: unknown, how: NonNullable<SignerFault['tamper']>): string {
  const c = checked as { resting: Array<{ hash: string }>; gas: { limit: bigint }; taking: { hash: string }; calldata: string };
  const seen = () => JSON.stringify({ resting: c.resting.map((r) => r.hash), limit: c.gas.limit.toString(), taking: c.taking.hash });
  const before = seen();
  try {
    if (how === 'reorder') c.resting.reverse();
    else if (how === 'swap') c.resting[0] = c.taking;
    else c.gas.limit = c.gas.limit - 1n;
  } catch (err) {
    return err instanceof TypeError ? 'refused: frozen' : 'refused';
  }
  return seen() === before ? 'unchanged' : 'changed';
}

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
  unhashBeforeSeal: () => unhash,
  signer: {
    handed: (checked) => {
      handed.push(checked);
      const f = signerFault;
      if (f.tamper !== undefined && f.tamper !== null) send({ type: 'tampered', how: f.tamper, result: tamperWith(checked, f.tamper) });
      signing = f.substitute === 'look-alike' ? structuredClone(checked) : f.substitute === 'earlier' && handed.length >= 2 ? handed[handed.length - 2] : checked;
      return signing;
    },
    envelope: (e) => {
      const f = signerFault.envelope;
      if (f === undefined || f === null) return e;
      return { ...e, ...(f.to === undefined ? {} : { to: f.to as `0x${string}` }), ...(f.value === undefined ? {} : { value: BigInt(f.value) }) };
    },
    // Every signed attempt, at once: its bytes go to the test over the channel, never to the process's output, beside
    // the fields of the sealed send the signer was handed for it, read as it signs.
    signed: (raw) => {
      send({ type: 'signed', raw, sealed: sealedFields(signing) });
      signing = null;
    },
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
