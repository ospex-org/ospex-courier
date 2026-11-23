import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { encodeFunctionData, keccak256, toBytes, type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { MULTICALL_ABI, MULTICALL_ADDRESS, RELAY_ABI } from '../courier/chain/abi';
import { byHash, callAt, createJsonRpc, estimateGasAt, ExecutionReverted, headerByTag, NodeFailure, OutOfGas } from '../courier/chain/rpc';
import { decodeRevert } from '../courier/check/decode';
import { CHAIN_LIMITS } from '../courier/http/limits';
import { openPool } from '../courier/records/store';
import { get } from './support/courier';
import { crossFromTheTest, orderOn, postOrder, sign, type Order } from './support/orders';
import type { ChainProxy } from './support/proxy';
import type { Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';

// The bet's check, from what a user would see: a signed order posted over
// HTTP to the courier as its own process, judged by the answer, by the bet's
// record, and by the rows and the lines read back. The first part is the
// node's requests the check makes: the time-out runs through the answer's
// body; the exact gas limit is carried in the request; a refusal of the EVM is
// told from the node's failures, with its revert bytes kept whole; a call at a
// block the chain no longer holds is the node's refusal and not the contract's.

let stack: Stack;
let rig: Rig;
let proxy: ChainProxy;
let pool: pg.Pool;
const url = () => stack.courier.url;

before(async () => {
  stack = await startStack('precheck');
  rig = stack.rig;
  proxy = stack.proxy;
  pool = openPool(stack.databaseUrl, null);
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

/** A fresh account of the rig's mnemonic, funded: coin, an allowance to the positions contract, the relay registered. */
let nextAccount = 40;
async function freshAccount(): Promise<HDAccount> {
  const who = rig.account(nextAccount++);
  await rig.fund(who);
  return who;
}

/** The bet's record once its check has written an outcome: read again until it is no longer queued. */
async function judged(hash: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const r = await get(url(), `/v1/orders/${hash}`);
    if (r.body.state !== 'queued') return r.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the bet ${hash} was still queued`);
}

/** The lines of the events table for a bet, by its hash, in order. */
async function linesOf(hash: string): Promise<Array<{ kind: string; reason: string | null; order_hash: string | null; facts: Record<string, unknown> }>> {
  const { rows } = await pool.query(`SELECT kind, reason, order_hash, facts FROM events WHERE bet_hash = $1 OR order_hash = $1 ORDER BY number`, [hash.toLowerCase()]);
  return rows as Array<{ kind: string; reason: string | null; order_hash: string | null; facts: Record<string, unknown> }>;
}

/** The key's transaction count on the chain, at the latest block. */
async function keyCount(): Promise<bigint> {
  return BigInt((await rig.rpc('eth_getTransactionCount', [rig.accounts.sender.address, 'latest'])) as string);
}

test("the worked bet: a maker who holds the other side is listed with an empty wallet; the bet is found ready at one block, its record not sent with one leg of 9,600 and 9,984, the maker pulled nothing and paid back 1,400, the bettor pulled 9,984, and nothing was signed or sent", async () => {
  const M = await freshAccount();
  const B = await freshAccount();
  const X = await freshAccount();
  const coin = rig.abis.TestCoin as Abi;
  // M takes the away side earlier, for 6,000 against a profit of 5,000: X quotes home at tick 220 and M's bet fills
  // 50 lots of it, sent by the test from the relay's sender.
  let T = await rig.time();
  const xQuote: Order = { ...orderOn(rig, X, { expiry: T + 600n, oddsTick: 220, riskAmount: 5_000n }), positionType: 0 };
  const mBet: Order = { ...orderOn(rig, M, { expiry: T + 25n, oddsTick: 180, riskAmount: 6_000n }), positionType: 1 };
  const earlier = await crossFromTheTest(rig, { order: mBet, signature: await sign(M, mBet, 31337, rig.addresses.matching) }, [{ order: xQuote, signature: await sign(X, xQuote, 31337, rig.addresses.matching) }]);
  assert.equal(earlier.filled, true, JSON.stringify(earlier));
  // M's wallet emptied: its quote can be listed only on the netted pull.
  const mCoin = await rig.read<bigint>(rig.addresses.coin, coin, 'balanceOf', [M.address]);
  await rig.write(M, rig.addresses.coin, coin, 'transfer', [X.address, mCoin]);
  assert.equal(await rig.read<bigint>(rig.addresses.coin, coin, 'balanceOf', [M.address]), 0n);

  const countBefore = await keyCount();
  const sendsBefore = proxy.sends();
  T = await rig.time();
  const quote: Order = { ...orderOn(rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 100_000n }), positionType: 0 };
  const posted = await postOrder(url(), rig, M, 'rest', quote);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const bet: Order = { ...orderOn(rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(url(), rig, B, 'take', bet);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  assert.equal(taken.body.state, 'queued');
  const hash = taken.body.orderHash as string;

  const record = await judged(hash);
  assert.equal(record.state, 'not sent', JSON.stringify(record));
  const cross = record.cross as Record<string, unknown>;
  assert.equal(cross.state, 'not sent');
  assert.equal(cross.handOffs, 0);
  assert.equal(cross.reason, 'SENDER_NOT_BUILT');
  const block = cross.block as { number: string; hash: string; time: string };
  assert.equal(cross.message, `The courier checked this bet at block ${block.number} and found that it would fill as listed. The sender is a later build, so nothing was signed or sent.`);
  assert.deepEqual(cross.legs, [{ position: 0, orderHash: posted.body.orderHash, account: M.address.toLowerCase(), oddsTick: 204, makerRisk: '9600', takerRisk: '9984' }]);
  assert.equal(cross.takerRisk, '9984');
  assert.deepEqual(cross.pulls, { [M.address]: '0', [B.address]: '9984' });
  assert.deepEqual(cross.paysBack, { [M.address]: '1400' });
  assert.deepEqual(cross.paysBackRefused, {});

  // The rows: one Cross not sent and never handed off, one leg, and the lines.
  const crosses = await pool.query(`SELECT state, hand_offs, not_sent_reason, block_hash FROM crosses WHERE bet_hash = $1`, [hash.toLowerCase()]);
  assert.deepEqual(crosses.rows, [{ state: 'not sent', hand_offs: 0, not_sent_reason: 'SENDER_NOT_BUILT', block_hash: block.hash }]);
  const legs = await pool.query(`SELECT position, order_hash, expected_maker_risk::text AS m, expected_taker_risk::text AS t FROM legs WHERE bet_hash = $1`, [hash.toLowerCase()]);
  assert.deepEqual(legs.rows, [{ position: 0, order_hash: (posted.body.orderHash as string).toLowerCase(), m: '9600', t: '9984' }]);
  assert.deepEqual((await linesOf(hash)).map((l) => l.kind), ['order received', 'cross not sent']);
  const quoteLines = await pool.query(`SELECT kind FROM events WHERE order_hash = $1 ORDER BY number`, [(posted.body.orderHash as string).toLowerCase()]);
  assert.deepEqual(quoteLines.rows.map((r: { kind: string }) => r.kind), ['order received']);
  // Nothing was signed or sent: the key's count is what it was, and the proxy saw no send.
  assert.equal(await keyCount(), countBefore);
  assert.deepEqual(proxy.sends(), sendsBefore);
  assert.deepEqual(proxy.sends(), { eth_sendRawTransaction: 0, eth_sendTransaction: 0 });
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
