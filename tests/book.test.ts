import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { encodeAbiParameters, getAddress, keccak256, type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { MARKETS_OF_GAME_SQL, marketsOfGameParams } from '../courier/records/orders';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import { cancelOnChain, contractHash, crossFromTheTest, hashesOf, liftCap, orderOn, postOrder, raiseFloor, sign, type Order } from './support/orders';
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
  markedCancelled: number;
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
    const head = await rig.publicClient.getBlock();
    const quoteHash = (await contractHash(rig, quote)).toLowerCase();
    const after = await market(url(), spread.scorer, spread.lineTicks, '&side=A');
    page = after.sides.A as Page;
    assert.deepEqual(hashesOf(page), [quoteHash]);
    assert.equal(page.endedOnChain, 3);
    assert.equal(page.live, 4, 'the four stood unmarked in the records when this request scanned them');
    assert.equal(page.markedCancelled, 2, "the cancelled quote and the floored one are marked by this request, the maker's own acts seen; the dropped account's is not");
    assert.equal(after.accounts[taker.address.toLowerCase()]?.registered, false);
    // The records: the two marked cancelled at the block this request read; the dropped account's quote unmarked.
    const hashes = await Promise.all([cancelled, floored, dropped].map((q) => contractHash(rig, q)));
    const { rows } = await pool.query<{ hash: string; ended: string | null; block: string | null; block_hash: string | null }>(
      `SELECT hash, ended, ended_block::text AS block, ended_block_hash AS block_hash FROM orders WHERE hash = ANY($1::text[])`,
      [hashes.map((h) => h.toLowerCase())],
    );
    const byHash = new Map(rows.map((r) => [r.hash, r]));
    for (const h of hashes.slice(0, 2)) assert.deepEqual(byHash.get(h.toLowerCase()), { hash: h.toLowerCase(), ended: 'cancelled', block: head.number.toString(), block_hash: head.hash.toLowerCase() });
    assert.deepEqual(byHash.get((hashes[2] as Hex).toLowerCase()), { hash: (hashes[2] as Hex).toLowerCase(), ended: null, block: null, block_hash: null }, 'the relay dropped is not an end of the quote');
    // Read again: the two marked are returned to no request; the dropped account's quote still is, and is still not listed.
    const again = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
    assert.deepEqual({ live: again.live, endedOnChain: again.endedOnChain, markedCancelled: again.markedCancelled, quotes: hashesOf(again) }, { live: 2, endedOnChain: 1, markedCancelled: 0, quotes: [quoteHash] });
  } finally {
    await rig.write(taker, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'registerCourier', [rig.addresses.relay]);
  }
  page = (await market(url(), spread.scorer, spread.lineTicks, '&side=A')).sides.A as Page;
  assert.equal(page.quotes.length, 2, 'registered again, the dropped account\'s quote is listed again, unmarked all along');
});

