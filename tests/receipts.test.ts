import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi, type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { MULTICALL_ABI } from '../courier/chain/abi';
import { createJsonRpc, receiptOf, type Receipt } from '../courier/chain/rpc';
import type { BettingSet } from '../courier/chain/set';
import { readCrossReceipt } from '../courier/send/chain';
import type { HookControl } from './support/courier';
import { contractHash, crossFromTheTest, grantAgent, nextOrderNumber, nonceOf, orderOn, postOrder as postOrderFrom, postOrderAs as postOrderAsFrom, sign, type Order } from './support/orders';
import { artifact, TIMELOCK_DELAY, type Rig } from './support/rig';
import { closeEach } from './support/close';
import { startStack, type Stack } from './support/stack';

// A sent Cross's outcome from the chain's own evidence at a final block on F's chain, and its record from the
// receipt's module events, Cross by Cross. The chain runs on its clock, with a coin that refuses by rules of its own
// when told to: an orphan's receipt, an orphaned H, the coin's own refusal of the bettor's pull, a quote's grant ended
// by its time, a cancel mined first in a Cross of one quote and in one whose minimum needs both, a pay-back refused at
// each of two visits, one maker's two quotes on one side, a maker netted down, a receipt with two Crosses, and last a
// receipt the state at F contradicts. Where a case needs transactions in one block in a known order, the chain's clock
// is stopped while the courier is held after its hand-off, the test's own transactions are sent at a higher tip, one
// block is mined, and the clock starts again.

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;
const url = () => stack.courier.url;
const hooks = () => stack.courier.hooks as HookControl;

