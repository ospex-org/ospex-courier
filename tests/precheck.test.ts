import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, toBytes, type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { MULTICALL_ABI, MULTICALL_ADDRESS, RELAY_ABI } from '../courier/chain/abi';
import { byHash, callAt, createJsonRpc, estimateGasAt, ExecutionReverted, headerByTag, NodeFailure, OutOfGas } from '../courier/chain/rpc';
import { decodeRevert } from '../courier/check/decode';
import { CHAIN_LIMITS } from '../courier/http/limits';
import { marketKey, orderHash as orderHashOf } from '../courier/orders/order';
import { openPool } from '../courier/records/store';
import { get as getFrom, startHookedCourier, type CourierProcess, type HookControl } from './support/courier';
import { cancelAll, cancelOnChain, contractHash, crossFromTheTest, grantAgent, liftCap, nextOrderNumber, nonceOf, orderOn, postOrder as postOrderFrom, postOrderAs as postOrderAsFrom, raiseFloor, sign, type Order } from './support/orders';
import { postStop as postStopFrom, stopMessage } from './support/stops';
import type { ChainProxy } from './support/proxy';
import type { Rig } from './support/rig';
import { publishedList, startStack, type Stack } from './support/stack';

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

/**
 * Every test sends from a network address of its own, as the courier's other tests do, so the courier's count of an
 * address's minute, 600 requests, limits none: the last value of X-Forwarded-For, an address of 198.18.0.0/16 new for
 * each. The requests below go out from it unless a case names another address.
 */
let from: Record<string, string> = {};
let nextAddress = 0;
const ownAddress = (): Record<string, string> => {
  const n = nextAddress++;
  return { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
};
beforeEach(() => {
  from = ownAddress();
});
const get = (...a: Parameters<typeof getFrom>) => getFrom(a[0], a[1], a[2] ?? from);
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const postOrderAs = (...a: Parameters<typeof postOrderAsFrom>) => postOrderAsFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const postStop = (...a: Parameters<typeof postStopFrom>) => postStopFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

before(async () => {
  stack = await startStack('precheck', { hooked: true });
  // The final block follows the head: a ready bet is now sent, and its Cross settles once a final block holds it.
  stack.proxy.finalFollows(0n);
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

/** The states of a bet whose outcome is not yet written: waiting or being checked, or sent and not yet final. */
const UNSETTLED = new Set(['queued', 'unknown', 'sent', 'pending']);

/** The bet's record once its check has written an outcome: read again until it is no longer queued, nor a Cross not yet final. */
async function judged(hash: string, on = url()): Promise<Record<string, unknown>> {
  // Read every tenth of a second, at most 300 times: well under the address's 600 a minute.
  for (let i = 0; i < 300; i++) {
    const r = await get(on, `/v1/orders/${hash}`);
    if (!UNSETTLED.has(String(r.body.state))) return r.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the bet ${hash} was still queued after 30 seconds${lastLines(on)}`);
}

/** The stack's courier's last lines, where the wait was on it: what a wait that ran out needs to be read. */
const lastLines = (on: string) => (on === url() ? `; the courier's last lines: ${stack.courier.lines.slice(-12).join(' | ')}` : '');

/**
 * The bet's record once its check is done: a ready bet held at its intent, where the send begins and no request of
 * the send is yet made (the caller armed the hold), or another bet with its outcome written.
 */
async function atIntentOrJudged(hash: string, on = url()): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const r = await get(on, `/v1/orders/${hash}`);
    if (r.body.state === 'queued' && r.body.turn === 'sending') return r.body;
    if (!UNSETTLED.has(String(r.body.state))) return r.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the bet ${hash} was neither at its intent nor judged after 30 seconds${lastLines(on)}`);
}

/**
 * The sender's two reads a ready bet's check now makes, counted by method at the proxy from `from`: one tip, and the
 * key's count at the final block beside the check's own count at H. A window of the check's own requests, which ends
 * at the check's result before any step of the send, leaves them out, and holds them to exactly these.
 */
function senderReads(on: ChainProxy, from: { tips: number; keyCounts: number }): { tip: number; keyCounts: number } {
  return { tip: on.count('eth_maxPriorityFeePerGas') - from.tips, keyCounts: on.count('eth_getTransactionCount') - from.keyCounts };
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

test("the worked bet: a maker who holds the other side is listed with an empty wallet; the bet is found ready at one block, signed once, handed off once and confirmed, with one leg of 9,600 and 9,984: the maker pulled nothing and paid back 1,400, the bettor pulled 9,984, as the check found and the receipt records", async () => {
  const M = await freshAccount();
  const B = await freshAccount();
  const X = await freshAccount();
  const coin = rig.abis.TestCoin as Abi;
  // M takes the away side earlier, for 6,000 against a profit of 5,000: X quotes home at tick 220 and M's bet fills
  // 50 lots of it, sent by the test through another courier.
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
  const bBefore = await rig.read<bigint>(rig.addresses.coin, coin, 'balanceOf', [B.address]);
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
  assert.equal(record.state, 'confirmed', JSON.stringify(record));
  const cross = record.cross as Record<string, unknown>;
  assert.equal(cross.state, 'confirmed');
  assert.equal(cross.handOffs, 1);
  assert.equal(cross.reason, null);
  const block = cross.block as { number: string; hash: string; time: string };
  const receipt = (cross.receipt as { block: { number: string } }).block;
  assert.ok(
    String(cross.message).startsWith(`Transaction ${String(cross.txHash)} is in final block ${receipt.number}. It filled 0.009984 USDC of this bet's 0.01 USDC, at the prices of the quotes listed. 0.000016 USDC of it did not fill in this transaction, and this courier does not carry the rest.`),
    String(cross.message),
  );
  assert.deepEqual(cross.legs, [{ position: 0, orderHash: posted.body.orderHash, account: M.address.toLowerCase(), oddsTick: 204, makerRisk: '9600', takerRisk: '9984', recorded: { makerRisk: '9600', takerRisk: '9984' } }]);
  assert.equal(cross.takerRisk, '9984');
  assert.deepEqual(cross.pulls, { [M.address]: '0', [B.address]: '9984' });
  assert.deepEqual(cross.paysBack, { [M.address]: '1400' });
  assert.deepEqual(cross.paysBackRefused, {});
  assert.equal(cross.betFilled, '9984');
  // The coin as the receipt moved it: the bettor paid 9,984; the maker, its wallet empty, was paid back 1,400.
  assert.equal(await rig.read<bigint>(rig.addresses.coin, coin, 'balanceOf', [B.address]), bBefore - 9_984n);
  assert.equal(await rig.read<bigint>(rig.addresses.coin, coin, 'balanceOf', [M.address]), 1_400n);

  // The rows: one Cross handed off once and confirmed, one leg, and the lines.
  const crosses = await pool.query(`SELECT state, hand_offs, not_sent_reason, block_hash FROM crosses WHERE bet_hash = $1`, [hash.toLowerCase()]);
  assert.deepEqual(crosses.rows, [{ state: 'confirmed', hand_offs: 1, not_sent_reason: null, block_hash: block.hash }]);
  const legs = await pool.query(`SELECT position, order_hash, expected_maker_risk::text AS m, expected_taker_risk::text AS t FROM legs WHERE bet_hash = $1`, [hash.toLowerCase()]);
  assert.deepEqual(legs.rows, [{ position: 0, order_hash: (posted.body.orderHash as string).toLowerCase(), m: '9600', t: '9984' }]);
  // Sent, then confirmed; pending between them where the receipt was first seen above the final block.
  const kinds = (await linesOf(hash)).map((l) => l.kind).join(', ');
  assert.ok(['order received, cross sent, cross confirmed', 'order received, cross sent, cross pending, cross confirmed'].includes(kinds), kinds);
  const quoteLines = await pool.query(`SELECT kind FROM events WHERE order_hash = $1 ORDER BY number`, [(posted.body.orderHash as string).toLowerCase()]);
  assert.deepEqual(quoteLines.rows.map((r: { kind: string }) => r.kind), ['order received']);
  // Signed once and handed off once: the key's count one more, and the proxy saw one send.
  assert.equal(await keyCount(), countBefore + 1n);
  assert.deepEqual(proxy.sends(), { eth_sendRawTransaction: sendsBefore.eth_sendRawTransaction + 1, eth_sendTransaction: 0 });
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
  // A block the chain no longer holds: mined on a branch that is then reverted and mined again, one second later, so
  // the block that takes its height is another block with another hash, however fast the two are mined.
  const snapshot = (await rig.rpc('evm_snapshot', [])) as Hex;
  await rig.mine(1);
  const orphan = await headerByTag(rpc, 'latest');
  await rig.rpc('evm_revert', [snapshot]);
  await rig.setNextBlockTime(orphan.timestamp + 1n);
  await rig.mine(1);
  const canonical = await headerByTag(rpc, 'latest');
  assert.deepEqual({ number: canonical.number, sameHash: canonical.hash === orphan.hash }, { number: orphan.number, sameHash: false }, 'the height is held by another block');
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

// ──────────────────────────── the shared fixtures of the bet's check ────────────────────────────

/** A market of a case's own: a spread line no other case uses, so its book holds the case's quotes alone. */
let nextLine = 1;
const ownMarket = () => ({ scorer: rig.addresses.spread, lineTicks: -(100 + 5 * nextLine++) });

/** A quote by `who` on side A of the market, signed and posted. */
async function quoteOn(who: HDAccount, market: { scorer: Address; lineTicks: number }, fields: Partial<Order> = {}): Promise<{ hash: Hex; order: Order }> {
  const T = await rig.time();
  const order: Order = { ...orderOn(rig, who, { expiry: T + 600n, oddsTick: 200, riskAmount: 100_000n, ...market, ...fields }), positionType: fields.positionType ?? 0 };
  const posted = await postOrder(url(), rig, who, 'rest', order);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as Hex, order };
}

/** A bet by `who` on side B of the market, signed and posted: 202. */
async function betOn(who: HDAccount, market: { scorer: Address; lineTicks: number }, fields: Partial<Order> = {}, on = url()): Promise<{ hash: Hex; order: Order }> {
  const T = await rig.time();
  const order: Order = { ...orderOn(rig, who, { expiry: T + 25n, oddsTick: 200, riskAmount: 10_000n, ...market, ...fields }), positionType: fields.positionType ?? 1 };
  const posted = await postOrder(on, rig, who, 'take', order);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as Hex, order };
}

/** The hooks of the stack's courier, which this file starts through the tests' start file. */
const hooks = (): HookControl => {
  const h = stack.courier.hooks;
  if (h === undefined) throw new Error("the stack's courier was not started through the tests' start file");
  return h;
};

/** The legs of a ready bet's record, by quote hash. */
const legsOf = (record: Record<string, unknown>) => ((record.cross as { legs: Array<{ orderHash: string }> }).legs ?? []).map((l) => l.orderHash.toLowerCase());

/** Records every request of these methods the proxy passes, with its params, until stopped. */
function recording(methods: string[]): { calls: Array<{ method: string; params: unknown[] }>; stop(): void } {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  for (const method of methods) proxy.rule(method, { kind: 'rewrite', params: (p) => (calls.push({ method, params: p }), p) });
  return {
    calls,
    stop() {
      for (const method of methods) proxy.rule(method, null);
    },
  };
}

const byHashOf = (p: unknown) => (typeof p === 'object' && p !== null && 'blockHash' in p ? (p as { blockHash: string; requireCanonical?: boolean }) : null);

// ──────────────────────────── one block, by hash ────────────────────────────

test('one block: two quotes and a stale answer. Read B is answered at the block before H, twice: the round is thrown away, the check starts again, and the bet is ready with the live quote alone, the one cancelled in H itself left out', async () => {
  const market = ownMarket();
  const X = await freshAccount();
  const Y = await freshAccount();
  const B = await freshAccount();
  const x = await quoteOn(X, market, { oddsTick: 200, riskAmount: 100n });
  const y = await quoteOn(Y, market, { oddsTick: 200, riskAmount: 100n });
  // X cancels on chain: the cancel is in H itself, and the block before H has X live.
  await cancelOnChain(rig, X, x.order);
  const H = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { hash: Hex; parentHash: Hex };
  let stale = 0;
  proxy.rule('eth_call', {
    kind: 'rewrite',
    params: (p) => {
      const ref = byHashOf(p[1]);
      const data = (p[0] as { data?: string }).data ?? '';
      if (ref?.blockHash === H.hash && data.includes(x.hash.slice(2).toLowerCase()) && stale < 2) {
        stale++;
        return [p[0], { blockHash: H.parentHash, requireCanonical: true }, ...p.slice(2)];
      }
      return p;
    },
  });
  try {
    const bet = await betOn(B, market, { riskAmount: 200n, oddsTick: 200 });
    const record = await judged(bet.hash);
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    assert.deepEqual(legsOf(record), [y.hash.toLowerCase()], 'ready with Y alone');
    assert.equal(stale, 2, 'read B was answered for the block before H, twice');
  } finally {
    proxy.rule('eth_call', null);
  }
});

test("one block: an orphan, by stand-in. Between read A and read C the node answers H as unknown, and the bettor's allowance is lowered on the chain that follows: the check starts again at a new H, with a fresh read A, and the bet is CANNOT_PAY there; every value the result used carries the new block (a proxy's stand-in for a real branch replacement, not one)", async () => {
  const market = ownMarket();
  const M = await freshAccount();
  const B = await freshAccount();
  await quoteOn(M, market, { oddsTick: 200, riskAmount: 100_000n });
  await hooks().arm('after-read-a');
  const bet = await betOn(B, market, { riskAmount: 10_000n });
  const held = await hooks().reached('after-read-a');
  const H = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { hash: Hex };
  // The chain after H: the bettor's allowance lowered under its pull.
  await rig.write(B, rig.addresses.coin, rig.abis.TestCoin as Abi, 'approve', [rig.addresses.positions, 5_000n]);
  const named: unknown[] = [];
  proxy.rule('eth_call', { kind: 'refuseIf', refuse: (p) => (named.push(p[1]), byHashOf(p[1])?.blockHash === H.hash), code: -32001, message: 'Resource not found' });
  try {
    await hooks().go(held);
    const record = await judged(bet.hash);
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'CANNOT_PAY', JSON.stringify(record));
    const block = verdict.block as { hash: string };
    assert.notEqual(block.hash, H.hash, 'decided at the new block');
    assert.equal(verdict.allowance, '5000', 'the allowance read at the new block');
    const atNew = named.map(byHashOf).filter((r) => r?.blockHash === block.hash);
    assert.ok(atNew.length >= 2, 'a fresh read A, and the reads after it, at the new block');
  } finally {
    proxy.rule('eth_call', null);
    await rig.write(B, rig.addresses.coin, rig.abis.TestCoin as Abi, 'approve', [rig.addresses.positions, 2n ** 256n - 1n]);
  }
});

test("one block: every request for a value the check makes names H by its hash, canonical, with H the result's own block; headers are read by tag only at the start (latest, then final) and by number only at the last check of H", async () => {
  const market = ownMarket();
  const M = await freshAccount();
  const B = await freshAccount();
  await quoteOn(M, market);
  await hooks().arm('after-reservation');
  const bet = await betOn(B, market);
  const held = await hooks().reached('after-reservation');
  const log = recording(['eth_call', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getStorageAt']);
  try {
    // The check's requests, to its result, before any step of the send: recorded there, and the courier goes on.
    await hooks().arm('before-result');
    await hooks().go(held);
    const atResult = await hooks().reached('before-result');
    log.stop();
    await hooks().go(atResult);
    const record = await judged(bet.hash);
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    const H = (record.cross as { block: { number: string; hash: string } }).block;
    const values = log.calls.filter((c) => c.method !== 'eth_getBlockByNumber' && c.method !== 'eth_getBlockByHash');
    assert.ok(values.length >= 6, `the reads, the exact call, its estimate, the call at the limit, the nonce: ${values.length}`);
    for (const c of values) {
      const ref = byHashOf(c.method === 'eth_getTransactionCount' || c.method === 'eth_getStorageAt' ? c.params[c.params.length - 1] : c.params[1]);
      assert.deepEqual(ref, { blockHash: H.hash, requireCanonical: true }, `${c.method} named ${JSON.stringify(c.params.slice(1))}`);
    }
    const headers = log.calls.filter((c) => c.method === 'eth_getBlockByNumber' || c.method === 'eth_getBlockByHash').map((c) => c.params[0]);
    assert.deepEqual(headers, ['latest', 'finalized', `0x${BigInt(H.number).toString(16)}`], 'latest, then final, then H again by its number');
  } finally {
    log.stop();
  }
});

test("one block: the last check of H. Its header, read again by its number at the end of the check, answers another hash, once: the round is thrown away and the check starts again from the latest header, and the bet is ready at the block its second round read, that round's own last check passing", async () => {
  const market = ownMarket();
  await quoteOn(await freshAccount(), market);
  await hooks().arm('after-reservation');
  const bet = await betOn(await freshAccount(), market);
  const held = await hooks().reached('after-reservation');
  const heads: unknown[] = [];
  let answeredOtherwise = 0;
  proxy.rule('eth_getBlockByNumber', {
    kind: 'rewriteResult',
    result: (p, r) => {
      heads.push(p[0]);
      const byNumber = typeof p[0] === 'string' && p[0] !== 'latest' && p[0] !== 'finalized';
      if (byNumber && answeredOtherwise === 0 && r !== null && typeof r === 'object') {
        answeredOtherwise++;
        return { ...(r as Record<string, unknown>), hash: keccak256(toBytes('another block at the same height')) };
      }
      return r;
    },
  });
  try {
    // The check's headers, to its result, before any step of the send: taken there, and the courier goes on.
    await hooks().arm('before-result');
    await hooks().go(held);
    const atResult = await hooks().reached('before-result');
    const checkHeads = [...heads];
    await hooks().go(atResult);
    const record = await judged(bet.hash);
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    const H = (record.cross as { block: { number: string } }).block;
    assert.equal(answeredOtherwise, 1, 'the last check read H by its number and was answered another hash');
    assert.deepEqual(
      { first: checkHeads.slice(0, 2), firstLast: typeof checkHeads[2] === 'string' && /^0x[0-9a-f]+$/.test(checkHeads[2] as string), second: checkHeads.slice(3) },
      { first: ['latest', 'finalized'], firstLast: true, second: ['latest', 'finalized', `0x${BigInt(H.number).toString(16)}`] },
      `the headers read, in order: ${JSON.stringify(checkHeads)}`,
    );
  } finally {
    proxy.rule('eth_getBlockByNumber', null);
  }
});

for (const variant of ['both rounds\' headers fail', 'each round reads its header, and then read A fails twice', 'the control: a refusal decided at H'] as const) {
  test(`one block: the same fault twice is CHAIN_UNREACHABLE with no block that decided it; ${variant}`, async () => {
    const B = await freshAccount();
    await hooks().arm('after-reservation');
    const bet = await betOn(B, ownMarket());
    const held = await hooks().reached('after-reservation');

    if (variant === "both rounds' headers fail") proxy.rule('eth_getBlockByNumber', { kind: 'refuseIf', refuse: (p) => p[0] === 'latest', code: -32000, message: 'held for the test' });
    if (variant === 'each round reads its header, and then read A fails twice') proxy.rule('eth_call', { kind: 'refuse', code: -32000, message: 'held for the test' });
    const heads: string[] = [];
    if (variant === 'each round reads its header, and then read A fails twice') proxy.rule('eth_getBlockByNumber', { kind: 'rewriteResult', result: (p, r) => (p[0] === 'latest' && r !== null && typeof r === 'object' ? (heads.push((r as { hash: string }).hash), r) : r) });
    try {
      await hooks().go(held);
      const record = await judged(bet.hash);
      const verdict = record.verdict as Record<string, unknown>;
      assert.equal(typeof verdict.at, 'string');
      const lines = await linesOf(bet.hash);
      assert.equal(lines.filter((l) => l.kind === 'bet refused').length, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()])).rows[0].n, 0);
      if (variant === 'the control: a refusal decided at H') {
        assert.equal(verdict.code, 'NO_DEPTH');
        assert.ok(verdict.block !== null && typeof verdict.block === 'object');
        assert.equal('lastObservedBlock' in verdict, false);
        return;
      }
      assert.equal(verdict.code, 'CHAIN_UNREACHABLE', JSON.stringify(record));
      assert.equal(verdict.error, 'The courier could not read the chain to check this bet, after two tries. Nothing was sent. Sign the bet again.');
      assert.equal(verdict.block, null);
      assert.ok(typeof verdict.operation === 'string' && typeof verdict.failureKind === 'string', 'the failed operation and its kind are named');
      if (variant === "both rounds' headers fail") {
        assert.equal('lastObservedBlock' in verdict, false, 'no round read a header');
      } else {
        const observed = verdict.lastObservedBlock as { hash: string };
        assert.equal(observed.hash, heads[heads.length - 1], "the second round's H, as an observation");
      }
    } finally {
      proxy.clear();
    }
  });
}