test("the list counts a quote its maker ended until a request asks the chain: posted and cancelled on chain, the list counts it; the market's page shows no quote and marks it at the block read; the list then counts none", async () => {
  const maker = rig.accounts.maker;
  const spread = { scorer: rig.addresses.spread, lineTicks: 255 };
  const T = await rig.time();
  const quote = orderOn(rig, maker, { expiry: T + 3_600n, oddsTick: 200, ...spread });
  const posted = await postOrder(url(), rig, maker, 'rest', quote);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  await cancelOnChain(rig, maker, quote);
  const find = (body: Record<string, unknown>) =>
    (body.markets as Array<{ scorer: Address; lineTicks: number; live: { A: { live: number; boundReached: boolean; marked: number } } }>).find(
      (m) => m.scorer.toLowerCase() === spread.scorer.toLowerCase() && m.lineTicks === spread.lineTicks,
    );
  // The list asks the chain nothing: it is the courier's records, which do not yet know of the cancel.
  const listed = await get(url(), `/v1/book?gameId=${rig.gameId}`);
  assert.deepEqual(find(listed.body)?.live.A, { live: 1, boundReached: false, marked: 0 }, 'the list counts the quote: the records stand until a request asks the chain');
  // The market's page asks the chain, shows no quote, and marks it at the block it read.
  const head = await rig.publicClient.getBlock();
  const page = await market(url(), spread.scorer, spread.lineTicks, '&side=A');
  assert.equal(page.block.hash, head.hash);
  assert.deepEqual(hashesOf(page.sides.A), []);
  assert.deepEqual({ live: page.sides.A?.live, endedOnChain: page.sides.A?.endedOnChain, markedCancelled: page.sides.A?.markedCancelled }, { live: 1, endedOnChain: 1, markedCancelled: 1 });
  // The list then counts none: with no live quote on either side the market is not listed.
  const after = await get(url(), `/v1/book?gameId=${rig.gameId}`);
  assert.equal(find(after.body), undefined, 'the market holds no quote the records count');
  const record = await get(url(), `/v1/orders/${posted.body.orderHash}`);
  assert.equal(record.body.state, 'cancelled');
  assert.deepEqual(record.body.endedBlock, { number: head.number.toString(), hash: head.hash.toLowerCase() });
});

/** Plants one quote a record number given, straight into the records: rows whose numbers the test chooses. */
async function plantNumbered(records: number[], fields: { marketKey: Hex; gameId: bigint; scorer: Address; lineTicks: number; oddsTick: number; expiry: bigint; account: Address }): Promise<void> {
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time, record_number)
     SELECT '0x' || lpad(to_hex(i), 64, '0'), 'rest', $1, $2, $3, $4, 0, $5, 1000000, i, $6, 0, '0x' || repeat('ab', 65), $7, 0, 1, '0x' || repeat('cd', 32), 1, i
     FROM unnest($8::bigint[]) AS i`,
    [fields.account.toLowerCase(), fields.gameId.toString(), fields.scorer.toLowerCase(), fields.lineTicks, fields.oddsTick, fields.expiry.toString(), fields.marketKey.toLowerCase(), records],
  );
}

/** Plants quotes straight into the records: a backlog the door never saw, as the fixture of the cost contract plants them. */
async function plant(n: number, fields: { marketKey: Hex; gameId: bigint; scorer: Address; lineTicks: number; oddsTick: number; expiry: bigint; account: Address; side?: 0 | 1 }): Promise<void> {
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT '0x' || lpad(to_hex(i), 64, '0'), 'rest', $1, $2, $3, $4, $10, $5, 1000000, i, $6, 0, '0x' || repeat('ab', 65), $7, $10, 1, '0x' || repeat('cd', 32), 1
     FROM generate_series($8::bigint, $9::bigint) AS i`,
    [fields.account.toLowerCase(), fields.gameId.toString(), fields.scorer.toLowerCase(), fields.lineTicks, fields.oddsTick, fields.expiry.toString(), fields.marketKey.toLowerCase(), planted + 1, planted + n, fields.side ?? 0],
  );
  planted += n;
}
let planted = 1_000_000;

