import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { decodeEventLog, type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { openPool } from '../courier/records/store';
import { get as getFrom, type HookControl } from './support/courier';
import { orderOn, postOrder as postOrderFrom, sign, type Order, type Signed } from './support/orders';
import type { Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';

// The walk and the netted pull against the contract itself: within the
// equality domain, the courier records a leg, a pull or a pay-back as the
// contract does them in the next block from the same state, and lists no less
// than the contract would fill there from the same candidates.
//
// The domain: the reference and the courier's own calldata each run from the
// rig's snapshot at the check's block H, nothing sent between, in one block
// whose time is pinned to T + 1; no signed time and no close at T + 1, and the
// bet's expiry within T + 30; the courier's own bounds and no self-match; and
// an override, so the comparison runs. The independent reference is every
// candidate the case posted that meets the bet's price, in the published
// order, frozen by the test, not drawn from the courier's choice: it runs
// whether the courier found the bet ready or refused it, so an omission is
// caught either way.
//
// The set's size and its seed are settings: DIFFERENTIAL_CASES (200 unless
// set) and DIFFERENTIAL_SEED. Its run time is printed.

const CASES = Number(process.env.DIFFERENTIAL_CASES ?? '200');
const SEED = Number(process.env.DIFFERENTIAL_SEED ?? '20261123');

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;
const url = () => stack.courier.url;

/**
 * Every test, and every case of the set, sends from a network address of its own, as the courier's other tests do, so the courier's count of an
 * address's minute, 600 requests, limits none: the last value of X-Forwarded-For, an address of 198.20.0.0/16 new for
 * each. The requests below go out from it unless a case names another address.
 */
let from: Record<string, string> = {};
let nextAddress = 0;
const ownAddress = (): Record<string, string> => {
  const n = nextAddress++;
  return { 'x-forwarded-for': `198.20.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
};
beforeEach(() => {
  from = ownAddress();
});
const get = (...a: Parameters<typeof getFrom>) => getFrom(a[0], a[1], a[2] ?? from);
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

before(async () => {
  stack = await startStack('differential', { hooked: true });
  rig = stack.rig;
  pool = openPool(stack.databaseUrl, null);
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

/** A small, fixed-seed generator: the same seed, the same cases, every run. */
function generator(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T,
  };
}

let nextAccount = 100;
async function freshAccount(on: Rig = rig): Promise<HDAccount> {
  const who = on.account(nextAccount++);
  await on.fund(who);
  return who;
}

let nextLine = 1;

/** The bet's record once its check has written an outcome. */
async function judged(hash: string, on = url()): Promise<Record<string, unknown>> {
  // Read every tenth of a second, at most 300 times: well under the address's 600 a minute.
  for (let i = 0; i < 300; i++) {
    const r = await get(on, `/v1/orders/${hash}`);
    if (r.body.state !== 'queued') return r.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the bet ${hash} was still queued after 30 seconds`);
}

/** What one Cross did, from its receipt's module events, each counted once and no hub copy: the legs, and each account's pulls, pay-backs and refused pay-backs. */
interface Done {
  filled: boolean;
  legs: Array<{ orderHash: string; makerRisk: bigint; takerRisk: bigint }>;
  pulled: Map<string, bigint>;
  paidBack: Map<string, bigint>;
  refused: Map<string, bigint>;
  revert?: string;
}

/** One Cross, sent by the test from the relay's sender into a block whose time is `time`, on the chain as it stands. */
async function crossAt(on: Rig, time: bigint, taking: Signed, resting: Signed[]): Promise<Done> {
  await on.setNextBlockTime(time);
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  const done: Done = { filled: false, legs: [], pulled: new Map(), paidBack: new Map(), refused: new Map() };
  let hash: Hex;
  try {
    hash = await on.write(on.accounts.sender, on.addresses.relay, on.abis.OspexCourierRelay as Abi, 'cross', [taking, resting]);
  } catch (err) {
    // A refused Cross mines nothing: the block's time is set again for whatever is sent next.
    done.revert = err instanceof Error ? err.message.slice(0, 200) : String(err);
    return done;
  }
  done.filled = true;
  const receipt = (await on.rpc('eth_getTransactionReceipt', [hash])) as { logs: Array<{ address: string; topics: Hex[]; data: Hex }> };
  for (const log of receipt.logs) {
    const from = log.address.toLowerCase();
    if (from === on.addresses.matching.toLowerCase()) {
      try {
        const e = decodeEventLog({ abi: on.abis.OspexMatching as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
        if (e.eventName === 'OrderMatched') done.legs.push({ orderHash: (e.args.orderHash as string).toLowerCase(), makerRisk: e.args.makerRisk as bigint, takerRisk: e.args.takerRisk as bigint });
      } catch {
        // another event of the module's
      }
    } else if (from === on.addresses.positions.toLowerCase()) {
      try {
        const e = decodeEventLog({ abi: on.abis.OspexPositions as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
        const account = (e.args.account as string | undefined)?.toLowerCase();
        if (e.eventName === 'HeldChanged' && account !== undefined) {
          add(done.pulled, account, e.args.pulled as bigint);
          add(done.paidBack, account, e.args.paidBack as bigint);
        } else if (e.eventName === 'PayBackRefused' && account !== undefined) add(done.refused, account, e.args.amount as bigint);
      } catch {
        // another event of the module's
      }
    }
  }
  return done;
}

const nonzero = (m: Map<string, bigint> | Record<string, string>) =>
  Object.fromEntries(
    (m instanceof Map ? [...m.entries()] : Object.entries(m).map(([k, v]) => [k.toLowerCase(), BigInt(v)] as const))
      .filter(([, v]) => v !== 0n)
      .map(([k, v]) => [k.toLowerCase(), v.toString()])
      .sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
  );

/** One case's quotes, the bet, and what the courier found; then the reference and the courier's own calldata, each from a snapshot at H into a block at T + 1, held to each other. */
async function runCase(on: { rig: Rig; url: string; hooks: HookControl }, quotes: Array<{ who: HDAccount; order: Order }>, bettor: HDAccount, bet: Order): Promise<{ record: Record<string, unknown>; reference: Done; own: Done | null }> {
  const r = on.rig;
  const posted: Array<{ hash: string; signed: Signed; recordNumber: number }> = [];
  for (const q of quotes) {
    const p = await postOrder(on.url, r, q.who, 'rest', q.order);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    posted.push({ hash: (p.body.orderHash as string).toLowerCase(), signed: { order: q.order, signature: p.signature }, recordNumber: Number(p.body.recordNumber) });
  }
  // The reference's candidates, frozen by the test: every quote of the case, in the published order (tick, then record).
  const frozen = [...posted].sort((a, b) => a.signed.order.oddsTick - b.signed.order.oddsTick || a.recordNumber - b.recordNumber);
  const betSigned: Signed = { order: bet, signature: await sign(bettor, bet, 31337, r.addresses.matching) };
  const b = await postOrder(on.url, r, bettor, 'take', bet);
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const record = await judged(b.body.orderHash as string, on.url);
  const H = (record.state === 'not sent' ? (record.cross as { block: { time: string } }).block : (record.verdict as { block: { time: string } | null }).block) ?? null;
  const T = H === null ? await r.time() : BigInt(H.time);
  // From one snapshot at H, nothing sent between: the reference, then back, then the courier's own calldata.
  const snapshot = (await r.rpc('evm_snapshot', [])) as Hex;
  const reference = await crossAt(r, T + 1n, betSigned, frozen.map((f) => f.signed));
  await r.rpc('evm_revert', [snapshot]);
  let own: Done | null = null;
  if (record.state === 'not sent') {
    const again = (await r.rpc('evm_snapshot', [])) as Hex;
    const legs = (record.cross as { legs: Array<{ orderHash: string }> }).legs.map((l) => posted.find((p) => p.hash === l.orderHash.toLowerCase())?.signed as Signed);
    own = await crossAt(r, T + 1n, betSigned, legs);
    await r.rpc('evm_revert', [again]);
  }
  return { record, reference, own };
}

/** The assertion: ready if and only if the reference fills and meets the bet's minimum; then the same legs, pulls, pay-backs and refused pay-backs as the reference, and as the courier's own calldata. */
function holdsTo(label: string, record: Record<string, unknown>, reference: Done, own: Done | null): void {
  const ready = record.state === 'not sent';
  assert.equal(ready, reference.filled, `${label}: the courier ${ready ? 'found it ready' : `refused it ${JSON.stringify(record.verdict)}`}, the reference ${reference.filled ? 'filled' : `was refused (${reference.revert})`}`);
  if (!ready) return;
  const cross = record.cross as { legs: Array<{ orderHash: string; makerRisk: string; takerRisk: string }>; pulls: Record<string, string>; paysBack: Record<string, string>; paysBackRefused: Record<string, string> };
  const legs = cross.legs.map((l) => ({ orderHash: l.orderHash.toLowerCase(), makerRisk: BigInt(l.makerRisk), takerRisk: BigInt(l.takerRisk) }));
  assert.deepEqual(legs, reference.legs, `${label}: the legs`);
  assert.deepEqual(nonzero(cross.pulls), nonzero(reference.pulled), `${label}: the pulls`);
  const paid = Object.fromEntries(Object.entries(cross.paysBack).filter(([k]) => !(k in cross.paysBackRefused)));
  assert.deepEqual(nonzero(paid), nonzero(reference.paidBack), `${label}: the pay-backs`);
  assert.deepEqual(nonzero(cross.paysBackRefused), nonzero(reference.refused), `${label}: the refused pay-backs`);
  assert.ok(own !== null && own.filled, `${label}: the courier's own calldata fills`);
  assert.deepEqual(own.legs, reference.legs, `${label}: the courier's own calldata, its legs`);
  assert.deepEqual(nonzero(own.pulled), nonzero(reference.pulled), `${label}: the courier's own calldata, its pulls`);
  assert.deepEqual(nonzero(own.paidBack), nonzero(reference.paidBack), `${label}: the courier's own calldata, its pay-backs`);
}

/** A stake that takes `lots` lots at `perLot` each, in whole lots of 100 as every order's stake is: the quote's room bounds the fill to `lots`. */
const stakeFor = (lots: bigint, perLot: bigint): bigint => ((lots * perLot + 99n) / 100n) * 100n;

/** The contract's TAKING_STAKE_CAP: a taking order's signed stake is at most this until the cap is lifted, as it is not here. */
const TAKING_STAKE_CAP = 10_000n;

/**
 * The lots an earlier position takes: those drawn, at least the fewest whose taking side is a lot's worth of units
 * (100), since the contract fills no fewer, and at most the most whose taking stake is under the cap. The earlier
 * positions are set-up, and must fill.
 */
const fitting = (lots: bigint, perLot: bigint): bigint => {
  const fewest = (100n + perLot - 1n) / perLot;
  const most = TAKING_STAKE_CAP / perLot;
  return lots < fewest ? fewest : lots > most ? most : lots;
};

/** An account that holds side B of the market: it took B earlier against a quote of X, `lots` lots, by a Cross the test sends. */
async function takesSideB(on: Rig, who: HDAccount, market: { scorer: Address; lineTicks: number }, drawn: bigint, tick: number): Promise<void> {
  const X = await freshAccount(on);
  const T = await on.time();
  const p = BigInt(tick - 100);
  const lots = fitting(drawn, p);
  const x: Order = { ...orderOn(on, X, { expiry: T + 600n, oddsTick: tick, riskAmount: lots * 100n, ...market }), positionType: 0 };
  const m: Order = { ...orderOn(on, who, { expiry: T + 25n, oddsTick: 100 + Math.floor(10_000 / (tick - 100)), riskAmount: stakeFor(lots, p), ...market }), positionType: 1 };
  const sent = await crossAt(on, T + 1n, { order: m, signature: await sign(who, m, 31337, on.addresses.matching) }, [{ order: x, signature: await sign(X, x, 31337, on.addresses.matching) }]);
  assert.equal(sent.filled, true, sent.revert);
}

/** An account that holds side A: it rested there earlier, filled by a bet of Y, by a Cross the test sends. */
async function restsSideA(on: Rig, who: HDAccount, market: { scorer: Address; lineTicks: number }, drawn: bigint, tick: number): Promise<void> {
  const Y = await freshAccount(on);
  const T = await on.time();
  const lots = fitting(drawn, BigInt(tick - 100));
  const q: Order = { ...orderOn(on, who, { expiry: T + 600n, oddsTick: tick, riskAmount: lots * 100n, ...market }), positionType: 0 };
  const y: Order = { ...orderOn(on, Y, { expiry: T + 25n, oddsTick: 100 + Math.floor(10_000 / (tick - 100)), riskAmount: stakeFor(lots, BigInt(tick - 100)), ...market }), positionType: 1 };
  const sent = await crossAt(on, T + 1n, { order: y, signature: await sign(Y, y, 31337, on.addresses.matching) }, [{ order: q, signature: await sign(who, q, 31337, on.addresses.matching) }]);
  assert.equal(sent.filled, true, sent.revert);
}

const MAX = 2n ** 256n - 1n;

test(`the differential set: ${CASES} cases from the seed ${SEED}, each within the equality domain, the courier held to the contract's own next block: prices either side of 2.00, rooms, minimums in both roles, finite allowances and the largest, wallets that run short, one account behind several quotes, makers and a bettor that hold the other side`, async () => {
  const g = generator(SEED);
  const started = Date.now();
  const group = async () => [await freshAccount(), await freshAccount(), await freshAccount(), await freshAccount()];
  let makers = await group();
  const coin = rig.abis.TestCoin as Abi;
  let ready = 0;
  for (let c = 0; c < CASES; c++) {
    // An account's admitted requests are budgeted, 240 at once and then 12 a minute: four new makers every 40 cases
    // keep each under it, at five quotes a case at most. The generator's draws are the same whoever the makers are.
    if (c > 0 && c % 40 === 0) makers = await group();
    from = ownAddress();
    const market = { scorer: rig.addresses.spread, lineTicks: 1_000 + 5 * nextLine++ };
    const betTick = g.pick([120, 150, 180, 196, 200, 204, 250, 300, 400]);
    const highest = 100 + Math.floor(10_000 / (betTick - 100));
    const bettor = await freshAccount();
    // Earlier positions on this market: a maker and the bettor that hold the other side.
    const holding = g.chance(0.3) ? (g.pick(makers) as HDAccount) : null;
    if (holding !== null) await takesSideB(rig, holding, market, BigInt(g.int(1, 60)), g.pick([150, 220, 300]));
    if (g.chance(0.2)) await restsSideA(rig, bettor, market, BigInt(g.int(1, 40)), g.pick([150, 220]));
    // The quotes: one to five, from one to three makers, ticks that meet the bet's price.
    const quotes: Array<{ who: HDAccount; order: Order }> = [];
    const T = await rig.time();
    const n = g.int(1, 5);
    for (let i = 0; i < n; i++) {
      const who = g.pick(makers.slice(0, g.int(1, 3)));
      const lots = BigInt(g.pick([1, 2, 3, 10, 48, 96, 100, 250]));
      const stake = lots * 100n;
      const minFill = g.chance(0.3) ? BigInt(g.int(0, Number(stake))) : 0n;
      quotes.push({ who, order: { ...orderOn(rig, who, { expiry: T + 600n, oddsTick: g.int(101, Math.min(highest, 10_100)), riskAmount: stake, minFill, ...market }), positionType: 0 } });
    }
    // The wallets: the largest allowance, or a finite one; a balance that may run short.
    for (const who of new Set(quotes.map((q) => q.who))) {
      const allowance = g.chance(0.5) ? MAX : BigInt(g.int(0, 30_000));
      await rig.write(who, rig.addresses.coin, coin, 'approve', [rig.addresses.positions, allowance]);
    }
    const stake = BigInt(g.int(1, 100)) * 100n;
    const bet: Order = { ...orderOn(rig, bettor, { expiry: T + 25n, oddsTick: betTick, riskAmount: stake, minFill: g.chance(0.3) ? BigInt(g.int(0, Number(stake))) : 0n, ...market }), positionType: 1 };
    if (g.chance(0.15)) await rig.write(bettor, rig.addresses.coin, coin, 'approve', [rig.addresses.positions, BigInt(g.int(0, Number(stake)))]);
    const { record, reference, own } = await runCase({ rig, url: url(), hooks: stack.courier.hooks as HookControl }, quotes, bettor, bet);
    holdsTo(`case ${c}`, record, reference, own);
    if (record.state === 'not sent') ready++;
    // The wallets back to the largest allowance, for the cases that follow.
    for (const who of new Set(quotes.map((q) => q.who))) await rig.write(who, rig.addresses.coin, coin, 'approve', [rig.addresses.positions, MAX]);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`# the differential set: ${CASES} cases, seed ${SEED}, ${ready} ready, ${seconds} s`);
  assert.ok(ready > 0 && ready < CASES, `both outcomes are in the set: ${ready} ready of ${CASES}`);
});

test("a maker that holds the other side (risk 3,000, profit 2,500, held 3,000) quotes twice at tick 204 with 4,800 of room each, the bet 10,000 at tick 196. The contract pulls the maker nothing at the first leg and 4,100 at the second, and pays it nothing back; the bettor 9,984. With the maker's wallet and allowance each 4,100, and with the largest allowance, the courier records the same", async () => {
  for (const allowance of [4_100n, MAX]) {
    const market = { scorer: rig.addresses.spread, lineTicks: 1_000 + 5 * nextLine++ };
    const M = await freshAccount();
    await takesSideB(rig, M, market, 25n, 220);
    const coin = rig.abis.TestCoin as Abi;
    const balance = await rig.read<bigint>(rig.addresses.coin, coin, 'balanceOf', [M.address]);
    await rig.write(M, rig.addresses.coin, coin, 'transfer', [rig.accounts.stranger.address, balance - 4_100n]);
    await rig.write(M, rig.addresses.coin, coin, 'approve', [rig.addresses.positions, allowance]);
    const T = await rig.time();
    const quotes = [0, 1].map(() => ({ who: M, order: { ...orderOn(rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 4_800n, ...market }), positionType: 0 as const } }));
    const bettor = await freshAccount();
    const bet: Order = { ...orderOn(rig, bettor, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
    const { record, reference, own } = await runCase({ rig, url: url(), hooks: stack.courier.hooks as HookControl }, quotes, bettor, bet);
    holdsTo(`allowance ${allowance}`, record, reference, own);
    assert.deepEqual(nonzero(reference.pulled), { [M.address.toLowerCase()]: '4100', [bettor.address.toLowerCase()]: '9984' });
    assert.deepEqual(nonzero(reference.paidBack), {});
  }
});

test("a pay-back the coin refuses: the maker paid back nothing, the amount still held for it; the courier's record names the refused pay-back as the contract records it, and the Cross is ready", async () => {
  const falseStack = await startStack('differential_false', { coin: 'FalseCoin', hooked: true });
  try {
    const r = falseStack.rig;
    const M = await freshAccount(r);
    const market = { scorer: r.addresses.spread, lineTicks: -7 };
    await takesSideB(r, M, market, 25n, 220);
    await r.write(r.accounts.deployer, r.addresses.coin, r.abis.FalseCoin as Abi, 'setRefuseTo', [M.address, true]);
    const T = await r.time();
    const quotes = [{ who: M, order: { ...orderOn(r, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 4_800n, ...market }), positionType: 0 as const } }];
    const bettor = await freshAccount(r);
    // 48 lots at 104 each, 4,992, in whole lots of 100: the quote's room bounds the fill to its 48 lots.
    const bet: Order = { ...orderOn(r, bettor, { expiry: T + 25n, oddsTick: 196, riskAmount: 5_000n, ...market }), positionType: 1 };
    const { record, reference, own } = await runCase({ rig: r, url: falseStack.courier.url, hooks: falseStack.courier.hooks as HookControl }, quotes, bettor, bet);
    holdsTo('the refused pay-back', record, reference, own);
    assert.ok(reference.refused.get(M.address.toLowerCase()) !== undefined, 'the contract refused the pay-back');
    assert.deepEqual(Object.keys((record.cross as { paysBackRefused: Record<string, string> }).paysBackRefused).map((k) => k.toLowerCase()), [M.address.toLowerCase()]);
  } finally {
    await falseStack.close();
  }
});

test("a blocked maker with a survivor: the coin refuses the first maker's pull, which the model cannot see; the one-quote probe names it and the one re-walk lists the survivor alone, as the contract fills it; the blocked quote is named in the figures", async () => {
  const refusing = await startStack('differential_refusing', { coin: 'RefusingCoin', hooked: true });
  try {
    const r = refusing.rig;
    const [M1, M2] = [await freshAccount(r), await freshAccount(r)];
    const market = { scorer: r.addresses.spread, lineTicks: -9 };
    const T = await r.time();
    const quotes = [
      { who: M1, order: { ...orderOn(r, M1, { expiry: T + 600n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 as const } },
      { who: M2, order: { ...orderOn(r, M2, { expiry: T + 600n, oddsTick: 202, riskAmount: 100_000n, ...market }), positionType: 0 as const } },
    ];
    await r.write(r.accounts.deployer, r.addresses.coin, r.abis.RefusingCoin as Abi, 'setBlocked', [M1.address, true]);
    const bettor = await freshAccount(r);
    const bet: Order = { ...orderOn(r, bettor, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
    const { record, reference, own } = await runCase({ rig: r, url: refusing.courier.url, hooks: refusing.courier.hooks as HookControl }, quotes, bettor, bet);
    holdsTo('the blocked maker', record, reference, own);
    const rpool = openPool(refusing.databaseUrl, null);
    try {
      const { rows } = await rpool.query<{ checked: { leftOutAfterCoinRefusal: string[] } }>('SELECT checked FROM crosses WHERE bet_hash = $1', [String(record.orderHash).toLowerCase()]);
      assert.equal(rows[0]?.checked.leftOutAfterCoinRefusal.length, 1, 'the blocked quote is named');
    } finally {
      await rpool.end();
    }
  } finally {
    await refusing.close();
  }
});

test("the skew: one predicted pull changed after selection, funds ample and the simulation unchanged: with the comparison, COURIER_FAULT, an incident line, and no Cross row; the control, no skew, ready", async () => {
  const hooks = stack.courier.hooks as HookControl;
  const market = { scorer: rig.addresses.spread, lineTicks: 1_000 + 5 * nextLine++ };
  const M = await freshAccount();
  const T = await rig.time();
  const q: Order = { ...orderOn(rig, M, { expiry: T + 600n, oddsTick: 200, riskAmount: 100_000n, ...market }), positionType: 0 };
  const posted = await postOrder(url(), rig, M, 'rest', q);
  await hooks.fault({ skewPull: { [String(posted.body.orderHash)]: 1n } });
  try {
    const bettor = await freshAccount();
    const b = await postOrder(url(), rig, bettor, 'take', { ...orderOn(rig, bettor, { expiry: T + 25n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 });
    const record = await judged(b.body.orderHash as string);
    assert.equal((record.verdict as { code: string }).code, 'COURIER_FAULT', JSON.stringify(record));
    const incidents = await pool.query(`SELECT reason FROM events WHERE kind = 'incident' AND bet_hash = $1`, [String(b.body.orderHash).toLowerCase()]);
    assert.deepEqual(incidents.rows, [{ reason: 'MODEL_AND_CONTRACT_DIFFER' }]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [String(b.body.orderHash).toLowerCase()])).rows[0].n, 0);
  } finally {
    await hooks.fault({ skewPull: {} });
  }
  const bettor = await freshAccount();
  const b = await postOrder(url(), rig, bettor, 'take', { ...orderOn(rig, bettor, { expiry: (await rig.time()) + 25n, oddsTick: 200, riskAmount: 10_000n, ...market }), positionType: 1 });
  assert.equal((await judged(b.body.orderHash as string)).state, 'not sent', 'the control');
});

test("model or coin: a quote cancelled at H, listed as if live by a test's fault, with a survivor behind it and the comparison on: its leg is left unfilled, the one-quote probe names Cancelled and not PullRefused, so it is the courier's fault: COURIER_FAULT with an incident line", async () => {
  const hooks = stack.courier.hooks as HookControl;
  const market = { scorer: rig.addresses.spread, lineTicks: 1_000 + 5 * nextLine++ };
  const [M1, M2] = [await freshAccount(), await freshAccount()];
  const T = await rig.time();
  const q1: Order = { ...orderOn(rig, M1, { expiry: T + 600n, oddsTick: 200, riskAmount: 5_000n, ...market }), positionType: 0 };
  const q2: Order = { ...orderOn(rig, M2, { expiry: T + 600n, oddsTick: 202, riskAmount: 100_000n, ...market }), positionType: 0 };
  const p1 = await postOrder(url(), rig, M1, 'rest', q1);
  await postOrder(url(), rig, M2, 'rest', q2);
  await rig.write(M1, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'cancelOrder', [q1]);
  await hooks.fault({ listAsLive: [String(p1.body.orderHash)] });
  try {
    const bettor = await freshAccount();
    const b = await postOrder(url(), rig, bettor, 'take', { ...orderOn(rig, bettor, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 });
    const record = await judged(b.body.orderHash as string);
    assert.equal((record.verdict as { code: string }).code, 'COURIER_FAULT', JSON.stringify(record));
    const incidents = await pool.query(`SELECT reason, facts FROM events WHERE kind = 'incident' AND bet_hash = $1`, [String(b.body.orderHash).toLowerCase()]);
    assert.equal(incidents.rows.length, 1);
    assert.equal(incidents.rows[0].reason, 'MODEL_AND_CONTRACT_DIFFER');
  } finally {
    await hooks.fault({ listAsLive: [] });
  }
});
