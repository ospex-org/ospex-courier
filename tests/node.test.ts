import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
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

test('the local chain honours every request at a block\'s hash, refuses a hash no block has, and takes an override', async () => {
  const check = await checkNode(rpc, { relay: rig.addresses.relay, sender: rig.accounts.sender.address });
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
  // The calls went through the proxy: the multicall probe three ways, the relay's read three ways, the override once.
  assert.equal(proxy.count('eth_call'), 7);
  assert.equal(proxy.count('eth_estimateGas'), 3);
  assert.equal(proxy.count('eth_getTransactionCount'), 3);
  // The headers: latest, the block 50 back, finalized.
  assert.equal(proxy.count('eth_getBlockByNumber'), 3);
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