/** Plants `pairs` (market, side) pairs on one game, each line two sides, with a key of its own a line: a book of another game. */
async function plantPairs(pairs: number, gameId: bigint, scorer: Address, expiry: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT '0x' || lpad(to_hex(i), 64, '0'), 'rest', $1, $2, $3, (i - $5) / 2, (i - $5) % 2, 200, 1000000, i, $4, 0, '0x' || repeat('ab', 65), '0x' || lpad(to_hex(7000000000 + (i - $5) / 2), 64, '0'), (i - $5) % 2, 1, '0x' || repeat('cd', 32), 1
     FROM generate_series($5::bigint, $6::bigint) AS i`,
    [rig.accounts.maker.address.toLowerCase(), gameId.toString(), scorer.toLowerCase(), expiry.toString(), planted + 1, planted + pairs],
  );
  planted += pairs;
}

/** The markets query's own plan: every scan of orders, its index, loops and rows, from EXPLAIN (ANALYZE). */
async function marketsPlan(gameId: bigint, after: { scorer: Address; lineTicks: number } | null, bound: number): Promise<{ indexes: string[]; loops: number; rows: number; buffers: number }> {
  type Node = Record<string, unknown> & { Plans?: Node[] };
  const { rows } = await pool.query<{ 'QUERY PLAN': Array<{ Plan: Node }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${MARKETS_OF_GAME_SQL}`, marketsOfGameParams(gameId, after, bound));
  const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
  assert.ok(root);
  const scans: Node[] = [];
  let union: Node | undefined;
  const walk = (n: Node) => {
    if (n['Relation Name'] === 'orders') scans.push(n);
    if (n['Node Type'] === 'Recursive Union') union = n;
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(root);
  assert.ok(scans.length > 0, 'the plan reads orders');
  assert.ok(union, 'the walk is the recursive union');
  // Loops are exact per node; a node's "Actual Rows" is its average a loop, so the rows are read where loops is one:
  // the union, which returns every pair the probes found.
  return {
    indexes: [...new Set(scans.map((s) => String(s['Index Name'] ?? s['Node Type'])))],
    loops: scans.reduce((sum, s) => sum + Number(s['Actual Loops'] ?? 0), 0),
    rows: Number(union['Actual Rows'] ?? 0),
    buffers: Number(root['Shared Hit Blocks'] ?? 0) + Number(root['Shared Read Blocks'] ?? 0),
  };
}

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

test("a page's cursor compares the numbers, not their text: quotes at one tick whose record numbers cross from seven digits to eight, and ticks that cross from three digits to four, are each served once, in the numbers' order, over pages of three", async () => {
  const total = { scorer: rig.addresses.total, lineTicks: 2_405 };
  const T = await rig.time();
  const key = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [rig.gameId, total.scorer, total.lineTicks]));
  // Four quotes at tick 999 with record numbers 9,999,998 to 10,000,001, four at tick 1,000 with 10,000,002 to
  // 10,000,005: as text, "10000000" sorts before "9999998" and "1000" before "999"; as numbers, neither does.
  const at999 = [9_999_998, 9_999_999, 10_000_000, 10_000_001];
  const at1000 = [10_000_002, 10_000_003, 10_000_004, 10_000_005];
  await plantNumbered(at999, { marketKey: key, gameId: rig.gameId, oddsTick: 999, expiry: T + 3_600n, account: rig.accounts.maker.address, ...total });
  await plantNumbered(at1000, { marketKey: key, gameId: rig.gameId, oddsTick: 1_000, expiry: T + 3_600n, account: rig.accounts.maker.address, ...total });
  const expected = [...at999, ...at1000];
  const seen: number[] = [];
  let after = '';
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 10, 'the walk ends');
    const page = (await market(url(), total.scorer, total.lineTicks, `&side=A&limit=3${after}`)).sides.A as Page;
    assert.ok(page.quotes.length <= 3);
    seen.push(...page.quotes.map((q) => q.recordNumber));
    if (page.next === null) {
      assert.equal(page.endedBy, 'book');
      break;
    }
    after = `&after=${page.next.oddsTick}:${page.next.recordNumber}`;
  }
  assert.deepEqual(seen, expected, 'every quote once, in the order of the numbers');
});

