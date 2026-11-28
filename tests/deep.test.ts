import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Hex } from 'viem';
import { createJsonRpc, headerByNumber, NodeFailure, type Header, type JsonRpc } from '../courier/chain/rpc';
import { ChainUnreachable, createChainReader, type ChainReader } from '../courier/chain/snapshot';
import type { Conditions } from '../courier/records/conditions';
import { decisionAt, onFinalChain, stillFinal, type Named } from '../courier/send/chain';
import { closeEach } from './support/close';
import { startProxy, type ChainProxy, type Counted } from './support/proxy';
import { startRig, type Rig } from './support/rig';
import { walkedTo } from './support/walk';

// The method that shows a block on the final block F's chain (courier/send/chain.ts), run through the courier's own
// client and reader against a real chain behind the tests' proxy, with no courier running: which of its three paths
// each distance below F takes, and what each asks the node; identity at every distance; two recorded blocks at one
// height; a block above F; a header at another height, missing, refused, malformed, dropped or not answered in time, at
// the read by number and at the last check of F; a decision's reads kept to that decision; and the crossed history a
// provider can serve, with genuine headers of two branches of the rig's own chain, beside the earlier build's walk as
// the control. A deep header at about 41,000 blocks is read through the whole courier in tests/quiet-41000.test.ts.

let rig: Rig;
let proxy: ChainProxy;
let direct: JsonRpc;

before(async () => {
  rig = await startRig();
  await rig.mine(1_200);
  proxy = await startProxy(rig.url);
  direct = createJsonRpc(rig.url);
});

after(() => closeEach(() => proxy?.close(), () => rig?.close()));

/** The reader's outcomes go nowhere: these cases read the method, not the condition's bookkeeping. */
const conditions: Conditions = {
  applyFailure: async () => ({ opened: false }),
  applySuccess: async () => ({ cleared: false }),
  raise: async () => ({ opened: false, line: 0 }),
  open_: async () => [],
};

/** The courier's own client and reader on the proxy, with the client's time-out as given. */
function reader(on: ChainProxy = proxy, timeoutMs = 10_000): { rpc: JsonRpc; chain: ChainReader } {
  const rpc = createJsonRpc(on.url, timeoutMs);
  return { rpc, chain: createChainReader({ rpc, conditions, run: 1 }) };
}

/** A block's header read past the proxy, from the chain itself. */
async function block(n: bigint, on: JsonRpc = direct): Promise<Header> {
  const h = await headerByNumber(on, n);
  if (h === null) throw new Error(`no block ${n}`);
  return h;
}

const asNamed = (h: Header): Named => ({ number: h.number, hash: h.hash });
const hex = (n: bigint) => `0x${n.toString(16)}`;
const OTHER = `0x${'ab'.repeat(32)}` as Hex;

