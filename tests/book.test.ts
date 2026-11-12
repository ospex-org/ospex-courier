import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import { cancelOnChain, crossFromTheTest, hashesOf, liftCap, orderOn, postOrder, raiseFloor, sign, type Order } from './support/orders';
import type { Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';

// The book, read from a user's side: real quotes posted through the door, a
// real Postgres, the local chain; pages, the fill-priority order, what is
// listed and what is not, the expiry boundary from both sides, and a backlog
// of expired quotes under the bound, with the final block held behind it and
// let past it.

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;
let extra1: HDAccount;
let extra2: HDAccount;

before(async () => {
  stack = await startStack('book');
  rig = stack.rig;
  pool = openPool(stack.databaseUrl, null);
  extra1 = rig.account(11);
  extra2 = rig.account(12);
  await rig.fund(extra1);
  await rig.fund(extra2);
  // Bets larger than one cent are needed to fill parts of quotes below.
  await liftCap(rig);
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

const url = () => stack.courier.url;

/**
 * Names the final block as the latest one, through the proxy. anvil's own
 * answer for the finalized tag is the block 64 behind the head, which on this
 * rig would hold the final block behind every expiry a test sets; on the live
 * chain the final block trails the head by seconds. A test that wants the final
 * block behind an expiry names an older block itself. The block is read whole,
 * not by the client's getBlockNumber, which is cached for the polling interval
 * and on a fast machine can answer with the block before the one just mined.
 */
async function finalIsLatest(): Promise<void> {
  stack.proxy.setFinal((await rig.publicClient.getBlock()).number);
}

interface Page {
  side: 'A' | 'B';
  quotes: Array<{ orderHash: Hex; account: Address; oddsTick: number; recordNumber: number; perLot: { bettor: number; maker: number }; bettorPrice: string; remaining: string; payable: string; expiry: string }>;
  scanned: number;
  marked: number;
  live: number;
  endedOnChain: number;
  endedBy: 'book' | 'bound' | null;
  next: { oddsTick: number; recordNumber: number } | null;
  limit: number;
}

interface MarketBody {
  block: { number: string; hash: Hex; time: string };
  final: { number: string; hash: Hex; time: string };
  sides: Partial<Record<'A' | 'B', Page>>;
  accounts: Record<string, { balance: string; allowance: string; registered: boolean }>;
  bound: number;
}

async function market(courier: string, scorer: Address, lineTicks: number, more = ''): Promise<MarketBody> {
  const { status, body } = await get(courier, `/v1/book?gameId=${rig.gameId}&scorer=${scorer}&lineTicks=${lineTicks}${more}`);
  assert.equal(status, 200, JSON.stringify(body));
  return body as unknown as MarketBody;
}

test('one market\'s quotes are listed lowest tick first, then record number, whatever the account; the same with the accounts swapped; the same after a restart; each quote with its two stakes per lot and the bettor\'s price rounded down', async () => {
  const T = await rig.time();
  const maker = rig.accounts.maker;
  const place = async (who: HDAccount, oddsTick: number, positionType: 0 | 1 = 0) => {
    const answer = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, oddsTick, positionType }));
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    return { hash: answer.body.orderHash as Hex, record: answer.body.recordNumber as number };
  };
  // Side A: five quotes, two at the same price, posted in an order that is not the book's.
  const q1 = await place(maker, 200);
  const q2 = await place(extra1, 200);
  const q3 = await place(maker, 150);
  const q4 = await place(extra2, 300);
  const q5 = await place(maker, 150);
  // Side B: the same shape with the accounts swapped.
  const r1 = await place(extra1, 200, 1);
  const r2 = await place(maker, 200, 1);
  const r3 = await place(extra1, 150, 1);
  const r4 = await place(maker, 300, 1);
  const r5 = await place(extra1, 150, 1);

  // One more at the best price, recorded last but stamped as received an hour ago: the number decides, not the time.
  const stale: Hex = `0x${'5a'.repeat(32)}`;
  const q6 = { hash: stale, record: 0 };
  {
    const { rows } = await pool.query<{ record_number: string }>(
      `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time, received_at)
       SELECT $1, 'rest', $2, $3, $4, 0, 0, 150, 1000000, 0, $5, 0, '0x' || repeat('ab', 65), market_key, 0, 1, '0x' || repeat('cd', 32), 1, now() - interval '1 hour'
       FROM orders WHERE hash = $6 RETURNING record_number::text`,
      [stale, maker.address.toLowerCase(), rig.gameId.toString(), rig.addresses.moneyline.toLowerCase(), (T + 3_600n).toString(), q1.hash.toLowerCase()],
    );
    q6.record = Number(rows[0]?.record_number);
    assert.ok(q6.record > q5.record);
  }
  const expectA = [q3, q5, q6, q1, q2, q4].map((q) => q.hash);
  const expectB = [r3, r5, r1, r2, r4].map((q) => q.hash);
  const first = await market(url(), rig.addresses.moneyline, 0);
  assert.deepEqual(hashesOf(first.sides.A), expectA);
  assert.deepEqual(hashesOf(first.sides.B), expectB);
  assert.ok(q3.record < q5.record, 'the earlier record comes first at one price');

  const top = first.sides.A?.quotes[0];
  assert.deepEqual(top?.perLot, { bettor: 50, maker: 100 });
  assert.equal(top?.bettorPrice, '3.00');
  assert.equal(first.sides.A?.quotes[3]?.bettorPrice, '2.00');
  assert.equal(first.sides.A?.quotes[5]?.bettorPrice, '1.50');
  assert.equal(top?.remaining, '1000000');
  assert.equal(top?.payable, '1000000', 'the purse covers it');
  assert.equal(first.sides.A?.live, 6);
  assert.equal(first.sides.A?.endedBy, 'book');
  assert.equal(first.sides.A?.next, null);
  const latest = await rig.publicClient.getBlock();
  assert.equal(first.block.hash, latest.hash);
  assert.ok(first.accounts[maker.address.toLowerCase()]?.registered);

  // The same after a restart: the record numbers are rows, not memory.
  const second = await startCourier(stack.env);
  try {
    const again = await market(second.url, rig.addresses.moneyline, 0);
    assert.deepEqual(hashesOf(again.sides.A), expectA);
    assert.deepEqual(hashesOf(again.sides.B), expectB);
  } finally {
    await second.stop();
  }

  // The markets of the game: this one, with its counts.
  const game = await get(url(), `/v1/book?gameId=${rig.gameId}`);
  const markets = game.body.markets as Array<{ scorer: Address; lineTicks: number; live: { A: { live: number; boundReached: boolean }; B: { live: number } } }>;
  const ml = markets.find((m) => m.scorer.toLowerCase() === rig.addresses.moneyline.toLowerCase() && m.lineTicks === 0);
  assert.deepEqual({ a: ml?.live.A.live, b: ml?.live.B.live, bound: ml?.live.A.boundReached }, { a: 6, b: 5, bound: false });
});