test("the scan at its bound serves the smallest record number: 2,002 quotes at one tick, record numbers 99,999 and 100,000 to 102,000, read in pages of 50, are each served once in the numbers' order, 99,999 first", async () => {
  const total = { scorer: rig.addresses.total, lineTicks: 2_705 };
  const T = await rig.time();
  const key = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [rig.gameId, total.scorer, total.lineTicks]));
  const records = [99_999, ...Array.from({ length: 2_001 }, (_, i) => 100_000 + i)];
  await plantNumbered(records, { marketKey: key, gameId: rig.gameId, oddsTick: 300, expiry: T + 3_600n, account: rig.accounts.maker.address, ...total });
  // As text, "100000" sorts before "99999": a window of 2,000 ordered by the text is 100,000 to 101,999, and 99,999
  // is in no window, since a later page starts after the cursor. By the numbers the window is 99,999 to 101,998.
  const seen: number[] = [];
  let after = '';
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 60, 'the walk ends');
    const page = (await market(url(), total.scorer, total.lineTicks, `&side=A&limit=50${after}`)).sides.A as Page;
    seen.push(...page.quotes.map((q) => q.recordNumber));
    if (page.next === null) break;
    after = `&after=${page.next.oddsTick}:${page.next.recordNumber}`;
  }
  assert.equal(seen[0], 99_999, 'the smallest number is served first');
  assert.deepEqual(seen, records, "every quote once, in the numbers' order");
});

