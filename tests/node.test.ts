import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { MULTICALL_ADDRESS } from '../courier/chain/abi';
import { checkNode, UNKNOWN_HASH } from '../courier/chain/node';
import { createJsonRpc, headerByTag, type JsonRpc } from '../courier/chain/rpc';
import { startProxy, type ChainProxy } from './support/proxy';
import { startRig, type Rig } from './support/rig';

// What the node can do, proved on the rig through the proxy: each request at
// the latest block's hash, at the hash of a block 50 back, and at a hash no
// block has; the override; the finalized tag. Then the proxy stands in for a
// node that will not: one that refuses a method at a hash, and one that
// ignores the hash and answers at its head, which the multicall probe catches.

let rig: Rig;
let proxy: ChainProxy;
let rpc: JsonRpc;
const run = promisify(execFile);
const ROOT = new URL('../', import.meta.url);

before(async () => {
  rig = await startRig();
  proxy = await startProxy(rig.url);
  rpc = createJsonRpc(proxy.url);
});

after(async () => {
  await proxy?.close();
  await rig?.close();
});

/**
 * What the node must prove at start, as the design has it: one request to a line. Each line is the method, what it
 * reads, and the block it names: the latest block's hash, the hash 50 back, or the hash no block has.
 */
const PROVED_AT_START = [
  // Each request the pre-check makes, three ways, as the check made them before the key's address was its sender.
  'eth_call the multicall contract at latest',
  'eth_call the multicall contract at back',
  'eth_call the multicall contract at unknown',
  'eth_getTransactionCount the sender at latest',
  'eth_getTransactionCount the sender at back',
  'eth_getTransactionCount the sender at unknown',
  'eth_call the relay, from the sender at latest',
  'eth_call the relay, from the sender at back',
  'eth_call the relay, from the sender at unknown',
  'eth_estimateGas the relay, from the sender at latest',
  'eth_estimateGas the relay, from the sender at back',
  'eth_estimateGas the relay, from the sender at unknown',
  // The relay's storage slot 0 held to the relay's sender, both read at the latest block's hash.
  "eth_getStorageAt the relay's slot 0 at latest",
  "eth_call the relay's sender at latest",
  // The override: the relay's slot 0 set to the multicall contract for one call, and the sender read back.
  'eth_call the relay, slot 0 overridden at latest',
  // A call whose answer depends on the block's time, at two hashes of two times: it succeeds at the older block, and
  // its estimate and the call at the estimated limit name the same hash; from the later block's time it is refused,
  // and so is its estimate.
  'eth_call the timed code at back',
  'eth_estimateGas the timed code at back',
  "eth_call the timed code, at the estimate's limit at back",
  'eth_call the timed code at latest',
  'eth_estimateGas the timed code at latest',
];