let from: Record<string, string> = {};
let nextAddress = 0;
beforeEach(() => {
  const n = nextAddress++;
  from = { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
});
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const postOrderAs = (...a: Parameters<typeof postOrderAsFrom>) => postOrderAsFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

before(async () => {
  stack = await startStack('receipts', { coin: 'RefusingCoin', hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  rig = stack.rig;
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

let nextAccount = 40;
async function fresh(): Promise<HDAccount> {
  const who = rig.account(nextAccount++);
  await rig.fund(who);
  return who;
}

/** A market of a case's own: a spread line no other case uses, so its book holds the case's quotes alone. */
let nextLine = 1;
const ownMarket = () => ({ scorer: rig.addresses.spread, lineTicks: -(3_000 + 5 * nextLine++) });

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
  tx_hash: Hex | null;
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
const reasonsOf = async (bet: string): Promise<string[]> =>
  (await pool.query<{ reason: string }>(`SELECT reason FROM events WHERE bet_hash = $1 AND kind LIKE 'cross %' ORDER BY number`, [bet.toLowerCase()])).rows.map((r) => r.reason);

/** A quote of `who` on the market, posted: its hash and its signed order. */
async function quoteOn(who: HDAccount, market: { scorer: Address; lineTicks: number }, fields: Partial<Order> = {}): Promise<{ hash: string; order: Order }> {
  const T = await rig.time();
  const order: Order = { ...orderOn(rig, who, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 9_600n, ...market, ...fields }), positionType: 0 };
  const posted = await postOrder(url(), rig, who, 'rest', order);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as string, order };
}

/** A bet of `who` on the market, posted: its hash and its signed order. */
async function betOn(who: HDAccount, market: { scorer: Address; lineTicks: number }, fields: Partial<Order> = {}): Promise<{ hash: string; order: Order; signature: Hex }> {
  const T = await rig.time();
  const order: Order = { ...orderOn(rig, who, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, ...market, ...fields }), positionType: 1 };
  const posted = await postOrder(url(), rig, who, 'take', order);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as string, order, signature: posted.signature };
}

/** A transaction of `who`, signed here and sent to the chain's pool at this tip, not waited for. */
async function sendFrom(who: HDAccount, to: Address, data: Hex, tip: bigint, gas = 300_000n): Promise<Hex> {
  const nonce = Number(BigInt((await rig.rpc('eth_getTransactionCount', [who.address, 'pending'])) as string));
  const block = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
  const raw = await who.signTransaction({ type: 'eip1559', chainId: 31337, to, data, value: 0n, nonce, gas, maxFeePerGas: BigInt(block.baseFeePerGas) * 3n + tip, maxPriorityFeePerGas: tip });
  return (await rig.rpc('eth_sendRawTransaction', [raw])) as Hex;
}

/**
 * The courier's Cross and the test's transactions in one block, in the order of their tips: the clock stopped before
 * the hand-off, the courier held after it, `between` run with the Cross in the pool, one block mined, the clock started.
 */
async function inOneBlock(post: () => Promise<string>, between: () => Promise<void>): Promise<string> {
  await hooks().arm('after-gate', 1);
  await hooks().arm('after-hand-off', 1);
  const bet = await post();
  const gate = await hooks().reached('after-gate');
  await rig.rpc('evm_setIntervalMining', [0]);
  await hooks().go(gate);
  const handed = await hooks().reached('after-hand-off');
  try {
    await between();
    await rig.rpc('anvil_mine', ['0x1']);
  } finally {
    await rig.rpc('evm_setIntervalMining', [2]);
    await hooks().go(handed);
  }
  return bet;
}

const coinAbi = () => rig.abis.RefusingCoin as Abi;
const blockData = (who: Address, blocked: boolean) => encodeFunctionData({ abi: coinAbi(), functionName: 'setBlocked', args: [who, blocked] });
const cancelData = (order: Order) => encodeFunctionData({ abi: rig.abis.OspexMatching as Abi, functionName: 'cancelOrder', args: [order] });

/** `who` holds side B of the market, risk 6,000 against a profit of 5,000: X's quote at tick 220, taken by a Cross the test sends through another courier. */
async function holdsSideB(who: HDAccount, market: { scorer: Address; lineTicks: number }): Promise<void> {
  const X = await fresh();
  const T = await rig.time();
  const x: Order = { ...orderOn(rig, X, { expiry: T + 600n, oddsTick: 220, riskAmount: 5_000n, ...market }), positionType: 0 };
  const m: Order = { ...orderOn(rig, who, { expiry: T + 25n, oddsTick: 180, riskAmount: 6_000n, ...market }), positionType: 1 };
  const sent = await crossFromTheTest(rig, { order: m, signature: await sign(who, m, 31337, rig.addresses.matching) }, [{ order: x, signature: await sign(X, x, 31337, rig.addresses.matching) }]);
  assert.equal(sent.filled, true, JSON.stringify(sent));
}

const EVENTS = parseAbi([
  'event OrderMatched(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 gameId, uint256 marketId, address scorer, int32 lineTicks, uint8 makerPositionType, uint16 oddsTick, uint256 makerRisk, uint256 takerRisk, uint256 orderRiskAmount, uint256 nonce, uint256 expiry, uint256 orderMinFill)',
  'event HeldChanged(uint256 indexed marketId, address indexed account, uint256 pulled, uint256 paidBack, uint256 held)',
  'event PayBackRefused(uint256 indexed marketId, address indexed account, uint256 amount, uint256 held)',
  'event Crossed(address indexed courier, bytes32 indexed takingOrderHash, address indexed taker, uint256 marketId, uint256 totalMakerRisk, uint256 totalTakerRisk)',
]);

interface Oracle {
  legs: Array<{ orderHash: string; makerRisk: bigint; takerRisk: bigint }>;
  held: Array<{ account: string; pulled: bigint; paidBack: bigint; held: bigint; logIndex: number }>;
  refused: Array<{ account: string; amount: bigint; held: bigint; logIndex: number }>;
  crossed: Array<{ takingOrderHash: string; logIndex: number }>;
}

/** The test's own reading of a receipt, by log index: the matching contract's legs and Crossed, the positions contract's HeldChanged and PayBackRefused, and nothing else. */
async function oracleOf(txHash: Hex): Promise<Oracle> {
  const receipt = (await rig.rpc('eth_getTransactionReceipt', [txHash])) as { logs: Array<{ address: string; topics: Hex[]; data: Hex; logIndex: Hex }> };
  const out: Oracle = { legs: [], held: [], refused: [], crossed: [] };
  for (const log of [...receipt.logs].sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)))) {
    const at = log.address.toLowerCase();
    const logIndex = Number(BigInt(log.logIndex));
    try {
      const e = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const a = e.args as Record<string, unknown>;
      if (e.eventName === 'OrderMatched' && at === rig.addresses.matching.toLowerCase()) out.legs.push({ orderHash: String(a.orderHash).toLowerCase(), makerRisk: a.makerRisk as bigint, takerRisk: a.takerRisk as bigint });
      if (e.eventName === 'Crossed' && at === rig.addresses.matching.toLowerCase()) out.crossed.push({ takingOrderHash: String(a.takingOrderHash).toLowerCase(), logIndex });
      if (e.eventName === 'HeldChanged' && at === rig.addresses.positions.toLowerCase()) out.held.push({ account: String(a.account).toLowerCase(), pulled: a.pulled as bigint, paidBack: a.paidBack as bigint, held: a.held as bigint, logIndex });
      if (e.eventName === 'PayBackRefused' && at === rig.addresses.positions.toLowerCase()) out.refused.push({ account: String(a.account).toLowerCase(), amount: a.amount as bigint, held: a.held as bigint, logIndex });
    } catch {
      // Another event.
    }
  }
  return out;
}

