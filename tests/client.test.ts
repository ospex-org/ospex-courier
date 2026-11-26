import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { after, before, test } from 'node:test';
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MATCHING_ABI, MULTICALL_ABI, MULTICALL_ADDRESS, RELAY_ABI } from '../courier/chain/abi';
import { checkNode } from '../courier/chain/node';
import { blockWithTransactions, byHash, createJsonRpc, handOff, headerByTag, maxPriorityFee, multicallAt, NAMED_ERRORS, receiptOf, traceOf, transactionCountAt } from '../courier/chain/rpc';
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

test("the hand-off: one request and no retry; taken only with the expected hash or request-bound already known; every named error is unknown with only its fixed words; other failed answers are unknown; and nothing of the node's raw text comes out", async () => {
  const rpc = createJsonRpc(proxy.url, 1_000);
  const sends = () => proxy.count('eth_sendRawTransaction');
  // Taken: the node answers with this transaction's own hash.
  let before = sends();
  const raw = await transfer(2);
  assert.deepEqual(await handOff(rpc, raw), { kind: 'taken' });
  assert.equal(sends() - before, 1);
  assert.notEqual(await rig.rpc('eth_getTransactionReceipt', [keccak256(raw)]), null, 'and the chain has it');
  // Each named error, in a letter case of its own and with other text around it, is not known, with its words alone.
  for (const words of NAMED_ERRORS) {
    const text = words === "the transaction's fee exceeds the node's configured cap" ? 'tx fee (2.00 ether) EXCEEDS THE CONFIGURED CAP (1.00 ether)' : `Planted Marker: ${words.toUpperCase()} at https://node.example.test/x 0xdeadbeef`;
    proxy.rule('eth_sendRawTransaction', { kind: 'refuse', code: -32000, message: text });
    before = sends();
    const answer = await handOff(rpc, raw);
    assert.deepEqual(answer, { kind: 'unknown', words }, text);
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

/**
 * A node of the test's own, for the answers the chain's proxy cannot give: each request is answered as `answer` says,
 * and counted as it arrives.
 */
async function stubNode(answer: (req: { id: unknown; params: unknown[] }, res: ServerResponse) => void): Promise<{ url: string; arrived: () => number; close(): Promise<void> }> {
  let arrived = 0;
  const sockets = new Set<Socket>();
  const server = createServer((incoming, res) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (c: Buffer) => chunks.push(c));
    incoming.on('end', () => {
      arrived += 1;
      const req = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; params?: unknown[] };
      answer({ id: req.id, params: req.params ?? [] }, res);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    arrived: () => arrived,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("the hand-off's transport and the binding of its answer: a refused connection, a time-out before the answer's headers and in its body, an HTTP failure after the request reached the node, and a redirect are each not known, with one attempt and none at the redirect's place; taken only with this request's id and this transaction's own hash, or an error whose whole message is already known; every other answer is not known, and nothing of it comes out", async () => {
  // Any signed bytes do: the answer is read against their own hash.
  const raw = (await transfer(4)) as Hex;
  const own = keccak256(raw).toLowerCase();
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  /** One hand-off to a node answering as `answer` says: what the client made of it, and how many requests reached the node. */
  async function handedTo(answer: (req: { id: unknown; params: unknown[] }, res: ServerResponse) => void, timeoutMs = 1_000): Promise<{ answer: unknown; arrived: number }> {
    const node = await stubNode(answer);
    try {
      const got = await handOff(createJsonRpc(node.url, timeoutMs), raw);
      return { answer: got, arrived: node.arrived() };
    } finally {
      await node.close();
    }
  }

  // Taken: this request's id, and this transaction's own hash as the result.
  assert.deepEqual(await handedTo((r, res) => json(res, { jsonrpc: '2.0', id: r.id, result: own })), { answer: { kind: 'taken' }, arrived: 1 });
  assert.deepEqual(await handedTo((r, res) => json(res, { jsonrpc: '2.0', id: r.id, result: own.toUpperCase().replace('0X', '0x') })), { answer: { kind: 'taken' }, arrived: 1 });
  // Taken: an error to this request whose whole message is already known, in any letter case and with space around it.
  for (const message of ['already known', '  Already Known \n', 'ALREADY KNOWN']) {
    assert.deepEqual(await handedTo((r, res) => json(res, { jsonrpc: '2.0', id: r.id, error: { code: -32000, message } })), { answer: { kind: 'taken' }, arrived: 1 }, JSON.stringify(message));
  }
  // Not known: every other answer, each made once, and nothing of it comes out.
  const others: Array<[string, (r: { id: unknown; params: unknown[] }, res: ServerResponse) => void, unknown]> = [
    ['another id', (r, res) => json(res, { jsonrpc: '2.0', id: Number(r.id) + 1, result: own }), { kind: 'unknown' }],
    ['no id', (_r, res) => json(res, { jsonrpc: '2.0', result: own }), { kind: 'unknown' }],
    ['the id as a string', (r, res) => json(res, { jsonrpc: '2.0', id: String(r.id), result: own }), { kind: 'unknown' }],
    ['another version', (r, res) => json(res, { jsonrpc: '1.0', id: r.id, result: own }), { kind: 'unknown' }],
    ['no version', (r, res) => json(res, { id: r.id, result: own }), { kind: 'unknown' }],
    ['a result and an error both', (r, res) => json(res, { jsonrpc: '2.0', id: r.id, result: own, error: { code: -32000, message: 'already known' } }), { kind: 'unknown' }],
    ['another hash', (r, res) => json(res, { jsonrpc: '2.0', id: r.id, result: `0x${'ee'.repeat(32)}` }), { kind: 'unknown' }],
    ['a result that says taken', (r, res) => json(res, { jsonrpc: '2.0', id: r.id, result: { kind: 'taken' } }), { kind: 'unknown' }],
    ['a result with fields of its own', (r, res) => json(res, { jsonrpc: '2.0', id: r.id, result: { kind: 'taken', words: 'nonce too low', planted: 'marker' } }), { kind: 'unknown' }],
    ['already known inside other text', (r, res) => json(res, { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'Planted Marker: this one is already known to a peer' } }), { kind: 'unknown' }],
    ['already known beside a named error', (r, res) => json(res, { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'nonce too low: already known' } }), { kind: 'unknown', words: 'nonce too low' }],
    ['a named error to another request', (r, res) => json(res, { jsonrpc: '2.0', id: Number(r.id) + 1, error: { code: -32000, message: 'nonce too low' } }), { kind: 'unknown' }],
    ['an error with no message', (r, res) => json(res, { jsonrpc: '2.0', id: r.id, error: { code: -32000 } }), { kind: 'unknown' }],
    ['not JSON', (_r, res) => json(res, 'Planted Marker {not json'), { kind: 'unknown' }],
    ['an array', (r, res) => json(res, [{ jsonrpc: '2.0', id: r.id, result: own }]), { kind: 'unknown' }],
    ['an HTTP failure after the request reached the node', (_r, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'already known' } }));
    }, { kind: 'unknown' }],
  ];
  for (const [what, answer, expected] of others) {
    const got = await handedTo(answer);
    assert.deepEqual(got, { answer: expected, arrived: 1 }, what);
    const out = JSON.stringify(got.answer).toLowerCase();
    for (const needle of ['planted', 'marker', 'peer', 'not json']) assert.ok(!out.includes(needle), `${what}: ${needle} does not come out`);
  }
  // A time-out before the answer's headers, and one in its body: not known, one request each, and no other.
  assert.deepEqual(await handedTo(() => undefined, 300), { answer: { kind: 'unknown' }, arrived: 1 }, 'no headers in time');
  assert.deepEqual(
    await handedTo((r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(`{"jsonrpc":"2.0","id":${JSON.stringify(r.id)},"result":"${own.slice(0, 20)}`);
    }, 300),
    { answer: { kind: 'unknown' }, arrived: 1 },
    'the body not whole in time',
  );
  // A redirect: not followed. Not known, and no request reaches the redirect's place.
  const elsewhere = await stubNode((r, res) => json(res, { jsonrpc: '2.0', id: r.id, result: own }));
  try {
    for (const status of [301, 302, 307, 308]) {
      const got = await handedTo((_r, res) => {
        res.writeHead(status, { location: elsewhere.url });
        res.end();
      });
      assert.deepEqual(got, { answer: { kind: 'unknown' }, arrived: 1 }, `a ${status}`);
    }
    assert.equal(elsewhere.arrived(), 0, "no request at the redirect's place");
  } finally {
    await elsewhere.close();
  }
  // A refused connection: not known, and no node saw the request.
  const gone = await stubNode(() => undefined);
  const url = gone.url;
  await gone.close();
  assert.deepEqual(await handOff(createJsonRpc(url, 1_000), raw), { kind: 'unknown' });
  assert.equal(gone.arrived(), 0, 'nothing arrived');
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
