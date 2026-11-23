import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { encodeFunctionData, keccak256, toBytes, type Hex } from 'viem';
import { MULTICALL_ABI, MULTICALL_ADDRESS, RELAY_ABI } from '../courier/chain/abi';
import { byHash, callAt, createJsonRpc, estimateGasAt, ExecutionReverted, headerByTag, NodeFailure, OutOfGas } from '../courier/chain/rpc';
import { decodeRevert } from '../courier/check/decode';
import { startProxy, type ChainProxy } from './support/proxy';
import { startRig, type Rig } from './support/rig';

// The bet's check, from what a user would see. This first part is the node's
// requests the check makes: the time-out runs through the answer's body; the
// exact gas limit is carried in the request; a refusal of the EVM is told from
// the node's failures, with its revert bytes kept whole; a call at a block the
// chain no longer holds is the node's refusal and not the contract's.

let rig: Rig;
let proxy: ChainProxy;

before(async () => {
  rig = await startRig();
  proxy = await startProxy(rig.url);
});

after(async () => {
  await proxy?.close();
  await rig?.close();
});

/** A server that answers every request after `headersAfterMs` with its headers, and then its body after `bodyAfterMs` more, or never. */
async function slowNode(headersAfterMs: number, bodyAfterMs: number | null): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"jsonrpc":"2.0","id":1,');
        if (bodyAfterMs !== null) setTimeout(() => res.end('"result":"0x1"}'), bodyAfterMs);
      }, headersAfterMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  return { url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`, server };
}

const closed = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

test('the node\'s time-out runs through the answer\'s body: headers that arrive and a body that does not are a failed request at the time-out, a timeout and not a rule about the bet; a body that arrives in time is the answer', async () => {
  const stalled = await slowNode(10, null);
  try {
    const rpc = createJsonRpc(stalled.url, 400);
    const started = Date.now();
    await assert.rejects(rpc.request('eth_chainId', []), (err: unknown) => err instanceof NodeFailure && err.kind === 'timeout' && err.method === 'eth_chainId');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 380 && elapsed < 3_000, `failed at the time-out, through the body: ${elapsed} ms`);
  } finally {
    await closed(stalled.server);
  }
  // Headers that do not arrive at all: the same failure, at the same time-out.
  const silent = await slowNode(5_000, 0);
  try {
    await assert.rejects(createJsonRpc(silent.url, 400).request('eth_chainId', []), (err: unknown) => err instanceof NodeFailure && err.kind === 'timeout');
  } finally {
    await closed(silent.server);
  }
  // The control: the body arrives inside the time-out, after the headers.
  const slow = await slowNode(10, 100);
  try {
    assert.equal(await createJsonRpc(slow.url, 2_000).request('eth_chainId', []), '0x1');
  } finally {
    await closed(slow.server);
  }
});

test('the exact gas limit is carried in the request, as the transaction would be signed with it; a call at too little gas fails, and the same call at enough answers', async () => {
  const rpc = createJsonRpc(proxy.url);
  const H = await headerByTag(rpc, 'latest');
  assert.ok(H.gasLimit !== undefined && H.gasLimit > 0n, 'the header carries the block\'s gas limit');
  const seen: unknown[] = [];
  proxy.rule('eth_call', { kind: 'rewrite', params: (p) => (seen.push(p[0]), p) });
  proxy.rule('eth_estimateGas', { kind: 'rewrite', params: (p) => (seen.push(p[0]), p) });
  try {
    const call = { from: rig.accounts.sender.address, to: rig.addresses.relay, data: encodeFunctionData({ abi: RELAY_ABI, functionName: 's_sender' }), value: 0n, gas: 200_000n };
    const out = await callAt(rpc, call, byHash(H.hash));
    assert.equal(out.toLowerCase().slice(-40), rig.accounts.sender.address.toLowerCase().slice(2));
    const { gas: _limit, ...noLimit } = call;
    const g = await estimateGasAt(rpc, noLimit, byHash(H.hash));
    assert.ok(g > 21_000n);
    assert.deepEqual(seen[0], { from: rig.accounts.sender.address, to: rig.addresses.relay, data: call.data, value: '0x0', gas: '0x30d40' }, 'the outgoing call carries the gas and the value');
    assert.deepEqual(Object.keys(seen[1] as object).sort(), ['data', 'from', 'to', 'value'], 'an estimate carries no gas of its own');
    // Too little gas for the call to run: the node refuses it, and the refusal is not the EVM's revert.
    await assert.rejects(callAt(rpc, { ...call, gas: 21_100n }, byHash(H.hash)), (err: unknown) => err instanceof NodeFailure && !(err instanceof ExecutionReverted));
  } finally {
    proxy.clear();
  }
});

test('a refusal of the EVM is told from the node\'s failures: a real custom error keeps its revert bytes whole and decodes by name; a revert with no data is said as no reason; an estimate out of gas is the node\'s out-of-gas answer; a call at a block the chain no longer holds is the node\'s refusal, not the contract\'s', async () => {
  const rpc = createJsonRpc(proxy.url);
  const H = await headerByTag(rpc, 'latest');
  const cross = encodeFunctionData({
    abi: RELAY_ABI,
    functionName: 'cross',
    args: [{ order: { account: rig.accounts.taker.address, gameId: 1n, scorer: rig.addresses.moneyline, lineTicks: 0, positionType: 0, oddsTick: 200, riskAmount: 10_000n, nonce: 0n, expiry: 0n, minFill: 0n }, signature: '0x' }, []],
  });
  // A stranger calls the relay: the relay's own refusal, with the caller in its bytes.
  const reverted = await callAt(rpc, { from: rig.accounts.stranger.address, to: rig.addresses.relay, data: cross }, byHash(H.hash)).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(reverted instanceof ExecutionReverted, String(reverted));
  assert.equal(reverted.kind, 'refused', 'every other reader treats it as before: a refusal');
  const decoded = decodeRevert(reverted.data);
  assert.deepEqual(decoded, { kind: 'named', name: 'OspexCourierRelay__NotTheSender', args: [rig.accounts.stranger.address] });
  // A revert that gives no reason: a selector the multicall contract does not have.
  const empty = await callAt(rpc, { to: MULTICALL_ADDRESS, data: '0xdeadbeef' }, byHash(H.hash)).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(empty instanceof ExecutionReverted);
  assert.equal(empty.data, '0x');
  assert.deepEqual(decodeRevert(empty.data), { kind: 'empty' });
  // An estimate allowed less gas than the call needs: the node's out-of-gas answer, with no data.
  const outOfGas = await estimateGasAt(rpc, { from: rig.accounts.sender.address, to: rig.addresses.relay, data: encodeFunctionData({ abi: RELAY_ABI, functionName: 's_sender' }), gas: 21_300n }, byHash(H.hash)).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(outOfGas instanceof OutOfGas, String(outOfGas));
  // A block the chain no longer holds: mined on a branch that is then reverted and mined again.
  const snapshot = (await rig.rpc('evm_snapshot', [])) as Hex;
  await rig.mine(1);
  const orphan = await headerByTag(rpc, 'latest');
  await rig.rpc('evm_revert', [snapshot]);
  await rig.mine(1);
  const atOrphan = await callAt(rpc, { to: MULTICALL_ADDRESS, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getBlockNumber' }) }, byHash(orphan.hash)).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(atOrphan instanceof NodeFailure && !(atOrphan instanceof ExecutionReverted), `the node refuses a block that is not canonical: ${String(atOrphan)}`);
  const atUnknown = await estimateGasAt(rpc, { to: MULTICALL_ADDRESS, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getBlockNumber' }) }, byHash(keccak256(toBytes('no block')))).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(atUnknown instanceof NodeFailure && !(atUnknown instanceof ExecutionReverted) && !(atUnknown instanceof OutOfGas), `an estimate at a hash no block has is refused: ${String(atUnknown)}`);
});