test('the local chain honours every request at a block\'s hash, refuses a hash no block has, and takes an override', async () => {
  // Each request's parameters as they reached the proxy, which passes them on unchanged.
  const seen: Array<{ method: string; params: unknown[] }> = [];
  for (const method of ['eth_call', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_getStorageAt']) {
    proxy.rule(method, { kind: 'rewrite', params: (params) => (seen.push({ method, params }), params) });
  }
  let check: Awaited<ReturnType<typeof checkNode>>;
  try {
    check = await checkNode(rpc, { relay: rig.addresses.relay, sender: rig.accounts.sender.address });
  } finally {
    proxy.clear();
  }
  assert.equal(check.usable, true, JSON.stringify(check, null, 1));
  assert.equal(check.verdicts.length, 4);
  for (const v of check.verdicts) {
    assert.equal(v.atLatest.ok, true, v.request);
    assert.equal(v.atBlockBack.ok, true, v.request);
    assert.equal(v.atUnknownHash.ok, true, v.request);
    assert.match(v.atUnknownHash.saw, /^refused/);
  }
  assert.equal(BigInt(check.back?.number ?? '0'), BigInt(check.latest?.number ?? '0') - 50n);
  assert.equal(check.overrideTaken.ok, true, check.overrideTaken.saw);
  assert.equal(check.finalized.ok, true, check.finalized.saw);
  // The calls went through the proxy, as the list above gives them: eth_call 11, eth_estimateGas 5,
  // eth_getStorageAt 1, eth_getTransactionCount 3.
  const listed = (method: string) => PROVED_AT_START.filter((l) => l.startsWith(`${method} `)).length;
  assert.deepEqual(
    { eth_call: listed('eth_call'), eth_estimateGas: listed('eth_estimateGas'), eth_getStorageAt: listed('eth_getStorageAt'), eth_getTransactionCount: listed('eth_getTransactionCount') },
    { eth_call: 11, eth_estimateGas: 5, eth_getStorageAt: 1, eth_getTransactionCount: 3 },
  );
  assert.equal(proxy.count('eth_call'), 11);
  assert.equal(proxy.count('eth_estimateGas'), 5);
  assert.equal(proxy.count('eth_getStorageAt'), 1);
  assert.equal(proxy.count('eth_getTransactionCount'), 3);
  // The headers: latest, the block 50 back, finalized.
  assert.equal(proxy.count('eth_getBlockByNumber'), 3);
  // Each request named its block by a hash, required canonical, and is the one the list names: the old ones and the
  // new ones alike. A block named any other way reads as NOT BY HASH.
  const latestHash = check.latest?.hash.toLowerCase();
  const backHash = check.back?.hash.toLowerCase();
  const lower = (a: unknown) => (typeof a === 'string' ? a.toLowerCase() : a);
  const blockOf = (ref: unknown): string => {
    const r = ref as { blockHash?: string; requireCanonical?: boolean } | undefined;
    if (r === undefined || r === null || typeof r !== 'object' || r.requireCanonical !== true || typeof r.blockHash !== 'string') return `NOT BY HASH: ${JSON.stringify(ref)}`;
    const h = r.blockHash.toLowerCase();
    return h === latestHash ? 'latest' : h === backHash ? 'back' : h === UNKNOWN_HASH.toLowerCase() ? 'unknown' : `another hash ${h}`;
  };
  const what = ({ method, params }: { method: string; params: unknown[] }): string => {
    const call = params[0] as { from?: string; to?: string; gas?: string };
    if (method === 'eth_getTransactionCount') return lower(params[0]) === lower(rig.accounts.sender.address) ? 'the sender' : `the count of ${String(params[0])}`;
    if (method === 'eth_getStorageAt') return lower(params[0]) === lower(rig.addresses.relay) && BigInt(params[1] as string) === 0n ? "the relay's slot 0" : `the storage ${JSON.stringify(params.slice(0, 2))}`;
    if (call.to === undefined) return `the timed code${call.gas === undefined ? '' : ", at the estimate's limit"}`;
    if (lower(call.to) === lower(MULTICALL_ADDRESS)) return 'the multicall contract';
    if (lower(call.to) === lower(rig.addresses.relay)) {
      if (method === 'eth_call' && params[2] !== undefined) return 'the relay, slot 0 overridden';
      if (lower(call.from) === lower(rig.accounts.sender.address)) return 'the relay, from the sender';
      return "the relay's sender";
    }
    return `a call to ${call.to}`;
  };
  const at = (method: string, params: unknown[]) => blockOf(params[method === 'eth_getStorageAt' ? 2 : 1]);
  assert.deepEqual(seen.map((s) => `${s.method} ${what(s)} at ${at(s.method, s.params)}`).sort(), [...PROVED_AT_START].sort());
});

test('a node that refuses one method at a hash fails that verdict and no other, and the node is not usable', async () => {
  proxy.rule('eth_getTransactionCount', { kind: 'refuse', code: -32601, message: 'the method is not supported with a block hash' });
  try {
    const check = await checkNode(rpc, { relay: rig.addresses.relay, sender: rig.accounts.sender.address });
    assert.equal(check.usable, false);
    const count = check.verdicts.find((v) => v.request.startsWith('eth_getTransactionCount'));
    assert.ok(count);
    assert.deepEqual([count.atLatest.ok, count.atBlockBack.ok], [false, false]);
    assert.equal(count.atLatest.saw, 'refused (-32601)');
    assert.equal(count.atUnknownHash.ok, true, 'a refusal at the unknown hash is still the right answer there');
    for (const v of check.verdicts.filter((x) => x !== count)) assert.equal(v.atLatest.ok && v.atBlockBack.ok && v.atUnknownHash.ok, true, v.request);
  } finally {
    proxy.clear();
  }
});

test('a node that ignores the hash and answers at its head is caught by the multicall probe, and by nothing else', async () => {
  // The proxy rewrites every eth_call's block to "latest": the relay's read answers the same at both blocks, so only
  // the probe of the block's number, time and parent sees it, and only for the block 50 back.
  proxy.rule('eth_call', { kind: 'rewrite', params: (params) => [params[0], 'latest', ...params.slice(2)] });
  try {
    const check = await checkNode(rpc, { relay: rig.addresses.relay, sender: rig.accounts.sender.address });
    assert.equal(check.usable, false);
    const probe = check.verdicts.find((v) => v.request.startsWith('eth_call to the multicall'));
    assert.ok(probe);
    assert.equal(probe.atLatest.ok, true, 'at the latest block the head is the block named');
    assert.equal(probe.atBlockBack.ok, false);
    assert.equal(probe.atBlockBack.saw, 'state-mismatch');
    assert.equal(probe.atUnknownHash.ok, false, 'a node that answers for a hash no block has is caught too');
    const relay = check.verdicts.find((v) => v.request.startsWith('eth_call from the sender'));
    assert.equal(relay?.atBlockBack.ok, true, "the relay's own read cannot tell the blocks apart: that is why the probe exists");
  } finally {
    proxy.clear();
  }
});

test('the proxy answers the finalized tag with the block the test names', async () => {
  proxy.setFinal(10n);
  try {
    const final = await headerByTag(rpc, 'finalized');
    assert.equal(final.number, 10n);
    const latest = await headerByTag(rpc, 'latest');
    assert.ok(latest.number > 10n);
    assert.equal((await rig.publicClient.getBlock({ blockNumber: 10n })).hash, final.hash);
  } finally {
    proxy.setFinal(null);
  }
  assert.notEqual(UNKNOWN_HASH, (await headerByTag(rpc, 'latest')).hash);
});

test('check:node, run as its command, writes its record and exits by the verdict', async () => {
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, POLYGON_RPC_URL: proxy.url, SIGNPOST_ADDRESS: rig.addresses.signpost, BETTING_ENTRY_ID: rig.bettingEntryId.toString() };
  const runsDir = new URL('../runs/', import.meta.url);
  const before = new Set(listRuns(runsDir));
  try {
    const good = await run(process.execPath, ['--import', 'tsx', 'scripts/check-node.ts'], { cwd: ROOT, env });
    assert.match(good.stdout, /check:node: the node honours every request the pre-check makes; written to runs\//);
    const written = listRuns(runsDir).filter((f) => !before.has(f));
    assert.equal(written.length, 1, 'one record written');
    proxy.rule('eth_estimateGas', { kind: 'refuse', code: -32000, message: 'held for the test' });
    await assert.rejects(run(process.execPath, ['--import', 'tsx', 'scripts/check-node.ts'], { cwd: ROOT, env }), (err: unknown) => {
      const e = err as { code?: number; stdout?: string };
      assert.equal(e.code, 1);
      assert.match(e.stdout ?? '', /the node FAILS a request the pre-check needs/);
      return true;
    });
  } finally {
    proxy.clear();
    for (const f of listRuns(runsDir).filter((f) => !before.has(f))) rmSync(new URL(f, runsDir));
  }
});

function listRuns(dir: URL): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith('check-node-'));
  } catch {
    return [];
  }
}