const sumBy = (rows: Array<{ account: string }>, value: (r: never) => bigint): Record<string, bigint> => {
  const out: Record<string, bigint> = {};
  for (const r of rows) {
    const v = value(r as never);
    if (v > 0n) out[r.account] = (out[r.account] ?? 0n) + v;
  }
  return out;
};
const lowerKeys = (m: Record<string, string> | undefined): Record<string, bigint> => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));

test("an orphan: the Cross mined in a block the chain then takes back, and mined again in the block that wins at the same height; the proxy keeps the orphan's receipt and serves it once the final block passes its height; no outcome is written from it, the Cross goes back to sent, and the outcome is the winning block's", async () => {
  const market = ownMarket();
  const M = await fresh();
  const B = await fresh();
  await quoteOn(M, market);
  // The final block held where it stands, so the Cross's first block lies above it while the chain takes it back.
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(BigInt((await rig.rpc('eth_blockNumber', [])) as string));
  await hooks().arm('after-gate', 1);
  await hooks().arm('after-hand-off', 1);
  const bet = await betOn(B, market);
  const gate = await hooks().reached('after-gate');
  await rig.rpc('evm_setIntervalMining', [0]);
  let serving = false;
  try {
    await hooks().go(gate);
    const handed = await hooks().reached('after-hand-off');
    const raw = hooks().signed[hooks().signed.length - 1] as Hex;
    const kept = (await rig.rpc('evm_snapshot', [])) as Hex;
    await rig.rpc('anvil_mine', ['0x1']);
    const txHash = (await row(bet.hash))?.tx_hash as Hex;
    const orphan = (await rig.rpc('eth_getTransactionReceipt', [txHash])) as { blockNumber: Hex; blockHash: Hex };
    assert.ok(orphan !== null, 'mined in the first block');
    const orphanTime = BigInt(((await rig.rpc('eth_getBlockByHash', [orphan.blockHash, false])) as { timestamp: Hex }).timestamp);
    await hooks().go(handed);
    await until(() => row(bet.hash), (r) => r?.state === 'pending' && r.receipt_block_hash === orphan.blockHash.toLowerCase(), 60_000, 'pending on the first receipt');
    // From here the proxy answers the orphan's receipt for this transaction.
    stack.proxy.rule('eth_getTransactionReceipt', { kind: 'rewriteResult', result: (p, r) => (serving && String(p[0]).toLowerCase() === txHash.toLowerCase() ? orphan : r) });
    serving = true;
    // The block taken back; the same transaction mined again at the same height in a block of another time.
    assert.equal(await rig.rpc('evm_revert', [kept]), true);
    try {
      await rig.rpc('eth_sendRawTransaction', [raw]);
    } catch {
      // Still in the pool after the revert: mined from there.
    }
    await rig.setNextBlockTime(orphanTime + 1n);
    await rig.rpc('anvil_mine', ['0x1']);
    const winning = (await rig.rpc('eth_getTransactionReceipt', [txHash])) as { blockNumber: Hex; blockHash: Hex };
    assert.equal(BigInt(winning.blockNumber), BigInt(orphan.blockNumber), 'mined again at the same height');
    assert.notEqual(winning.blockHash.toLowerCase(), orphan.blockHash.toLowerCase(), 'in another block');
    // The final block passes the height: the orphan's receipt is not on its chain, and no outcome is written from it.
    stack.proxy.setFinal(BigInt(winning.blockNumber));
    await until(() => reasonsOf(bet.hash), (r) => r.includes('RECEIPT_ORPHANED'), 90_000, 'the orphan set aside');
    assert.equal((await row(bet.hash))?.state, 'sent', 'back to sent');
    await new Promise((r) => setTimeout(r, 6_000));
    assert.ok(!FINAL.includes(String((await row(bet.hash))?.state)), 'no outcome from the orphan, look after look');
    serving = false;
    const r = await final(bet.hash);
    assert.equal(r?.state, 'confirmed', JSON.stringify(r));
    assert.equal(r?.receipt_block_hash, winning.blockHash.toLowerCase(), "the winning block's receipt");
    assert.equal(r?.hand_offs, 1);
  } finally {
    serving = false;
    stack.proxy.rule('eth_getTransactionReceipt', null);
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
    await rig.rpc('evm_setIntervalMining', [2]);
  }
});