/** A height a request names by number; null for a tag or anything else. */
const numberedAt = (c: Counted): bigint | null => {
  const p = c.params?.[0];
  return c.method === 'eth_getBlockByNumber' && typeof p === 'string' && /^0x[0-9a-fA-F]+$/.test(p) ? BigInt(p) : null;
};
const since = (from: number, on: ChainProxy = proxy) => on.counted.slice(from);
const heightsRead = (cs: Counted[]) => cs.map(numberedAt).filter((n): n is bigint => n !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

test('the three paths, each by what it asks the node: a block at F\'s height compared with F and nothing asked; 1 to 256 below, one multicall at F\'s hash; 257 below and further, the header at each height by number, once each; then the last check, F\'s own height by number once', async () => {
  const { rpc, chain } = reader();
  const F = await block(BigInt((await rig.rpc('eth_blockNumber', [])) as string) - 1n);
  const distances = [0n, 1n, 255n, 256n, 257n, 300n, 1_000n];
  const named = await Promise.all(distances.map(async (d) => asNamed(await block(F.number - d))));
  const decision = decisionAt(F);
  const from = proxy.counted.length;
  assert.deepEqual(await onFinalChain(chain, rpc, decision, named), named.map(() => true));
  const seen = since(from);
  const calls = seen.filter((c) => c.method === 'eth_call');
  assert.equal(calls.length, 1, 'one multicall for the window');
  assert.equal(String((calls[0]?.params?.[1] as { blockHash?: string } | undefined)?.blockHash).toLowerCase(), F.hash.toLowerCase(), "at F's hash");
  assert.deepEqual(heightsRead(seen).map(String), [F.number - 1_000n, F.number - 300n, F.number - 257n].map(String), 'by number: 257, 300 and 1,000 below F, once each');
  assert.equal(seen.filter((c) => c.method === 'eth_getBlockByHash').length, 0, 'nothing by hash');
  assert.equal(seen.length, 4, JSON.stringify(seen.map((c) => c.method)));
  const again = proxy.counted.length;
  assert.equal(await stillFinal(chain, rpc, decision), true);
  assert.deepEqual(heightsRead(since(again)).map(String), [String(F.number)], "the last check: F's own height, by number, once");
  // A decision that read nothing by number needs no last check, and asks nothing for it.
  const windowOnly = decisionAt(F);
  await onFinalChain(chain, rpc, windowOnly, named.slice(0, 4));
  const none = proxy.counted.length;
  assert.equal(await stillFinal(chain, rpc, windowOnly), true);
  assert.equal(since(none).length, 0, 'no read for a decision with no deep read');
});

test("identity at every distance: a block at its height under another hash is not on F's chain, at F's height, 1, 256, 257 and 1,000 below; the block's own hash in capitals is", async () => {
  const { rpc, chain } = reader();
  const F = await block(BigInt((await rig.rpc('eth_blockNumber', [])) as string) - 1n);
  for (const d of [0n, 1n, 256n, 257n, 1_000n]) {
    const b = await block(F.number - d);
    const capitals = `0x${b.hash.slice(2).toUpperCase()}` as Hex;
    assert.deepEqual(await onFinalChain(chain, rpc, decisionAt(F), [{ number: b.number, hash: OTHER }, { number: b.number, hash: capitals }]), [false, true], `${d} below F`);
  }
});

test('two recorded blocks at one deep height, in one decision: the header there is read once, and only the block whose hash it has passes; a block above F is not comparable and asks nothing', async () => {
  const { rpc, chain } = reader();
  const F = await block(BigInt((await rig.rpc('eth_blockNumber', [])) as string) - 1n);
  const b = await block(F.number - 600n);
  const from = proxy.counted.length;
  assert.deepEqual(await onFinalChain(chain, rpc, decisionAt(F), [{ number: b.number, hash: OTHER }, asNamed(b), { number: b.number, hash: OTHER }]), [false, true, false]);
  assert.deepEqual(heightsRead(since(from)).map(String), [String(b.number)], 'one read at the height');
  const above = proxy.counted.length;
  assert.deepEqual(await onFinalChain(chain, rpc, decisionAt(F), [{ number: F.number + 1n, hash: OTHER }]), ['not comparable']);
  assert.equal(since(above).length, 0, 'nothing asked for a block above F');
});

test("a header returned at another height than the one asked: a contradiction, thrown as the node's own failure and never read again as if it were missing; at a deep height and at the last check of F alike", async () => {
  const { rpc, chain } = reader();
  const F = await block(BigInt((await rig.rpc('eth_blockNumber', [])) as string) - 1n);
  const b = await block(F.number - 500n);
  for (const at of [b.number, F.number]) {
    proxy.rule('eth_getBlockByNumber', { kind: 'rewriteResult', result: (p, result) => (typeof p[0] === 'string' && p[0] === hex(at) && result !== null ? { ...(result as Record<string, unknown>), number: hex(at - 1n) } : result) });
    try {
      const decision = decisionAt(F);
      const from = proxy.counted.length;
      const run = at === F.number ? (async () => (await onFinalChain(chain, rpc, decision, [asNamed(b)]), stillFinal(chain, rpc, decision)))() : onFinalChain(chain, rpc, decision, [asNamed(b)]);
      await assert.rejects(run, (err: unknown) => err instanceof NodeFailure && !(err instanceof ChainUnreachable) && /at another height/.test(err.message), 'a contradiction');
      assert.equal(heightsRead(since(from)).filter((n) => n === at).length, 1, 'asked once, never again');
    } finally {
      proxy.rule('eth_getBlockByNumber', null);
    }
  }
});

test('missing, refused, malformed, dropped or not answered in time, at the read by number and at the last check of F: once, the reader reads it again and the answer stands; twice, it is unavailable, never a false and never a proof', async () => {
  const { rpc, chain } = reader(proxy, 500);
  const F = await block(BigInt((await rig.rpc('eth_blockNumber', [])) as string) - 1n);
  const b = await block(F.number - 700n);
  type Fault = 'missing' | 'refused' | 'malformed' | 'dropped' | 'late';
  const faults: Fault[] = ['missing', 'refused', 'malformed', 'dropped', 'late'];
  for (const where of ['deep', 'last'] as const) {
    const at = where === 'deep' ? b.number : F.number;
    for (const fault of faults) {
      for (const times of [1, 2]) {
        if (fault === 'late' && times === 1) continue; // a late answer once is the client's time-out once, as a dropped one is
        const decision = decisionAt(F);
        // At the last check, the deep read first, answered whole: the fault is at F's own height alone.
        if (where === 'last') assert.deepEqual(await onFinalChain(chain, rpc, decision, [asNamed(b)]), [true]);
        let hit = 0;
        const picks = (p: unknown[]) => typeof p[0] === 'string' && p[0] === hex(at);
        let held: { release(): void } | null = null;
        if (fault === 'missing' || fault === 'malformed') {
          proxy.rule('eth_getBlockByNumber', { kind: 'rewriteResult', result: (p, result) => (picks(p) && hit++ < times ? (fault === 'missing' ? null : { ...(result as Record<string, unknown>), hash: 'not a hash' }) : result) });
        } else if (fault === 'refused') {
          proxy.rule('eth_getBlockByNumber', { kind: 'refuseIf', refuse: (p) => picks(p) && hit++ < times, code: -32000, message: 'header not found' });
        } else if (fault === 'dropped') {
          // Only the reads of this height are made from here, so the drop meets them alone.
          if (times === 1) proxy.dropNext('eth_getBlockByNumber');
          else proxy.drop('eth_getBlockByNumber');
        } else {
          held = proxy.hold('eth_getBlockByNumber', picks);
        }
        const from = proxy.counted.length;
        try {
          const run = where === 'deep' ? onFinalChain(chain, rpc, decision, [asNamed(b)]) : stillFinal(chain, rpc, decision);
          if (times === 1) assert.deepEqual(await run, where === 'deep' ? [true] : true, `${fault} once at ${where}: read again, and it stands`);
          else await assert.rejects(run, (err: unknown) => err instanceof ChainUnreachable, `${fault} twice at ${where}: unavailable`);
          assert.deepEqual(heightsRead(since(from)).map(String), [String(at), String(at)], `${fault} ${times === 1 ? 'once' : 'twice'} at ${where}: two attempts at the height, no more`);
        } finally {
          held?.release();
          proxy.rule('eth_getBlockByNumber', null);
        }
      }
    }
  }
});

test('a decision keeps its reads to itself: a deep header read once in a decision is not read again in it, and is read again in the next decision at the same F; the last check reads F\'s height at every call, and no check of one decision stands for another', async () => {
  const { rpc, chain } = reader();
  const F = await block(BigInt((await rig.rpc('eth_blockNumber', [])) as string) - 1n);
  const b = asNamed(await block(F.number - 800n));
  const first = decisionAt(F);
  const from = proxy.counted.length;
  await onFinalChain(chain, rpc, first, [b]);
  await onFinalChain(chain, rpc, first, [b]);
  assert.equal(heightsRead(since(from)).length, 1, 'once in the decision');
  const second = decisionAt(F);
  await onFinalChain(chain, rpc, second, [b]);
  assert.equal(heightsRead(since(from)).length, 2, 'again in the next');
  const checks = proxy.counted.length;
  await stillFinal(chain, rpc, first);
  await stillFinal(chain, rpc, first);
  await stillFinal(chain, rpc, second);
  assert.deepEqual(heightsRead(since(checks)).map(String), [F.number, F.number, F.number].map(String), "F's height read at each of the three checks");
});

// ── The crossed history: genuine headers of two branches of one chain ──────────────────────────────────────────────

interface Branches {
  rig: Rig;
  proxy: ChainProxy;
  s: bigint;
  /** Branch B's raw blocks, as the chain answered them before it was reverted, by height and by hash. */
  B: Map<bigint, Record<string, unknown>>;
  BbyHash: Map<string, Record<string, unknown>>;
}
let branches: Branches | null = null;

/** A chain with two genuine branches of 300 blocks from height s: B mined and read whole, then reverted; A mined in its place, the chain's canonical one. */
async function twoBranches(): Promise<Branches> {
  if (branches !== null) return branches;
  const r = await startRig();
  const s = BigInt((await r.rpc('eth_blockNumber', [])) as string);
  const snapshot = await r.rpc('evm_snapshot', []);
  await r.rpc('anvil_mine', ['0x12c', '0x1']);
  const B = new Map<bigint, Record<string, unknown>>();
  const BbyHash = new Map<string, Record<string, unknown>>();
  for (let n = s + 1n; n <= s + 300n; n++) {
    const raw = (await r.rpc('eth_getBlockByNumber', [hex(n), false])) as Record<string, unknown>;
    B.set(n, raw);
    BbyHash.set(String(raw.hash).toLowerCase(), raw);
  }
  assert.equal(await r.rpc('evm_revert', [snapshot]), true, 'branch B reverted');
  const t = BigInt(((await r.rpc('eth_getBlockByNumber', ['latest', false])) as { timestamp: Hex }).timestamp);
  await r.rpc('evm_setNextBlockTimestamp', [Number(t + 7n)]);
  await r.rpc('anvil_mine', ['0x12c', '0x1']);
  const p = await startProxy(r.url);
  branches = { rig: r, proxy: p, s, B, BbyHash };
  return branches;
}

after(async () => {
  if (branches !== null) await closeEach(() => branches?.proxy.close(), () => branches?.rig.close());
});

const headerOfRaw = (raw: Record<string, unknown>): Named => ({ number: BigInt(String(raw.number)), hash: String(raw.hash) as Hex });

test("the crossed history the method gives up, recorded as the trust it accepts and not as a detection: F and its parents from branch A, the recorded block from branch B at its height, F's height from A again; the method accepts the block, and the earlier build's walk, kept in the tests' support, refuses it; the proxy shows which branch answered each request", async () => {
  const x = await twoBranches();
  const height = x.s + 10n;
  const fromB = x.B.get(height) as Record<string, unknown>;
  const onA = await block(height, createJsonRpc(x.rig.url));
  assert.notEqual(onA.hash.toLowerCase(), String(fromB.hash).toLowerCase(), 'two genuine branches: A and B differ at the height');
  const F = await block(x.s + 299n, createJsonRpc(x.rig.url));
  // The crossed provider: the recorded height answered by B's block, every other request by the chain, A. The rule
  // says which requests it answered from B.
  const fromBranchB: string[] = [];
  x.proxy.rule('eth_getBlockByNumber', {
    kind: 'rewriteResult',
    result: (p, result) => {
      if (p[0] !== hex(height)) return result;
      fromBranchB.push(String(p[0]));
      return fromB;
    },
  });
  try {
    const { rpc, chain } = reader(x.proxy);
    const from = x.proxy.counted.length;
    const decision = decisionAt(F);
    assert.deepEqual(await onFinalChain(chain, rpc, decision, [headerOfRaw(fromB)]), [true], "the method accepts B's block: the provider's coherence is what it trusts");
    assert.equal(await stillFinal(chain, rpc, decision), true, "F's height still F, from A");
    const seen = since(from, x.proxy);
    assert.deepEqual(heightsRead(seen).map(String), [String(height), String(F.number)], 'the recorded height, then F\'s');
    assert.deepEqual(fromBranchB, [hex(height)], 'the recorded height answered from B, and F\'s from the chain, A');
    assert.equal(await walkedTo(rpc, F, headerOfRaw(fromB)), false, "the earlier build's walk, from A's F by its parents, refuses B's block");
    assert.equal(await walkedTo(rpc, F, { number: onA.number, hash: onA.hash }), true, "and the walk's control: A's own block at that height is F's ancestor");
  } finally {
    x.proxy.rule('eth_getBlockByNumber', null);
  }
});

test("the crossed history that the last check does catch: the provider answers F's own height from branch B when it is read again; the decision is not accepted", async () => {
  const x = await twoBranches();
  const height = x.s + 10n;
  const F = await block(x.s + 299n, createJsonRpc(x.rig.url));
  const fromB = x.B.get(height) as Record<string, unknown>;
  const FfromB = x.B.get(F.number) as Record<string, unknown>;
  x.proxy.rule('eth_getBlockByNumber', { kind: 'rewriteResult', result: (p, result) => (p[0] === hex(height) ? fromB : p[0] === hex(F.number) ? FfromB : result) });
  try {
    const { rpc, chain } = reader(x.proxy);
    const decision = decisionAt(F);
    assert.deepEqual(await onFinalChain(chain, rpc, decision, [headerOfRaw(fromB)]), [true]);
    assert.equal(await stillFinal(chain, rpc, decision), false, "F's height answered by another block: not accepted");
  } finally {
    x.proxy.rule('eth_getBlockByNumber', null);
  }
});

test("a backend that lacks the recorded height, honest and behind: the read is missing on both attempts, so the decision is unavailable and holds; never a false, never a contradiction", async () => {
  const x = await twoBranches();
  const height = x.s + 10n;
  const F = await block(x.s + 299n, createJsonRpc(x.rig.url));
  const onA = await block(height, createJsonRpc(x.rig.url));
  x.proxy.rule('eth_getBlockByNumber', { kind: 'rewriteResult', result: (p, result) => (p[0] === hex(height) ? null : result) });
  try {
    const { rpc, chain } = reader(x.proxy);
    await assert.rejects(onFinalChain(chain, rpc, decisionAt(F), [{ number: onA.number, hash: onA.hash }]), (err: unknown) => err instanceof ChainUnreachable, 'unavailable');
  } finally {
    x.proxy.rule('eth_getBlockByNumber', null);
  }
});

test("a provider false the same way in every answer, serving branch B whole, F among it: neither the method nor the earlier build's walk can tell, and this case claims no detection; both accept B's block", async () => {
  const x = await twoBranches();
  const height = x.s + 10n;
  const fromB = x.B.get(height) as Record<string, unknown>;
  const FfromB = x.B.get(x.s + 299n) as Record<string, unknown>;
  x.proxy.rule('eth_getBlockByNumber', {
    kind: 'rewriteResult',
    result: (p, result) => {
      const n = typeof p[0] === 'string' && /^0x[0-9a-fA-F]+$/.test(p[0]) ? BigInt(p[0]) : null;
      return n !== null && x.B.has(n) ? (x.B.get(n) as Record<string, unknown>) : result;
    },
  });
  x.proxy.rule('eth_getBlockByHash', { kind: 'rewriteResult', result: (p, result) => x.BbyHash.get(String(p[0]).toLowerCase()) ?? result });
  try {
    const { rpc, chain } = reader(x.proxy);
    const F: Header = { number: BigInt(String(FfromB.number)), hash: String(FfromB.hash) as Hex, parentHash: String(FfromB.parentHash) as Hex, timestamp: BigInt(String(FfromB.timestamp)), gasLimit: BigInt(String(FfromB.gasLimit)) };
    const decision = decisionAt(F);
    assert.deepEqual(await onFinalChain(chain, rpc, decision, [headerOfRaw(fromB)]), [true]);
    assert.equal(await stillFinal(chain, rpc, decision), true);
    assert.equal(await walkedTo(rpc, F, headerOfRaw(fromB)), true, 'the walk too');
  } finally {
    x.proxy.rule('eth_getBlockByNumber', null);
    x.proxy.rule('eth_getBlockByHash', null);
  }
});