test("one block: a node that fails the check made at the courier's start. It answers a hash no block has as if it knew it: every POST /v1/orders, a quote or a bet, is answered 503 NODE_UNUSABLE and writes no row; the control, the same node passing, admits", async () => {
  const { UNKNOWN_HASH } = await import('../courier/chain/node');
  const lying = (p: unknown[]) => (byHashOf(p[1])?.blockHash === UNKNOWN_HASH ? [p[0], 'latest', ...p.slice(2)] : p);
  proxy.rule('eth_call', { kind: 'rewrite', params: lying });
  proxy.rule('eth_estimateGas', { kind: 'rewrite', params: lying });
  let started: (CourierProcess & { hooks?: HookControl }) | null = null;
  try {
    started = await stack.restartCourier({ hooked: true });
    const status = await get(started.url, '/v1/status');
    assert.equal((status.body.node as { usable: boolean }).usable, false);
    const M = await freshAccount();
    const market = ownMarket();
    const T = await rig.time();
    for (const [role, order] of [
      ['rest', { ...orderOn(rig, M, { expiry: T + 600n, ...market }), positionType: 0 }],
      ['take', { ...orderOn(rig, M, { expiry: T + 25n, riskAmount: 10_000n, ...market }), positionType: 1 }],
    ] as const) {
      const answer = await postOrder(started.url, rig, M, role, order as Order);
      assert.equal(answer.status, 503, JSON.stringify(answer.body));
      assert.equal(answer.body.code, 'NODE_UNUSABLE');
      assert.equal(answer.body.error, "The courier's node failed the check made when the courier started, so the courier takes no order until it restarts on a node that passes. Nothing was recorded.");
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE account = $1', [M.address.toLowerCase()])).rows[0].n, 0, 'no row');
  } finally {
    proxy.clear();
    await stack.restartCourier({ hooked: true });
  }
  // The control: the node passes, and a quote is admitted.
  const M = await freshAccount();
  await quoteOn(M, ownMarket());
});

// ──────────────────────────── the exact call from the key, at the recorded gas limit ────────────────────────────

test('the exact call at the recorded limit: the node halving the estimate, as one estimating at another block would, gives a limit the call cannot run on, and the bet is CROSS_WOULD_REVERT at the gas limit with no Cross row; the outgoing call at the limit carries the gas; the control, the estimate as the node gives it, is ready', async () => {
  const market = ownMarket();
  const M = await freshAccount();
  const B = await freshAccount();
  await quoteOn(M, market);
  const gasSeen: string[] = [];
  proxy.rule('eth_estimateGas', { kind: 'rewriteResult', result: (_p, r) => `0x${(BigInt(r as string) / 2n).toString(16)}` });
  proxy.rule('eth_call', { kind: 'rewrite', params: (p) => ((p[0] as { gas?: string }).gas !== undefined && gasSeen.push((p[0] as { gas: string }).gas), p) });
  try {
    const bet = await betOn(B, market);
    const record = await judged(bet.hash);
    assert.ok(record.verdict, JSON.stringify(record));
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'CROSS_WOULD_REVERT', JSON.stringify(record));
    assert.ok(typeof verdict.atGasLimit === 'string', 'marked as at the gas limit');
    assert.match(verdict.error as string, /^The node ran the exact transaction at block \d+ at the gas limit the courier would sign it with, and it was refused: /);
    assert.deepEqual(gasSeen, [`0x${BigInt(verdict.atGasLimit as string).toString(16)}`], 'the call at the limit carried the limit');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()])).rows[0].n, 0);
  } finally {
    proxy.clear();
  }
  const control = await betOn(await freshAccount(), market);
  assert.equal((await judged(control.hash)).state, 'confirmed');
});

test("the estimate's refusal on the record: the simulation at H clean, and the estimate of the same call refused, once by name (the node made to run it from a stranger, so the relay names the caller) and once with no reason (the node made to run it on too little gas). Each is CROSS_WOULD_REVERT with its reason, the named one with the error's arguments; `step` names the estimate, and `at` is the time the outcome was recorded, never a word; no Cross row", async () => {
  const market = ownMarket();
  await quoteOn(await freshAccount(), market);
  for (const variant of ['by name', 'no reason'] as const) {
    proxy.rule('eth_estimateGas', {
      kind: 'rewrite',
      params: (p) => [variant === 'by name' ? { ...(p[0] as object), from: rig.accounts.stranger.address } : { ...(p[0] as object), gas: `0x${(21_300).toString(16)}` }, ...p.slice(1)],
    });
    try {
      const bet = await betOn(await freshAccount(), market);
      const record = await judged(bet.hash);
      assert.ok(record.verdict, JSON.stringify(record));
      const verdict = record.verdict as Record<string, unknown>;
      assert.equal(verdict.code, 'CROSS_WOULD_REVERT', `${variant}: ${JSON.stringify(record)}`);
      const line = (await pool.query<{ at: Date }>(`SELECT at FROM events WHERE bet_hash = $1 AND kind = 'bet refused'`, [bet.hash.toLowerCase()])).rows[0];
      assert.equal(verdict.at, line?.at.toISOString(), `${variant}: at is the time the outcome was recorded`);
      assert.equal(verdict.step, 'estimate', variant);
      if (variant === 'by name') {
        assert.equal(verdict.reason, 'OspexCourierRelay__NotTheSender');
        assert.deepEqual(verdict.args, [rig.accounts.stranger.address], "the error's arguments");
      } else {
        assert.equal(verdict.reason, 'none');
        assert.equal('args' in verdict, false);
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()])).rows[0].n, 0);
    } finally {
      proxy.rule('eth_estimateGas', null);
    }
  }
});

test("the record's `at` is the time its outcome was recorded, whatever the line's facts hold: a refusal line whose facts carry a field named at, planted by the test in its own database ahead of the check's own line, is served with `at` that line's time, and the field does not replace it", async () => {
  await hooks().arm('after-reservation');
  const bet = await betOn(await freshAccount(), ownMarket());
  const held = await hooks().reached('after-reservation');
  const run = (await pool.query<{ run: string }>('SELECT run::text AS run FROM events WHERE order_hash = $1 ORDER BY number LIMIT 1', [bet.hash.toLowerCase()])).rows[0]?.run;
  const planted = (
    await pool.query<{ at: Date }>(`INSERT INTO events (run, kind, bet_hash, reason, facts) VALUES ($1, 'bet refused', $2, 'NO_DEPTH', $3) RETURNING at`, [
      run,
      bet.hash.toLowerCase(),
      JSON.stringify({ code: 'NO_DEPTH', error: 'planted by the test', block: null, at: 'a fact named at' }),
    ])
  ).rows[0];
  await hooks().go(held);
  const record = await judged(bet.hash);
  assert.ok(record.verdict, JSON.stringify(record));
  const verdict = record.verdict as Record<string, unknown>;
  assert.equal(verdict.error, 'planted by the test', 'the record is served from the first line, the planted one');
  assert.equal(verdict.at, planted?.at.toISOString(), JSON.stringify(record));
});

/**
 * A game that the read at H finds with its start written, and that the contract at an earlier block does not: created
 * at block e, its start written at the next. The case's accounts are funded first, so at e they stand as they do at H;
 * a rule of the proxy then points one request of the check at e, where the contract refuses the fill by name,
 * GameNotVerified: the courier's read of the game and the contract disagree.
 */
async function gameWrittenAfter(): Promise<{ gameId: bigint; earlier: { blockHash: Hex; requireCanonical: true } }> {
  const gameId = await rig.createGame();
  const head = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { number: Hex };
  const created = (await rig.rpc('eth_getBlockByNumber', [`0x${(BigInt(head.number) - 1n).toString(16)}`, false])) as { hash: Hex };
  return { gameId, earlier: { blockHash: created.hash, requireCanonical: true } };
}

/** The Cross's own call to the relay, and whether it carries a gas limit: the call at the limit does, the simulations do not. */
const toRelay = (p: unknown[]) => (p[0] as { to?: string }).to?.toLowerCase() === rig.addresses.relay.toLowerCase();
const carriesGas = (p: unknown[]) => (p[0] as { gas?: string }).gas !== undefined;

for (const site of ['simulation', 'estimate', 'simulation of the chosen prefix', 'call at the limit'] as const) {
  test(`GameNotVerified from the contract at the ${site}, where the read at H found the game's start written: the bet is CROSS_WOULD_REVERT naming it, with an incident line beside the refusal that names the ${site}, the courier's read of the game and the contract disagreeing; no Cross row`, async () => {
    const [M1, M2, B] = [await freshAccount(), await freshAccount(), await freshAccount()];
    const { gameId, earlier } = await gameWrittenAfter();
    const market = ownMarket();
    // Two quotes where the search needs a shorter prefix to choose; one that fills the bet otherwise.
    if (site === 'simulation of the chosen prefix') {
      await quoteOn(M1, market, { oddsTick: 200, riskAmount: 5_000n, gameId });
      await quoteOn(M2, market, { oddsTick: 200, riskAmount: 5_000n, gameId });
    } else {
      await quoteOn(M1, market, { oddsTick: 200, riskAmount: 100_000n, gameId });
    }
    let simulations = 0;
    let estimates = 0;
    const atEarlier = (p: unknown[]) => [p[0], earlier, ...p.slice(2)];
    if (site === 'simulation') proxy.rule('eth_call', { kind: 'rewrite', params: (p) => (toRelay(p) && !carriesGas(p) && simulations++ === 0 ? atEarlier(p) : p) });
    if (site === 'estimate') proxy.rule('eth_estimateGas', { kind: 'rewrite', params: (p) => (estimates++ === 0 ? atEarlier(p) : p) });
    if (site === 'simulation of the chosen prefix') {
      // The whole list's estimate answered at the one transaction's cap, so its limit is over it and the search runs;
      // the search's own estimate of the one-quote prefix is the node's. The prefix's simulation is pointed at e.
      proxy.rule('eth_estimateGas', { kind: 'rewriteResult', result: (_p, r) => (estimates++ === 0 ? `0x${BigInt(CHAIN_LIMITS.transactionGasCap).toString(16)}` : r) });
      proxy.rule('eth_call', { kind: 'rewrite', params: (p) => (toRelay(p) && !carriesGas(p) && simulations++ === 1 ? atEarlier(p) : p) });
    }
    if (site === 'call at the limit') proxy.rule('eth_call', { kind: 'rewrite', params: (p) => (toRelay(p) && carriesGas(p) ? atEarlier(p) : p) });
    try {
      const bet = await betOn(B, market, { oddsTick: 200, riskAmount: 10_000n, gameId });
      const record = await judged(bet.hash);
      assert.ok(record.verdict, JSON.stringify(record));
      const verdict = record.verdict as Record<string, unknown>;
      assert.deepEqual({ code: verdict.code, reason: verdict.reason }, { code: 'CROSS_WOULD_REVERT', reason: 'OspexMarkets__GameNotVerified' }, JSON.stringify(record));
      const incidents = (await linesOf(bet.hash)).filter((l) => l.kind === 'incident');
      assert.deepEqual(
        incidents.map((l) => {
          const revert = l.facts.revert as { name?: string; args?: unknown[] } | undefined;
          return { reason: l.reason, at: l.facts.at, error: revert?.name, args: (revert?.args ?? []).map(String) };
        }),
        // The game's status at block e: 1, Unverified, created and its start not yet written.
        [{ reason: 'GAME_READ_AND_CONTRACT_DIFFER', at: site, error: 'OspexMarkets__GameNotVerified', args: [gameId.toString(), '1'] }],
        JSON.stringify(incidents),
      );
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()])).rows[0].n, 0);
    } finally {
      proxy.clear();
    }
  });
}