test("an orphaned H: another courier's fill of part of the bet stands at H, and H is then dropped; the Cross fills on the branch that wins: confirmed, and no fault", async () => {
  const market = ownMarket();
  const [M, M1, M2, B] = [await fresh(), await fresh(), await fresh(), await fresh()];
  await quoteOn(M, market, { riskAmount: 100_000n });
  const T = await rig.time();
  const first: Order = { ...orderOn(rig, M1, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 1_200n, ...market }), positionType: 0 };
  const part: Order = { ...orderOn(rig, M2, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 2_400n, ...market }), positionType: 0 };
  await hooks().arm('after-reservation', 1);
  await hooks().arm('after-intent', 1);
  const bet = await betOn(B, market);
  const reserved = await hooks().reached('after-reservation');
  // A first part-fill by another courier, on both branches: the market and the bettor's position stand before H, so
  // the Cross estimated at H costs on the winning branch what it cost there.
  const earlier = await crossFromTheTest(rig, { order: bet.order, signature: bet.signature }, [{ order: first, signature: await sign(M1, first, 31337, rig.addresses.matching) }]);
  assert.equal(earlier.filled, true, JSON.stringify(earlier));
  const before = await rig.read<bigint>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_filledRisk', [bet.hash]);
  await rig.rpc('evm_setIntervalMining', [0]);
  let H: { hash: Hex; timestamp: Hex } | null = null;
  try {
    // The block before H kept; another courier's Cross of part of the bet mined as H.
    const kept = (await rig.rpc('evm_snapshot', [])) as Hex;
    const data = encodeFunctionData({ abi: rig.abis.OspexCourierRelay as Abi, functionName: 'cross', args: [{ order: bet.order, signature: bet.signature }, [{ order: part, signature: await sign(M2, part, 31337, rig.addresses.matching) }]] } as never);
    await sendFrom(rig.accounts.otherSender, rig.addresses.otherRelay, data, 2_000_000_000n, 1_000_000n);
    await rig.rpc('anvil_mine', ['0x1']);
    H = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { hash: Hex; timestamp: Hex };
    const atH = await rig.read<bigint>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_filledRisk', [bet.hash]);
    assert.ok(atH > before, "H's own part-fill stands at H");
    await hooks().go(reserved);
    const intent = await hooks().reached('after-intent');
    const checked = (await pool.query<{ block_hash: string; checked: { betFilledAtH?: string } }>('SELECT block_hash, checked FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()])).rows[0];
    assert.equal(checked?.block_hash, H.hash.toLowerCase(), 'checked at H');
    // H dropped: the chain taken back to the block before it, and another block mined there, at another time.
    assert.equal(await rig.rpc('evm_revert', [kept]), true);
    await rig.setNextBlockTime(BigInt(H.timestamp) + 1n);
    await rig.rpc('anvil_mine', ['0x1']);
    assert.equal(await rig.read<bigint>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_filledRisk', [bet.hash]), before, "H's part-fill is not on the branch that wins");
    await rig.rpc('evm_setIntervalMining', [2]);
    await hooks().go(intent);
  } finally {
    await rig.rpc('evm_setIntervalMining', [2]);
  }
  const r = await final(bet.hash);
  assert.equal(r?.state, 'confirmed', JSON.stringify(r));
  const totals = (r?.recorded as { totals: { taker: string } }).totals;
  assert.equal(BigInt((r?.recorded as { betFilled: string }).betFilled), before + BigInt(totals.taker), "the bet's filled amount at F: the first part-fill and this Cross, and not H's");
  const faults = await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind = 'incident' AND reason = 'COURIER_FAULT'`);
  assert.equal(faults.rows[0].n, 0, 'no fault');
  const next = await betOn(await fresh(), market);
  assert.equal((await final(next.hash))?.state, 'confirmed', 'the lane goes on');
});

test("the coin's own refusal of the bettor's pull, the bettor's balance and allowance enough and the bettor changing nothing: the coin's administrator blocks the bettor in the Cross's block, before it; reverted, TakerPullRefused, evidence trace, the bettor the affected account in its role, pinned on no account but unknown", async () => {
  const market = ownMarket();
  const M = await fresh();
  const B = await fresh();
  try {
    const bet = await inOneBlock(
      async () => {
        await quoteOn(M, market);
        return (await betOn(B, market)).hash;
      },
      async () => {
        await sendFrom(rig.accounts.deployer, rig.addresses.coin, blockData(B.address, true), 50_000_000_000n);
      },
    );
    const r = await final(bet);
    assert.deepEqual([r?.state, r?.revert_reason, r?.revert_evidence], ['reverted', 'TakerPullRefused', 'trace'], JSON.stringify(r));
    const line = await lineOf(bet, 'cross reverted');
    assert.equal(line?.pinnedOn, 'unknown', JSON.stringify(line));
    assert.deepEqual(line?.affected, [{ account: B.address, role: 'bettor', pull: '9984', coin: 'blocked' }], JSON.stringify(line));
    // B's balance and allowance at the Cross's block were enough: the refusal was the coin's own.
    const receipt = (await rig.rpc('eth_getTransactionReceipt', [r?.tx_hash])) as { blockNumber: Hex };
    const at = BigInt(receipt.blockNumber);
    const balance = (await rig.publicClient.readContract({ address: rig.addresses.coin, abi: coinAbi(), functionName: 'balanceOf', args: [B.address], blockNumber: at })) as bigint;
    const allowance = (await rig.publicClient.readContract({ address: rig.addresses.coin, abi: coinAbi(), functionName: 'allowance', args: [B.address, rig.addresses.positions], blockNumber: at })) as bigint;
    assert.ok(balance >= 9_984n && allowance >= 9_984n, `balance ${balance}, allowance ${allowance}`);
  } finally {
    await rig.write(rig.accounts.deployer, rig.addresses.coin, coinAbi(), 'setBlocked', [B.address, false]);
  }
});

test("a quote's grant ended by its time: a quote its account's agent signed under a grant that ends at the Cross's block, the bet's only quote; NothingFilled, and that quote's act pinned on unknown", async () => {
  const market = ownMarket();
  const owner = await fresh();
  const agent = await fresh();
  const B = await fresh();
  const T0 = await rig.time();
  const ends = T0 + 20n;
  const g = await grantAgent(rig, owner, agent.address, 10n ** 12n, ends);
  const bet = await inOneBlock(
    async () => {
      const T = await rig.time();
      const order: Order = { ...orderOn(rig, owner, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 9_600n, nonce: nonceOf(0n, g, nextOrderNumber()), ...market }), positionType: 0 };
      const posted = await postOrderAs(url(), rig, agent, 'rest', order);
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      return (await betOn(B, market)).hash;
    },
    async () => {
      // The Cross's block at the grant's end: the grant is over there.
      await rig.setNextBlockTime(ends);
    },
  );
  const r = await final(bet);
  assert.deepEqual([r?.state, r?.revert_reason, r?.revert_evidence], ['reverted', 'NothingFilled', 'trace'], JSON.stringify(r));
  assert.equal((await lineOf(bet, 'cross reverted'))?.pinnedOn, 'unknown');
});

test('a cancel mined first, in a Cross of one quote: the maker cancels in the Cross\'s block, before it; reverted, NothingFilled, pinned on the maker whose cancel the reason names', async () => {
  const market = ownMarket();
  const M = await fresh();
  const B = await fresh();
  let q: { hash: string; order: Order } | null = null;
  const bet = await inOneBlock(
    async () => {
      q = await quoteOn(M, market);
      return (await betOn(B, market)).hash;
    },
    async () => {
      await sendFrom(M, rig.addresses.matching, cancelData((q as { order: Order }).order), 50_000_000_000n);
    },
  );
  const r = await final(bet);
  assert.deepEqual([r?.state, r?.revert_reason, r?.revert_evidence], ['reverted', 'NothingFilled', 'trace'], JSON.stringify(r));
  assert.deepEqual((await lineOf(bet, 'cross reverted'))?.pinnedOn, [{ account: M.address, role: 'maker', act: 'cancelled on chain' }]);
});

test("a cancel mined first, in a Cross of two quotes whose bet's minimum needs both: the first maker cancels in the Cross's block, before it; the whole Cross reverts, TakingOrderUnderMinFill", async () => {
  const market = ownMarket();
  const [M1, M2, B] = [await fresh(), await fresh(), await fresh()];
  let q1: { hash: string; order: Order } | null = null;
  const bet = await inOneBlock(
    async () => {
      q1 = await quoteOn(M1, market, { riskAmount: 4_800n });
      await quoteOn(M2, market, { riskAmount: 4_800n });
      return (await betOn(B, market, { minFill: 9_000n })).hash;
    },
    async () => {
      await sendFrom(M1, rig.addresses.matching, cancelData((q1 as { order: Order }).order), 50_000_000_000n);
    },
  );
  const r = await final(bet);
  assert.deepEqual([r?.state, r?.revert_reason, r?.revert_evidence], ['reverted', 'TakingOrderUnderMinFill', 'trace'], JSON.stringify(r));
});

test("a pay-back the coin refuses, at each of two visits: a maker that holds the other side, blocked by the coin, behind two quotes; the record's refused pay-backs are the receipt's two PayBackRefused, by log index, and what stays held is the last one's, as the positions contract holds it at the final block", async () => {
  const market = ownMarket();
  const M = await fresh();
  await holdsSideB(M, market);
  await quoteOn(M, market, { riskAmount: 4_800n });
  await quoteOn(M, market, { riskAmount: 4_800n });
  await rig.write(rig.accounts.deployer, rig.addresses.coin, coinAbi(), 'setBlocked', [M.address, true]);
  try {
    const bet = await betOn(await fresh(), market);
    const r = await final(bet.hash);
    assert.equal(r?.state, 'confirmed', JSON.stringify(r));
    const o = await oracleOf(r?.tx_hash as Hex);
    assert.equal(o.refused.length, 2, 'refused at each of two visits');
    const recorded = (r?.recorded as { paysBackRefused: Array<{ account: string; amount: string; held: string; logIndex: number }> }).paysBackRefused;
    assert.deepEqual(
      recorded.map((p) => ({ account: p.account.toLowerCase(), amount: BigInt(p.amount), held: BigInt(p.held), logIndex: p.logIndex })),
      o.refused,
    );
    const last = o.refused[o.refused.length - 1] as { held: bigint };
    const final_ = (r?.recorded as { final: { number: string } }).final;
    const marketId = BigInt((r?.recorded as { totals: { marketId: string } }).totals.marketId);
    const heldAtF = (await rig.publicClient.readContract({ address: rig.addresses.positions, abi: rig.abis.OspexPositions as Abi, functionName: 's_held', args: [marketId, M.address], blockNumber: BigInt(final_.number) })) as bigint;
    assert.equal(heldAtF, last.held, "the last refusal's held amount is what the positions contract holds at the final block");
  } finally {
    await rig.write(rig.accounts.deployer, rig.addresses.coin, coinAbi(), 'setBlocked', [M.address, false]);
  }
});

test('one maker, two quotes, both legs on the same side: a pull at each leg, and the record is the receipt\'s legs and pulls, by log index', async () => {
  const market = ownMarket();
  const M = await fresh();
  await quoteOn(M, market, { riskAmount: 4_800n });
  await quoteOn(M, market, { riskAmount: 4_800n });
  const B = await fresh();
  const bet = await betOn(B, market);
  const r = await final(bet.hash);
  assert.equal(r?.state, 'confirmed', JSON.stringify(r));
  const o = await oracleOf(r?.tx_hash as Hex);
  const mPulls = o.held.filter((h) => h.account === M.address.toLowerCase() && h.pulled > 0n);
  assert.equal(mPulls.length, 2, 'a pull at each leg');
  const legs = await pool.query<{ order_hash: string; m: string; t: string }>('SELECT order_hash, recorded_maker_risk::text AS m, recorded_taker_risk::text AS t FROM legs WHERE bet_hash = $1 ORDER BY position', [bet.hash.toLowerCase()]);
  assert.deepEqual(legs.rows.map((l) => ({ orderHash: l.order_hash, makerRisk: BigInt(l.m), takerRisk: BigInt(l.t) })), o.legs);
  assert.deepEqual(lowerKeys((r?.recorded as { pulls: Record<string, string> }).pulls), sumBy(o.held, (h: { pulled: bigint }) => h.pulled));
});

test('a maker holding the other side, netted down: no pull, and a pay-back at the end; the record is the receipt\'s pulls and pay-backs, by log index', async () => {
  const market = ownMarket();
  const M = await fresh();
  await holdsSideB(M, market);
  await quoteOn(M, market, { riskAmount: 100_000n });
  const B = await fresh();
  const bet = await betOn(B, market);
  const r = await final(bet.hash);
  assert.equal(r?.state, 'confirmed', JSON.stringify(r));
  const o = await oracleOf(r?.tx_hash as Hex);
  const m = o.held.filter((h) => h.account === M.address.toLowerCase());
  assert.ok(m.every((h) => h.pulled === 0n), 'no pull of the maker');
  assert.ok(m.some((h) => h.paidBack > 0n), 'a pay-back to the maker');
  const recorded = r?.recorded as { pulls: Record<string, string>; paysBack: Record<string, string> };
  assert.deepEqual(lowerKeys(recorded.pulls), sumBy(o.held, (h: { pulled: bigint }) => h.pulled));
  assert.deepEqual(lowerKeys(recorded.paysBack), sumBy(o.held, (h: { paidBack: bigint }) => h.paidBack));
  assert.equal(lowerKeys(recorded.pulls)[M.address.toLowerCase()], undefined, 'the maker pulled nothing');
});

test("a receipt the courier did not send, with two Crosses in one transaction, as a timelock's batch through a relay can make: each bet's record is read from its own Cross's events and from no other's, and a bet the receipt does not cross has none", async () => {
  // A relay whose sender is the rig's timelock, which any account may execute through once its delay has passed.
  const art = artifact('OspexCourierRelay.sol', 'OspexCourierRelay');
  const deployHash = await rig.wallet(rig.accounts.deployer).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [rig.addresses.matching, rig.addresses.timelock], account: rig.accounts.deployer, chain: null });
  const batchRelay = (await rig.publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address;
  const crosses: Array<{ data: Hex; betHash: Hex }> = [];
  for (let i = 0; i < 2; i++) {
    const market = ownMarket();
    const [M, B] = [await fresh(), await fresh()];
    for (const who of [M, B]) await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'registerCourier', [batchRelay]);
    const T = await rig.time();
    const quote: Order = { ...orderOn(rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 4_800n * BigInt(i + 1), ...market }), positionType: 0 };
    // Signed for the block the batch runs in, past the timelock's delay: within the contract's longest life of it.
    const bet: Order = { ...orderOn(rig, B, { expiry: T + TIMELOCK_DELAY + 25n, oddsTick: 196, riskAmount: 5_000n * BigInt(i + 1), ...market }), positionType: 1 };
    const data = encodeFunctionData({ abi: rig.abis.OspexCourierRelay as Abi, functionName: 'cross', args: [{ order: bet, signature: await sign(B, bet, 31337, rig.addresses.matching) }, [{ order: quote, signature: await sign(M, quote, 31337, rig.addresses.matching) }]] } as never);
    crosses.push({ data, betHash: (await contractHash(rig, bet)).toLowerCase() as Hex });
  }
  // The two Crosses in one batch: scheduled, the delay passed, executed by an account that is not the courier's key.
  const timelockAbi = rig.abis.TimelockController as Abi;
  const zero: Hex = `0x${'0'.repeat(64)}`;
  const salt: Hex = `0x${'7'.repeat(64)}`;
  const batch = [crosses.map(() => batchRelay), crosses.map(() => 0n), crosses.map((c) => c.data), zero, salt] as const;
  await rig.write(rig.accounts.timelockKey, rig.addresses.timelock, timelockAbi, 'scheduleBatch', [...batch, TIMELOCK_DELAY]);
  await rig.increaseTime(TIMELOCK_DELAY);
  const txHash = await rig.write(rig.accounts.stranger, rig.addresses.timelock, timelockAbi, 'executeBatch', [...batch]);
  const receipt = await receiptOf(createJsonRpc(rig.url), txHash);
  assert.ok(receipt !== null && receipt.status === 'success', 'the batch ran');
  const o = await oracleOf(txHash);
  assert.equal(o.crossed.length, 2, 'two Crosses in one transaction');
  const set = { matching: rig.addresses.matching, positions: rig.addresses.positions, markets: rig.addresses.markets } as BettingSet;
  const records = crosses.map((c) => readCrossReceipt(set, receipt as Receipt, c.betHash));
  for (const [i, c] of crosses.entries()) {
    // The oracle's piece of this Cross: its events after the Cross before it, up to its own Crossed.
    const crossedAt = (o.crossed[i] as { logIndex: number }).logIndex;
    const startAt = i === 0 ? -1 : (o.crossed[i - 1] as { logIndex: number }).logIndex;
    const within = <T extends { logIndex: number }>(rows: T[]) => rows.filter((r) => r.logIndex > startAt && r.logIndex < crossedAt);
    const r = records[i] as ReturnType<typeof readCrossReceipt>;
    assert.equal(r.crossed?.takingOrderHash.toLowerCase(), c.betHash, `Cross ${i + 1}: its own Crossed`);
    assert.equal((o.crossed[i] as { takingOrderHash: string }).takingOrderHash, c.betHash);
    assert.equal(r.legs.length, 1, `Cross ${i + 1}: its own leg alone`);
    const leg = r.legs[0] as { logIndex: number };
    assert.ok(leg.logIndex > startAt && leg.logIndex < crossedAt, `Cross ${i + 1}: its leg within its own events`);
    const pulls = Object.fromEntries([...r.pulls].map(([a, v]) => [a.toLowerCase(), v]));
    assert.deepEqual(pulls, sumBy(within(o.held), (h: { pulled: bigint }) => h.pulled), `Cross ${i + 1}: its own pulls`);
  }
  assert.notDeepEqual(records[0]?.crossed, records[1]?.crossed, 'each its own');
  assert.equal(readCrossReceipt(set, receipt as Receipt, `0x${'ab'.repeat(32)}`).crossed, null, 'a bet the receipt does not cross has no record there');
});

test("a receipt the state at the final block contradicts: the receipt whole and well formed, and the bet's filled amount at the final block short of the receipt's; no outcome is written, the courier stops sending, and an incident holds the reads it judged; started again, the Cross is confirmed from the chain", async () => {
  const market = ownMarket();
  const M = await fresh();
  await quoteOn(M, market);
  const B = await fresh();
  await hooks().arm('after-hand-off', 1);
  const bet = await betOn(B, market);
  const handed = await hooks().reached('after-hand-off');
  // Every multicall that reads the bet's filled amount answers it as nothing, from the hand-off on.
  let contradicted = 0;
  const selector = encodeFunctionData({ abi: rig.abis.OspexMatching as Abi, functionName: 's_filledRisk', args: [bet.hash] }).toLowerCase();
  stack.proxy.rule('eth_call', {
    kind: 'rewriteResult',
    result: (p, result) => {
      const data = String((p[0] as { data?: string }).data ?? '').toLowerCase();
      if (!data.includes(selector.slice(2)) || typeof result !== 'string') return result;
      try {
        const calls = (decodeFunctionData({ abi: MULTICALL_ABI, data: data as Hex }).args[0] ?? []) as ReadonlyArray<{ target: string; callData: Hex }>;
        const at = calls.findIndex((c) => c.callData.toLowerCase() === selector);
        if (at < 0) return result;
        const answers = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result as Hex }) as ReadonlyArray<{ success: boolean; returnData: Hex }>;
        const zero = `0x${'0'.repeat(64)}` as Hex;
        contradicted++;
        return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', result: answers.map((a, i) => (i === at ? { success: a.success, returnData: zero } : a)) } as never);
      } catch {
        return result;
      }
    },
  });
  try {
    await hooks().go(handed);
    const opened = await until(
      async () => (await pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'incident' AND reason = 'CHAIN_CONTRADICTS_RECORDS' AND bet_hash = $1 ORDER BY number`, [bet.hash.toLowerCase()])).rows,
      (rows) => rows.length > 0,
      90_000,
      'the incident',
    );
    assert.match(JSON.stringify(opened[0]?.facts), /filled amount/);
    assert.ok(contradicted > 0, 'the read at the final block was the one answered');
    const r = await row(bet.hash);
    assert.ok(!FINAL.includes(String(r?.state)), `no outcome written: ${JSON.stringify(r)}`);
    // The courier sends nothing more: a new bet is refused at the door, and nothing was handed off for it.
    const T = await rig.time();
    const late: Order = { ...orderOn(rig, await fresh(), { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
    const refused = await postOrder(url(), rig, rig.account(nextAccount - 1), 'take', late);
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'NOT_TAKING_BETS');
  } finally {
    stack.proxy.rule('eth_call', null);
  }
  await stack.restartCourier({ hooked: true });
  const r = await final(bet.hash);
  assert.equal(r?.state, 'confirmed', JSON.stringify(r));
});
