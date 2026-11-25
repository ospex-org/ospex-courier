import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MATCHING_ABI, MULTICALL_ABI, MULTICALL_ADDRESS, RELAY_ABI } from '../courier/chain/abi';
import { checkNode } from '../courier/chain/node';
import { blockWithTransactions, byHash, createJsonRpc, handOff, headerByTag, maxPriorityFee, multicallAt, NODE_REFUSALS, receiptOf, traceOf, transactionCountAt } from '../courier/chain/rpc';
import { testAccountKey } from './support/keystore';
import { orderOn, sign } from './support/orders';
import { startProxy, type ChainProxy } from './support/proxy';
import { startRig, type Rig } from './support/rig';

// The node's client, for the sender's requests: the one hand-off and its
// answer, read inside the client; a receipt, a block in full and a trace; the
// tip; the key's count and a block's hash, at a final block named by its hash;
// and the node check's three verdicts for the sender. Each request goes through
// the proxy, which counts it as it arrives. Nothing here starts a courier.

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

/** A signed transfer of one unit of the coin from the test account at `index`, at its next nonce: a transaction the node takes. */
async function transfer(index: number): Promise<Hex> {
  const who = privateKeyToAccount(testAccountKey(index));
  const nonce = Number(BigInt((await rig.rpc('eth_getTransactionCount', [who.address, 'pending'])) as string));
  const block = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
  const data = encodeFunctionData({ abi: rig.abis.TestCoin as Abi, functionName: 'transfer', args: [rig.accounts.stranger.address, 1n] });
  return who.signTransaction({ type: 'eip1559', chainId: 31337, to: rig.addresses.coin, data, value: 0n, nonce, gas: 100_000n, maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
}

/** A Cross of one bet against no quote, from the relay's sender, mined with a fixed limit so that it reverts: NothingFilled. */
async function revertedCross(): Promise<Hex> {
  const T = await rig.time();
  const bet = { ...orderOn(rig, rig.accounts.taker, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 as const };
  const signature = await sign(rig.accounts.taker, bet, 31337, rig.addresses.matching);
  const data = encodeFunctionData({ abi: RELAY_ABI, functionName: 'cross', args: [{ order: bet, signature }, []] } as never);
  const who = privateKeyToAccount(testAccountKey(4));
  const nonce = Number(BigInt((await rig.rpc('eth_getTransactionCount', [who.address, 'pending'])) as string));
  const block = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
  const raw = await who.signTransaction({ type: 'eip1559', chainId: 31337, to: rig.addresses.relay, data, value: 0n, nonce, gas: 1_000_000n, maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  return (await rig.rpc('eth_sendRawTransaction', [raw])) as Hex;
}

test("the hand-off: one request and no retry; taken with the transaction's own hash, or as already known; each named refusal read inside the client to its own words; a text not on the list, a time-out and a dropped answer not known; and nothing of the node's text comes out", async () => {
  const rpc = createJsonRpc(proxy.url, 1_000);
  const sends = () => proxy.count('eth_sendRawTransaction');
  // Taken: the node answers with this transaction's own hash.
  let before = sends();
  const raw = await transfer(2);
  assert.deepEqual(await handOff(rpc, raw), { kind: 'taken' });
  assert.equal(sends() - before, 1);
  assert.notEqual(await rig.rpc('eth_getTransactionReceipt', [keccak256(raw)]), null, 'and the chain has it');
  // Each named refusal, in a letter case of its own and with other text around it, comes out as its words alone.
  for (const words of NODE_REFUSALS) {
    const text = words === "the transaction's fee exceeds the node's configured cap" ? 'tx fee (2.00 ether) EXCEEDS THE CONFIGURED CAP (1.00 ether)' : `Planted Marker: ${words.toUpperCase()} at https://node.example.test/x 0xdeadbeef`;
    proxy.rule('eth_sendRawTransaction', { kind: 'refuse', code: -32000, message: text });
    before = sends();
    const answer = await handOff(rpc, raw);
    assert.deepEqual(answer, { kind: 'refused', words }, text);
    assert.equal(sends() - before, 1, 'one request, and no retry');
    const out = JSON.stringify(answer).toLowerCase();
    for (const needle of ['planted marker', 'node.example.test', '0xdeadbeef', '2.00 ether']) assert.ok(!out.includes(needle), `${needle} does not come out`);
  }
  // Already known: the node holds this very transaction, so it was taken.
  proxy.rule('eth_sendRawTransaction', { kind: 'refuse', code: -32000, message: 'already known' });
  assert.deepEqual(await handOff(rpc, raw), { kind: 'taken' });
  // A text that is not on the list: not known.
  proxy.rule('eth_sendRawTransaction', { kind: 'refuse', code: -32000, message: 'the node is having a day' });
  assert.deepEqual(await handOff(rpc, raw), { kind: 'unknown' });
  // An answer that is another hash: not known.
  proxy.rule('eth_sendRawTransaction', { kind: 'answer', result: () => `0x${'ee'.repeat(32)}` });
  assert.deepEqual(await handOff(rpc, raw), { kind: 'unknown' });
  // A time-out, its time running through the answer: not known, and one request.
  const held = proxy.hold('eth_sendRawTransaction');
  before = sends();
  assert.deepEqual(await handOff(rpc, await transfer(3)), { kind: 'unknown' });
  assert.equal(sends() - before, 1, 'one request, and no retry after the time-out');
  held.release({ kind: 'refuse', code: -32000, message: 'released after the time-out' });
  // Dropped with no answer: not known, and one request.
  proxy.drop('eth_sendRawTransaction');
  before = sends();
  assert.deepEqual(await handOff(rpc, await transfer(3)), { kind: 'unknown' });
  assert.equal(sends() - before, 1);
  proxy.rule('eth_sendRawTransaction', null);
});

test("a mined Cross's receipt, its block in full and its trace; the tip the node suggests; and the key's count and a block's hash read at a final block named by its hash", async () => {
  const rpc = createJsonRpc(proxy.url);
  const reverted = await revertedCross();
  const receipt = await receiptOf(rpc, reverted);
  assert.ok(receipt !== null);
  assert.equal(receipt.status, 'reverted');
  assert.equal(receipt.from.toLowerCase(), rig.accounts.sender.address.toLowerCase());
  assert.equal(receipt.to?.toLowerCase(), rig.addresses.relay.toLowerCase());
  assert.ok(receipt.gasUsed > 21_000n && receipt.effectiveGasPrice > 0n);
  assert.deepEqual(receipt.logs, [], 'a failed receipt carries no logs');
  assert.equal(await receiptOf(rpc, `0x${'ab'.repeat(32)}`), null, 'no receipt for a hash the chain has not mined');
  // The block in full: the transaction from the key at its nonce.
  const block = await blockWithTransactions(rpc, receipt.blockNumber);
  assert.ok(block !== null);
  assert.equal(block.header.hash.toLowerCase(), receipt.blockHash);
  const tx = block.transactions.find((t) => t.hash === reverted.toLowerCase());
  assert.ok(tx !== undefined);
  assert.equal(tx.from.toLowerCase(), rig.accounts.sender.address.toLowerCase());
  // The trace: the top call's output, the contract's own refusal.
  const trace = await traceOf(rpc, reverted);
  assert.ok(trace.output !== null);
  assert.equal(decodeErrorResult({ abi: MATCHING_ABI, data: trace.output }).errorName, 'OspexMatching__NothingFilled');
  // The tip.
  assert.ok((await maxPriorityFee(rpc)) >= 0n);
  // A final block the test names; the key's count and a block's hash read at it, each by its hash.
  proxy.setFinal(receipt.blockNumber);
  try {
    const F = await headerByTag(rpc, 'finalized');
    assert.equal(F.number, receipt.blockNumber);
    assert.ok(F.baseFee !== undefined && F.baseFee > 0n, "the header carries the block's base fee");
    // What each request names, seen at the proxy on its way.
    const named: unknown[] = [];
    const seen = (params: unknown[]) => {
      named.push(params[params.length - 1]);
      return params;
    };
    proxy.rule('eth_getTransactionCount', { kind: 'rewrite', params: seen });
    proxy.rule('eth_call', { kind: 'rewrite', params: (p) => seen(p.slice(0, 2)) });
    const counted = proxy.counted.length;
    const count = await transactionCountAt(rpc, rig.accounts.sender.address, byHash(F.hash));
    assert.equal(count, tx.nonce + 1n, 'the key used its nonce in that block');
    const [hashAt] = await multicallAt(rpc, F, [{ target: MULTICALL_ADDRESS, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getBlockHash', args: [F.number - 1n] }) }]);
    const parent = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getBlockHash', data: (hashAt as { returnData: Hex }).returnData }) as Hex;
    assert.equal(parent.toLowerCase(), F.parentHash.toLowerCase(), "the block's hash, as the chain itself has it at F");
    assert.deepEqual(proxy.counted.slice(counted).map((c) => c.method), ['eth_getTransactionCount', 'eth_call'], 'each request counted');
    assert.deepEqual(named, [{ blockHash: F.hash, requireCanonical: true }, { blockHash: F.hash, requireCanonical: true }], 'and each names F by its hash');
  } finally {
    proxy.setFinal(null);
    proxy.rule('eth_getTransactionCount', null);
    proxy.rule('eth_call', null);
  }
});

test("the node check, for the sender: the base fee and the tip are required of the node; the trace is tried on the transaction named, to an output; a node that cannot trace is reported and refuses nothing; with no transaction named it is not tried", async () => {
  const rpc = createJsonRpc(proxy.url);
  const reverted = await revertedCross();
  const targets = { relay: rig.addresses.relay, sender: rig.accounts.sender.address };
  const good = await checkNode(rpc, { ...targets, traceTransaction: reverted });
  assert.equal(good.usable, true, JSON.stringify(good));
  assert.deepEqual([good.baseFee.ok, good.tip.ok, good.trace.ok, good.trace.tried], [true, true, true, true]);
  // No transaction named: not tried.
  const untried = await checkNode(rpc, targets);
  assert.deepEqual([untried.usable, untried.trace.tried, untried.trace.ok], [true, false, false]);
  // A node that refuses the trace: reported, and the node still usable.
  proxy.rule('debug_traceTransaction', { kind: 'refuse', code: -32601, message: 'the method does not exist' });
  try {
    const noTrace = await checkNode(rpc, { ...targets, traceTransaction: reverted });
    assert.deepEqual([noTrace.usable, noTrace.trace.tried, noTrace.trace.ok], [true, true, false]);
  } finally {
    proxy.rule('debug_traceTransaction', null);
  }
  // A node with no tip: not usable.
  proxy.rule('eth_maxPriorityFeePerGas', { kind: 'refuse', code: -32601, message: 'the method does not exist' });
  try {
    const noTip = await checkNode(rpc, targets);
    assert.deepEqual([noTip.usable, noTip.tip.ok], [false, false]);
  } finally {
    proxy.rule('eth_maxPriorityFeePerGas', null);
  }
  // A latest block with no base fee: not usable.
  proxy.rule('eth_getBlockByNumber', { kind: 'rewriteResult', result: (params, result) => (params[0] === 'latest' && result !== null ? { ...(result as Record<string, unknown>), baseFeePerGas: undefined } : result) });
  try {
    const noBaseFee = await checkNode(rpc, targets);
    assert.deepEqual([noBaseFee.usable, noBaseFee.baseFee.ok], [false, false]);
  } finally {
    proxy.rule('eth_getBlockByNumber', null);
  }
});
