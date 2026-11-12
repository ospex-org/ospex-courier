import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { encodeAbiParameters, keccak256, toBytes, type Abi, type Address, type Hex } from 'viem';
import { orderHash, orderSigner } from '../courier/orders/order';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import { cancelOnChain, contractHash, crossFromTheTest, liftCap, orderOn, post, postOrder, raiseFloor, sign, wire, type Order } from './support/orders';
import type { Rig } from './support/rig';
import { publishedList, startStack, type Stack } from './support/stack';

// The door, from a user's side: signed orders posted over HTTP to the courier
// running as its own process against the local chain and a real Postgres;
// judged by the answer, the rows and the lines. The sixteen checks in the
// plan's order, the records, and the hash against the contract.

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;

before(async () => {
  stack = await startStack('orders');
  rig = stack.rig;
  pool = openPool(stack.databaseUrl, null);
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

const url = () => stack.courier.url;

/** The readings a start report rests on, as the rig's own does; and a score's, three finals that agree and one silent seat. */
const READINGS_START = [
  { seat: 1, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 2, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 3, kind: 1, homeScore: 88, awayScore: 90 },
  { seat: 4, kind: 0, homeScore: 0, awayScore: 0 },
];
const READINGS_SCORE = [
  { seat: 1, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 2, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 3, kind: 2, homeScore: 104, awayScore: 97 },
  { seat: 4, kind: 0, homeScore: 0, awayScore: 0 },
];

interface Line {
  kind: string;
  order_hash: string | null;
  account: string | null;
  game_id: string | null;
  reason: string | null;
  facts: Record<string, unknown>;
}

async function lines(where = ''): Promise<Line[]> {
  const { rows } = await pool.query<Line>(`SELECT kind, order_hash, account, game_id::text AS game_id, reason, facts FROM events ${where} ORDER BY number`);
  return rows;
}

async function orderRow(hash: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE hash = $1`, [hash.toLowerCase()]);
  return (rows[0] as Record<string, unknown>) ?? null;
}

async function refusedBeforeAdmission(): Promise<Record<string, number>> {
  return ((await get(url(), '/v1/status')).body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode;
}

// ──────────────────────────── the hash ────────────────────────────────────

const FROZEN = {
  matching: '0x00000000000000000000000000000000C0550001' as Address,
  account: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as Address,
  order: { account: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as Address, gameId: 1n, scorer: '0x00000000000000000000000000000000c0550002' as Address, lineTicks: 0, positionType: 0 as const, oddsTick: 200, riskAmount: 10_000n, nonce: 7n, expiry: 1_900_000_000n, minFill: 9_900n },
  digest: '0x9af8958f00563f5d9c4bd30f85953c0d0a67df62efffbccdfa9b4a7cbc3aaae0' as Hex,
  signature: '0x834021ff982e27711ee8f07cf27b2901be8b8c1c359688742df735c10973ed593fcae360612d264bd2a84d5ce07fe9a2a4f2cd25a52e8ab6c6ed79624d4a877d1b' as Hex,
  typehash: '0x9f84ebcb32dbe12642da2b9008bc0ec2e6332472ec69f27f13e8abebbb92934c' as Hex,
  /** The nine-field digest the contracts replaced: not the hash of the same order here either. */
  oldDigest: '0x428d170f2fc43ee0a5b21f7433a1a99bba76a4203d2985a47cbc3b5f83549219' as Hex,
};

test("the courier's hash of the contracts' frozen ten-field order is the frozen digest, whose signature, made outside, recovers to the frozen account", async () => {
  assert.equal(orderHash(FROZEN.order, 137n, FROZEN.matching), FROZEN.digest);
  assert.equal((await orderSigner(FROZEN.order, FROZEN.signature, 137n, FROZEN.matching))?.toLowerCase(), FROZEN.account.toLowerCase());
  assert.equal(
    keccak256(toBytes('OspexOrder(address account,uint256 gameId,address scorer,int32 lineTicks,uint8 positionType,uint16 oddsTick,uint256 riskAmount,uint256 nonce,uint256 expiry,uint256 minFill)')),
    FROZEN.typehash,
    'the type string is the contract\'s',
  );
  assert.notEqual(orderHash(FROZEN.order, 137n, FROZEN.matching), FROZEN.oldDigest, 'the nine-field digest is not this order\'s hash');
  assert.notEqual(orderHash(FROZEN.order, 31337n, FROZEN.matching), FROZEN.digest, 'another chain is another domain');
  assert.notEqual(orderHash({ ...FROZEN.order, minFill: 9_899n }, 137n, FROZEN.matching), FROZEN.digest, 'the tenth field is in the hash');
});

test("the courier's hash equals the contract's getOrderHash for forty orders across the fields' ranges", async () => {
  const scorers = [rig.addresses.moneyline, rig.addresses.spread, rig.addresses.total];
  const big = 2n ** 256n - 1n;
  for (let i = 0; i < 40; i++) {
    const scorer = scorers[i % 3] as Address;
    const order: Order = {
      account: (i % 2 === 0 ? rig.accounts.maker : rig.accounts.taker).address,
      gameId: i % 5 === 0 ? big : BigInt(i * 7 + 1),
      scorer,
      lineTicks: scorer === rig.addresses.moneyline ? 0 : scorer === rig.addresses.total ? i * 25 : (i % 2 === 0 ? -1 : 1) * (i * 35 + 5),
      positionType: (i % 2) as 0 | 1,
      oddsTick: 101 + ((i * 251) % 10_000),
      riskAmount: BigInt(100 * (i + 1) * (i % 4 === 0 ? 1_000_000 : 1)),
      nonce: i % 7 === 0 ? big - BigInt(i) : BigInt(i),
      expiry: i % 3 === 0 ? big : BigInt(1_700_000_000 + i),
      minFill: i % 2 === 0 ? 0n : BigInt(100 * (i + 1)),
    };
    assert.equal(orderHash(order, 31337n, rig.addresses.matching), await contractHash(rig, order), `order ${i}`);
  }
});

// ──────────────────────────── a quote in ──────────────────────────────────

test('a quote posted is recorded: 201, resting, a record number, the chain\'s time; the row holds the ten fields; one line; the record is served; a repeat is the record and writes nothing; the other role is a conflict', async () => {
  const T = await rig.time();
  const order = orderOn(rig, rig.accounts.maker, { expiry: T + 3_600n, oddsTick: 190, riskAmount: 2_500_000n, minFill: 100_000n });
  const linesBefore = (await lines()).length;
  const posted = await postOrder(url(), rig, rig.accounts.maker, 'rest', order);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.role, 'rest');
  assert.equal(posted.body.state, 'resting');
  assert.equal(typeof posted.body.recordNumber, 'number');
  assert.equal(posted.body.chainTime, T.toString());
  const hash = posted.body.orderHash as string;
  assert.equal(hash, await contractHash(rig, order), 'the record\'s hash is the contract\'s');
  assert.equal((posted.body.receivedBlock as { number: string }).number, (await rig.publicClient.getBlock()).number.toString());

  // The row, whole: every field as signed, lowercase where it is an address, and the market key as the contract computes it.
  const row = await orderRow(hash);
  assert.ok(row !== null);
  const expectedKey = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [order.gameId, order.scorer, order.lineTicks]));
  assert.deepEqual(
    {
      role: row.role, account: row.account, game_id: String(row.game_id), scorer: row.scorer, line_ticks: row.line_ticks, position_type: row.position_type, odds_tick: row.odds_tick,
      risk_amount: String(row.risk_amount), nonce: String(row.nonce), expiry: String(row.expiry), min_fill: String(row.min_fill), signature: row.signature, market_key: row.market_key, side: row.side,
      ended: row.ended, ended_at: row.ended_at, bet_state: row.bet_state,
    },
    {
      role: 'rest', account: order.account.toLowerCase(), game_id: order.gameId.toString(), scorer: order.scorer.toLowerCase(), line_ticks: 0, position_type: 0, odds_tick: 190,
      risk_amount: '2500000', nonce: order.nonce.toString(), expiry: order.expiry.toString(), min_fill: '100000', signature: posted.signature.toLowerCase(), market_key: expectedKey, side: 0,
      ended: null, ended_at: null, bet_state: null,
    },
  );
  assert.equal(Number(row.record_number), posted.body.recordNumber);

  // One line, and it is the order's.
  const after = await lines();
  assert.equal(after.length, linesBefore + 1);
  const line = after[after.length - 1] as Line;
  assert.equal(line.kind, 'order received');
  assert.equal(line.order_hash, hash);
  assert.equal(line.account, order.account.toLowerCase());
  assert.equal(line.game_id, order.gameId.toString());
  assert.equal(line.facts.role, 'rest');
  assert.equal(line.facts.recordNumber, posted.body.recordNumber);

  // Served by its hash.
  const served = await get(url(), `/v1/orders/${hash}`);
  assert.equal(served.status, 200);
  assert.equal(served.body.recordNumber, posted.body.recordNumber);
  assert.deepEqual(served.body.order, wire(order));
  assert.equal((await get(url(), `/v1/orders/0x${'1'.repeat(64)}`)).body.code, 'UNKNOWN_ORDER');
  assert.equal((await get(url(), '/v1/orders/abc')).body.code, 'INVALID_PARAM');

  // The same order again: the record, 200, and nothing written.
  const again = await post(url(), '/v1/orders', { role: 'rest', order: wire(order), signature: posted.signature });
  assert.equal(again.status, 200);
  assert.equal(again.body.recordNumber, posted.body.recordNumber);
  assert.equal((await lines()).length, linesBefore + 1, 'a repeat writes no line');
  // Under the other role: a conflict, counted, and nothing written.
  const conflict = await post(url(), '/v1/orders', { role: 'take', order: wire(order), signature: posted.signature });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'ROLE_CONFLICT');
  assert.equal((await lines()).length, linesBefore + 1);
  assert.equal((await refusedBeforeAdmission()).ROLE_CONFLICT, 1);
});

// ──────────────────────────── the checks before admission ─────────────────

test('each of the ten fields changed after signing, and the signature itself, is refused BAD_SIGNATURE with no row and no line; the unchanged order is accepted', async () => {
  const T = await rig.time();
  const base = orderOn(rig, rig.accounts.maker, { expiry: T + 600n, scorer: rig.addresses.spread, lineTicks: -35, oddsTick: 210, riskAmount: 1_000_000n, minFill: 200_000n });
  const signature = await sign(rig.accounts.maker, base, 31337, rig.addresses.matching);
  const changes: Array<[string, Partial<Order>]> = [
    ['account', { account: rig.accounts.taker.address }],
    ['gameId', { gameId: base.gameId + 1n }],
    ['scorer', { scorer: rig.addresses.total, lineTicks: 35 }],
    ['lineTicks', { lineTicks: -45 }],
    ['positionType', { positionType: 1 }],
    ['oddsTick', { oddsTick: 211 }],
    ['riskAmount', { riskAmount: 1_000_100n }],
    ['nonce', { nonce: base.nonce + 1n }],
    ['expiry', { expiry: base.expiry + 1n }],
    ['minFill', { minFill: 200_100n }],
  ];
  const linesBefore = (await lines()).length;
  const rowsBefore = Number((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n);
  for (const [field, change] of changes) {
    const answer = await post(url(), '/v1/orders', { role: 'rest', order: wire({ ...base, ...change }), signature });
    assert.equal(answer.status, 422, `${field}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, 'BAD_SIGNATURE', field);
  }
  const flipped = (signature.slice(0, -2) + (signature.endsWith('1b') ? '1c' : '1b')) as Hex;
  assert.equal((await post(url(), '/v1/orders', { role: 'rest', order: wire(base), signature: flipped })).body.code, 'BAD_SIGNATURE', 'the signature\'s last byte');
  assert.equal((await lines()).length, linesBefore, 'nothing before admission is a line');
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n), rowsBefore, 'nothing before admission is a row');
  assert.equal((await refusedBeforeAdmission()).BAD_SIGNATURE, 11);
  const control = await post(url(), '/v1/orders', { role: 'rest', order: wire(base), signature });
  assert.equal(control.status, 201, JSON.stringify(control.body));
});