test('the markets of a game are paged, 100 a page in the order of the market contract and the line, and the cursor reaches the rest: 101 markets with a live quote each, lines from −2,500 across zero to 2,500, are listed once each, over two pages and over pages of seven', async () => {
  const game = await rig.createGame();
  const spread = rig.addresses.spread;
  // Lines across a change of sign and of width: as text "-50" sorts before "-500" and "100" before "50".
  const lines = Array.from({ length: 101 }, (_, i) => -2_500 + i * 50);
  const T = await rig.time();
  for (const lineTicks of lines) {
    const key = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [game, spread, lineTicks]));
    await plant(1, { marketKey: key, gameId: game, scorer: spread, lineTicks, oddsTick: 200, expiry: T + 3_600n, account: rig.accounts.maker.address });
  }
  const page1 = await get(url(), `/v1/book?gameId=${game}`);
  assert.equal(page1.status, 200, JSON.stringify(page1.body));
  const m1 = page1.body.markets as Array<{ scorer: Address; lineTicks: number; live: { A: { live: number } } }>;
  assert.deepEqual(m1.map((m) => m.lineTicks), lines.slice(0, 100), 'the first hundred, in order');
  assert.deepEqual(m1[0]?.live.A, { live: 1, boundReached: false, marked: 0 });
  assert.equal(page1.body.more, true);
  assert.equal(page1.body.limit, 100);
  assert.deepEqual(page1.body.next, { scorer: getAddress(spread), lineTicks: lines[99] }, 'where the next page starts: the last market of this one');
  const next = page1.body.next as { scorer: string; lineTicks: number };
  const page2 = await get(url(), `/v1/book?gameId=${game}&after=${next.scorer}:${next.lineTicks}`);
  assert.equal(page2.status, 200, JSON.stringify(page2.body));
  assert.deepEqual((page2.body.markets as Array<{ lineTicks: number }>).map((m) => m.lineTicks), [lines[100]], 'the cursor reaches the rest');
  assert.equal(page2.body.more, false);
  assert.equal(page2.body.next, null);

  // Pages of seven walk the same list: every market once, in order.
  const seen: number[] = [];
  let after = '';
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 20, 'the walk ends');
    const page = await get(url(), `/v1/book?gameId=${game}&limit=7${after}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const markets = page.body.markets as Array<{ lineTicks: number }>;
    assert.ok(markets.length <= 7);
    seen.push(...markets.map((m) => m.lineTicks));
    if (page.body.more !== true) {
      assert.equal(page.body.next, null);
      break;
    }
    const n = page.body.next as { scorer: string; lineTicks: number };
    after = `&after=${n.scorer}:${n.lineTicks}`;
  }
  assert.deepEqual(seen, lines);
  for (const bad of ['&limit=0', '&limit=101', '&after=abc', `&after=${spread}`, `&after=${spread}:x`, '&after=1:2']) {
    assert.equal((await get(url(), `/v1/book?gameId=${game}${bad}`)).body.code, 'INVALID_PARAM', bad);
  }
});

test("a read of a game touches that game's markets only, and a page's work is bounded by its limit, not by the book: 5,000 pairs planted on another game are not visited by this game's page nor by an empty game's, asserted on the query's own rows and loops; the other game's own page is bounded by its limit", async () => {
  const game = await rig.createGame();
  const other = 888_888n;
  const empty = 999_999n;
  const spread = rig.addresses.spread;
  const T = await rig.time();
  const lines = [-150, -100, -50, 0, 50];
  for (const lineTicks of lines) {
    const key = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [game, spread, lineTicks]));
    await plant(1, { marketKey: key, gameId: game, scorer: spread, lineTicks, oddsTick: 200, expiry: T + 3_600n, account: rig.accounts.maker.address });
    await plant(1, { marketKey: key, gameId: game, scorer: spread, lineTicks, oddsTick: 210, expiry: T + 3_600n, account: rig.accounts.maker.address, side: 1 });
  }
  const strip = (body: Record<string, unknown>) => ({ markets: body.markets, more: body.more, next: body.next, limit: body.limit });
  const before = await get(url(), `/v1/book?gameId=${game}`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual((before.body.markets as Array<{ lineTicks: number; live: { A: { live: number }; B: { live: number } } }>).map((m) => [m.lineTicks, m.live.A.live, m.live.B.live]), lines.map((l) => [l, 1, 1]));

  // The book of another game: 5,000 pairs, 2,500 lines with two sides each.
  await plantPairs(5_000, other, spread, T + 3_600n);
  const after_ = await get(url(), `/v1/book?gameId=${game}`);
  assert.deepEqual(strip(after_.body), strip(before.body), "this game's page is the same page");
  const none = await get(url(), `/v1/book?gameId=${empty}`);
  assert.deepEqual(strip(none.body), { markets: [], more: false, next: null, limit: 100 });

  // The query's own plan: the game's index, one probe a pair; the pairs of this game plus the one probe that finds
  // no more, whatever the other game holds; nothing at all read of the 5,000.
  const ours = await marketsPlan(game, null, 2 * (100 + 1));
  assert.deepEqual(ours.indexes, ['orders_markets_of_game']);
  assert.equal(ours.rows, 10, "the game's ten pairs, and no other row");
  assert.equal(ours.loops, 11, 'ten probes that found a pair, one that found the end');
  const nothing = await marketsPlan(empty, null, 2 * (100 + 1));
  assert.deepEqual(nothing.indexes, ['orders_markets_of_game']);
  assert.deepEqual({ rows: nothing.rows, loops: nothing.loops }, { rows: 0, loops: 1 }, 'one probe, no row');
  // The other game's own page of seven: the walk stops at the bound of pairs, not at the book's end.
  const bound = 2 * (7 + 1);
  const big = await marketsPlan(other, null, bound);
  assert.deepEqual(big.indexes, ['orders_markets_of_game']);
  assert.deepEqual({ rows: big.rows, loops: big.loops }, { rows: bound, loops: bound }, `${bound} pairs, ${bound} probes, of the 5,000`);
  const page = await get(url(), `/v1/book?gameId=${other}&limit=7`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual((page.body.markets as Array<{ lineTicks: number }>).map((m) => m.lineTicks), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(page.body.more, true);
  assert.deepEqual(page.body.next, { scorer: getAddress(spread), lineTicks: 6 });
  const second = await marketsPlan(other, { scorer: spread, lineTicks: 6 }, bound);
  assert.deepEqual({ rows: second.rows, loops: second.loops }, { rows: bound, loops: bound }, 'from the cursor, the same work');
  console.log(`# markets of a game: ${JSON.stringify({ thisGame: ours, emptyGame: nothing, otherGamePageOf7: big, fromCursor: second })}`);
});
