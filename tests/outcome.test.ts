import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { decodeEventLog, encodeFunctionData, parseAbi, type Abi, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import type { HookControl } from './support/courier';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { closeEach } from './support/close';
import { startStack, type Stack } from './support/stack';

// A Cross's outcome, from the chain's own evidence at a final block on F's
// chain and from nothing else, and the reason a mined Cross reverted, from one
// trace and from nothing else. Where a case needs two transactions in one
// block in a known order, the chain's clock is stopped while the courier is
// held after its hand-off, the test's own transaction is sent at a higher tip,
// one block is mined, and the clock starts again.

let stack: Stack;
let pool: pg.Pool;
const url = () => stack.courier.url;
const hooks = () => stack.courier.hooks as HookControl;
const handOffs = () => stack.proxy.count('eth_sendRawTransaction');

let from: Record<string, string> = {};
let nextAddress = 0;
beforeEach(() => {
  const n = nextAddress++;
  from = { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
});
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

before(async () => {
  stack = await startStack('outcome', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

let nextAccount = 40;
async function fresh(): Promise<HDAccount> {
  const who = stack.rig.account(nextAccount++);
  await stack.rig.fund(who);
  return who;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface Row {
  state: string;
  hand_offs: number;
  tx_hash: string | null;
  receipt_block_hash: string | null;
  revert_reason: string | null;
  revert_evidence: string | null;
  recorded: Record<string, unknown> | null;
}
const row = async (bet: string): Promise<Row | null> =>
  ((await pool.query('SELECT state, hand_offs, tx_hash, receipt_block_hash, revert_reason, revert_evidence, recorded FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()])).rows[0] as Row | undefined) ?? null;
const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];
const final = (bet: string, ms = 90_000) => until(() => row(bet), (r) => r !== null && FINAL.includes(r.state), ms, `the Cross of ${bet}`);
async function lineOf(bet: string, kind: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query<{ facts: Record<string, unknown> }>('SELECT facts FROM events WHERE bet_hash = $1 AND kind = $2 ORDER BY number LIMIT 1', [bet.toLowerCase(), kind]);
  return rows[0]?.facts ?? null;
}

async function quoteAndBet(life = 30n): Promise<{ M: HDAccount; B: HDAccount; bet: string; quote: string }> {
  const M = await fresh();
  const B = await fresh();
  const T = await stack.rig.time();
  const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 9_600n }), positionType: 0 };
  const posted = await postOrder(url(), stack.rig, M, 'rest', q);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + life, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(url(), stack.rig, B, 'take', b);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  return { M, B, bet: taken.body.orderHash as string, quote: posted.body.orderHash as string };
}

/** A transaction of `who`, signed here and sent to the chain's pool at this tip, not waited for. */
async function sendFrom(who: HDAccount, to: Hex, data: Hex, tip: bigint): Promise<Hex> {
  const nonce = Number(BigInt((await stack.rig.rpc('eth_getTransactionCount', [who.address, 'pending'])) as string));
  const block = (await stack.rig.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
  const raw = await who.signTransaction({ type: 'eip1559', chainId: 31337, to, data, value: 0n, nonce, gas: 200_000n, maxFeePerGas: BigInt(block.baseFeePerGas) * 3n + tip, maxPriorityFeePerGas: tip });
  return (await stack.rig.rpc('eth_sendRawTransaction', [raw])) as Hex;
}

const approveData = (amount: bigint) => encodeFunctionData({ abi: stack.rig.abis.TestCoin as Abi, functionName: 'approve', args: [stack.rig.addresses.positions, amount] });

/**
 * The courier's Cross and the test's transactions in one block, in the order of their tips: the clock stopped before
 * the hand-off, the courier held after it, `between` run with the Cross in the pool, one block mined, the clock started.
 */
async function inOneBlock(between: () => Promise<void>, life = 30n): Promise<{ bet: string; B: HDAccount; M: HDAccount }> {
  await hooks().arm('after-gate', 1);
  await hooks().arm('after-hand-off', 1);
  const c = await quoteAndBet(life);
  const gate = await hooks().reached('after-gate');
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await hooks().go(gate);
  const handed = await hooks().reached('after-hand-off');
  try {
    await between();
    await stack.rig.rpc('anvil_mine', ['0x1']);
  } finally {
    await stack.rig.rpc('evm_setIntervalMining', [2]);
    await hooks().go(handed);
  }
  return { bet: c.bet, B: c.B, M: c.M };
}

test('never mined, and no timer: the hand-off answered taken by the proxy and kept from the chain, F held behind the bet\'s expiry for 60 seconds of real time; the record stays sent and the lane holds no other Cross; once F passes the expiry it is expired unmined at the next look', async () => {
  const withheld = stack.proxy.withhold();
  const c = await quoteAndBet();
  await until(() => row(c.bet), (r) => r?.state === 'sent', 30_000, 'sent');
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string));
  const behind = await quoteAndBet();
  await new Promise((r) => setTimeout(r, 60_000));
  assert.equal((await row(c.bet))?.state, 'sent', 'still sent after 60 seconds of real time');
  assert.equal(await row(behind.bet), null, 'the lane holds no other Cross');
  stack.proxy.setFinal(null);
  stack.proxy.finalFollows(1n);
  withheld.stop();
  const r = await final(c.bet, 60_000);
  assert.equal(r?.state, 'expired unmined', JSON.stringify(r));
  // The bet that waited behind it ran out of time before its turn came: it lapses, and no Cross is made for it.
  const lapsed = await until(async () => (await pool.query<{ bet_state: string }>('SELECT bet_state FROM orders WHERE hash = $1', [behind.bet.toLowerCase()])).rows[0]?.bet_state, (s) => s === 'lapsed', 60_000, 'the bet behind it');
  assert.equal(lapsed, 'lapsed');
});

test('a receipt in F itself: taken on F\'s own hash, with no call of the chain\'s own hash of a height at the proxy', async () => {
  let blockhashCalls = 0;
  // F held at the head as it stands, at or past the watermark's anchor, so the Cross is sent and its receipt lands above F.
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string));
  const c = await quoteAndBet();
  const mined = await until(async () => (await stack.rig.rpc('eth_getTransactionReceipt', [(await row(c.bet))?.tx_hash ?? '0x' + '0'.repeat(64)])) as { blockNumber: Hex } | null, (r) => r !== null, 30_000, 'mined');
  stack.proxy.rule('eth_call', { kind: 'rewrite', params: (p) => (JSON.stringify(p).toLowerCase().includes('ee82ac5e') ? (blockhashCalls++, p) : p) });
  stack.proxy.setFinal(BigInt((mined as { blockNumber: Hex }).blockNumber));
  const r = await final(c.bet, 60_000);
  stack.proxy.rule('eth_call', null);
  stack.proxy.setFinal(null);
  stack.proxy.finalFollows(1n);
  assert.equal(r?.state, 'confirmed', JSON.stringify(r));
  assert.equal(blockhashCalls, 0, 'no blockhash call for a receipt in F itself');
});

test("a revert with a trace: B's own allowance to the positions contract set to zero, at a higher tip, in the Cross's block and before it; reverted, TakerPullRefused, evidence trace, pinned on B; one hand-off; the lane freed and the next bet sent", async () => {
  const before = handOffs();
  let B: HDAccount | null = null;
  const c = await inOneBlock(async () => {
    const rows = await pool.query<{ account: string }>(`SELECT o.account FROM orders o JOIN lanes l ON l.held_bet = o.hash`);
    const who = stack.rig.account(nextAccount - 1);
    assert.equal(who.address.toLowerCase(), rows.rows[0]?.account.toLowerCase(), "the held bet is the last fresh account's");
    B = who;
    await sendFrom(who, stack.rig.addresses.coin, approveData(0n), 50_000_000_000n);
  });
  const r = await final(c.bet);
  assert.deepEqual([r?.state, r?.revert_reason, r?.revert_evidence], ['reverted', 'TakerPullRefused', 'trace'], JSON.stringify(r));
  const line = await lineOf(c.bet, 'cross reverted');
  assert.deepEqual(line?.pinnedOn, [{ account: (B as unknown as HDAccount).address, role: 'bettor', act: 'its approval to the positions contract was too low' }]);
  assert.equal(handOffs() - before, 1, 'one hand-off');
  const next = await quoteAndBet();
  assert.equal((await final(next.bet))?.state, 'confirmed');
});

test("a revert with no trace, and a replay that would mislead: the node refuses the trace, and B's allowance is given back later in the same block; reverted with the reason unavailable, pinned on nobody's account, and no call that runs the transaction again", async () => {
  stack.proxy.rule('debug_traceTransaction', { kind: 'refuse', code: -32601, message: 'the method is not available' });
  const replays: unknown[] = [];
  try {
    const c = await inOneBlock(async () => {
      const who = stack.rig.account(nextAccount - 1);
      await sendFrom(who, stack.rig.addresses.coin, approveData(0n), 50_000_000_000n);
      await sendFrom(who, stack.rig.addresses.coin, approveData(10n ** 18n), 1_000_000n);
      stack.proxy.rule('eth_call', { kind: 'rewrite', params: (p) => (JSON.stringify(p).toLowerCase().includes('84075346') ? (replays.push(p), p) : p) });
    });
    const r = await final(c.bet);
    assert.deepEqual([r?.state, r?.revert_reason, r?.revert_evidence], ['reverted', 'unavailable', 'unavailable'], JSON.stringify(r));
    const line = await lineOf(c.bet, 'cross reverted');
    assert.equal(line?.pinnedOn, 'unknown');
    assert.equal(replays.length, 0, 'no call ran the transaction again');
  } finally {
    stack.proxy.rule('debug_traceTransaction', null);
    stack.proxy.rule('eth_call', null);
  }
});

test("a Cross mined after the bet's expiry: the next block's time set past it; reverted, with the expiry and the block's time, pinned on nobody", async () => {
  let expiry = 0n;
  const c = await inOneBlock(async () => {
    const e = await pool.query<{ expiry: string }>('SELECT o.expiry::text AS expiry FROM orders o JOIN lanes l ON l.held_bet = o.hash');
    expiry = BigInt((e.rows[0] as { expiry: string }).expiry);
    await stack.rig.rpc('evm_setNextBlockTimestamp', [`0x${(expiry + 1n).toString(16)}`]);
  });
  const r = await final(c.bet);
  assert.equal(r?.state, 'reverted', JSON.stringify(r));
  const line = await lineOf(c.bet, 'cross reverted');
  assert.deepEqual(line?.pinnedOn, []);
  assert.equal((line?.expired as { expiry: string } | undefined)?.expiry, expiry.toString());
});

test('a trace for another transaction: the node answers the trace of another call; the reason is unavailable, pinned on nobody\'s account', async () => {
  stack.proxy.rule('debug_traceTransaction', { kind: 'rewriteResult', result: (_p, result) => ({ ...(result as Record<string, unknown>), input: '0x84075346' + '00'.repeat(32) }) });
  try {
    const c = await inOneBlock(async () => {
      const who = stack.rig.account(nextAccount - 1);
      await sendFrom(who, stack.rig.addresses.coin, approveData(0n), 50_000_000_000n);
    });
    const r = await final(c.bet);
    assert.deepEqual([r?.state, r?.revert_evidence], ['reverted', 'unavailable'], JSON.stringify(r));
    assert.equal((await lineOf(c.bet, 'cross reverted'))?.pinnedOn, 'unknown');
  } finally {
    stack.proxy.rule('debug_traceTransaction', null);
  }
});

const EVENTS = parseAbi([
  'event OrderMatched(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 gameId, uint256 marketId, address scorer, int32 lineTicks, uint8 makerPositionType, uint16 oddsTick, uint256 makerRisk, uint256 takerRisk, uint256 orderRiskAmount, uint256 nonce, uint256 expiry, uint256 orderMinFill)',
  'event HeldChanged(uint256 indexed marketId, address indexed account, uint256 pulled, uint256 paidBack, uint256 held)',
]);

test('the bet end to end, held against an oracle of the test\'s own by log index: the record\'s legs are the receipt\'s OrderMatched, its pulls the positions contract\'s HeldChanged and not the hub\'s copy, and each balance moves by exactly that', async () => {
  const c = await quoteAndBet();
  const bBefore = await stack.rig.read<bigint>(stack.rig.addresses.coin, stack.rig.abis.TestCoin as Abi, 'balanceOf', [c.B.address]);
  const r = await final(c.bet);
  assert.equal(r?.state, 'confirmed');
  const receipt = (await stack.rig.rpc('eth_getTransactionReceipt', [r?.tx_hash])) as { logs: Array<{ address: string; topics: Hex[]; data: Hex; logIndex: Hex }> };
  const matched: Array<{ orderHash: string; makerRisk: bigint; takerRisk: bigint }> = [];
  const pulls = new Map<string, bigint>();
  for (const log of [...receipt.logs].sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)))) {
    const at = log.address.toLowerCase();
    try {
      const e = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (e.eventName === 'OrderMatched' && at === stack.rig.addresses.matching.toLowerCase()) matched.push({ orderHash: (e.args.orderHash as string).toLowerCase(), makerRisk: e.args.makerRisk as bigint, takerRisk: e.args.takerRisk as bigint });
      if (e.eventName === 'HeldChanged' && at === stack.rig.addresses.positions.toLowerCase()) pulls.set((e.args.account as string).toLowerCase(), (pulls.get((e.args.account as string).toLowerCase()) ?? 0n) + (e.args.pulled as bigint));
    } catch {
      // Another event.
    }
  }
  const legs = await pool.query<{ order_hash: string; recorded_maker_risk: string; recorded_taker_risk: string }>('SELECT order_hash, recorded_maker_risk::text AS recorded_maker_risk, recorded_taker_risk::text AS recorded_taker_risk FROM legs WHERE bet_hash = $1 ORDER BY position', [c.bet.toLowerCase()]);
  assert.deepEqual(legs.rows.map((l) => ({ orderHash: l.order_hash, makerRisk: BigInt(l.recorded_maker_risk), takerRisk: BigInt(l.recorded_taker_risk) })), matched);
  const recordedPulls = (r?.recorded as { pulls: Record<string, string> }).pulls;
  assert.deepEqual(Object.fromEntries(Object.entries(recordedPulls).map(([a, v]) => [a.toLowerCase(), BigInt(v)])), Object.fromEntries(pulls));
  const bAfter = await stack.rig.read<bigint>(stack.rig.addresses.coin, stack.rig.abis.TestCoin as Abi, 'balanceOf', [c.B.address]);
  assert.equal(bBefore - bAfter, pulls.get(c.B.address.toLowerCase()), "the bettor's balance moved by exactly its pull");
});

test("the pause's first carry: one cross reverted line for each failed Cross, in a form a count can read; a count over this file's lines gives the bettor for the revert traced to its own allowance, unknown for the one with no trace and the one with another's trace, and nobody for the one past its expiry, and never counts an account merely affected", async () => {
  const { rows } = await pool.query<{ pinned: unknown; affected: unknown }>(`SELECT facts->'pinnedOn' AS pinned, facts->'affected' AS affected FROM events WHERE kind = 'cross reverted' ORDER BY number`);
  const shape = rows.map((r) => (Array.isArray(r.pinned) ? (r.pinned.length === 0 ? 'nobody' : 'account') : r.pinned));
  assert.deepEqual(shape, ['account', 'unknown', 'nobody', 'unknown']);
  const counted = rows.flatMap((r) => (Array.isArray(r.pinned) ? (r.pinned as Array<{ account: string }>).map((p) => p.account.toLowerCase()) : []));
  assert.equal(counted.length, 1, 'one account counted: the bettor whose own act the trace shows');
});