test("the order's own rules, as the contract has them, each refused by its code before admission; a spread with a negative line is accepted", async () => {
  const T = await rig.time();
  const maker = rig.accounts.maker;
  const cases: Array<[string, Partial<Order>]> = [
    ['PRICE_OUT_OF_RANGE', { oddsTick: 100 }],
    ['PRICE_OUT_OF_RANGE', { oddsTick: 10_101 }],
    ['STAKE_NOT_IN_LOTS', { riskAmount: 0n }],
    ['STAKE_NOT_IN_LOTS', { riskAmount: 1_000_150n }],
    ['MIN_FILL_ABOVE_STAKE', { riskAmount: 1_000_000n, minFill: 1_000_100n }],
    ['UNKNOWN_MARKET_CONTRACT', { scorer: rig.addresses.coin }],
    ['INVALID_LINE', { scorer: rig.addresses.spread, lineTicks: 1_000_001 }],
    ['INVALID_LINE', { scorer: rig.addresses.spread, lineTicks: -1_000_001 }],
    ['INVALID_LINE', { scorer: rig.addresses.moneyline, lineTicks: 10 }],
    ['INVALID_LINE', { scorer: rig.addresses.total, lineTicks: -10 }],
  ];
  const show = (fields: Partial<Order>) => JSON.stringify(fields, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  for (const [code, fields] of cases) {
    const answer = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, ...fields }));
    assert.equal(answer.status, 422, `${code} ${show(fields)}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, code, show(fields));
  }
  const spread = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, scorer: rig.addresses.spread, lineTicks: -35 }));
  assert.equal(spread.status, 201, JSON.stringify(spread.body));
  const total = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, scorer: rig.addresses.total, lineTicks: 2_205 }));
  assert.equal(total.status, 201, JSON.stringify(total.body));
});

test('the body: over 8 KB is refused 413 before it is read whole; not JSON, the wrong shape and a bad role are INVALID_PARAM; each counted and none a row', async () => {
  const T = await rig.time();
  const order = orderOn(rig, rig.accounts.maker, { expiry: T + 600n });
  const signature = await sign(rig.accounts.maker, order, 31337, rig.addresses.matching);
  const big = JSON.stringify({ role: 'rest', order: wire(order), signature, padding: 'x'.repeat(8 * 1024) });
  const tooLarge = await post(url(), '/v1/orders', big);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, 'BODY_TOO_LARGE');
  assert.equal((await post(url(), '/v1/orders', '{not json')).body.code, 'INVALID_PARAM');
  assert.equal((await post(url(), '/v1/orders', [1, 2])).body.code, 'INVALID_PARAM');
  assert.equal((await post(url(), '/v1/orders', { role: 'rest', order: wire(order) })).body.code, 'INVALID_PARAM');
  assert.equal((await post(url(), '/v1/orders', { role: 'rest', order: wire(order), signature, extra: 1 })).body.code, 'INVALID_PARAM');
  assert.equal((await post(url(), '/v1/orders', { role: 'hold', order: wire(order), signature })).body.code, 'INVALID_PARAM');
  assert.equal((await post(url(), '/v1/orders', { role: 'rest', order: { ...wire(order), eleventh: 1 }, signature })).body.code, 'INVALID_PARAM');
  assert.equal((await post(url(), '/v1/orders', { role: 'rest', order: { ...wire(order), riskAmount: 1_000_000 }, signature })).body.code, 'INVALID_PARAM', 'an amount is a decimal string');
  assert.equal((await post(url(), '/v1/orders', { role: 'rest', order: wire(order), signature: '0x1234' })).body.code, 'INVALID_PARAM');
  const counts = await refusedBeforeAdmission();
  assert.equal(counts.BODY_TOO_LARGE, 1);
  assert.ok((counts.INVALID_PARAM ?? 0) >= 8);
  assert.equal(await orderRow(orderHash(order, 31337n, rig.addresses.matching)), null);
});

test('before admission nothing is kept: a key that has not registered the relay is refused NOT_REGISTERED, with no row, no line and no budget row; counted', async () => {
  const stranger = rig.accounts.stranger;
  const T = await rig.time();
  for (let i = 0; i < 25; i++) {
    const answer = await postOrder(url(), rig, stranger, i % 2 === 0 ? 'rest' : 'take', orderOn(rig, stranger, { expiry: T + 20n, riskAmount: 10_000n }));
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'NOT_REGISTERED');
    assert.match(String(answer.body.error), new RegExp(rig.addresses.relay, 'i'), 'the sentence names the relay');
  }
  const account = stranger.address.toLowerCase();
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM orders WHERE account = $1', [account])).rows[0].n), 0);
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM events WHERE account = $1', [account])).rows[0].n), 0);
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM accounts WHERE account = $1', [account])).rows[0].n), 0);
  assert.equal((await refusedBeforeAdmission()).NOT_REGISTERED, 25);
});

// ──────────────────────────── the checks after admission ──────────────────

test('the game rule: not a game is UNKNOWN_GAME; no written start is NO_WRITTEN_START with one start-unreadable line until the start is read; a list other than the published one is REPORTERS_NOT_THE_PUBLISHED_LIST', async () => {
  const maker = rig.accounts.maker;
  const T = await rig.time();
  const unknown = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, gameId: 999n }));
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.code, 'UNKNOWN_GAME');
  const refusedLine = (await lines(`WHERE kind = 'order refused' AND reason = 'UNKNOWN_GAME'`))[0];
  assert.ok(refusedLine !== undefined, 'an admitted refusal is a line');
  assert.equal(refusedLine.game_id, '999');

  const unwritten = await rig.createGame({ startWritten: false });
  const first = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, gameId: unwritten }));
  assert.equal(first.body.code, 'NO_WRITTEN_START', JSON.stringify(first.body));
  const second = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, gameId: unwritten }));
  assert.equal(second.body.code, 'NO_WRITTEN_START');
  const unreadable = await lines(`WHERE kind = 'start unreadable' AND game_id = ${unwritten}`);
  assert.equal(unreadable.length, 1, 'once per game, with its time, until it can be read');
  assert.equal(typeof unreadable[0]?.facts.time, 'string');
  const game = (await pool.query('SELECT start, reporters_published, start_unreadable_at FROM games WHERE game_id = $1', [unwritten.toString()])).rows[0] as Record<string, unknown>;
  assert.equal(game.start, null);
  assert.equal(game.reporters_published, true);
  assert.ok(game.start_unreadable_at instanceof Date);

  // The start is written: the game is carried, and the row says so.
  const date = (await rig.time()) + 86_400n;
  await rig.write(rig.accounts.deployer, rig.addresses.reporter, rig.abis.MockReporter as Abi, 'send', [
    { gameId: unwritten, kind: 1, start: date + 613n, homeScore: 0, awayScore: 0, readings: READINGS_START, payout: '0x0000000000000000000000000000000000000000' },
  ]);
  const carried = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, gameId: unwritten }));
  assert.equal(carried.status, 201, JSON.stringify(carried.body));
  const written = (await pool.query('SELECT start::text AS start, start_unreadable_at FROM games WHERE game_id = $1', [unwritten.toString()])).rows[0] as Record<string, unknown>;
  assert.equal(written.start, (date + 613n).toString());
  assert.equal(written.start_unreadable_at, null);

  // A courier whose published list names another reporter carries no game of this set.
  const other = await startCourier({ ...stack.env, PUBLISHED_REPORTERS_FILE: publishedList([rig.accounts.stranger.address]) });
  try {
    const status = await get(other.url, '/v1/status');
    assert.deepEqual((status.body.published as { reporters: string[] }).reporters, [rig.accounts.stranger.address]);
    const refused = await postOrder(other.url, rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n }));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'REPORTERS_NOT_THE_PUBLISHED_LIST');
    assert.deepEqual(refused.body.published, [rig.accounts.stranger.address]);
  } finally {
    await other.stop();
  }
  // Exactly the list: a game whose reporters are a strict subset of a two-reporter list is not carried either.
  const wider = await startCourier({ ...stack.env, PUBLISHED_REPORTERS_FILE: publishedList([rig.addresses.reporter, rig.accounts.stranger.address]) });
  try {
    const subset = await postOrder(wider.url, rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n }));
    assert.equal(subset.status, 422, JSON.stringify(subset.body));
    assert.equal(subset.body.code, 'REPORTERS_NOT_THE_PUBLISHED_LIST', 'a subset of the list is not the list');
  } finally {
    await wider.stop();
  }
  // The games row is the database's, so the other courier's read is what it holds now; this courier's next read puts its own back.
  const flagged = (await pool.query('SELECT reporters_published FROM games WHERE game_id = $1', [rig.gameId.toString()])).rows[0] as Record<string, unknown>;
  assert.equal(flagged.reporters_published, false, 'two couriers sharing one database share one record of the game');
  assert.equal((await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, oddsTick: 177 }))).status, 201);
  const restored = (await pool.query('SELECT reporters_published FROM games WHERE game_id = $1', [rig.gameId.toString()])).rows[0] as Record<string, unknown>;
  assert.equal(restored.reporters_published, true);
});

test("the order's standing on chain: cancelled is CANCELLED; a nonce under the account's floor is CANCELLED and one at the floor is taken; expiry at T + 1 is EXPIRED and at T + 2 is taken, with no margin; a quote the chain shows filled is FILLED", async () => {
  const maker = rig.accounts.maker;
  const taker = rig.accounts.taker;
  let T = await rig.time();
  const cancelled = orderOn(rig, maker, { expiry: T + 600n, oddsTick: 180 });
  await cancelOnChain(rig, maker, cancelled);
  T = await rig.time();
  const c = await postOrder(url(), rig, maker, 'rest', cancelled);
  assert.equal(c.body.code, 'CANCELLED', JSON.stringify(c.body));

  // The floor, on the total market at line 2155 so no earlier quote of the maker's is touched.
  const market = { scorer: rig.addresses.total, lineTicks: 2_155 };
  const under = orderOn(rig, maker, { expiry: T + 600n, ...market });
  await raiseFloor(rig, maker, under, under.nonce + 1n);
  T = await rig.time();
  const u = await postOrder(url(), rig, maker, 'rest', under);
  assert.equal(u.body.code, 'CANCELLED', JSON.stringify(u.body));
  const at = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, ...market, nonce: under.nonce + 1n }));
  assert.equal(at.status, 201, JSON.stringify(at.body));

  // The expiry, exact: at T + 1 it can fill in no later block; at T + 2 it can.
  T = await rig.time();
  const atOne = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 1n }));
  assert.equal(atOne.body.code, 'EXPIRED', JSON.stringify(atOne.body));
  assert.equal(atOne.body.chainTime, T.toString());
  const atTwo = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 2n }));
  assert.equal(atTwo.status, 201, JSON.stringify(atTwo.body));
  const refusedLines = await lines(`WHERE kind = 'order refused' AND reason IN ('CANCELLED', 'EXPIRED')`);
  assert.ok(refusedLines.length >= 3, 'each admitted refusal is a line');

  // Filled: one Cross sent by the test, from the relay's sender, fills a quote whole; the quote is then FILLED at the door.
  T = await rig.time();
  const quote = orderOn(rig, maker, { expiry: T + 600n, oddsTick: 200, riskAmount: 10_000n, scorer: rig.addresses.spread, lineTicks: -55 });
  const bet: Order = { ...orderOn(rig, taker, { expiry: T + 20n, oddsTick: 200, riskAmount: 10_000n, scorer: rig.addresses.spread, lineTicks: -55 }), positionType: 1 };
  const sent = await crossFromTheTest(
    rig,
    { order: bet, signature: await sign(taker, bet, 31337, rig.addresses.matching) },
    [{ order: quote, signature: await sign(maker, quote, 31337, rig.addresses.matching) }],
  );
  assert.equal(sent.filled, true, JSON.stringify(sent));
  const filled = await postOrder(url(), rig, maker, 'rest', quote);
  assert.equal(filled.body.code, 'FILLED', JSON.stringify(filled.body));
});

test('a bet: 202 queued, with no Cross; the cap before the lift refuses 10,100 with the sentence and takes 10,000; the expiry at most 30 seconds past the chain\'s time; two waiting bets an account; a quote is never capped; after the lift 10,100 is taken', async () => {
  const taker = rig.accounts.taker;
  const maker = rig.accounts.maker;
  let T = await rig.time();
  const over = await postOrder(url(), rig, taker, 'take', orderOn(rig, taker, { expiry: T + 20n, riskAmount: 10_100n, positionType: 1 }));
  assert.equal(over.status, 422, JSON.stringify(over.body));
  assert.equal(over.body.code, 'ABOVE_CAP');
  assert.equal(over.body.error, 'Bets are capped at 0.01 USDC until the cap is lifted. This bet is signed for 0.0101 USDC. Nothing was sent.');

  const at = await postOrder(url(), rig, taker, 'take', orderOn(rig, taker, { expiry: T + 20n, riskAmount: 10_000n, positionType: 1 }));
  assert.equal(at.status, 202, JSON.stringify(at.body));
  assert.equal(at.body.state, 'queued');
  assert.equal(at.body.cross, null);
  const row = await orderRow(at.body.orderHash as string);
  assert.equal(row?.bet_state, 'waiting');
  assert.equal(row?.role, 'take');

  T = await rig.time();
  const tooFar = await postOrder(url(), rig, taker, 'take', orderOn(rig, taker, { expiry: T + 31n, riskAmount: 10_000n, positionType: 1 }));
  assert.equal(tooFar.body.code, 'EXPIRY_TOO_FAR', JSON.stringify(tooFar.body));
  assert.equal(tooFar.body.chainTime, T.toString());
  const atThirty = await postOrder(url(), rig, taker, 'take', orderOn(rig, taker, { expiry: T + 30n, riskAmount: 10_000n, positionType: 1 }));
  assert.equal(atThirty.status, 202, JSON.stringify(atThirty.body));

  // Two of the account's bets wait; a third is refused for the count, never for the time it has left.
  const third = await postOrder(url(), rig, taker, 'take', orderOn(rig, taker, { expiry: T + 30n, riskAmount: 10_000n, positionType: 1 }));
  assert.equal(third.status, 503, JSON.stringify(third.body));
  assert.equal(third.body.code, 'QUEUE_FULL');
  assert.deepEqual(third.body.waiting, { account: 2, all: 2 });

  // A quote of 50 USDC is accepted: resting stakes are not capped.
  const large = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, riskAmount: 50_000_000n, oddsTick: 250 }));
  assert.equal(large.status, 201, JSON.stringify(large.body));

  // The lift, through the timelock: from then on nothing is refused for size.
  await liftCap(rig);
  T = await rig.time();
  const lifted = await postOrder(url(), rig, maker, 'take', orderOn(rig, maker, { expiry: T + 20n, riskAmount: 10_100n, positionType: 1 }));
  assert.equal(lifted.status, 202, JSON.stringify(lifted.body));
});

test('an account holds at most 16 live quotes on one side of one market; an expired one among them is not counted, nor one the chain shows cancelled', async () => {
  const who = rig.account(9);
  await rig.fund(who);
  let T = await rig.time();
  const market = { scorer: rig.addresses.spread, lineTicks: -95 };
  const quotes: Order[] = [];
  for (let i = 0; i < 16; i++) {
    const q = orderOn(rig, who, { expiry: i === 0 ? T + 2n : T + 3_600n, ...market });
    const answer = await postOrder(url(), rig, who, 'rest', q);
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    quotes.push(q);
  }
  const seventeenth = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  assert.equal(seventeenth.status, 422, JSON.stringify(seventeenth.body));
  assert.equal(seventeenth.body.code, 'TOO_MANY_QUOTES');
  // The first quote expires: it is not counted, and the next is taken.
  await rig.increaseTime(5n);
  T = await rig.time();
  const afterExpiry = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  assert.equal(afterExpiry.status, 201, JSON.stringify(afterExpiry.body));
  // Sixteen live again; one cancelled on chain is found when the chain is asked at the bound, and the next is taken.
  assert.equal((await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }))).body.code, 'TOO_MANY_QUOTES');
  const callsBefore = stack.proxy.count('eth_call');
  await cancelOnChain(rig, who, quotes[5] as Order);
  const afterCancel = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  assert.equal(afterCancel.status, 201, JSON.stringify(afterCancel.body));
  assert.ok(stack.proxy.count('eth_call') >= callsBefore + 2, 'the chain was asked about the sixteen');
  assert.equal((await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }))).body.code, 'TOO_MANY_QUOTES');
  // The other side is its own count.
  const otherSide = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market, positionType: 1 }));
  assert.equal(otherSide.status, 201);
});

test('the count of live quotes looks past the ended ones standing in front: sixteen quotes cancelled on chain, with later expiries than their replacements, hide no live quote behind them; sixteen replacements are taken and the seventeenth is refused', async () => {
  const who = rig.account(10);
  await rig.fund(who);
  const T = await rig.time();
  const market = { scorer: rig.addresses.total, lineTicks: 2_305 };
  const first: Order[] = [];
  for (let i = 0; i < 16; i++) {
    const q = orderOn(rig, who, { expiry: T + 3_600n, ...market });
    const answer = await postOrder(url(), rig, who, 'rest', q);
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    first.push(q);
  }
  for (const q of first) await cancelOnChain(rig, who, q);
  // The replacements expire an hour earlier than the cancelled sixteen, so in the index, newest expiry first, every
  // one of them stands behind all sixteen. Each is taken: the cancelled ones are read at the block and not counted.
  for (let i = 0; i < 16; i++) {
    const answer = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 1_800n, ...market }));
    assert.equal(answer.status, 201, `replacement ${i + 1}: ${JSON.stringify(answer.body)}`);
  }
  const seventeenth = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 1_800n, ...market }));
  assert.equal(seventeenth.status, 422, JSON.stringify(seventeenth.body));
  assert.equal(seventeenth.body.code, 'TOO_MANY_QUOTES');
  assert.equal(seventeenth.body.error, 'This account holds 16 live quotes on this side of this market; the bound is 16.');
  const unended = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE account = $1 AND role = 'rest' AND ended IS NULL`, [who.address.toLowerCase()]);
  assert.equal(unended.rows[0]?.n, 32, 'the cancelled sixteen stand unmarked in the records: what the chain knows is read at the block, never stored');
  // One replacement cancelled makes room for one, found behind the cancelled sixteen as well.
  const replacement = orderOn(rig, who, { expiry: T + 1_800n, ...market });
  assert.equal((await postOrder(url(), rig, who, 'rest', replacement)).body.code, 'TOO_MANY_QUOTES');
  await cancelOnChain(rig, who, first[0] as Order);
  assert.equal((await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 1_800n, ...market }))).body.code, 'TOO_MANY_QUOTES', 'a cancelled quote that was not counted makes no room');
});