test("the relay's sender at H is the key: with the sender set to another key through the timelock, the bet is COURIER_CANNOT_SEND and no Cross row; set back, the control is ready", async () => {
  const market = ownMarket();
  const M = await freshAccount();
  await quoteOn(M, market);
  const relayAbi = rig.abis.OspexCourierRelay as Abi;
  await rig.throughTimelock(rig.addresses.relay, encodeFunctionData({ abi: relayAbi, functionName: 'setSender', args: [rig.accounts.stranger.address] } as never));
  try {
    const bet = await betOn(await freshAccount(), market);
    const record = await judged(bet.hash);
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'COURIER_CANNOT_SEND', JSON.stringify(record));
    assert.match(verdict.error as string, /^At block \d+ the courier's key is not the relay's sender, so the courier cannot send\. Nothing was sent\.$/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()])).rows[0].n, 0);
  } finally {
    await rig.throughTimelock(rig.addresses.relay, encodeFunctionData({ abi: relayAbi, functionName: 'setSender', args: [rig.accounts.sender.address] } as never));
  }
  const control = await betOn(await freshAccount(), market);
  assert.equal((await judged(control.hash)).state, 'confirmed');
});

test('the exact call from the key: a coin that refuses the bettor, with its balance and its allowance enough and no override to compare, is caught by the exact call alone: CROSS_WOULD_REVERT naming TakerPullRefused, and no Cross row; the control, the bettor not blocked, is ready', async () => {
  const refusing = await startStack('precheck_refusing', { coin: 'RefusingCoin', hooked: true });
  refusing.proxy.finalFollows(0n);
  try {
    const r = refusing.rig;
    const M = r.account(40);
    const B = r.account(41);
    await r.fund(M);
    await r.fund(B);
    // The node refuses overrides from the courier's start: the comparison is off.
    refusing.proxy.rule('eth_call', { kind: 'refuseIf', refuse: (p) => p.length >= 3, code: -32602, message: 'overrides are not taken here' });
    const courier = await refusing.restartCourier({ hooked: true });
    assert.equal(((await get(courier.url, '/v1/status')).body.node as { overrideTaken: { ok: boolean } }).overrideTaken.ok, false);
    const T = await r.time();
    const market = { scorer: r.addresses.spread, lineTicks: -55 };
    const q: Order = { ...orderOn(r, M, { expiry: T + 600n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 };
    assert.equal((await postOrder(courier.url, r, M, 'rest', q)).status, 201);
    await r.write(r.accounts.deployer, r.addresses.coin, r.abis.RefusingCoin as Abi, 'setBlocked', [B.address, true]);
    const bet: Order = { ...orderOn(r, B, { expiry: T + 25n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 };
    const posted = await postOrder(courier.url, r, B, 'take', bet);
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const record = await judged(posted.body.orderHash as string, courier.url);
    assert.ok(record.verdict, JSON.stringify(record));
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'CROSS_WOULD_REVERT', JSON.stringify(record));
    assert.equal(verdict.reason, 'OspexPositions__TakerPullRefused');
    const rpool = openPool(refusing.databaseUrl, null);
    try {
      const crosses = await rpool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [String(posted.body.orderHash).toLowerCase()]);
      assert.equal(crosses.rows[0].n, 0, 'no Cross row');
    } finally {
      await rpool.end();
    }
    // The control: unblocked, a bet from the same account is ready.
    await r.write(r.accounts.deployer, r.addresses.coin, r.abis.RefusingCoin as Abi, 'setBlocked', [B.address, false]);
    const T2 = await r.time();
    const again: Order = { ...orderOn(r, B, { expiry: T2 + 25n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 };
    const ok = await postOrder(courier.url, r, B, 'take', again);
    assert.equal((await judged(ok.body.orderHash as string, courier.url)).state, 'confirmed');
  } finally {
    refusing.proxy.clear();
    await refusing.close();
  }
});

// ──────────────────────────── a stop ahead's original ────────────────────────────

test("a stop ahead's original is never a candidate: an original that would meet a bet at the best price, stopped ahead and never posted, is in neither the candidate statement's rows nor the walk's input, and the bet is NO_DEPTH; the control, the same order posted with no stop, is listed and ready", async () => {
  const market = ownMarket();
  const M = await freshAccount();
  const B = await freshAccount();
  const T = await rig.time();
  const original: Order = { ...orderOn(rig, M, { expiry: T + 600n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 };
  const signature = await sign(M, original, 31337, rig.addresses.matching);
  const originalHash = (await contractHash(rig, original)).toLowerCase();
  const stop = await postStop(url(), rig, M, stopMessage(M.address, [originalHash as Hex]), [{ orderHash: originalHash as Hex, order: original, signature }]);
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const seen = hooks().observed.length;
  // The boundary first: held once the check has ended and before its outcome is written, by which point both of its
  // observations have come (they travel ahead of the hold on the same channel). Then the check goes on to its outcome.
  await hooks().arm('before-result');
  const bet = await betOn(B, market);
  const held = await hooks().reached('before-result');
  try {
    const observed = hooks().observed.slice(seen);
    const candidates = observed.filter((o) => o.what === 'candidates');
    const input = observed.filter((o) => o.what === 'walk input');
    assert.ok(candidates.length >= 1 && input.length >= 1, 'the boundary was observed');
    for (const o of observed) assert.ok(!o.hashes.map((h) => h.toLowerCase()).includes(originalHash), `${o.what} held the original`);
  } finally {
    await hooks().go(held);
  }
  const record = await judged(bet.hash);
  assert.equal((record.verdict as { code: string }).code, 'NO_DEPTH', JSON.stringify(record));
  // The control: the same terms, signed afresh and posted with no stop, listed and ready.
  const posted = await quoteOn(M, market);
  const control = await betOn(await freshAccount(), market);
  const ready = await judged(control.hash);
  assert.equal(ready.state, 'confirmed');
  assert.deepEqual(legsOf(ready), [posted.hash.toLowerCase()]);
});

// ──────────────────────────── the gas ────────────────────────────

/**
 * An account that holds the other side of the market, as the worked fixture has it: it took side B earlier for 3,000
 * against a profit of 2,500, by a Cross the test sends through another courier, so it holds 3,000 there.
 */
async function holdingOtherSide(market: { scorer: Address; lineTicks: number }, on: Rig = rig, fresh: () => Promise<HDAccount> = freshAccount): Promise<HDAccount> {
  const M = await fresh();
  const X = await fresh();
  const T = await on.time();
  const x: Order = { ...orderOn(on, X, { expiry: T + 600n, oddsTick: 220, riskAmount: 2_500n, ...market }), positionType: 0 };
  const m: Order = { ...orderOn(on, M, { expiry: T + 25n, oddsTick: 180, riskAmount: 3_000n, ...market }), positionType: 1 };
  const sent = await crossFromTheTest(on, { order: m, signature: await sign(M, m, 31337, on.addresses.matching) }, [{ order: x, signature: await sign(X, x, 31337, on.addresses.matching) }]);
  assert.equal(sent.filled, true, JSON.stringify(sent));
  return M;
}

/**
 * The requests the courier makes of the node while a held check runs to its result, before any step of the send: the
 * outcome's record, and the count at the proxy. A ready bet's count leaves out the sender's two reads its check now
 * makes, held to exactly one tip and one key's count at the final block.
 */
async function countedCheck(bet: () => Promise<{ hash: Hex }>, during?: () => void): Promise<{ record: Record<string, unknown>; requests: number }> {
  await hooks().arm('after-reservation');
  const posted = await bet();
  const held = await hooks().reached('after-reservation');
  during?.();
  const before = proxy.count();
  const from = { tips: proxy.count('eth_maxPriorityFeePerGas'), keyCounts: proxy.count('eth_getTransactionCount') };
  await hooks().arm('before-result');
  await hooks().go(held);
  const atResult = await hooks().reached('before-result');
  const requests = proxy.count() - before;
  const reads = senderReads(proxy, from);
  await hooks().go(atResult);
  const record = await judged(posted.hash);
  if (record.state !== 'confirmed') return { record, requests };
  assert.deepEqual(reads, { tip: 1, keyCounts: 2 }, "the sender's two reads, beside the check's own count at H");
  return { record, requests: requests - 2 };
}

test('the gas: the limit is the estimate and a fifth of it, in whole gas, to the unit, for estimates either side of a multiple of five', async () => {
  const market = ownMarket();
  await quoteOn(await freshAccount(), market);
  for (const [g, limit] of [
    [600_004n, 720_004n],
    [600_005n, 720_006n],
    [600_009n, 720_010n],
  ] as const) {
    proxy.rule('eth_estimateGas', { kind: 'rewriteResult', result: () => `0x${g.toString(16)}` });
    try {
      const bet = await betOn(await freshAccount(), market);
      const record = await judged(bet.hash);
      assert.equal(record.state, 'confirmed', JSON.stringify(record));
      const gas = (record.cross as { gas: { estimate: string; limit: string; used: string } }).gas;
      assert.deepEqual({ estimate: gas.estimate, limit: gas.limit }, { estimate: g.toString(), limit: limit.toString() });
      assert.ok(BigInt(gas.used) <= limit, `the gas used is within the limit: ${gas.used}`);
    } finally {
      proxy.rule('eth_estimateGas', null);
    }
  }
});

test("the gas: the bet's minimum rules out every shorter prefix. Two quotes of a maker that holds the other side, the bet's minimum 9,000 and the ceiling below the two-leg call: one leg would fill 4,992 and leave 5,008, so no shorter prefix is estimated; CROSS_TOO_LARGE in its second form, with listed 2, shortestMeetingMinimum 2 and estimates 0, in exactly 8 requests to the node", async () => {
  const market = ownMarket();
  const M = await holdingOtherSide(market);
  await quoteOn(M, market, { oddsTick: 204, riskAmount: 4_800n });
  await quoteOn(M, market, { oddsTick: 204, riskAmount: 4_800n });
  await hooks().fault({ transactionGasCap: 50_000n });
  try {
    const B = await freshAccount();
    const { record, requests } = await countedCheck(() => betOn(B, market, { oddsTick: 196, riskAmount: 10_000n, minFill: 9_000n }));
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'CROSS_TOO_LARGE', JSON.stringify(record));
    assert.deepEqual({ listed: verdict.listed, shortest: verdict.shortestMeetingMinimum, estimates: verdict.estimates }, { listed: 2, shortest: 2, estimates: 0 });
    assert.match(verdict.error as string, /^At block \d+, a fill of this bet against the 2 quotes listed for it needs more gas than one transaction may carry\. The courier looked for a fill against fewer of them, taken in their order, that fits one transaction and meets this bet's minimum, and its search found none; that does not mean none exists\. Nothing was sent\. Sign the bet again with a smaller stake or a lower minimum\.$/);
    assert.equal(requests, 8, 'H, read A, F, read B, read C, the simulation, the comparison and the whole list\'s estimate');
  } finally {
    await hooks().fault({ transactionGasCap: null });
  }
});

test('the gas: even one quote. The same two quotes with a minimum of 0 and the ceiling below a one-leg call: the search\'s one step, the one-quote prefix, is over the ceiling; CROSS_TOO_LARGE in its first form, in 9 requests', async () => {
  const market = ownMarket();
  const M = await holdingOtherSide(market);
  await quoteOn(M, market, { oddsTick: 204, riskAmount: 4_800n });
  await quoteOn(M, market, { oddsTick: 204, riskAmount: 4_800n });
  await hooks().fault({ transactionGasCap: 50_000n });
  try {
    const B = await freshAccount();
    const { record, requests } = await countedCheck(() => betOn(B, market, { oddsTick: 196, riskAmount: 10_000n, minFill: 0n }));
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'CROSS_TOO_LARGE', JSON.stringify(record));
    assert.match(verdict.error as string, /^At block \d+ even a fill of this bet against one quote needs more gas than one transaction may carry\. Nothing was sent\.$/);
    assert.equal(requests, 9);
  } finally {
    await hooks().fault({ transactionGasCap: null });
  }
});

/** Forty quotes at tick 200 of one lot each, from three makers: a bet of 4,000 at tick 200 lists all forty. */
async function fortyQuotes(market: { scorer: Address; lineTicks: number }): Promise<void> {
  const makers = [await freshAccount(), await freshAccount(), await freshAccount()];
  for (let i = 0; i < 40; i++) await quoteOn(makers[Math.floor(i / 16)] as HDAccount, market, { oddsTick: 200, riskAmount: 100n });
}

test('the gas: a fit found. With the ceiling set so forty legs do not fit and a shorter prefix does, the bet is ready with that prefix, its own simulation, comparison and call at the limit run on it, every step of the search in the figures, and the limit never cut', async () => {
  const market = ownMarket();
  // The forty legs' limit, measured on a twin market stocked the same way by makers of its own: the measuring bet is
  // sent, and fills the market it measured, where a second Cross would find the makers' slots written and cost less.
  const twin = ownMarket();
  await fortyQuotes(twin);
  const whole = await judged((await betOn(await freshAccount(), twin, { oddsTick: 200, riskAmount: 4_000n })).hash);
  assert.equal(legsOf(whole).length, 40, JSON.stringify(whole));
  const wholeLimit = BigInt((whole.cross as { gas: { limit: string } }).gas.limit);
  await fortyQuotes(market);
  // The ceiling half a leg's gas under the forty legs' limit: another bet's calldata (its signature, its fields) has
  // other zero bytes, so its forty-leg estimate is not this one's to the unit, and a ceiling one gas under would let
  // a slightly cheaper forty legs fit. An eightieth of the limit, about half a leg's share of it, keeps forty over the
  // ceiling and a shorter prefix under it.
  const cap = wholeLimit - wholeLimit / 80n;
  await hooks().fault({ transactionGasCap: cap });
  try {
    const B = await freshAccount();
    const { record, requests } = await countedCheck(() => betOn(B, market, { oddsTick: 200, riskAmount: 4_000n }));
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    const legs = legsOf(record).length;
    assert.ok(legs >= 1 && legs < 40, `a shorter prefix: ${legs}`);
    const gas = (record.cross as { gas: { estimate: string; limit: string } }).gas;
    assert.equal(BigInt(gas.limit), BigInt(gas.estimate) + BigInt(gas.estimate) / 5n, 'the limit is the estimate and a fifth: never cut');
    assert.ok(BigInt(gas.limit) <= cap);
    const { rows } = await pool.query<{ checked: { gas: { trim: { estimates: number; steps: unknown[] } } } }>('SELECT checked FROM crosses WHERE bet_hash = $1', [String(record.orderHash).toLowerCase()]);
    const trim = rows[0]?.checked.gas.trim;
    assert.ok(trim !== undefined && trim.estimates >= 1 && trim.estimates <= 6 && trim.steps.length === trim.estimates, JSON.stringify(trim));
    // H, read A, F, read B, the simulation, the comparison, the whole list's estimate, the search's estimates, then
    // the chosen prefix's simulation, comparison and call at the limit, the key's count, and H again.
    assert.equal(requests, 12 + trim.estimates);
  } finally {
    await hooks().fault({ transactionGasCap: null });
  }
});

test('the gas: no reason at a step. One step\'s estimate answered with the node\'s out-of-gas error and no data: the search goes below it, the bet is ready with a shorter prefix, and the figures name that step as one where no reason came back', async () => {
  const market = ownMarket();
  const makers = [await freshAccount(), await freshAccount(), await freshAccount()];
  // The three legs' limit, measured on a twin market stocked the same way by makers of its own: the measuring bet is
  // sent, and fills the market it measured, where a second Cross would find the makers' slots written and cost less.
  const twin = ownMarket();
  for (const m of [await freshAccount(), await freshAccount(), await freshAccount()]) await quoteOn(m, twin, { oddsTick: 200, riskAmount: 100n });
  const whole = await judged((await betOn(await freshAccount(), twin, { oddsTick: 200, riskAmount: 300n })).hash);
  assert.equal(legsOf(whole).length, 3, JSON.stringify(whole));
  for (const m of makers) await quoteOn(m, market, { oddsTick: 200, riskAmount: 100n });
  // The ceiling a twelfth under the three legs' limit, not one gas: another bet's calldata has other zero bytes, so its
  // three-leg estimate can be a little lower, and one gas under let it fit. One leg's limit is far under either.
  const wholeLimit = BigInt((whole.cross as { gas: { limit: string } }).gas.limit);
  await hooks().fault({ transactionGasCap: wholeLimit - wholeLimit / 12n });
  try {
    const B = await freshAccount();
    const { record } = await countedCheck(
      () => betOn(B, market, { oddsTick: 200, riskAmount: 300n }),
      () => proxy.rule('eth_estimateGas', { kind: 'refuseWhen', refuse: (nth) => nth === 2, code: -32003, message: 'Out of gas: gas required exceeds allowance: 1' }),
    );
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    assert.equal(legsOf(record).length, 1);
    const { rows } = await pool.query<{ checked: { gas: { trim: { steps: Array<{ k: number; answer?: string; fits?: boolean }> } } } }>('SELECT checked FROM crosses WHERE bet_hash = $1', [String(record.orderHash).toLowerCase()]);
    const steps = rows[0]?.checked.gas.trim.steps ?? [];
    assert.deepEqual(steps.map((s) => ({ k: s.k, how: s.answer ?? (s.fits ? 'fits' : 'over') })), [{ k: 2, how: 'no reason came back' }, { k: 1, how: 'fits' }]);
  } finally {
    proxy.rule('eth_estimateGas', null);
    await hooks().fault({ transactionGasCap: null });
  }
});

test("the gas: a step refused, with no override. The node takes no override; the first listed maker's coin refuses its pull, a survivor behind it; the ceiling below the whole call: the one-quote step's estimate is refused NothingFilled naming PullRefused, so the search ends, and the bet is CROSS_WOULD_REVERT with trimmedTo 1, no estimate after it", async () => {
  const refusing = await startStack('precheck_step', { coin: 'RefusingCoin', hooked: true });
  refusing.proxy.finalFollows(0n);
  try {
    const r = refusing.rig;
    const fund = async (i: number) => {
      const who = r.account(i);
      await r.fund(who);
      return who;
    };
    const [M1, M2, B] = [await fund(40), await fund(41), await fund(42)];
    refusing.proxy.rule('eth_call', { kind: 'refuseIf', refuse: (p) => p.length >= 3, code: -32602, message: 'overrides are not taken here' });
    const courier = await refusing.restartCourier({ hooked: true });
    const h = courier.hooks as HookControl;
    const T = await r.time();
    const market = { scorer: r.addresses.spread, lineTicks: -95 };
    // The first quote fills half the bet, so the second is listed behind it: a whole list of two to trim.
    for (const [who, tick, risk] of [[M1, 200, 5_000n], [M2, 202, 100_000n]] as const) {
      const q: Order = { ...orderOn(r, who, { expiry: T + 600n, oddsTick: tick, riskAmount: risk, ...market }), positionType: 0 };
      assert.equal((await postOrder(courier.url, r, who, 'rest', q)).status, 201);
    }
    await r.write(r.accounts.deployer, r.addresses.coin, r.abis.RefusingCoin as Abi, 'setBlocked', [M1.address, true]);
    // The ceiling: under the whole call's limit, whatever it is; the search is what is under test.
    await h.fault({ transactionGasCap: 60_000n });
    await h.arm('after-reservation');
    const bet: Order = { ...orderOn(r, B, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
    const posted = await postOrder(courier.url, r, B, 'take', bet);
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const held = await h.reached('after-reservation');
    const estimatesBefore = refusing.proxy.count('eth_estimateGas');
    await h.go(held);
    const record = await judged(posted.body.orderHash as string, courier.url);
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'CROSS_WOULD_REVERT', JSON.stringify(record));
    assert.equal(verdict.trimmedTo, 1);
    assert.equal(verdict.reason, 'OspexMatching__NothingFilled');
    assert.match(verdict.error as string, /^At block \d+, a fill of this bet against all its listed quotes needs more gas than one transaction may carry, and the node refused the fill against the first 1 of them: OspexMatching__NothingFilled\(PullRefused\)\. Nothing was sent\. Sign the bet again\.$/);
    assert.equal(refusing.proxy.count('eth_estimateGas') - estimatesBefore, 2, 'the whole list\'s estimate and the one step: none after it');
  } finally {
    await refusing.close();
  }
});

// ──────────────────────────── a stored row changed ────────────────────────────

/** The ten fields' columns, and a change to each that keeps the row's own rules; and the signature. */
const CHANGES: Array<{ field: string; sql: string }> = [
  { field: 'account', sql: `account = '0x000000000000000000000000000000000000dead'` },
  { field: 'gameId', sql: 'game_id = game_id + 1000' },
  { field: 'scorer', sql: `scorer = '0x000000000000000000000000000000000000beef'` },
  { field: 'lineTicks', sql: 'line_ticks = line_ticks - 1' },
  { field: 'positionType', sql: 'position_type = 1 - position_type, side = 1 - side' },
  { field: 'oddsTick', sql: 'odds_tick = odds_tick - 1' },
  { field: 'riskAmount', sql: 'risk_amount = risk_amount + 100' },
  { field: 'nonce', sql: 'nonce = nonce + 1' },
  { field: 'expiry', sql: 'expiry = expiry + 1' },
  { field: 'minFill', sql: 'min_fill = min_fill + 1' },
  { field: 'signature', sql: `signature = overlay(signature placing (CASE WHEN substr(signature, 3, 2) = '11' THEN '22' ELSE '11' END) from 3 for 2)` },
];

test("a stored quote changed: each of the ten fields and the signature, one at a time, changed in the quote's stored row: the quote is not listed, with an incident line naming it; the control beside each, the same quote unchanged, is listed and ready", async () => {
  for (const change of CHANGES) {
    const market = ownMarket();
    const M = await freshAccount();
    const q = await quoteOn(M, market);
    await pool.query(`UPDATE orders SET ${change.sql} WHERE hash = $1`, [q.hash.toLowerCase()]);
    const bet = await betOn(await freshAccount(), market);
    const record = await judged(bet.hash);
    if (change.field === 'positionType') {
      // Turned to the other side, the stored quote is not among this side's candidates at all: never examined.
      assert.equal((record.verdict as { code: string }).code, 'NO_DEPTH', `${change.field}: ${JSON.stringify(record)}`);
    } else {
      assert.equal((record.verdict as { code: string }).code, 'NO_DEPTH', `${change.field}: ${JSON.stringify(record)}`);
      const incidents = await pool.query(`SELECT reason, order_hash FROM events WHERE kind = 'incident' AND bet_hash = $1`, [bet.hash.toLowerCase()]);
      assert.deepEqual(incidents.rows, [{ reason: 'STORED_ORDER_CHANGED', order_hash: q.hash.toLowerCase() }], change.field);
    }
    // The control: an unchanged quote on the same market is listed and ready.
    const control = await quoteOn(await freshAccount(), market);
    const ready = await judged((await betOn(await freshAccount(), market)).hash);
    assert.deepEqual(legsOf(ready), [control.hash.toLowerCase()], `${change.field}: the control`);
  }
});

test("a stored bet changed: each of the ten fields and the signature, one at a time, changed in the bet's stored row while it waits its turn: COURIER_FAULT, with an incident line; the control, a bet unchanged, is ready", async () => {
  const market = ownMarket();
  await quoteOn(await freshAccount(), market);
  // The runner held after every reservation that finds the queue empty, so each bet waits until its row is changed.
  const parked = await stack.restartCourier({ hooked: true, holds: 'after-empty-reservation:all' });
  const h = parked.hooks as HookControl;
  let held = await h.reached('after-empty-reservation');
  for (const change of CHANGES) {
    const bet = await betOn(await freshAccount(), market);
    await pool.query(`UPDATE orders SET ${change.sql} WHERE hash = $1`, [bet.hash.toLowerCase()]);
    await h.go(held);
    held = await h.reached('after-empty-reservation');
    const record = await judged(bet.hash);
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'COURIER_FAULT', `${change.field}: ${JSON.stringify(record)}`);
    assert.equal(verdict.error, "The courier's own check of this bet went wrong. That is the courier's fault, and it is recorded as one. Nothing was sent. Sign the bet again.");
    const incidents = await pool.query(`SELECT reason FROM events WHERE kind = 'incident' AND bet_hash = $1`, [bet.hash.toLowerCase()]);
    assert.deepEqual(incidents.rows, [{ reason: 'STORED_ORDER_CHANGED' }], change.field);
  }
  await h.disarm('after-empty-reservation');
  const control = await betOn(await freshAccount(), market);
  await h.go(held);
  assert.equal((await judged(control.hash)).state, 'confirmed', 'the control');
  await stack.restartCourier({ hooked: true });
});

// ──────────────────────────── time: only a signed time or the contract's close, against the chain's time at H ────────────────────────────

/** One environment for the time cases: a stack, its courier's hooks, its own accounts, its database. */
interface Clocked {
  stack: Stack;
  rig: Rig;
  url: string;
  hooks: HookControl;
  pool: pg.Pool;
  fresh(): Promise<HDAccount>;
}

let behind: Clocked | null = null;
after(async () => {
  await behind?.pool.end();
  await behind?.stack.close();
});

/** The two clocks: this file's chain moved a day ahead of the wall clock, and a chain of its own started a day behind it. */
async function clocked(which: 'ahead' | 'behind'): Promise<Clocked> {
  if (which === 'ahead') {
    const wall = BigInt(Math.floor(Date.now() / 1000));
    const T = await rig.time();
    if (T < wall + 86_400n) await rig.increaseTime(wall + 86_400n - T);
    return { stack, rig, url: url(), hooks: hooks(), pool, fresh: freshAccount };
  }
  if (behind === null) {
    const s = await startStack('precheck_behind', { hooked: true, genesisTime: BigInt(Math.floor(Date.now() / 1000)) - 2n * 86_400n });
    s.proxy.finalFollows(0n);
    let next = 80;
    behind = {
      stack: s,
      rig: s.rig,
      url: s.courier.url,
      hooks: s.courier.hooks as HookControl,
      pool: openPool(s.databaseUrl, null),
      async fresh() {
        const who = s.rig.account(next++);
        await s.rig.fund(who);
        return who;
      },
    };
  }
  return behind;
}

/**
 * Holds the check after its reservation, mines H at `time`, and lets the check go: the outcome's record. A bet found
 * ready is held again at its intent, and its Cross is mined in the block at H's time + 1, the next block its check
 * judged it for, as the live chain's next block follows H.
 */
async function checkedAt(env: Clocked, post: () => Promise<Hex>, time: bigint): Promise<Record<string, unknown>> {
  await env.hooks.arm('after-reservation');
  await env.hooks.arm('after-intent');
  const hash = await post();
  const held = await env.hooks.reached('after-reservation');
  await env.rig.setNextBlockTime(time);
  await env.rig.mine(1);
  assert.equal(await env.rig.time(), time);
  await env.hooks.go(held);
  const first = await atIntentOrJudged(hash, env.url);
  if (first.state !== 'queued') {
    await env.hooks.disarm('after-intent');
    return first;
  }
  const atIntent = await env.hooks.reached('after-intent');
  await env.rig.setNextBlockTime(time + 1n);
  await env.hooks.go(atIntent);
  return judged(hash, env.url);
}

const timeMarket = (env: Clocked) => ({ scorer: env.rig.addresses.spread, lineTicks: -(500 + 5 * nextLine++) });

async function postAs(env: Clocked, who: HDAccount, role: 'rest' | 'take', order: Order): Promise<Hex> {
  const posted = await postOrder(env.url, env.rig, who, role, order);
  assert.equal(posted.status, role === 'rest' ? 201 : 202, JSON.stringify(posted.body));
  return posted.body.orderHash as Hex;
}

for (const which of ['ahead', 'behind'] as const) {
  const clock = which === 'ahead' ? 'the chain a day ahead of the wall clock' : 'the chain a day behind the wall clock';

  test(`time, ${clock}: a bet whose expiry is T + 1 at its check is lapsed, BET_LAPSED, with its sentence; with T + 2 it is checked and ready`, async () => {
    const env = await clocked(which);
    const market = timeMarket(env);
    const T0 = await env.rig.time();
    const M = await env.fresh();
    await postAs(env, M, 'rest', { ...orderOn(env.rig, M, { expiry: T0 + 600n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 });
    for (const [gap, expect] of [[1n, 'lapsed'], [2n, 'confirmed']] as const) {
      const B = await env.fresh();
      const T = await env.rig.time();
      const order: Order = { ...orderOn(env.rig, B, { expiry: T + 20n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 };
      const record = await checkedAt(env, () => postAs(env, B, 'take', order), order.expiry - gap);
      assert.equal(record.state, expect, JSON.stringify(record));
      if (expect === 'lapsed') {
        const v = record.verdict as Record<string, unknown>;
        assert.equal(v.code, 'BET_LAPSED');
        const block = v.block as { number: string; time: string };
        assert.equal(v.error, `This bet ran out of time before its turn came. Its expiry is ${order.expiry}, and at block ${block.number} a bet needed an expiry above ${BigInt(block.time) + 1n}. Nothing was sent. Sign it again.`);
      }
    }
  });

  test(`time, ${clock}: a quote whose expiry is T + 1 at the check is not listed, and one with T + 2 is; the candidate statement alone leaves out the first and returns the second; and the walk, handed the first directly, does not list it`, async () => {
    const env = await clocked(which);
    const market = timeMarket(env);
    // Every account funded first: a funding mines blocks. Then H's time is twenty seconds on, inside the bet's life.
    const [M1, M2, candidateBettor, walkBettor, B] = [await env.fresh(), await env.fresh(), await env.fresh(), await env.fresh(), await env.fresh()];
    const T0 = await env.rig.time();
    const at = T0 + 20n;
    // The one about to expire is the better price, so it would come first were it live.
    const early: Order = { ...orderOn(env.rig, M1, { expiry: at + 1n, oddsTick: 190, riskAmount: 100_000n, ...market }), positionType: 0 };
    const late: Order = { ...orderOn(env.rig, M2, { expiry: at + 2n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 };
    const earlyHash = await postAs(env, M1, 'rest', early);
    const lateHash = await postAs(env, M2, 'rest', late);
    // The candidate statement alone, at H's time `at`, with the final block's time behind both expiries: nothing marked.
    const { candidates: candidateQuery } = await import('../courier/records/orders');
    const alone = await candidateQuery(env.pool, { marketKey: marketKeyOf(env, market), side: 0, betTick: 196, bettor: candidateBettor.address, blockTime: at, finalTime: T0 });
    assert.deepEqual(alone.rows.map((r) => r.hash.toLowerCase()), [lateHash.toLowerCase()], 'the candidate statement alone');
    // The walk handed the first directly: not listed, for its expiry.
    const { walk } = await import('../courier/check/walk');
    const { PullModel } = await import('../courier/check/pull');
    const bettor = walkBettor.address;
    const model = new PullModel(new Map([[bettor.toLowerCase(), { records: { riskA: 0n, profitA: 0n, riskB: 0n, profitB: 0n }, held: 0n, balance: 10n ** 12n, allowance: 10n ** 12n }], [M1.address.toLowerCase(), { records: { riskA: 0n, profitA: 0n, riskB: 0n, profitB: 0n }, held: 0n, balance: 10n ** 12n, allowance: 10n ** 12n }]]), bettor, 1);
    const direct = walk(
      { account: bettor, side: 1, oddsTick: 196, riskAmount: 10_000n, minFill: 0n, filled: 0n },
      [{ hash: earlyHash, order: early, signature: '0x', recordNumber: 1, signer: M1.address, state: { registered: true, cancelled: false, version: 0n, floorAtVersion: 0n, currentGrant: 0, grant: null, filled: 0n } }],
      model,
      at,
      40,
    );
    assert.deepEqual(direct.notListed, [{ hash: earlyHash, why: 'Expired' }], 'the walk, handed it directly');
    // End to end, at H's time `at`: the bet is ready with the later quote alone.
    const bet: Order = { ...orderOn(env.rig, B, { expiry: (await env.rig.time()) + 30n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
    const record = await checkedAt(env, () => postAs(env, B, 'take', bet), at);
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    assert.deepEqual(legsOf(record), [lateHash.toLowerCase()]);
  });

  test(`time, ${clock}: a quote under a grant that ends at T + 1 at the check is not listed, and one under a grant that ends at T + 2 is`, async () => {
    const env = await clocked(which);
    const market = timeMarket(env);
    // Every account funded first: a funding mines blocks. Then H's time is twenty seconds on, inside the bet's life;
    // the two grants, written after, take a block each.
    const pairs = [
      [await env.fresh(), await env.fresh()],
      [await env.fresh(), await env.fresh()],
    ] as const;
    const B = await env.fresh();
    const T0 = await env.rig.time();
    const at = T0 + 20n;
    const quotes: Hex[] = [];
    for (const [i, [ends, tick]] of ([[at + 1n, 190], [at + 2n, 200]] as const).entries()) {
      const [owner, agent] = pairs[i] as readonly [HDAccount, HDAccount];
      const g = await grantAgent(env.rig, owner, agent.address, 10n ** 12n, ends);
      const order: Order = { ...orderOn(env.rig, owner, { expiry: T0 + 600n, oddsTick: tick, riskAmount: 100_000n, nonce: nonceOf(0n, g, nextOrderNumber()), ...market }), positionType: 0 };
      const posted = await postOrderAs(env.url, env.rig, agent, 'rest', order);
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      quotes.push(posted.body.orderHash as Hex);
    }
    const bet: Order = { ...orderOn(env.rig, B, { expiry: (await env.rig.time()) + 30n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
    const record = await checkedAt(env, () => postAs(env, B, 'take', bet), at);
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    assert.deepEqual(legsOf(record), [(quotes[1] as Hex).toLowerCase()], 'the grant that ends at T + 2 only');
  });

  test(`time, ${clock}: a hold of twenty seconds between read A and read B, with no request in flight, changes nothing: the result is the one with no hold, and the times show the twenty seconds`, async () => {
    const env = await clocked(which);
    const market = timeMarket(env);
    const M = await env.fresh();
    const B = await env.fresh();
    const T = await env.rig.time();
    await postAs(env, M, 'rest', { ...orderOn(env.rig, M, { expiry: T + 600n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 });
    await env.hooks.arm('after-read-a');
    const hash = await postAs(env, B, 'take', { ...orderOn(env.rig, B, { expiry: T + 28n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 });
    const held = await env.hooks.reached('after-read-a');
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    await env.hooks.go(held);
    const record = await judged(hash, env.url);
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    const { rows } = await env.pool.query<{ kind: string; at: Date }>(`SELECT kind, at FROM events WHERE bet_hash = $1 OR (order_hash = $1 AND kind = 'order received') ORDER BY number`, [hash.toLowerCase()]);
    const received = rows.find((r) => r.kind === 'order received')?.at as Date;
    const outcome = rows.find((r) => r.kind === 'cross sent')?.at as Date;
    assert.ok(outcome.getTime() - received.getTime() >= 20_000, `the times show the hold: ${outcome.getTime() - received.getTime()} ms`);
  });

  test(`time, ${clock}: the game's close at T + 1 at the check is BETS_CLOSED, and at T + 2 the bet is ready; the door's check 11 at the same boundary refuses a quote and a bet alike, and takes each one second earlier`, async (t) => {
    // A stack of its own: the bet at T + 2 is sent and confirmed near the close, and the chain is taken back below it.
    const env = await ownClocked(which);
    // The chain is taken back at the end: its time at the rig's game's close would close that game for every case after.
    const snapshot = (await env.rig.rpc('evm_snapshot', [])) as Hex;
    t.after(async () => {
      try {
        await env.rig.rpc('evm_revert', [snapshot]);
        await env.rig.mine(1);
        const start = await env.rig.read<bigint>(env.rig.addresses.games, env.rig.abis.OspexGames as Abi, 'getGameStart', [env.rig.gameId]);
        assert.ok((await env.rig.time()) < start + 86_400n - 3_600n, 'the chain taken back from the close, its next block too');
      } finally {
        await env.close();
      }
    });
    const market = timeMarket(env);
    const gamesAbi = env.rig.abis.OspexGames as Abi;
    const start = await env.rig.read<bigint>(env.rig.addresses.games, gamesAbi, 'getGameStart', [env.rig.gameId]);
    const window = await env.rig.read<bigint>(env.rig.addresses.games, gamesAbi, 'getGameWindow', [env.rig.gameId]);
    const closesAt = start + window;
    // Every account funded first, since a funding mines blocks; from here on only the checks' own blocks are mined.
    const [M, B2, B1, Q, D] = [await env.fresh(), await env.fresh(), await env.fresh(), await env.fresh(), await env.fresh()];
    // Brought near the close, by the block's time named, not by an addition.
    await env.rig.setNextBlockTime(closesAt - 20n);
    await env.rig.mine(1);
    await postAs(env, M, 'rest', { ...orderOn(env.rig, M, { expiry: closesAt + 600n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 });
    // T + 2 first: its bet is admitted twenty seconds before the close, checked at closesAt − 2 and found ready, and
    // held at its intent, before anything is signed or sent. Then T + 1: its bet is admitted at the chain's time
    // closesAt − 2, where the door takes it (the close is above T + 1), as it takes a quote there. The first is let go,
    // and its Cross mined in the block at closesAt − 1, the next block its check judged it for: that block is the
    // second's H.
    let T = await env.rig.time();
    const ready: Order = { ...orderOn(env.rig, B2, { expiry: T + 30n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 };
    await env.hooks.arm('after-reservation');
    await env.hooks.arm('after-intent');
    const readyHash = await postAs(env, B2, 'take', ready);
    const readyHeld = await env.hooks.reached('after-reservation');
    await env.rig.setNextBlockTime(closesAt - 2n);
    await env.rig.mine(1);
    await env.hooks.go(readyHeld);
    const atIntent = await atIntentOrJudged(readyHash, env.url);
    assert.equal(atIntent.state, 'queued', JSON.stringify(atIntent));
    const intentHeld = await env.hooks.reached('after-intent');
    T = await env.rig.time();
    assert.equal(T, closesAt - 2n);
    await postAs(env, Q, 'rest', { ...orderOn(env.rig, Q, { expiry: T + 600n, oddsTick: 445, ...market }), positionType: 0 });
    const closing: Order = { ...orderOn(env.rig, B1, { expiry: T + 30n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 };
    await env.hooks.arm('after-reservation');
    const closingHash = await postAs(env, B1, 'take', closing);
    await env.rig.setNextBlockTime(closesAt - 1n);
    await env.hooks.go(intentHeld);
    const record = await judged(readyHash, env.url);
    assert.equal(record.state, 'confirmed', JSON.stringify(record));
    const closingHeld = await env.hooks.reached('after-reservation');
    assert.equal(await env.rig.time(), closesAt - 1n);
    await env.hooks.go(closingHeld);
    const refused = await judged(closingHash, env.url);
    assert.equal(refused.state, 'refused', JSON.stringify(refused));
    const v = refused.verdict as Record<string, unknown>;
    assert.equal(v.code, 'BETS_CLOSED');
    const block = v.block as { number: string };
    assert.equal(v.error, `At block ${block.number}, bets on game ${env.rig.gameId} close at ${closesAt}, the start plus its window. The chain's time is ${closesAt - 1n}, so no later block can take this bet. Nothing was sent.`);
    // The door, at the chain's time closesAt − 1: a quote and a bet are refused; at closesAt − 2 (above) each was taken.
    T = await env.rig.time();
    assert.equal(T, closesAt - 1n);
    for (const [role, order] of [
      ['rest', { ...orderOn(env.rig, D, { expiry: T + 600n, oddsTick: 444, ...market }), positionType: 0 }],
      ['take', { ...orderOn(env.rig, D, { expiry: T + 25n, riskAmount: 10_000n, ...market }), positionType: 1 }],
    ] as const) {
      const answer = await postOrder(env.url, env.rig, D, role, order as Order);
      assert.equal(answer.status, 422, JSON.stringify(answer.body));
      assert.equal(answer.body.code, 'BETS_CLOSED');
      assert.equal(answer.body.error, `Bets on game ${env.rig.gameId} close at ${closesAt}, the start plus its window. The chain's time is ${T}, so no later block can take this order.`);
    }
  });
}

/**
 * A clocked stack of its own, for a case whose chain is taken back at its end below a Cross the courier has sent and
 * recorded final: no other case's courier holds that Cross. Closed by the case.
 */
async function ownClocked(which: 'ahead' | 'behind'): Promise<Clocked & { close(): Promise<void> }> {
  const s = await startStack(`precheck_close_${which}`, which === 'ahead' ? { hooked: true } : { hooked: true, genesisTime: BigInt(Math.floor(Date.now() / 1000)) - 2n * 86_400n });
  s.proxy.finalFollows(0n);
  if (which === 'ahead') {
    const wall = BigInt(Math.floor(Date.now() / 1000));
    const T = await s.rig.time();
    if (T < wall + 86_400n) await s.rig.increaseTime(wall + 86_400n - T);
  }
  let next = 80;
  const ownPool = openPool(s.databaseUrl, null);
  return {
    stack: s,
    rig: s.rig,
    url: s.courier.url,
    hooks: s.courier.hooks as HookControl,
    pool: ownPool,
    async fresh() {
      const who = s.rig.account(next++);
      await s.rig.fund(who);
      return who;
    },
    async close() {
      await ownPool.end();
      await s.close();
    },
  };
}

/** The market's key, as the contract computes it. */
function marketKeyOf(env: Clocked, market: { scorer: Address; lineTicks: number }): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [env.rig.gameId, market.scorer, market.lineTicks]));
}

// ──────────────────────────── the walk's answers, and who can pay ────────────────────────────

const coinAbi = () => rig.abis.TestCoin as Abi;
const balanceOf = (who: Address) => rig.read<bigint>(rig.addresses.coin, coinAbi(), 'balanceOf', [who]);
const allowanceOf = (who: Address) => rig.read<bigint>(rig.addresses.coin, coinAbi(), 'allowance', [who, rig.addresses.positions]);

/** Leaves `who` holding exactly `left` of the coin: the rest is sent to the stranger. */
async function walletTo(who: HDAccount, left: bigint): Promise<void> {
  const balance = await balanceOf(who.address);
  if (balance > left) await rig.write(who, rig.addresses.coin, coinAbi(), 'transfer', [rig.accounts.stranger.address, balance - left]);
  assert.equal(await balanceOf(who.address), left);
}

/** The verdict of a refused bet, with the number of its block. */
function verdictOf(record: Record<string, unknown>): Record<string, unknown> & { code: string; error: string; n: string } {
  const v = record.verdict as Record<string, unknown> & { code: string; error: string; block: { number: string } | null };
  return { ...v, n: v.block?.number ?? '' };
}

/** A record's pulls, by lower-cased account. */
const pullsOf = (record: Record<string, unknown>) => Object.fromEntries(Object.entries((record.cross as { pulls: Record<string, string> }).pulls).map(([k, v]) => [k.toLowerCase(), v]));

/** The market's id on the markets contract, 0 where it is not drawn. */
const marketIdOf = (market: { scorer: Address; lineTicks: number }) => rig.read<bigint>(rig.addresses.markets, rig.abis.OspexMarkets as Abi, 'getMarketId', [rig.gameId, market.scorer, market.lineTicks]);

test("netting from the bettor's side: a bettor that holds side A (it rested 5,000 at tick 200, taken whole), its wallet then emptied, bets 4,000 on side B at tick 200 against one quote and is found ready; each pull in the record is the positions contract's own preview of that one-leg fill, the bettor's 0", async () => {
  const market = ownMarket();
  const B = await freshAccount();
  const X = await freshAccount();
  const T = await rig.time();
  const a: Order = { ...orderOn(rig, B, { expiry: T + 600n, oddsTick: 200, riskAmount: 5_000n, ...market }), positionType: 0 };
  const x: Order = { ...orderOn(rig, X, { expiry: T + 25n, oddsTick: 200, riskAmount: 5_000n, ...market }), positionType: 1 };
  const sent = await crossFromTheTest(rig, { order: x, signature: await sign(X, x, 31337, rig.addresses.matching) }, [{ order: a, signature: await sign(B, a, 31337, rig.addresses.matching) }]);
  assert.equal(sent.filled, true, JSON.stringify(sent));
  await walletTo(B, 0n);
  const M = await freshAccount();
  await quoteOn(M, market, { oddsTick: 200, riskAmount: 100_000n });
  const record = await judged((await betOn(B, market, { oddsTick: 200, riskAmount: 4_000n })).hash);
  assert.equal(record.state, 'confirmed', JSON.stringify(record));
  const id = await marketIdOf(market);
  const positions = rig.abis.OspexPositions as Abi;
  // Read at H, the block the record's pulls are of: the Cross has since filled, at a later block.
  const atH = BigInt((record.cross as { block: { number: string } }).block.number);
  const preview = async (args: readonly unknown[]) => (await rig.publicClient.readContract({ address: rig.addresses.positions, abi: positions, functionName: 'previewFill', args, blockNumber: atH })) as readonly [bigint, bigint];
  const [bettorPull] = await preview([id, B.address, 1, 4_000n, 4_000n]);
  const [makerPull] = await preview([id, M.address, 0, 4_000n, 4_000n]);
  const pulls = pullsOf(record);
  assert.deepEqual(
    { bettor: pulls[B.address.toLowerCase()] ?? '0', maker: pulls[M.address.toLowerCase()] ?? '0' },
    { bettor: bettorPull.toString(), maker: makerPull.toString() },
  );
  assert.deepEqual({ bettorPull, makerPull }, { bettorPull: 0n, makerPull: 4_000n });
});

test("CANNOT_PAY: a bettor whose wallet holds 1,000 bets 4,000 against one quote: refused, the pull, the balance and the allowance in its record as the rig's own reads give them, with the sentence", async () => {
  const market = ownMarket();
  await quoteOn(await freshAccount(), market, { oddsTick: 200, riskAmount: 100_000n });
  const B = await freshAccount();
  await walletTo(B, 1_000n);
  const allowance = await allowanceOf(B.address);
  const record = await judged((await betOn(B, market, { oddsTick: 200, riskAmount: 4_000n })).hash);
  const v = verdictOf(record);
  assert.deepEqual(
    { state: record.state, code: v.code, pull: v.pull, balance: v.balance, allowance: v.allowance },
    { state: 'refused', code: 'CANNOT_PAY', pull: '4000', balance: '1000', allowance: allowance.toString() },
    JSON.stringify(record),
  );
  assert.match(v.error, new RegExp(`^This bet needs 0\\.004 USDC from its account's wallet\\. At block ${v.n} the wallet holds 0\\.001 USDC and allows the positions contract [0-9.]+ USDC\\. Nothing was sent\\.$`));
});

test('a maker that cannot pay is passed: its quote, the better price, not listed; the next quote, in the published order, listed; the bet ready with it alone', async () => {
  const market = ownMarket();
  const poor = await freshAccount();
  const able = await freshAccount();
  const first = await quoteOn(poor, market, { oddsTick: 190, riskAmount: 10_000n });
  await walletTo(poor, 0n);
  const second = await quoteOn(able, market, { oddsTick: 200, riskAmount: 10_000n });
  const record = await judged((await betOn(await freshAccount(), market, { oddsTick: 196, riskAmount: 1_000n })).hash);
  assert.equal(record.state, 'confirmed', JSON.stringify(record));
  assert.deepEqual(legsOf(record), [second.hash.toLowerCase()], `the first, ${first.hash}, is passed`);
});

test('NO_DEPTH and ONLY_YOUR_OWN_QUOTES, each with its sentence: a bet with no quote on its market; a bet whose market holds only its own account\'s quote at its price', async () => {
  const none = await judged((await betOn(await freshAccount(), ownMarket())).hash);
  const v1 = verdictOf(none);
  assert.deepEqual({ state: none.state, code: v1.code, error: v1.error }, { state: 'refused', code: 'NO_DEPTH', error: `At block ${v1.n} no quote on the book meets this bet's price. Nothing was sent.` });
  const market = ownMarket();
  const B = await freshAccount();
  await quoteOn(B, market, { oddsTick: 200 });
  const own = await judged((await betOn(B, market, { oddsTick: 200 })).hash);
  const v2 = verdictOf(own);
  assert.deepEqual(
    { state: own.state, code: v2.code, error: v2.error },
    { state: 'refused', code: 'ONLY_YOUR_OWN_QUOTES', error: `At block ${v2.n} the only quotes that meet this bet's price are its own account's, and an account is never matched with itself. Nothing was sent.` },
  );
});

test("NOT_ENOUGH_DEPTH, and the minimum's two edges: a bet of 10,000 with a minimum of 9,900 against 5,000 of depth is refused with what fills and what it asks; the same bet with 9,900 filled on chain fills its last 100, ready; a quote of 10,000 with a minimum of 9,900 and 100 left is listed for its last 100", async () => {
  const market = ownMarket();
  await quoteOn(await freshAccount(), market, { oddsTick: 200, riskAmount: 5_000n });
  const short = await judged((await betOn(await freshAccount(), market, { oddsTick: 200, riskAmount: 10_000n, minFill: 9_900n })).hash);
  const v = verdictOf(short);
  assert.deepEqual(
    { state: short.state, code: v.code, filled: v.filled, minFill: v.minFill, error: v.error },
    { state: 'refused', code: 'NOT_ENOUGH_DEPTH', filled: '5000', minFill: '9900', error: `At block ${v.n} the book can fill 0.005 USDC of this bet. It asks for at least 0.0099 USDC. Nothing was sent.` },
  );

  // The bet's last 100: 9,900 of it filled by a Cross the test sends, then posted and checked against a quote of 100.
  const lastMarket = ownMarket();
  const B = await freshAccount();
  const X = await freshAccount();
  const T = await rig.time();
  const bet: Order = { ...orderOn(rig, B, { expiry: T + 28n, oddsTick: 200, riskAmount: 10_000n, minFill: 9_900n, ...lastMarket }), positionType: 1 };
  const x: Order = { ...orderOn(rig, X, { expiry: T + 600n, oddsTick: 200, riskAmount: 9_900n, ...lastMarket }), positionType: 0 };
  const sent = await crossFromTheTest(rig, { order: bet, signature: await sign(B, bet, 31337, rig.addresses.matching) }, [{ order: x, signature: await sign(X, x, 31337, rig.addresses.matching) }]);
  assert.equal(sent.filled, true, JSON.stringify(sent));
  const small = await quoteOn(await freshAccount(), lastMarket, { oddsTick: 200, riskAmount: 100n });
  const posted = await postOrder(url(), rig, B, 'take', bet);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const last = await judged(posted.body.orderHash as string);
  assert.equal(last.state, 'confirmed', `the bet's last 100 meets its minimum: ${JSON.stringify(last)}`);
  assert.deepEqual(legsOf(last), [small.hash.toLowerCase()]);

  // The quote's last 100: a quote of 10,000 with a minimum of 9,900, 9,900 of it filled by a Cross the test sends.
  const quoteMarket = ownMarket();
  const M = await freshAccount();
  const Y = await freshAccount();
  const T2 = await rig.time();
  const q: Order = { ...orderOn(rig, M, { expiry: T2 + 600n, oddsTick: 200, riskAmount: 10_000n, minFill: 9_900n, ...quoteMarket }), positionType: 0 };
  const y: Order = { ...orderOn(rig, Y, { expiry: T2 + 25n, oddsTick: 200, riskAmount: 9_900n, ...quoteMarket }), positionType: 1 };
  const filled = await crossFromTheTest(rig, { order: y, signature: await sign(Y, y, 31337, rig.addresses.matching) }, [{ order: q, signature: await sign(M, q, 31337, rig.addresses.matching) }]);
  assert.equal(filled.filled, true, JSON.stringify(filled));
  const rest = await postOrder(url(), rig, M, 'rest', q);
  assert.equal(rest.status, 201, JSON.stringify(rest.body));
  const ready = await judged((await betOn(await freshAccount(), quoteMarket, { oddsTick: 200, riskAmount: 10_000n })).hash);
  assert.equal(ready.state, 'confirmed', `the quote's last 100 is listed: ${JSON.stringify(ready)}`);
  assert.deepEqual((ready.cross as { legs: Array<{ orderHash: string; makerRisk: string }> }).legs.map((l) => [l.orderHash.toLowerCase(), l.makerRisk]), [[(rest.body.orderHash as string).toLowerCase(), '100']]);
});

/**
 * Plants quotes straight into the records, as the book's and the cost's tests plant a backlog the door never saw.
 * Signed: each row's hash is the order's and its signature the account's, so the check's rehash and recovery pass.
 */
async function plantSigned(who: HDAccount, n: number, market: { scorer: Address; lineTicks: number }, fields: { oddsTick: number; riskAmount: bigint; expiry: bigint }): Promise<void> {
  const key = marketKey(rig.gameId, market.scorer, market.lineTicks).toLowerCase();
  const rows: Array<[string, string, string]> = [];
  for (let i = 0; i < n; i++) {
    const order: Order = { ...orderOn(rig, who, { ...fields, nonce: nonceOf(0n, 0, 9_000_000n + BigInt(plantedSigned++)), ...market }), positionType: 0 };
    const signature = await sign(who, order, 31337, rig.addresses.matching);
    rows.push([contractHashLocal(order), order.nonce.toString(), signature]);
  }
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT r.hash, 'rest', $1, $2, $3, $4, 0, $5, $6, r.nonce::numeric, $7, 0, r.signature, $8, 0, 1, '0x' || repeat('cd', 32), 1
     FROM unnest($9::text[], $10::text[], $11::text[]) AS r(hash, nonce, signature)`,
    [who.address.toLowerCase(), rig.gameId.toString(), market.scorer.toLowerCase(), market.lineTicks, fields.oddsTick, fields.riskAmount.toString(), fields.expiry.toString(), key, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])],
  );
}
let plantedSigned = 0;

/** Plants rows whose signatures no one made: rows the check never reads as candidates (expired at the block, or the bettor's own). */
async function plantUnsigned(account: Address, n: number, market: { scorer: Address; lineTicks: number }, fields: { oddsTick: number; expiry: bigint }): Promise<void> {
  const key = marketKey(rig.gameId, market.scorer, market.lineTicks).toLowerCase();
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT '0x' || lpad(to_hex(i), 64, 'e'), 'rest', $1, $2, $3, $4, 0, $5, 10000, i, $6, 0, '0x' || repeat('ab', 65), $7, 0, 1, '0x' || repeat('cd', 32), 1
     FROM generate_series($8::bigint, $9::bigint) AS i`,
    [account.toLowerCase(), rig.gameId.toString(), market.scorer.toLowerCase(), market.lineTicks, fields.oddsTick, fields.expiry.toString(), key, plantedUnsigned + 1, plantedUnsigned + n],
  );
  plantedUnsigned += n;
}
let plantedUnsigned = 50_000_000;

/** The order's hash as the courier computes it, which the matching contract's own getOrderHash equals (the door's check 9). */
function contractHashLocal(order: Order): string {
  return orderHashOf(order, 31337n, rig.addresses.matching).toLowerCase();
}

test('DEPTH_BEYOND_BOUND, by the quotes examined: 200 candidates whose account has not registered the relay, none listed, answer the bound with nothing filled; 199 of them and one quote behind them that fills 100 answer the bound with what fills and what the bet asks', async () => {
  const unregistered = rig.account(nextAccount++);
  const T = await rig.time();
  const none = ownMarket();
  await plantSigned(unregistered, 200, none, { oddsTick: 150, riskAmount: 10_000n, expiry: T + 3_600n });
  const r1 = await judged((await betOn(await freshAccount(), none, { oddsTick: 200 })).hash);
  const v1 = verdictOf(r1);
  assert.deepEqual(
    { state: r1.state, code: v1.code, bound: v1.bound, error: v1.error },
    { state: 'refused', code: 'DEPTH_BEYOND_BOUND', bound: 'quotesExamined', error: `The courier examined the first 200 quotes in price order and found none that can fill this bet at block ${v1.n}. Quotes behind them were not examined. Nothing was sent.` },
  );
  const some = ownMarket();
  await plantSigned(unregistered, 199, some, { oddsTick: 150, riskAmount: 10_000n, expiry: T + 3_600n });
  await quoteOn(await freshAccount(), some, { oddsTick: 200, riskAmount: 100n });
  const r2 = await judged((await betOn(await freshAccount(), some, { oddsTick: 200, riskAmount: 10_000n, minFill: 9_000n })).hash);
  const v2 = verdictOf(r2);
  assert.deepEqual(
    { state: r2.state, code: v2.code, bound: v2.bound, filled: v2.filled, minFill: v2.minFill, error: v2.error },
    { state: 'refused', code: 'DEPTH_BEYOND_BOUND', bound: 'quotesExamined', filled: '100', minFill: '9000', error: `The courier examined the first 200 quotes in price order. At block ${v2.n} they fill 0.0001 USDC of this bet, and it asks for at least 0.009 USDC. Quotes behind them were not examined. Nothing was sent.` },
  );
});

test("DEPTH_BEYOND_BOUND, by the rows scanned: 2,000 of the bettor's own quotes reached with nothing listed answer the bound, never ONLY_YOUR_OWN_QUOTES; a backlog of 2,000 expired at the block, the final block held behind their expiries so none is marked, answers the bound, never NO_DEPTH; and 1,999 of that backlog with one live quote behind it that fills 100 answer the bound with what fills", async () => {
  const B = await freshAccount();
  const T = await rig.time();
  const ownRows = ownMarket();
  await plantUnsigned(B.address, 2_000, ownRows, { oddsTick: 150, expiry: T + 3_600n });
  const r1 = await judged((await betOn(B, ownRows, { oddsTick: 200 })).hash);
  const v1 = verdictOf(r1);
  const scanNone = (n: string) => `The courier took the first 2,000 quotes of its book for this side that it had not marked ended, in price order, and found none that can fill this bet at block ${n}. What lies behind them was not read. Nothing was sent.`;
  assert.deepEqual({ state: r1.state, code: v1.code, bound: v1.bound, error: v1.error }, { state: 'refused', code: 'DEPTH_BEYOND_BOUND', bound: 'scanRows', error: scanNone(v1.n) });

  // The backlog: expired at every block from here on, the final block named behind their expiries.
  const head = await rig.publicClient.getBlock();
  const backlog = ownMarket();
  await plantUnsigned(rig.accounts.stranger.address, 2_000, backlog, { oddsTick: 150, expiry: head.timestamp + 5n });
  const mixed = ownMarket();
  await plantUnsigned(rig.accounts.stranger.address, 1_999, mixed, { oddsTick: 150, expiry: head.timestamp + 5n });
  const M = await freshAccount();
  const live = await quoteOn(M, mixed, { oddsTick: 200, riskAmount: 100n, expiry: head.timestamp + 3_600n });
  await rig.increaseTime(30n);
  proxy.setFinal(head.number);
  try {
    const r2 = await judged((await betOn(await freshAccount(), backlog, { oddsTick: 200 })).hash);
    const v2 = verdictOf(r2);
    assert.deepEqual({ state: r2.state, code: v2.code, bound: v2.bound, error: v2.error }, { state: 'refused', code: 'DEPTH_BEYOND_BOUND', bound: 'scanRows', error: scanNone(v2.n) });
    const markedNone = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE market_key = $1 AND ended IS NOT NULL`, [marketKey(rig.gameId, backlog.scorer, backlog.lineTicks).toLowerCase()]);
    assert.equal(markedNone.rows[0]?.n, 0, 'the final block behind their expiries: none marked');
    const r3 = await judged((await betOn(await freshAccount(), mixed, { oddsTick: 200, riskAmount: 10_000n, minFill: 9_000n })).hash);
    const v3 = verdictOf(r3);
    assert.deepEqual(
      { state: r3.state, code: v3.code, bound: v3.bound, filled: v3.filled, error: v3.error },
      { state: 'refused', code: 'DEPTH_BEYOND_BOUND', bound: 'scanRows', filled: '100', error: `The courier took the first 2,000 quotes of its book for this side that it had not marked ended, in price order. At block ${v3.n} the live quotes among them fill 0.0001 USDC of this bet, and it asks for at least 0.009 USDC. What lies behind them was not read. Nothing was sent.` },
      `the live quote ${live.hash} is the one that fills`,
    );
  } finally {
    proxy.setFinal(null);
  }
});

test('DEPTH_BEYOND_BOUND, by the quotes listed: forty-one quotes of 100 each, the bet of 10,000 asking at least 9,000: forty listed fill 4,000, and the answer names the bound', async () => {
  const market = ownMarket();
  const makers = [await freshAccount(), await freshAccount(), await freshAccount()];
  for (let i = 0; i < 41; i++) await quoteOn(makers[Math.floor(i / 16)] as HDAccount, market, { oddsTick: 200, riskAmount: 100n });
  const record = await judged((await betOn(await freshAccount(), market, { oddsTick: 200, riskAmount: 10_000n, minFill: 9_000n })).hash);
  const v = verdictOf(record);
  assert.deepEqual(
    { state: record.state, code: v.code, bound: v.bound, filled: v.filled, minFill: v.minFill, error: v.error },
    { state: 'refused', code: 'DEPTH_BEYOND_BOUND', bound: 'quotesListed', filled: '4000', minFill: '9000', error: `One fill lists 40 quotes at most. At block ${v.n} the first 40 quotes that can fill this bet cover 0.004 USDC of it, and it asks for at least 0.009 USDC. Nothing was sent.` },
  );
});

// ──────────────────────────── what changed between a bet's post and its turn ────────────────────────────

/** The check of the bet `post` makes, held just after its reservation while `between` runs, then let go: its record. */
test("the largest read B and read C, on the rig: 200 quotes of 200 registered accounts, each quote signed by an agent under a grant of its account's own, on a market drawn by one fill. Read B is two calls, each of 100 quotes, 100 accounts and 100 grants; read C is one call over 201 accounts, the 200 and the bettor's; every one names H. The bet is ready, and the two payloads' sizes are recorded", async () => {
  const market = ownMarket();
  // The market drawn: one fill, by a Cross the test sends.
  const [X, Y] = [await freshAccount(), await freshAccount()];
  let T = await rig.time();
  const x: Order = { ...orderOn(rig, X, { expiry: T + 600n, oddsTick: 200, riskAmount: 100n, ...market }), positionType: 0 };
  const y: Order = { ...orderOn(rig, Y, { expiry: T + 25n, oddsTick: 200, riskAmount: 100n, ...market }), positionType: 1 };
  const drawn = await crossFromTheTest(rig, { order: y, signature: await sign(Y, y, 31337, rig.addresses.matching) }, [{ order: x, signature: await sign(X, x, 31337, rig.addresses.matching) }]);
  assert.equal(drawn.filled, true, JSON.stringify(drawn));
  // The 200 accounts: each registered, each under a grant of its own to one agent; the first funded, and its quote,
  // the best price, fills the bet. The others hold no coin: the walk passes them, and every read reads them.
  const agent = rig.account(nextAccount++);
  T = await rig.time();
  const quotes: Array<{ account: Address; order: Order; grant: number }> = [];
  for (let i = 0; i < 200; i++) {
    const who = rig.account(nextAccount++);
    if (i === 0) await rig.fund(who);
    else {
      await rig.rpc('anvil_setBalance', [who.address, `0x${(10n ** 18n).toString(16)}`]);
      await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'registerCourier', [rig.addresses.relay]);
    }
    const grant = await grantAgent(rig, who, agent.address, 1_000_000n, T + 86_400n);
    const order: Order = { ...orderOn(rig, who, { expiry: T + 3_600n, oddsTick: i === 0 ? 140 : 150, riskAmount: i === 0 ? 100_000n : 10_000n, nonce: nonceOf(0n, grant, nextOrderNumber()), ...market }), positionType: 0 };
    quotes.push({ account: who.address, order, grant });
  }
  // The quotes planted straight into the records, as the book's tests plant a backlog: each signed by the agent.
  const key = marketKey(rig.gameId, market.scorer, market.lineTicks).toLowerCase();
  const rows = await Promise.all(quotes.map(async (q) => ({ hash: contractHashLocal(q.order), account: q.account.toLowerCase(), tick: q.order.oddsTick, risk: q.order.riskAmount.toString(), nonce: q.order.nonce.toString(), signature: await sign(agent, q.order, 31337, rig.addresses.matching) })));
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT r.hash, 'rest', r.account, $1, $2, $3, 0, r.tick::int, r.risk::numeric, r.nonce::numeric, $4, 0, r.signature, $5, 0, 1, '0x' || repeat('cd', 32), 1
     FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) AS r(hash, account, tick, risk, nonce, signature)`,
    [rig.gameId.toString(), market.scorer.toLowerCase(), market.lineTicks, (T + 3_600n).toString(), key, rows.map((r) => r.hash), rows.map((r) => r.account), rows.map((r) => String(r.tick)), rows.map((r) => r.risk), rows.map((r) => r.nonce), rows.map((r) => r.signature)],
  );

  await hooks().arm('after-reservation');
  const bet = await betOn(await freshAccount(), market, { oddsTick: 200, riskAmount: 10_000n });
  const held = await hooks().reached('after-reservation');
  const from = proxy.counted.length;
  const log = recording(['eth_call']);
  let record: Record<string, unknown>;
  let to: number;
  try {
    // The check's calls, to its result, before any step of the send: recorded there, and the courier goes on.
    await hooks().arm('before-result');
    await hooks().go(held);
    const atResult = await hooks().reached('before-result');
    log.stop();
    to = proxy.counted.length;
    await hooks().go(atResult);
    record = await judged(bet.hash);
  } finally {
    log.stop();
  }
  assert.equal(record.state, 'confirmed', JSON.stringify(record));
  const H = (record.cross as { block: { hash: string } }).block;
  assert.deepEqual(legsOf(record), [rows[0]?.hash], 'the best price fills the bet');

  // The check's calls to the node, each with its bytes as the proxy counted them, in the order they arrived.
  const counted = proxy.counted.slice(from, to).filter((c) => c.method === 'eth_call');
  assert.equal(counted.length, log.calls.length, 'every call the proxy counted was recorded');
  const name = (target: string, data: Hex) => {
    const abi = target === rig.addresses.matching.toLowerCase() ? rig.abis.OspexMatching : target === rig.addresses.positions.toLowerCase() ? rig.abis.OspexPositions : target === rig.addresses.markets.toLowerCase() ? rig.abis.OspexMarkets : null;
    return abi === null ? target : decodeFunctionData({ abi: abi as Abi, data }).functionName;
  };
  const reads = log.calls.map((c, i) => {
    const call = c.params[0] as { to: string; data: Hex };
    const inner = call.to.toLowerCase() === MULTICALL_ADDRESS.toLowerCase() && c.params[2] === undefined ? (decodeFunctionData({ abi: MULTICALL_ABI, data: call.data }).args[0] as ReadonlyArray<{ target: string; callData: Hex }>) : [];
    const names = inner.map((s) => name(s.target.toLowerCase(), s.callData));
    const count = (n: string) => names.filter((m) => m === n).length;
    return { block: byHashOf(c.params[1]), names, count, requestBytes: counted[i]?.requestBytes ?? 0, answerBytes: counted[i]?.answerBytes ?? 0 };
  });
  // Read A asks the market's count and read B does not: read B is every call that asks a quote's standing and not that.
  const readB = reads.filter((r) => r.count('s_cancelledOrders') > 0 && r.count('s_marketCount') === 0);
  // Read C asks the market's record; the comparison, which also asks what is held, is made with an override and is not a read here.
  const readC = reads.filter((r) => r.count('getMarket') === 1 && r.count('s_held') > 0);
  assert.deepEqual(
    readB.map((r) => ({ quotes: r.count('s_cancelledOrders'), accounts: r.count('isCourier'), grants: r.count('getGrant'), grantLines: r.count('isGrantLine'), blockProbes: r.count(MULTICALL_ADDRESS.toLowerCase()), calls: r.names.length, block: r.block })),
    [0, 1].map(() => ({ quotes: 100, accounts: 100, grants: 100, grantLines: 100, blockProbes: 3, calls: 1_003, block: { blockHash: H.hash, requireCanonical: true } })),
    "read B: two calls, each of 100 quotes (2 subcalls a quote), 100 accounts (5 an account), 100 floors, 100 grants and 100 grant lines, and the multicall's three probes of the block, at H",
  );
  assert.deepEqual(
    readC.map((r) => ({ accounts: r.count('s_held'), positions: r.count('getPosition'), blockProbes: r.count(MULTICALL_ADDRESS.toLowerCase()), calls: r.names.length, block: r.block })),
    [{ accounts: 201, positions: 402, blockProbes: 3, calls: 607, block: { blockHash: H.hash, requireCanonical: true } }],
    "read C: one call, the market's record and three subcalls for each of 201 accounts, and the three probes of the block, at H",
  );
  console.log(
    `# the largest reads on the rig: read B, two calls of 1,003 subcalls each, requests ${readB.map((r) => r.requestBytes).join(' and ')} bytes, answers ${readB.map((r) => r.answerBytes).join(' and ')} bytes; read C, one call of 607 subcalls, request ${readC[0]?.requestBytes} bytes, answer ${readC[0]?.answerBytes} bytes`,
  );
});

async function checkedAfter(post: () => Promise<{ hash: Hex }>, between: () => Promise<void>): Promise<Record<string, unknown>> {
  await hooks().arm('after-reservation');
  const posted = await post();
  const held = await hooks().reached('after-reservation');
  assert.equal(held.bet, posted.hash.toLowerCase());
  try {
    await between();
  } finally {
    await hooks().go(held);
  }
  return judged(posted.hash);
}

/** The chain as it stands, kept to be taken back to. */
const snapshotNow = async (): Promise<Hex> => (await rig.rpc('evm_snapshot', [])) as Hex;

/**
 * A case that takes its chain back below a bet the courier has sent, run on a stack of its own: this file's stack, its
 * rig, its proxy and its database stand in for the file's own while the case runs, and are closed after it. On the
 * file's own stack the lane's records would then hold a final block its chain no longer has, and that lane would
 * rightly send nothing more for the cases after.
 */
async function onOwnStack(name: string, body: () => Promise<void>): Promise<void> {
  const own = await startStack(name, { hooked: true });
  own.proxy.finalFollows(0n);
  const saved = { stack, rig, proxy, pool };
  stack = own;
  rig = own.rig;
  proxy = own.proxy;
  pool = openPool(own.databaseUrl, null);
  try {
    await body();
  } finally {
    await pool.end();
    ({ stack, rig, proxy, pool } = saved);
    await own.close();
  }
}
/** The chain taken back to the snapshot, and a block mined on it: the next H is a block of that branch. */
async function backTo(snapshot: Hex): Promise<void> {
  assert.equal(await rig.rpc('evm_revert', [snapshot]), true);
  await rig.mine(1);
}

const READINGS_SCORE = [
  { seat: 1, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 2, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 3, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 4, kind: 0, homeScore: 0, awayScore: 0 },
];

test("the game at H, each with its sentence: a game scored between the bet's post and its turn is GAME_ENDED with its status; a game that the chain, taken back under the bet, no longer has is UNKNOWN_GAME; and one whose start the chain, taken back, no longer holds written is NO_WRITTEN_START", async () => {
  const gamesAbi = rig.abis.OspexGames as Abi;
  // Scored while the bet waits. A game is scored no earlier than its start, a day out, so the chain is brought one
  // second past it, where its bets are still open, and the bet is admitted there; the chain is taken back afterwards,
  // so no later case finds the rig's own game nearer its close.
  const scored = await rig.createGame();
  const B1 = await freshAccount();
  const scoredStart = await rig.read<bigint>(rig.addresses.games, gamesAbi, 'getGameStart', [scored]);
  const beforeScore = await snapshotNow();
  let ended: Record<string, unknown>;
  try {
    await rig.setNextBlockTime(scoredStart + 1n);
    await rig.mine(1);
    ended = await checkedAfter(
      () => betOn(B1, { ...ownMarket() }, { gameId: scored }),
      async () => {
        await rig.write(rig.accounts.deployer, rig.addresses.reporter, rig.abis.MockReporter as Abi, 'send', [{ gameId: scored, kind: 2, start: 0n, homeScore: 104, awayScore: 97, readings: READINGS_SCORE, payout: rig.accounts.creator.address }]);
        assert.equal(await rig.read<number>(rig.addresses.games, gamesAbi, 'getGameStatus', [scored]), 4);
      },
    );
  } finally {
    await backTo(beforeScore);
  }
  assert.ok((await rig.time()) < scoredStart, 'the chain taken back before the game\'s start, its next block too');
  const v1 = verdictOf(ended);
  assert.deepEqual({ state: ended.state, code: v1.code, status: v1.status, error: v1.error }, { state: 'refused', code: 'GAME_ENDED', status: 4, error: `At block ${v1.n}, game ${scored} has ended (status 4). Nothing was sent.` });

  // A game the chain no longer has: made after a snapshot, the bet admitted on it, the chain taken back.
  const B2 = await freshAccount();
  const before = await snapshotNow();
  const gone = await rig.createGame();
  const unknown = await checkedAfter(() => betOn(B2, ownMarket(), { gameId: gone }), () => backTo(before));
  const v2 = verdictOf(unknown);
  assert.deepEqual({ state: unknown.state, code: v2.code, error: v2.error }, { state: 'refused', code: 'UNKNOWN_GAME', error: `At block ${v2.n}, game ${gone} is not a game on the games set. Nothing was sent.` });

  // A game whose start the chain no longer holds written: made with its start after a snapshot, the bet admitted, the
  // chain taken back and the same game made again with no start written.
  const B3 = await freshAccount();
  const beforeStart = await snapshotNow();
  const unstarted = await rig.createGame();
  const noStart = await checkedAfter(
    () => betOn(B3, ownMarket(), { gameId: unstarted }),
    async () => {
      await backTo(beforeStart);
      assert.equal(await rig.createGame({ startWritten: false }), unstarted, 'the same game, made again');
    },
  );
  const v3 = verdictOf(noStart);
  assert.deepEqual({ state: noStart.state, code: v3.code, error: v3.error }, { state: 'refused', code: 'NO_WRITTEN_START', error: `At block ${v3.n}, game ${unstarted} has no written start yet; the courier carries a game once its start is written. Nothing was sent.` });
});

test("the game's reporters at H: a bet admitted by a courier whose published list names the game's reporter, then checked by one started on a list that names another, is REPORTERS_NOT_THE_PUBLISHED_LIST, with its sentence", async () => {
  // The stack's courier holds a set-up bet, so the bet under test waits; then it is stopped there, and a courier on
  // another published list takes the lane and checks both.
  await hooks().arm('after-reservation');
  await betOn(await freshAccount(), ownMarket());
  await hooks().reached('after-reservation');
  const B = await freshAccount();
  const waiting = await betOn(B, ownMarket());
  await stack.courier.stop();
  const other = await startHookedCourier({ ...stack.env, PUBLISHED_REPORTERS_FILE: publishedList([rig.accounts.stranger.address]) }, '');
  try {
    const record = await judged(waiting.hash, other.url);
    const v = verdictOf(record);
    assert.deepEqual(
      { state: record.state, code: v.code, error: v.error },
      { state: 'refused', code: 'REPORTERS_NOT_THE_PUBLISHED_LIST', error: `At block ${v.n}, game ${rig.gameId}'s reporters are not exactly the published list; the courier carries only games whose reporters are. Nothing was sent.` },
    );
  } finally {
    await other.stop();
    await stack.restartCourier({ hooked: true });
  }
});

test("the cap: on a branch where the cap is lifted, a bet of 10,100 is admitted and found ready; a second, admitted there and checked after the chain is taken back under the lift, is ABOVE_CAP at its block, with the cap and the sentence", () =>
  // A stack of its own: the first bet is sent and confirmed on the branch, and the chain is taken back below it.
  onOwnStack('precheck_cap', async () => {
    const market = ownMarket();
    const B1 = await freshAccount();
    const B2 = await freshAccount();
    const M = await freshAccount();
    const before = await snapshotNow();
    await liftCap(rig);
    await quoteOn(M, market, { oddsTick: 200, riskAmount: 100_000n });
    const lifted = await judged((await betOn(B1, market, { oddsTick: 200, riskAmount: 10_100n })).hash);
    assert.equal(lifted.state, 'confirmed', `after the lift, 10,100 is found ready: ${JSON.stringify(lifted)}`);
    const capped = await checkedAfter(() => betOn(B2, market, { oddsTick: 200, riskAmount: 10_100n }), () => backTo(before));
    const v = verdictOf(capped);
    assert.deepEqual(
      { state: capped.state, code: v.code, cap: v.cap, error: v.error },
      { state: 'refused', code: 'ABOVE_CAP', cap: '10000', error: `At block ${v.n}, bets are capped at 0.01 USDC until the cap is lifted. This bet is signed for 0.0101 USDC. Nothing was sent.` },
    );
  }));

test('a lapse in the queue: a bet behind a held check, its expiry two seconds past the chain\'s time, reaches its turn after the chain has moved past it, and is lapsed, BET_LAPSED, with no Cross', async () => {
  // Both accounts funded first: a funding mines blocks, and on some nodes each block moves the chain's time on.
  const [A1, A2] = [await freshAccount(), await freshAccount()];
  await hooks().arm('after-reservation');
  const first = await betOn(A1, ownMarket());
  const held = await hooks().reached('after-reservation');
  let letGo = false;
  try {
    const T = await rig.time();
    const second = await betOn(A2, ownMarket(), { expiry: T + 3n });
    await rig.setNextBlockTime(T + 2n);
    await rig.mine(1);
    await hooks().go(held);
    letGo = true;
    assert.equal((await judged(first.hash)).state, 'refused');
    const record = await judged(second.hash);
    const v = verdictOf(record);
    assert.deepEqual({ state: record.state, code: v.code, cross: record.cross }, { state: 'lapsed', code: 'BET_LAPSED', cross: null });
  } finally {
    // A failure before the hold is let go would leave the lane held for every case after this one.
    if (!letGo) await hooks().go(held);
  }
});

test('a cancel on chain between a quote\'s post and the bet: the quote is not listed, it is marked cancelled at the check\'s block, and the next page of its market does not list it', async () => {
  const market = ownMarket();
  const M = await freshAccount();
  const q = await quoteOn(M, market);
  await cancelOnChain(rig, M, q.order);
  const record = await judged((await betOn(await freshAccount(), market)).hash);
  const v = verdictOf(record);
  assert.equal(v.code, 'NO_DEPTH', JSON.stringify(record));
  const { rows } = await pool.query<{ ended: string; ended_block: string }>('SELECT ended, ended_block::text FROM orders WHERE hash = $1', [q.hash.toLowerCase()]);
  assert.deepEqual(rows[0], { ended: 'cancelled', ended_block: v.n });
  const page = await get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=A`);
  assert.deepEqual(((page.body.sides as Record<string, { quotes: unknown[] }>).A?.quotes ?? []).length, 0);
});

test("an agent's bet and its grant at H: the grant ending at T + 1 is GRANT_GONE; ending at T + 2 the bet is checked; and a grant that reads otherwise at H (the chain taken back and the grant made again to another agent) refuses the bet with the grant's own code, while a quote under such a grant is not listed and not marked", async () => {
  const owner = await freshAccount();
  const agent = await freshAccount();
  // The grant ends twenty seconds on; the bet's expiry, thirty past its post, is after the grant's end, so at the
  // block one second before that end the bet is not lapsed and its grant is gone.
  const T0 = await rig.time();
  const ends = T0 + 20n;
  const g = await grantAgent(rig, owner, agent.address, 10n ** 12n, ends);
  const underGrant = async (expiry: bigint) => {
    const order: Order = { ...orderOn(rig, owner, { expiry, oddsTick: 200, riskAmount: 10_000n, nonce: nonceOf(0n, g, nextOrderNumber()), ...ownMarket() }), positionType: 1 };
    const posted = await postOrderAs(url(), rig, agent, 'take', order);
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    return { hash: posted.body.orderHash as Hex };
  };
  const at = async (time: bigint) => {
    await rig.setNextBlockTime(time);
    await rig.mine(1);
  };
  const gone = await checkedAfter(async () => underGrant((await rig.time()) + 30n), () => at(ends - 1n));
  assert.equal(verdictOf(gone).code, 'GRANT_GONE', JSON.stringify(gone));

  const owner2 = await freshAccount();
  const agent2 = await freshAccount();
  const T1 = await rig.time();
  const g2 = await grantAgent(rig, owner2, agent2.address, 10n ** 12n, T1 + 20n);
  const second = await checkedAfter(
    async () => {
      const order: Order = { ...orderOn(rig, owner2, { expiry: (await rig.time()) + 30n, oddsTick: 200, riskAmount: 10_000n, nonce: nonceOf(0n, g2, nextOrderNumber()), ...ownMarket() }), positionType: 1 };
      const posted = await postOrderAs(url(), rig, agent2, 'take', order);
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return { hash: posted.body.orderHash as Hex };
    },
    () => at(T1 + 18n),
  );
  assert.equal(verdictOf(second).code, 'NO_DEPTH', `checked, its grant live at T + 2: ${JSON.stringify(second)}`);

  // Reads otherwise: the grants made after a snapshot, a quote and a bet admitted under them, the chain taken back and
  // each grant made again, with the same number, to another agent.
  const qOwner = await freshAccount();
  const qAgent = await freshAccount();
  const bOwner = await freshAccount();
  const bAgent = await freshAccount();
  const others = [await freshAccount(), await freshAccount()];
  const market = ownMarket();
  const before = await snapshotNow();
  const T2 = await rig.time();
  const gq = await grantAgent(rig, qOwner, qAgent.address, 10n ** 12n, T2 + 3_600n);
  const gb = await grantAgent(rig, bOwner, bAgent.address, 10n ** 12n, T2 + 3_600n);
  const quote: Order = { ...orderOn(rig, qOwner, { expiry: T2 + 3_000n, oddsTick: 200, riskAmount: 100_000n, nonce: nonceOf(0n, gq, nextOrderNumber()), ...market }), positionType: 0 };
  const quoted = await postOrderAs(url(), rig, qAgent, 'rest', quote);
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  const refused = await checkedAfter(
    async () => {
      const order: Order = { ...orderOn(rig, bOwner, { expiry: T2 + 25n, oddsTick: 200, riskAmount: 10_000n, nonce: nonceOf(0n, gb, nextOrderNumber()), ...ownMarket() }), positionType: 1 };
      const posted = await postOrderAs(url(), rig, bAgent, 'take', order);
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return { hash: posted.body.orderHash as Hex };
    },
    async () => {
      await backTo(before);
      assert.equal(await grantAgent(rig, qOwner, (others[0] as HDAccount).address, 10n ** 12n, T2 + 3_600n), gq);
      assert.equal(await grantAgent(rig, bOwner, (others[1] as HDAccount).address, 10n ** 12n, T2 + 3_600n), gb);
    },
  );
  const v = verdictOf(refused);
  assert.deepEqual({ state: refused.state, code: v.code }, { state: 'refused', code: 'BAD_SIGNATURE' }, JSON.stringify(refused));
  assert.equal(v.error, `At block ${v.n}, the signature is not the agent's of grant ${gb}, the grant this order's nonce names: an order under a grant is signed by that grant's agent, not by its account and not by another key. Nothing was sent.`);
  const walked = await judged((await betOn(await freshAccount(), market, { oddsTick: 200 })).hash);
  assert.equal(verdictOf(walked).code, 'NO_DEPTH', `the quote under the grant that reads otherwise is not listed: ${JSON.stringify(walked)}`);
  const { rows } = await pool.query<{ ended: string | null }>('SELECT ended FROM orders WHERE hash = $1', [String(quoted.body.orderHash).toLowerCase()]);
  assert.equal(rows[0]?.ended, null, 'and not marked');
});

test("the bet's own standing at H, each with its sentence: cancelled by its own cancel, by a cancel of everything, and by a raised floor, CANCELLED; filled on chain to less than a lot, FILLED; its account's relay unregistered, NOT_REGISTERED", async () => {
  const cancelled = (n: string) => `At block ${n} this bet is cancelled on chain: by its own cancel, by its account moving to a new version, or by a floor raised above its order number on this line. Nothing was sent.`;
  const cases: Array<[string, (who: HDAccount, order: Order) => Promise<void>, string, (n: string) => string]> = [
    ['its own cancel', (who, order) => cancelOnChain(rig, who, order), 'CANCELLED', cancelled],
    ['a cancel of everything', async (who) => void (await cancelAll(rig, who)), 'CANCELLED', cancelled],
    ['a raised floor', (who, order) => raiseFloor(rig, who, who.address, order, (order.nonce & ((1n << 96n) - 1n)) + 1n), 'CANCELLED', cancelled],
    [
      'filled on chain',
      async (who, order) => {
        const X = await freshAccount();
        const x: Order = { ...orderOn(rig, X, { expiry: (await rig.time()) + 600n, oddsTick: order.oddsTick, riskAmount: 100_000n, gameId: order.gameId, scorer: order.scorer, lineTicks: order.lineTicks }), positionType: 0 };
        const sent = await crossFromTheTest(rig, { order, signature: await sign(who, order, 31337, rig.addresses.matching) }, [{ order: x, signature: await sign(X, x, 31337, rig.addresses.matching) }]);
        assert.equal(sent.filled, true, JSON.stringify(sent));
      },
      'FILLED',
      (n) => `At block ${n} this bet has less than a lot of its stake left on chain. Nothing was sent.`,
    ],
    ['its relay unregistered', async (who) => void (await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'unregisterCourier', [rig.addresses.relay])), 'NOT_REGISTERED', (n) => `At block ${n} this bet's account has not registered the courier's relay, ${rig.addresses.relay}. Nothing was sent.`],
  ];
  for (const [what, change, code, sentence] of cases) {
    const B = await freshAccount();
    let bet: { hash: Hex; order: Order } | null = null;
    const record = await checkedAfter(
      async () => (bet = await betOn(B, ownMarket(), { oddsTick: 200 })),
      () => change(B, (bet as { order: Order }).order),
    );
    const v = verdictOf(record);
    assert.deepEqual({ state: record.state, code: v.code, error: v.error.toLowerCase() }, { state: 'refused', code, error: sentence(v.n).toLowerCase() }, what);
  }
});

test('a live quote after kickoff, the game\'s start passed and its close not reached, is listed, and the bet is ready (the chain taken back afterwards)', () =>
  // A stack of its own: the bet is sent and confirmed after kickoff, and the chain is taken back below it.
  onOwnStack('precheck_kickoff', async () => {
    const before = await snapshotNow();
    try {
      const game = await rig.createGame();
      const start = await rig.read<bigint>(rig.addresses.games, rig.abis.OspexGames as Abi, 'getGameStart', [game]);
      const M = await freshAccount();
      const B = await freshAccount();
      await rig.setNextBlockTime(start + 60n);
      await rig.mine(1);
      const market = { ...ownMarket() };
      const q = await quoteOn(M, market, { gameId: game });
      const record = await judged((await betOn(B, market, { gameId: game })).hash);
      assert.equal(record.state, 'confirmed', JSON.stringify(record));
      assert.deepEqual(legsOf(record), [q.hash.toLowerCase()]);
    } finally {
      await backTo(before);
    }
  }));

test('a judged bet posted again in the same role is answered 200 with its whole record, verdict and all, and nothing is written', async () => {
  const B = await freshAccount();
  const bet = await betOn(B, ownMarket());
  const first = await judged(bet.hash);
  const lines = (await linesOf(bet.hash)).length;
  const again = await postOrder(url(), rig, B, 'take', bet.order);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, first);
  assert.equal((await linesOf(bet.hash)).length, lines);
});

test("a token sent to the key unasked: its balance at the check's block is in the next ready result's figures, beside the relay's", async () => {
  const sent = 123_456n;
  await rig.write(rig.accounts.deployer, rig.addresses.coin, rig.abis.TestCoin as Abi, 'mint', [rig.accounts.sender.address, sent]);
  const keyCoin = await balanceOf(rig.accounts.sender.address);
  const relayCoin = await balanceOf(rig.addresses.relay);
  const market = ownMarket();
  await quoteOn(await freshAccount(), market);
  const bet = await betOn(await freshAccount(), market);
  assert.equal((await judged(bet.hash)).state, 'confirmed');
  const { rows } = await pool.query<{ checked: { keyCoin: string; relayCoin: string } }>('SELECT checked FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()]);
  assert.deepEqual({ keyCoin: rows[0]?.checked.keyCoin, relayCoin: rows[0]?.checked.relayCoin }, { keyCoin: keyCoin.toString(), relayCoin: relayCoin.toString() });
  assert.ok(keyCoin >= sent);
});

test("a bet's longest life after a branch at an earlier time: the chain taken back under the bet's admission and mined again with an earlier time, the bet's expiry 31 seconds past the check's block; the exact call is refused TakingOrderTooLong and the record names it; the same orders sent by the test into the next block at T + 1 fill, the expected asymmetry", async () => {
  const market = ownMarket();
  const M = await freshAccount();
  const B = await freshAccount();
  const q = await quoteOn(M, market);
  const before = await snapshotNow();
  const beforeTime = await rig.time();
  await rig.setNextBlockTime(beforeTime + 10n);
  await rig.mine(1);
  const T = await rig.time();
  const bet: Order = { ...orderOn(rig, B, { expiry: T + 30n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 };
  // The branch mined again at an earlier time: H's time is the expiry less 31.
  const H = bet.expiry - 31n;
  const record = await checkedAfter(
    async () => {
      const posted = await postOrder(url(), rig, B, 'take', bet);
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return { hash: posted.body.orderHash as Hex };
    },
    async () => {
      assert.equal(await rig.rpc('evm_revert', [before]), true);
      await rig.setNextBlockTime(H);
      await rig.mine(1);
      assert.equal(await rig.time(), H);
    },
  );
  const v = verdictOf(record);
  assert.deepEqual({ state: record.state, code: v.code, reason: v.reason }, { state: 'refused', code: 'CROSS_WOULD_REVERT', reason: 'OspexMatching__TakingOrderTooLong' }, JSON.stringify(record));
  assert.equal((v.block as { time: string }).time, H.toString(), 'checked at the block mined again');
  // The reference: the same orders, sent by the test into the next block, at H + 1. The contract measures the thirty
  // seconds from the block the Cross lands in: at H the expiry is 31 past, refused; at H + 1 it is 30, and fills.
  const snapshot = await snapshotNow();
  try {
    await rig.setNextBlockTime(H + 1n);
    const sent = await crossFromTheTest(rig, { order: bet, signature: await sign(B, bet, 31337, rig.addresses.matching) }, [{ order: q.order, signature: await sign(M, q.order, 31337, rig.addresses.matching) }]);
    assert.equal(sent.filled, true, `the reference fills in the next block, at H + 1: ${JSON.stringify(sent)}`);
  } finally {
    await backTo(snapshot);
  }
});