test('a page is 50 a side at most, from the cursor; a page short of its limit says whether the book or the bound ended it', async () => {
  const T = await rig.time();
  const spread = { scorer: rig.addresses.spread, lineTicks: -75 };
  const accounts = [rig.accounts.maker, extra1, extra2, rig.accounts.taker];
  const placed: Hex[] = [];
  // Sixty quotes on side A, sixteen an account at most, at rising ticks so the order is plain.
  for (let i = 0; i < 60; i++) {
    const who = accounts[Math.floor(i / 16)] as HDAccount;
    const answer = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, oddsTick: 150 + i, ...spread }));
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    placed.push(answer.body.orderHash as Hex);
  }
  const page1 = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.equal(page1.quotes.length, 50);
  assert.deepEqual(hashesOf(page1), placed.slice(0, 50));
  assert.equal(page1.endedBy, null, 'more live rows than the page');
  assert.ok(page1.next !== null);
  assert.equal(page1.scanned, 60);
  const page2 = (await market(url(), spread.scorer, spread.lineTicks, `&side=A&after=${page1.next?.oddsTick}:${page1.next?.recordNumber}`)).sides.A as Page;
  assert.deepEqual(hashesOf(page2), placed.slice(50));
  assert.equal(page2.endedBy, 'book');
  assert.equal(page2.next, null);
  const small = (await market(url(), spread.scorer, spread.lineTicks, '&side=A&limit=5')).sides.A as Page;
  assert.equal(small.quotes.length, 5);
  assert.equal(small.limit, 5);
  assert.deepEqual(hashesOf(small), placed.slice(0, 5));
  for (const bad of ['&limit=0', '&limit=51', '&side=C', '&after=1:2', '&side=A&after=abc']) {
    assert.equal((await get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${spread.scorer}&lineTicks=${spread.lineTicks}${bad}`)).body.code, 'INVALID_PARAM', bad);
  }
  assert.equal((await get(url(), `/v1/book?gameId=${rig.gameId}&side=A`)).body.code, 'INVALID_PARAM');
});

test('the expiry boundary, from both sides: a quote with expiry E is listed at E − 2 and fills when mined at E − 1; at E − 1 it is not listed, and the same Cross mined at E is refused by the contract as expired', async () => {
  const maker = rig.accounts.maker;
  const taker = rig.accounts.taker;
  const total = { scorer: rig.addresses.total, lineTicks: 2_155 };
  const T0 = await rig.time();
  const E = T0 + 100n;
  const quote1 = orderOn(rig, maker, { expiry: E, oddsTick: 200, riskAmount: 10_000n, ...total });
  const quote2 = orderOn(rig, maker, { expiry: E, oddsTick: 200, riskAmount: 10_000n, ...total });
  for (const q of [quote1, quote2]) assert.equal((await postOrder(url(), rig, maker, 'rest', q)).status, 201);

  // The latest block at E − 2, and final: both listed, and neither marked, since F + 1 is under E.
  await rig.setNextBlockTime(E - 2n);
  await rig.mine(1);
  await finalIsLatest();
  const atMinusTwo = await market(url(), total.scorer, total.lineTicks, '&side=A');
  assert.equal(atMinusTwo.block.time, (E - 2n).toString());
  assert.equal(atMinusTwo.sides.A?.quotes.length, 2);

  // The Cross on quote1, mined at E − 1: it fills.
  const bet1: Order = { ...orderOn(rig, taker, { expiry: E + 20n, oddsTick: 200, riskAmount: 10_000n, ...total }), positionType: 1 };
  await rig.setNextBlockTime(E - 1n);
  const sent1 = await crossFromTheTest(rig, { order: bet1, signature: await sign(taker, bet1, 31337, rig.addresses.matching) }, [{ order: quote1, signature: await sign(maker, quote1, 31337, rig.addresses.matching) }]);
  assert.equal(sent1.filled, true, JSON.stringify(sent1));
  assert.equal(await rig.time(), E - 1n);
  const filled = await rig.read<bigint>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_filledRisk', [await rig.read<Hex>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 'getOrderHash', [quote1])]);
  assert.equal(filled, 10_000n, 'the quote filled whole on chain');

  // The latest block at E − 1, and final: quote2 is not listed, and this read marks it, since F + 1 is E.
  await finalIsLatest();
  const atMinusOne = await market(url(), total.scorer, total.lineTicks, '&side=A');
  assert.equal(atMinusOne.block.time, (E - 1n).toString());
  assert.deepEqual(hashesOf(atMinusOne.sides.A), []);
  assert.equal(atMinusOne.sides.A?.live, 0);
  const { rows } = await pool.query<{ ended: string | null }>('SELECT ended FROM orders WHERE hash = $1', [(await rig.read<Hex>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 'getOrderHash', [quote2])).toLowerCase()]);
  assert.equal(rows[0]?.ended, 'expired');

  // The same Cross on quote2, mined at E: the contract refuses it, the quote expired.
  const bet2: Order = { ...orderOn(rig, taker, { expiry: E + 20n, oddsTick: 200, riskAmount: 10_000n, ...total }), positionType: 1 };
  await rig.setNextBlockTime(E);
  const sent2 = await crossFromTheTest(rig, { order: bet2, signature: await sign(taker, bet2, 31337, rig.addresses.matching) }, [{ order: quote2, signature: await sign(maker, quote2, 31337, rig.addresses.matching) }]);
  assert.equal(sent2.filled, false);

  // And the bet's own 30 seconds, from the contract's side: one with 31 left is refused by name.
  const T = await rig.time();
  const quote3 = orderOn(rig, maker, { expiry: T + 600n, oddsTick: 200, riskAmount: 10_000n, ...total });
  const bet3: Order = { ...orderOn(rig, taker, { expiry: T + 32n, oddsTick: 200, riskAmount: 10_000n, ...total }), positionType: 1 };
  await rig.setNextBlockTime(T + 1n);
  const sent3 = await crossFromTheTest(rig, { order: bet3, signature: await sign(taker, bet3, 31337, rig.addresses.matching) }, [{ order: quote3, signature: await sign(maker, quote3, 31337, rig.addresses.matching) }]);
  assert.equal(sent3.filled, false);
  assert.match(sent3.reason, /TooLong|reverted/i);
});

test('remaining is the stake less what the chain shows filled; payable is what the balance and the allowance cover; a quote with nothing payable is still listed; a cancelled quote, one under a floor and one whose account dropped the relay are not', async () => {
  const maker = rig.accounts.maker;
  const taker = rig.accounts.taker;
  const spread = { scorer: rig.addresses.spread, lineTicks: 135 };
  const T = await rig.time();
  const quote = orderOn(rig, extra1, { expiry: T + 3_600n, oddsTick: 200, riskAmount: 1_000_000n, ...spread });
  assert.equal((await postOrder(url(), rig, extra1, 'rest', quote)).status, 201);
  // A Cross by the test fills 400,000 of it.
  const bet: Order = { ...orderOn(rig, taker, { expiry: T + 20n, oddsTick: 200, riskAmount: 400_000n, ...spread }), positionType: 1 };
  const sent = await crossFromTheTest(rig, { order: bet, signature: await sign(taker, bet, 31337, rig.addresses.matching) }, [{ order: quote, signature: await sign(extra1, quote, 31337, rig.addresses.matching) }]);
  assert.equal(sent.filled, true, JSON.stringify(sent));
  let page = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.equal(page.quotes[0]?.remaining, '600000');
  assert.equal(page.quotes[0]?.payable, '600000');

  // The allowance shrinks: payable follows, remaining does not.
  const coin = rig.abis.TestCoin as Abi;
  await rig.write(extra1, rig.addresses.coin, coin, 'approve', [rig.addresses.positions, 500n]);
  page = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.equal(page.quotes[0]?.remaining, '600000');
  assert.equal(page.quotes[0]?.payable, '500');
  await rig.write(extra1, rig.addresses.coin, coin, 'approve', [rig.addresses.positions, 0n]);
  const body = await market(url(), spread.scorer, spread.lineTicks, '&side=A');
  page = body.sides.A as Page;
  assert.equal(page.quotes[0]?.payable, '0', 'nothing payable, still listed');
  assert.equal(page.quotes.length, 1);
  assert.equal(body.accounts[extra1.address.toLowerCase()]?.allowance, '0');
  await rig.write(extra1, rig.addresses.coin, coin, 'approve', [rig.addresses.positions, 2n ** 256n - 1n]);

  // Three more quotes; each ended on chain in its own way is not listed, and is counted as ended on chain.
  const cancelled = orderOn(rig, maker, { expiry: T + 3_600n, oddsTick: 190, ...spread });
  const floored = orderOn(rig, extra2, { expiry: T + 3_600n, oddsTick: 190, ...spread });
  const dropped = orderOn(rig, taker, { expiry: T + 3_600n, oddsTick: 190, ...spread });
  for (const [who, q] of [[maker, cancelled], [extra2, floored], [taker, dropped]] as Array<[HDAccount, Order]>) assert.equal((await postOrder(url(), rig, who, 'rest', q)).status, 201);
  page = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.equal(page.quotes.length, 4);
  await cancelOnChain(rig, maker, cancelled);
  await raiseFloor(rig, extra2, floored, floored.nonce + 1n);
  await rig.write(taker, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'unregisterCourier', [rig.addresses.relay]);
  try {
    const after = await market(url(), spread.scorer, spread.lineTicks, '&side=A');
    page = after.sides.A as Page;
    assert.deepEqual(hashesOf(page), [(await rig.read<Hex>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 'getOrderHash', [quote])).toLowerCase()]);
    assert.equal(page.endedOnChain, 3);
    assert.equal(page.live, 4, 'the courier itself knows nothing of the three: they are read at the block, never stored');
    assert.equal(after.accounts[taker.address.toLowerCase()]?.registered, false);
  } finally {
    await rig.write(taker, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'registerCourier', [rig.addresses.relay]);
  }
  page = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.equal(page.quotes.length, 2, 'registered again, the dropped account\'s quote is listed again');
});

/** Plants quotes straight into the records: a backlog the door never saw, as the fixture of the cost contract plants them. */
async function plant(n: number, fields: { marketKey: Hex; gameId: bigint; scorer: Address; lineTicks: number; oddsTick: number; expiry: bigint; account: Address }): Promise<void> {
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT '0x' || lpad(to_hex(i), 64, '0'), 'rest', $1, $2, $3, $4, 0, $5, 1000000, i, $6, 0, '0x' || repeat('ab', 65), $7, 0, 1, '0x' || repeat('cd', 32), 1
     FROM generate_series($8::bigint, $9::bigint) AS i`,
    [fields.account.toLowerCase(), fields.gameId.toString(), fields.scorer.toLowerCase(), fields.lineTicks, fields.oddsTick, fields.expiry.toString(), fields.marketKey.toLowerCase(), planted + 1, planted + n],
  );
  planted += n;
}
let planted = 1_000_000;

test('a backlog of 2,500 expired quotes not yet marked, at better prices than one live quote: the first read is returned the bound and marks them, answering with the bound and not an empty book; the second finds the live one. With the final block held behind their expiries nothing is marked and every read is answered with the bound; let past, the marking resumes', async () => {
  const maker = rig.accounts.maker;
  const spread = { scorer: rig.addresses.spread, lineTicks: -175 };
  const T = await rig.time();
  const live = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 3_600n, oddsTick: 200, ...spread }));
  assert.equal(live.status, 201, JSON.stringify(live.body));
  const marketKey = live.body.marketKey as Hex;
  // Expired at the latest block and at the final block: the latest block's time less ten, the final block the latest.
  await plant(2_500, { marketKey, gameId: rig.gameId, oddsTick: 150, expiry: T - 10n, account: maker.address, ...spread });
  await finalIsLatest();
  const first = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.deepEqual({ scanned: first.scanned, marked: first.marked, live: first.live, quotes: first.quotes.length, endedBy: first.endedBy }, { scanned: 2_000, marked: 2_000, live: 0, quotes: 0, endedBy: 'bound' });
  assert.ok(first.next !== null, 'where the next page starts');
  const second = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.deepEqual({ scanned: second.scanned, marked: second.marked, live: second.live, endedBy: second.endedBy }, { scanned: 501, marked: 500, live: 1, endedBy: 'book' });
  assert.deepEqual(hashesOf(second), [live.body.orderHash]);
  const marked = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE market_key = $1 AND ended = 'expired'`, [marketKey.toLowerCase()]);
  assert.equal(marked.rows[0]?.n, 2_500);

  // The final block held behind the expiries: a block before them, named through the proxy.
  const fBlock = await rig.publicClient.getBlock();
  await rig.increaseTime(100n);
  const T2 = await rig.time();
  await plant(2_500, { marketKey, gameId: rig.gameId, oddsTick: 150, expiry: fBlock.timestamp + 50n, account: maker.address, ...spread });
  stack.proxy.setFinal(fBlock.number);
  try {
    const held1 = await market(url(), spread.scorer, spread.lineTicks, '&side=A');
    assert.equal(held1.final.number, fBlock.number.toString());
    assert.equal(held1.block.time, T2.toString());
    const h1 = held1.sides.A as Page;
    assert.deepEqual({ scanned: h1.scanned, marked: h1.marked, live: h1.live, endedBy: h1.endedBy }, { scanned: 2_000, marked: 0, live: 0, endedBy: 'bound' });
    const held2 = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
    assert.deepEqual({ scanned: held2.scanned, marked: held2.marked, endedBy: held2.endedBy, next: held2.next }, { scanned: 2_000, marked: 0, endedBy: 'bound', next: h1.next }, 'the same rows again, the bound named, never an empty book');
  } finally {
    await finalIsLatest();
  }
  // The final block past them: the marking resumes.
  const resumed = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.deepEqual({ scanned: resumed.scanned, marked: resumed.marked, endedBy: resumed.endedBy }, { scanned: 2_000, marked: 2_000, endedBy: 'bound' });
  const found = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.deepEqual({ scanned: found.scanned, marked: found.marked, live: found.live, endedBy: found.endedBy }, { scanned: 501, marked: 500, live: 1, endedBy: 'book' });
  assert.deepEqual(hashesOf(found), [live.body.orderHash]);

  // The markets of the game say the bound ended a side's count while a backlog stands.
  await plant(2_100, { marketKey, gameId: rig.gameId, oddsTick: 150, expiry: T - 10n, account: maker.address, ...spread });
  const game = await get(url(), `/v1/book?gameId=${rig.gameId}`);
  const m = (game.body.markets as Array<{ marketKey: Hex; live: { A: { live: number; boundReached: boolean; marked: number } } }>).find((x) => x.marketKey === marketKey.toLowerCase());
  assert.deepEqual(m?.live.A, { live: 0, boundReached: true, marked: 2_000 });
});