test('a stop on record for the hash is honoured at the door: STOPPED, as a line (the stop build writes the record; the door reads it)', async () => {
  const maker = rig.accounts.maker;
  const T = await rig.time();
  const order = orderOn(rig, maker, { expiry: T + 600n, oddsTick: 333 });
  const hash = await contractHash(rig, order);
  await pool.query(
    `INSERT INTO stops (hash, account, message, signature) VALUES ($1, $2, $3, $4)`,
    [hash.toLowerCase(), maker.address.toLowerCase(), JSON.stringify({ account: maker.address, orderHashes: [hash] }), `0x${'ab'.repeat(65)}`],
  );
  const refused = await postOrder(url(), rig, maker, 'rest', order);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'STOPPED');
  assert.equal((await lines(`WHERE kind = 'order refused' AND reason = 'STOPPED' AND order_hash = '${hash.toLowerCase()}'`)).length, 1);
  assert.equal(await orderRow(hash), null, 'a refused order holds no place');
});

test('a live quote after kickoff on a game with a written start is taken; a scored game is GAME_ENDED; past the start plus the window, BETS_CLOSED', async () => {
  const maker = rig.accounts.maker;
  const second = await rig.createGame();
  const start = await rig.read<bigint>(rig.addresses.games, rig.abis.OspexGames as Abi, 'getGameStart', [second]);
  const window = await rig.read<bigint>(rig.addresses.games, rig.abis.OspexGames as Abi, 'getGameWindow', [second]);
  let T = await rig.time();
  await rig.increaseTime(start - T + 60n);
  T = await rig.time();
  assert.ok(T >= start, 'after kickoff');
  const afterKickoff = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, gameId: second }));
  assert.equal(afterKickoff.status, 201, JSON.stringify(afterKickoff.body));

  // The game is scored: an end.
  await rig.write(rig.accounts.deployer, rig.addresses.reporter, rig.abis.MockReporter as Abi, 'send', [
    { gameId: second, kind: 2, start: 0n, homeScore: 104, awayScore: 97, readings: READINGS_SCORE, payout: rig.accounts.creator.address },
  ]);
  assert.equal(await rig.read<number>(rig.addresses.games, rig.abis.OspexGames as Abi, 'getGameStatus', [second]), 4, 'scored');
  T = await rig.time();
  const ended = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, gameId: second }));
  assert.equal(ended.body.code, 'GAME_ENDED', JSON.stringify(ended.body));

  // The rig's first game, still verified: at the start plus the window, bets are closed; one second before, not.
  const firstStart = await rig.read<bigint>(rig.addresses.games, rig.abis.OspexGames as Abi, 'getGameStart', [rig.gameId]);
  const closesAt = firstStart + window;
  T = await rig.time();
  if (T < closesAt - 1n) await rig.increaseTime(closesAt - 1n - T);
  T = await rig.time();
  assert.equal(T, closesAt - 1n);
  const open = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, oddsTick: 444 }));
  assert.equal(open.status, 201, JSON.stringify(open.body));
  await rig.increaseTime(1n);
  T = await rig.time();
  const closed = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 600n, oddsTick: 445 }));
  assert.equal(closed.body.code, 'BETS_CLOSED', JSON.stringify(closed.body));
  assert.equal(closed.body.closesAt, closesAt.toString());
});

test('every refusal line is of an admitted request: no line carries a code of the checks before admission', async () => {
  const before = new Set(['INVALID_PARAM', 'BODY_TOO_LARGE', 'RATE_LIMIT_EXCEEDED', 'PRICE_OUT_OF_RANGE', 'STAKE_NOT_IN_LOTS', 'MIN_FILL_ABOVE_STAKE', 'UNKNOWN_MARKET_CONTRACT', 'INVALID_LINE', 'BAD_SIGNATURE', 'ROLE_CONFLICT', 'CHAIN_UNREACHABLE', 'NOT_REGISTERED']);
  const { rows } = await pool.query<{ reason: string }>(`SELECT DISTINCT reason FROM events WHERE kind = 'order refused'`);
  const reasons = rows.map((r) => r.reason);
  assert.ok(reasons.length >= 8, `the refusals seen: ${reasons.join(', ')}`);
  for (const reason of reasons) assert.ok(!before.has(reason), `${reason} is a refusal before admission and must not be a line`);
  const counts = await refusedBeforeAdmission();
  for (const code of Object.keys(counts)) assert.ok(before.has(code) || code === 'NOT_FOUND' || code === 'HTTPS_REQUIRED', `${code} was counted before admission`);
});
