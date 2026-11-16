import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, keccak256, recoverTypedDataAddress, toBytes, type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { MATCHING_ABI, MULTICALL_ABI, MULTICALL_ADDRESS } from '../courier/chain/abi';
import { orderHash, orderSigner, splitNonce } from '../courier/orders/order';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import {
  cancelAll,
  cancelOnChain,
  contractHash,
  crossFromTheTest,
  crossRefusal,
  domainOf,
  grantAgent,
  liftCap,
  nextOrderNumber,
  nonceOf,
  ORDER_TYPE,
  orderOn,
  post,
  postOrder,
  postOrderAs,
  raiseFloor,
  refusedForm,
  revokeAgent,
  sign,
  wire,
  type Answer,
  type Order,
} from './support/orders';
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
  const { rows } = await pool.query<Line>(`SELECT kind, order_hash, account, game_id, reason, facts FROM events ${where} ORDER BY number`);
  return rows;
}

async function orderRow(hash: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE hash = $1`, [hash.toLowerCase()]);
  return (rows[0] as Record<string, unknown>) ?? null;
}

async function refusedBeforeAdmission(): Promise<Record<string, number>> {
  return ((await get(url(), '/v1/status')).body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode;
}

/**
 * The node's answer to the door's one call, with the matching contract's answer for its cap replaced: the chain
 * made to say another cap. The contract's TAKING_STAKE_CAP is a constant, so the contracts cannot give the door
 * another value; the proxy, the door's only source, can.
 */
function withCapAnswered(params: unknown[], result: unknown, capCall: Hex, cap: bigint): unknown {
  const call = params[0] as { to?: string; data?: Hex } | undefined;
  if (typeof result !== 'string' || call?.to?.toLowerCase() !== MULTICALL_ADDRESS.toLowerCase() || call.data === undefined) return result;
  const decoded = decodeFunctionData({ abi: MULTICALL_ABI, data: call.data });
  if (decoded.functionName !== 'aggregate3') return result;
  const calls = decoded.args[0] as ReadonlyArray<{ callData: Hex }>;
  const answers = [...(decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result as Hex }) as ReadonlyArray<{ success: boolean; returnData: Hex }>)];
  calls.forEach((c, i) => {
    if (c.callData.toLowerCase() === capCall.toLowerCase()) answers[i] = { success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [cap]) };
  });
  return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', result: answers });
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

  assert.equal(served.body.chainTime, T.toString(), 'the record carries the chain\'s time it was taken at');

  // The same order again: the record, 200, and nothing written. It is the first answer, the chain's time included,
  // and stays so after the chain's clock has moved: a repeat is answered from the record and asks the chain nothing.
  const again = await post(url(), '/v1/orders', { role: 'rest', order: wire(order), signature: posted.signature });
  assert.equal(again.status, 200);
  assert.equal(again.body.recordNumber, posted.body.recordNumber);
  assert.equal(again.body.chainTime, T.toString(), 'the repeat carries the first answer\'s chain time');
  assert.equal((await lines()).length, linesBefore + 1, 'a repeat writes no line');
  await rig.increaseTime(7n);
  assert.ok((await rig.time()) > T, 'the chain\'s clock has moved');
  const chainCalls = stack.proxy.count();
  const later = await post(url(), '/v1/orders', { role: 'rest', order: wire(order), signature: posted.signature });
  assert.equal(later.status, 200);
  assert.deepEqual(later.body, posted.body, 'the repeat is the first answer, whole');
  assert.equal(stack.proxy.count(), chainCalls, 'a repeat asks the chain nothing');
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

test("a request that never arrives whole is closed by the courier at its own ten seconds, answered 408, and counted as no refusal; the same bytes sent whole are answered at once", async () => {
  const countsBefore = await refusedBeforeAdmission();
  const started = Date.now();
  // Headers whole, a body announced at 4,000 bytes and sent to its fifteenth: then nothing, for as long as the courier
  // allows. Node's own default would hold this for five minutes; the test gives up at 25 seconds.
  const outcome = await new Promise<{ closed: boolean; answer: string; elapsedMs: number }>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: stack.courier.port });
    let answer = '';
    socket.on('data', (c: Buffer) => {
      answer += c.toString('utf8');
    });
    socket.on('connect', () => socket.write('POST /v1/orders HTTP/1.1\r\nHost: courier\r\nContent-Type: application/json\r\nContent-Length: 4000\r\n\r\n{"role":"rest",'));
    socket.on('close', () => resolve({ closed: true, answer, elapsedMs: Date.now() - started }));
    socket.on('error', () => undefined);
    setTimeout(() => {
      socket.destroy();
      resolve({ closed: false, answer, elapsedMs: Date.now() - started });
    }, 25_000).unref();
  });
  assert.ok(outcome.closed, `the courier closed the connection; what it answered: ${JSON.stringify(outcome.answer)}`);
  assert.ok(outcome.elapsedMs >= 9_000 && outcome.elapsedMs < 20_000, `closed at the courier's own ten seconds, not at another's number: ${outcome.elapsedMs} ms`);
  assert.match(outcome.answer, /^HTTP\/1\.1 408/, 'answered 408');
  const countsAfter = await refusedBeforeAdmission();
  assert.equal(countsAfter.BODY_TOO_LARGE ?? 0, countsBefore.BODY_TOO_LARGE ?? 0, 'a request cut short is not a body too large');
  assert.equal(countsAfter.INVALID_PARAM ?? 0, countsBefore.INVALID_PARAM ?? 0, 'nor a bad body');
  // The control: the same bytes, sent whole, are read and answered at once (not JSON).
  const whole = await post(url(), '/v1/orders', '{"role":"rest",');
  assert.equal(whole.status, 400);
  assert.equal(whole.body.code, 'INVALID_PARAM');
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
  const written = (await pool.query('SELECT start, start_unreadable_at FROM games WHERE game_id = $1', [unwritten.toString()])).rows[0] as Record<string, unknown>;
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
  await raiseFloor(rig, maker, maker.address, under, under.nonce + 1n);
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
  assert.equal(at.body.chainTime, T.toString(), 'a bet\'s record carries the chain\'s time too');
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

  // The cap is the chain's answer, not a number the courier holds. The contract's cap is a constant, so the chain is
  // made to answer 20,000 at the proxy, the door's only source: told 20,000, the door names it and takes 15,000,
  // which the contract's own 10,000 would refuse; the chain answering 10,000 again, 15,000 is refused.
  const capCall = encodeFunctionData({ abi: rig.abis.OspexMatching as Abi, functionName: 'TAKING_STAKE_CAP', args: [] } as never);
  stack.proxy.rule('eth_call', { kind: 'rewriteResult', result: (params, result) => withCapAnswered(params, result, capCall, 20_000n) });
  try {
    const toldOver = await postOrder(url(), rig, maker, 'take', orderOn(rig, maker, { expiry: T + 20n, riskAmount: 20_100n, positionType: 1 }));
    assert.equal(toldOver.body.code, 'ABOVE_CAP', JSON.stringify(toldOver.body));
    assert.equal(toldOver.body.error, 'Bets are capped at 0.02 USDC until the cap is lifted. This bet is signed for 0.0201 USDC. Nothing was sent.');
    const toldUnder = await postOrder(url(), rig, maker, 'take', orderOn(rig, maker, { expiry: T + 20n, riskAmount: 15_000n, positionType: 1 }));
    assert.equal(toldUnder.status, 202, `told a cap of 20,000, 15,000 is taken: ${JSON.stringify(toldUnder.body)}`);
  } finally {
    stack.proxy.rule('eth_call', null);
  }
  const chainsOwn = await postOrder(url(), rig, maker, 'take', orderOn(rig, maker, { expiry: T + 20n, riskAmount: 15_000n, positionType: 1 }));
  assert.equal(chainsOwn.body.code, 'ABOVE_CAP', `the chain's own answer again: ${JSON.stringify(chainsOwn.body)}`);

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

/** The account's unended quote rows on a market and side, by hash, with how each ended and at which block. */
async function unendedRows(who: HDAccount, side: 0 | 1 = 0): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE account = $1 AND role = 'rest' AND side = $2 AND ended IS NULL`, [who.address.toLowerCase(), side]);
  return rows[0]?.n ?? -1;
}

async function marks(hashes: string[]): Promise<Array<{ ended: string | null; block: string | null; hash: string | null }>> {
  const { rows } = await pool.query<{ ended: string | null; block: string | null; hash: string | null }>(
    `SELECT ended, ended_block::text AS block, ended_block_hash AS hash FROM orders WHERE hash = ANY($1::text[]) ORDER BY record_number`,
    [hashes.map((h) => h.toLowerCase())],
  );
  return rows;
}

test('the count of standing quotes is one page and at most one read of the chain: sixteen quotes cancelled on chain are marked cancelled, at the block read, by the first post that finds sixteen standing, and hide no live quote; sixteen replacements are taken, the seventeenth is refused; one live replacement cancelled makes room for one, a quote already marked and cancelled again makes none', async () => {
  const who = rig.account(10);
  await rig.fund(who);
  const T = await rig.time();
  const market = { scorer: rig.addresses.total, lineTicks: 2_305 };
  const first: Order[] = [];
  const firstHashes: string[] = [];
  for (let i = 0; i < 16; i++) {
    const q = orderOn(rig, who, { expiry: T + 3_600n, ...market });
    const answer = await postOrder(url(), rig, who, 'rest', q);
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    first.push(q);
    firstHashes.push(answer.body.orderHash as string);
  }
  for (const q of first) await cancelOnChain(rig, who, q);
  assert.equal(await unendedRows(who), 16, 'cancelled on chain, the sixteen stand in the records until a request asks the chain about them');

  // The first replacement finds sixteen standing, asks the chain once about them, marks the sixteen it shows cancelled
  // at the block it read, and is taken. The replacements expire an hour before the cancelled sixteen, so every one of
  // them would stand behind the sixteen in the index: the mark is what makes room, not the order.
  const head = await rig.publicClient.getBlock();
  const callsBefore = stack.proxy.count('eth_call');
  const taken = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 1_800n, ...market }));
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.equal(stack.proxy.count('eth_call') - callsBefore, 2, "the door's own read and one read of the sixteen");
  const marked = await marks(firstHashes);
  assert.equal(marked.length, 16);
  for (const m of marked) assert.deepEqual(m, { ended: 'cancelled', block: head.number.toString(), hash: head.hash.toLowerCase() }, 'marked cancelled at the block the chain was read at');
  assert.equal(await unendedRows(who), 1);

  // Fifteen more replacements, each with fewer than sixteen standing: the chain is asked nothing about the quotes.
  const replacements: Order[] = [];
  for (let i = 1; i < 16; i++) {
    const before = stack.proxy.count('eth_call');
    const q = orderOn(rig, who, { expiry: T + 1_800n, ...market });
    const answer = await postOrder(url(), rig, who, 'rest', q);
    assert.equal(answer.status, 201, `replacement ${i + 1}: ${JSON.stringify(answer.body)}`);
    assert.equal(stack.proxy.count('eth_call') - before, 1, `replacement ${i + 1}: the door's own read and no other`);
    replacements.push(q);
  }
  const seventeenth = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 1_800n, ...market }));
  assert.equal(seventeenth.status, 422, JSON.stringify(seventeenth.body));
  assert.equal(seventeenth.body.code, 'TOO_MANY_QUOTES');
  assert.equal(seventeenth.body.error, 'This account holds 16 live quotes on this side of this market; the bound is 16.');
  assert.equal(await unendedRows(who), 16, 'the sixteen replacements stand; the cancelled sixteen are marked');

  // One live replacement cancelled on chain makes room for one: found by the next post's one read, marked, and the post taken.
  await cancelOnChain(rig, who, replacements[0] as Order);
  const roomBefore = stack.proxy.count('eth_call');
  const room = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 1_800n, ...market }));
  assert.equal(room.status, 201, JSON.stringify(room.body));
  assert.equal(stack.proxy.count('eth_call') - roomBefore, 2);
  assert.equal((await marks([await contractHash(rig, replacements[0] as Order)]))[0]?.ended, 'cancelled');
  // A quote already marked, cancelled on chain again, makes none: it is not asked about again.
  await cancelOnChain(rig, who, first[0] as Order);
  const none = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 1_800n, ...market }));
  assert.equal(none.body.code, 'TOO_MANY_QUOTES', 'a quote already marked makes no room');
  assert.equal(await unendedRows(who), 16);

  // The record of a marked quote says how and at which block.
  const served = await get(url(), `/v1/orders/${firstHashes[0]}`);
  assert.equal(served.status, 200);
  assert.equal(served.body.state, 'cancelled');
  assert.equal(served.body.ended, 'cancelled');
  assert.equal(typeof served.body.endedAt, 'string');
  assert.deepEqual(served.body.endedBlock, { number: head.number.toString(), hash: head.hash.toLowerCase() });
  // A live quote's record carries no such block.
  assert.equal((await get(url(), `/v1/orders/${taken.body.orderHash}`)).body.endedBlock, null);
});

test('one post is one page and at most one read of the chain for the quotes, whatever the account has posted: 256 quotes ended by floor raises, the 257th post included; then 256 rows planted under the floor, a state the door cannot make, each post one read, marking sixteen, refused until the side is clear', async () => {
  const who = rig.account(13);
  await rig.fund(who);
  const market = { scorer: rig.addresses.spread, lineTicks: -1_235 };
  let T = await rig.time();
  const requests: number[] = [];
  const quoteReads: number[] = [];
  const postOne = async (positionType: 0 | 1) => {
    const before = { all: stack.proxy.count(), calls: stack.proxy.count('eth_call') };
    const q = orderOn(rig, who, { expiry: T + 3_600n, ...market, positionType });
    const answer = await postOrder(url(), rig, who, 'rest', q);
    requests.push(stack.proxy.count() - before.all);
    // The door's own read is one eth_call; a read of the quotes is one more.
    quoteReads.push(stack.proxy.count('eth_call') - before.calls - 1);
    return { ...answer, order: q };
  };

  // Sixteen batches of sixteen quotes, each batch ended by one raise of the account's floor above its nonces. The
  // account's budget is 240 at once and 12 a minute of the chain's time, so the chain's clock is moved for the rest.
  for (let batch = 0; batch < 16; batch++) {
    if (batch === 15) {
      await rig.increaseTime(90n);
      T = await rig.time();
    }
    let top = 0n;
    let one: Order | null = null;
    for (let i = 0; i < 16; i++) {
      const answer = await postOne(0);
      assert.equal(answer.status, 201, `batch ${batch}, post ${i}: ${JSON.stringify(answer.body)}`);
      if (answer.order.nonce > top) top = answer.order.nonce;
      one = answer.order;
    }
    await raiseFloor(rig, who, who.address, one as Order, top + 1n);
  }
  // The 257th finds the last batch's sixteen standing, asks once, marks them, and is taken.
  const last = await postOne(0);
  assert.equal(last.status, 201, JSON.stringify(last.body));
  assert.equal(requests.length, 257);
  assert.ok(requests.every((n) => n <= 3), `at most three requests to the chain a post (one header, the door's read, one read of the quotes): ${JSON.stringify(requests)}`);
  assert.ok(quoteReads.every((n) => n <= 1), `at most one read of the quotes a post: ${JSON.stringify(quoteReads)}`);
  assert.equal(quoteReads.filter((n) => n === 1).length, 16, 'the chain was asked about the quotes once per sixteen posted: at each post that found sixteen standing');
  assert.equal(Number((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE account = $1 AND ended = 'cancelled'`, [who.address.toLowerCase()])).rows[0]?.n), 256, 'the 256 ended by the floor are marked');
  assert.equal(await unendedRows(who, 0), 1);

  // A state the door cannot make: 256 unended rows planted on the other side, every nonce under the floor. Each post
  // is one page and one read, marks sixteen, and is refused until the side is clear; the sixteenth clears it.
  const key = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [rig.gameId, market.scorer, market.lineTicks]));
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time)
     SELECT '0x' || lpad(to_hex(900000000 + i), 64, '0'), 'rest', $1, $2, $3, $4, 1, 200, 1000000, i, $5, 0, '0x' || repeat('ab', 65), $6, 1, 1, '0x' || repeat('cd', 32), 1
     FROM generate_series(1, 256) AS i`,
    [who.address.toLowerCase(), rig.gameId.toString(), market.scorer.toLowerCase(), market.lineTicks, (T + 3_600n).toString(), key.toLowerCase()],
  );
  assert.equal(await unendedRows(who, 1), 256);
  await rig.increaseTime(90n);
  T = await rig.time();
  for (let i = 0; i < 16; i++) {
    const answer = await postOne(1);
    const left = 256 - 16 * (i + 1);
    assert.equal(answer.status, i < 15 ? 422 : 201, `planted post ${i + 1}: ${JSON.stringify(answer.body)}`);
    if (i < 15) assert.equal(answer.body.error, `This account holds 16${left > 16 ? ' or more' : ''} live quotes on this side of this market; the bound is 16.`, `planted post ${i + 1}: the count read again after the mark`);
    assert.equal(quoteReads[quoteReads.length - 1], 1, `planted post ${i + 1}: one read of the quotes`);
    assert.equal(requests[requests.length - 1], 3);
    assert.equal(await unendedRows(who, 1), left + (i < 15 ? 0 : 1), `planted post ${i + 1}: sixteen marked`);
  }
});

test("each read of the chain is tried once more, so a post at the cap makes at most six requests to the node: with every read failing once at the proxy the post is answered as it would be without the failures, in six requests and with no condition opened; without the failures, in three", async () => {
  const who = rig.account(17);
  await rig.fund(who);
  const T = await rig.time();
  const market = { scorer: rig.addresses.spread, lineTicks: -1_405 };
  for (let i = 0; i < 16; i++) {
    const answer = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
  }
  // Every read fails once: of each method, the first request since the rule was set is refused, the second passes,
  // the third refused, the fourth passes. A post at the cap reads the header, its own state and the sixteen's.
  const odd = (nth: number) => nth % 2 === 1;
  stack.proxy.rule('eth_getBlockByNumber', { kind: 'refuseWhen', refuse: odd, code: -32000, message: 'held for the test' });
  stack.proxy.rule('eth_call', { kind: 'refuseWhen', refuse: odd, code: -32000, message: 'held for the test' });
  const before = { headers: stack.proxy.count('eth_getBlockByNumber'), calls: stack.proxy.count('eth_call'), all: stack.proxy.count() };
  let withFailures;
  try {
    withFailures = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  } finally {
    stack.proxy.rule('eth_getBlockByNumber', null);
    stack.proxy.rule('eth_call', null);
  }
  assert.equal(withFailures.status, 422, JSON.stringify(withFailures.body));
  assert.equal(withFailures.body.code, 'TOO_MANY_QUOTES', 'answered as it would be without the failures');
  assert.deepEqual(
    { headers: stack.proxy.count('eth_getBlockByNumber') - before.headers, calls: stack.proxy.count('eth_call') - before.calls, all: stack.proxy.count() - before.all },
    { headers: 2, calls: 4, all: 6 },
    'the header twice, the door\'s read twice, the sixteen\'s read twice: six',
  );
  assert.deepEqual((await get(url(), '/v1/status')).body.conditions, [], 'a read that fails once and succeeds once more opens no condition');
  // Without the failures: three.
  const again = { all: stack.proxy.count() };
  const plain = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  assert.equal(plain.body.code, 'TOO_MANY_QUOTES');
  assert.equal(stack.proxy.count() - again.all, 3);

  // The retry's limit: the sixteen's read failing both its tries is CHAIN_UNREACHABLE, exactly two requests of it and no
  // third, and the condition opens; the next read that succeeds clears it. (The door's own read, the first eth_call
  // since the rule was set, passes.)
  stack.proxy.rule('eth_call', { kind: 'refuseWhen', refuse: (nth) => nth >= 2, code: -32000, message: 'held for the test' });
  const limit = { calls: stack.proxy.count('eth_call') };
  let unreachable;
  try {
    unreachable = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  } finally {
    stack.proxy.rule('eth_call', null);
  }
  assert.equal(unreachable.status, 503, JSON.stringify(unreachable.body));
  assert.equal(unreachable.body.code, 'CHAIN_UNREACHABLE');
  assert.equal(stack.proxy.count('eth_call') - limit.calls, 3, "the door's read once, the sixteen's read twice, and no third try");
  assert.deepEqual(((await get(url(), '/v1/status')).body.conditions as Array<{ key: string }>).map((c) => c.key), ['chain-unreachable'], 'two failures open the condition');
  const recovered = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  assert.equal(recovered.body.code, 'TOO_MANY_QUOTES');
  assert.deepEqual((await get(url(), '/v1/status')).body.conditions, [], 'the next read that succeeds clears it');
});

test("the door's page is the sixteen with the newest expiry, by the numbers: a planted set where the page's order decides the answer, record numbers 9,990 to 10,015 at one expiry, the upper sixteen under the floor and the lower ten live; the post marks the sixteen and is admitted", async () => {
  const who = rig.account(18);
  await rig.fund(who);
  const T = await rig.time();
  const market = { scorer: rig.addresses.total, lineTicks: 2_605 };
  // The account's floor on this market at 500: a planted nonce under it is ended on chain, one above it is live.
  await raiseFloor(rig, who, who.address, orderOn(rig, who, { expiry: T + 3_600n, ...market }), 500n);
  const key = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [rig.gameId, market.scorer, market.lineTicks]));
  await pool.query(
    `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time, record_number)
     SELECT '0x' || lpad(to_hex(800000000 + i), 64, '0'), 'rest', $1, $2, $3, $4, 0, 200, 1000000, CASE WHEN i >= 10000 THEN i - 9999 ELSE 600 + i - 9990 END, $5, 0, '0x' || repeat('ab', 65), $6, 0, 1, '0x' || repeat('cd', 32), 1, i
     FROM generate_series(9990, 10015) AS i`,
    [who.address.toLowerCase(), rig.gameId.toString(), market.scorer.toLowerCase(), market.lineTicks, (T + 3_600n).toString(), key.toLowerCase()],
  );
  // As text, "9999" sorts above "10015": a page ordered by the text holds the ten live and six of the sixteen, marks
  // six, recounts twenty, and refuses. By the numbers it holds the sixteen under the floor, marks them all, recounts
  // ten, and admits.
  const posted = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }));
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const { rows } = await pool.query<{ record_number: string; ended: string | null }>(
    // Read with no cast, so this ORDER BY is the column's, the numbers': cast to text and named after the column, the
    // output would have taken the bare name, and the rows would have come back in the text's order.
    `SELECT record_number, ended FROM orders WHERE account = $1 AND record_number BETWEEN 9990 AND 10015 ORDER BY record_number`,
    [who.address.toLowerCase()],
  );
  assert.deepEqual(rows.filter((r) => r.ended === 'cancelled').map((r) => Number(r.record_number)), Array.from({ length: 16 }, (_, i) => 10_000 + i), 'the sixteen under the floor are marked');
  assert.deepEqual(rows.filter((r) => r.ended === null).map((r) => Number(r.record_number)), Array.from({ length: 10 }, (_, i) => 9_990 + i), 'the ten live stand');
  assert.equal(await unendedRows(who), 11, 'the ten and the one admitted');
});

test("a quote the chain shows filled, with less than a lot of its stake left, is marked filled at the block read, by the door and by the market's page alike: sixteen quotes of one account, three filled on chain by the rig; the next post is 201 and the three are marked with their block; the page lists them no more; a quote partly filled with a lot or more left is still listed and still counted", async () => {
  const who = rig.account(19);
  await rig.fund(who);
  const taker = rig.accounts.taker;
  const T = await rig.time();
  const market = { scorer: rig.addresses.spread, lineTicks: 345 };
  const quotes: Order[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < 16; i++) {
    const q = orderOn(rig, who, { expiry: T + 3_600n, oddsTick: 200, riskAmount: 10_000n, ...market });
    const answer = await postOrder(url(), rig, who, 'rest', q);
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    quotes.push(q);
    hashes.push(answer.body.orderHash as string);
  }
  // The rig fills three whole and a fourth in part (4,000 of 10,000: sixty lots left), each one Cross sent through
  // the relay from its sender. The courier is not involved: nothing in it signs or sends.
  const fill = async (q: Order, riskAmount: bigint) => {
    const bet: Order = { ...orderOn(rig, taker, { expiry: (await rig.time()) + 20n, oddsTick: 200, riskAmount, ...market }), positionType: 1 };
    const sent = await crossFromTheTest(rig, { order: bet, signature: await sign(taker, bet, 31337, rig.addresses.matching) }, [{ order: q, signature: await sign(who, q, 31337, rig.addresses.matching) }]);
    assert.equal(sent.filled, true, JSON.stringify(sent));
  };
  for (const q of quotes.slice(0, 3)) await fill(q, 10_000n);
  await fill(quotes[3] as Order, 4_000n);
  assert.equal(await unendedRows(who), 16, 'filled on chain, the four stand in the records until a request asks the chain about them');

  // The next post finds sixteen standing, asks the chain once, marks the three filled at the block it read, and is taken.
  const head = await rig.publicClient.getBlock();
  const callsBefore = stack.proxy.count('eth_call');
  const taken = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, oddsTick: 200, riskAmount: 10_000n, ...market }));
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.equal(stack.proxy.count('eth_call') - callsBefore, 2, "the door's own read and one read of the sixteen");
  for (const m of await marks(hashes.slice(0, 3))) assert.deepEqual(m, { ended: 'filled', block: head.number.toString(), hash: head.hash.toLowerCase() }, 'marked filled at the block the chain was read at');
  assert.deepEqual((await marks([hashes[3] as string]))[0], { ended: null, block: null, hash: null }, 'partly filled with sixty lots left: not an end');
  assert.equal(await unendedRows(who), 14, 'thirteen standing and the one admitted');
  const served = await get(url(), `/v1/orders/${hashes[0]}`);
  assert.equal(served.body.state, 'filled');
  assert.deepEqual(served.body.endedBlock, { number: head.number.toString(), hash: head.hash.toLowerCase() });

  // The market's page: the three are listed no more; the partly filled one is listed with what remains; the new one is listed.
  type Side = { quotes: Array<{ orderHash: string; remaining: string }>; markedFilled: number; markedCancelled: number; endedOnChain: number };
  const pageOf = async (): Promise<Side> => ((await get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=A`)).body.sides as { A: Side }).A;
  const page1 = await pageOf();
  assert.equal(page1.quotes.length, 14);
  assert.ok(!page1.quotes.some((q) => hashes.slice(0, 3).includes(q.orderHash)), 'the three filled are not listed');
  assert.equal(page1.quotes.find((q) => q.orderHash === hashes[3])?.remaining, '6000', 'the partly filled one is listed with what remains');
  assert.deepEqual({ filled: page1.markedFilled, cancelled: page1.markedCancelled, ended: page1.endedOnChain }, { filled: 0, cancelled: 0, ended: 0 }, 'the door marked the three; the page is returned them no more');

  // The page marks too: a fifth filled whole after the post is listed no more and marked at the block the page read.
  await fill(quotes[4] as Order, 10_000n);
  const head2 = await rig.publicClient.getBlock();
  const page2 = await pageOf();
  assert.deepEqual({ listed: page2.quotes.length, filled: page2.markedFilled, ended: page2.endedOnChain }, { listed: 13, filled: 1, ended: 1 });
  assert.deepEqual((await marks([hashes[4] as string]))[0], { ended: 'filled', block: head2.number.toString(), hash: head2.hash.toLowerCase() });

  // Still counted: the partly filled quote is one of the sixteen. Three more posts fill the count; the next is refused.
  for (let i = 0; i < 3; i++) assert.equal((await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, oddsTick: 200, riskAmount: 10_000n, ...market }))).status, 201, `more ${i}`);
  assert.equal(await unendedRows(who), 16);
  const seventeenth = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, oddsTick: 200, riskAmount: 10_000n, ...market }));
  assert.equal(seventeenth.body.code, 'TOO_MANY_QUOTES', JSON.stringify(seventeenth.body));
  assert.equal(await unendedRows(who), 16, 'the partly filled quote counts: sixty lots can still fill');
});

// ──────────────────────────── the version, the floor and the grant ────────

/** One side of one market's page, as the courier serves it. */
interface SideServed {
  quotes: Array<{ orderHash: string; account: string; remaining: string }>;
  live: number;
  endedOnChain: number;
  markedCancelled: number;
  markedFilled: number;
}

async function sideOf(market: { scorer: Address; lineTicks: number }, side: 'A' | 'B'): Promise<SideServed> {
  const page = await get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=${side}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return (page.body.sides as Record<string, SideServed>)[side] as SideServed;
}

/** The floor the chain holds for an account on a line at a version. */
async function floorOnChain(account: Address, version: bigint, line: { scorer: Address; lineTicks: number }): Promise<bigint> {
  const key = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [rig.gameId, line.scorer, line.lineTicks]));
  return BigInt(await rig.publicClient.readContract({ address: rig.addresses.matching, abi: MATCHING_ABI, functionName: 's_floors', args: [account, version, key] }));
}

interface BudgetRow {
  row_version: string;
  account: string;
  budget: string;
  budget_at: Date;
  refused: string;
  last_refused_at: Date | null;
  first_seen_at: Date;
}

/**
 * The two budget rows a post for this account could touch, the account's and the courier's, each whole and with its
 * row version: any write to a row changes the version, even one that sets what the row already held.
 */
async function budgetRows(account: Address): Promise<BudgetRow[]> {
  const { rows } = await pool.query<BudgetRow>(
    `SELECT a.xmin::text AS row_version, a.account, a.budget, a.budget_at, a.refused, a.last_refused_at, a.first_seen_at
     FROM accounts a WHERE a.account = ANY($1::text[]) ORDER BY a.account`,
    [[account.toLowerCase(), 'courier']],
  );
  return rows;
}

/**
 * Sends one post for an order of `account` and asserts it cost the account nothing and left nothing: both budget
 * rows as they were, each with a budget it could have been taken from; no line written, of any kind; no row for the
 * order. Returns the answer, for the caller to judge.
 */
async function costsNothing(account: Address, order: Order, send: () => Promise<Answer>): Promise<Answer> {
  const hash = await contractHash(rig, order);
  const rowsBefore = await budgetRows(account);
  assert.equal(rowsBefore.length, 2, 'the account and the courier each hold a budget row before the post');
  for (const row of rowsBefore) assert.ok(Number(row.budget) >= 1, `${row.account} has a budget to be taken from: ${row.budget}`);
  const linesBefore = (await lines()).length;
  const answer = await send();
  assert.deepEqual(await budgetRows(account), rowsBefore, `both budget rows are as they were: ${JSON.stringify(answer.body)}`);
  assert.equal((await lines()).length, linesBefore, `no line was written: ${JSON.stringify(answer.body)}`);
  assert.equal(await orderRow(hash), null, 'the order holds no row');
  return answer;
}

/** A bet by the rig's taker against one quote: the other side, the same price, the stake the cap allows. */
async function betAgainst(quote: Order): Promise<{ order: Order; signature: Hex }> {
  const taker = rig.accounts.taker;
  const order: Order = { ...orderOn(rig, taker, { expiry: (await rig.time()) + 20n, oddsTick: quote.oddsTick, riskAmount: 10_000n, scorer: quote.scorer, lineTicks: quote.lineTicks }), positionType: quote.positionType === 0 ? 1 : 0 };
  return { order, signature: await sign(taker, order, 31337, rig.addresses.matching) };
}

test("the nonce's three numbers: one word of three literals, a version, a grant number and the top order number, is split by the pinned contract and by the courier into the same three; a plain small nonce is version 0, grant 0 and itself", async () => {
  // The word as the contract reads it: the version in the top 128 bits, the grant number in the next 32, the order
  // number in the low 96. Written here whole, and its three parts written beside it, none computed from another.
  const word = 0x0123456789abcdef0011223344556677_89abcdef_ffffffffffffffffffffffffn;
  const parts = { version: 0x0123456789abcdef0011223344556677n, grantNumber: 0x89abcdef, orderNumber: 79_228_162_514_264_337_593_543_950_335n };
  assert.equal(parts.orderNumber, 2n ** 96n - 1n, 'the order number is the top one');
  const onChain = async (nonce: bigint) => {
    const [version, grantNumber, orderNumber] = await rig.publicClient.readContract({ address: rig.addresses.matching, abi: MATCHING_ABI, functionName: 'splitNonce', args: [nonce] });
    return { version, grantNumber, orderNumber };
  };
  assert.deepEqual(await onChain(word), parts, "the pinned contract's split of the word");
  assert.deepEqual(splitNonce(word), parts, "the courier's split of the word");
  assert.equal(nonceOf(parts.version, parts.grantNumber, parts.orderNumber), word, 'the packing the other cases build their nonces with gives the word back');
  // The control: a nonce as an account that has cancelled nothing and granted nothing signs it.
  assert.deepEqual(await onChain(7n), { version: 0n, grantNumber: 0, orderNumber: 7n });
  assert.deepEqual(splitNonce(7n), { version: 0n, grantNumber: 0, orderNumber: 7n });
});

test("the version and the floor, as the contract judges them: an order is judged at the version its own nonce names and by its line's floor at that version; one under the floor is CANCELLED and one at it is taken; an order at a version the account has left is CANCELLED though above that version's floor; the floor of a version left decides nothing at the version the account is at; the top order number is taken under the highest floor a line can have", async () => {
  const who = rig.account(20);
  await rig.fund(who);
  const T = await rig.time();
  const line = { scorer: rig.addresses.spread, lineTicks: -2_015 };
  const at = (version: bigint, orderNumber: bigint, market: { scorer: Address; lineTicks: number } = line): Order => orderOn(rig, who, { expiry: T + 3_600n, ...market, nonce: nonceOf(version, 0, orderNumber) });
  const send = (order: Order) => postOrder(url(), rig, who, 'rest', order);
  const refused: Order[] = [];
  const cancelled = async (order: Order, what: string) => {
    const answer = await send(order);
    assert.equal(answer.status, 422, `${what}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, 'CANCELLED', what);
    refused.push(order);
  };
  const taken = async (order: Order, what: string) => {
    const answer = await send(order);
    assert.equal(answer.status, 201, `${what}: ${JSON.stringify(answer.body)}`);
    assert.equal((await orderRow(answer.body.orderHash as string))?.nonce, order.nonce.toString(), `${what}: the row holds the nonce whole`);
  };

  // Version 0, where an account begins. The line's floor raised to 50: 49 is under it, 50 is at it.
  await raiseFloor(rig, who, who.address, at(0n, 0n), 50n);
  await cancelled(at(0n, 49n), 'one under the floor, at version 0');
  await taken(at(0n, 50n), 'at the floor, at version 0');

  // The account cancels everything. It is at a new version, which the contract drew, and that version's floors are zero.
  const version = await cancelAll(rig, who);
  assert.ok(version > 0n, 'the account is at a version above zero');
  assert.deepEqual({ left: await floorOnChain(who.address, 0n, line), current: await floorOnChain(who.address, version, line) }, { left: 50n, current: 0n }, 'the floor of the version left stands at 50; the current version has none');
  // At the version left an order is dead, whatever its number: 60 is above that version's floor, and the version decides.
  await cancelled(at(0n, 60n), 'an order at the version the account has left, above that version\'s floor');
  // At the current version an order is judged by the current version's floor: 10 is under the 50 of the version left, and is taken.
  await taken(at(version, 10n), 'an order at the current version, under the floor of the version left');

  // The floor raised at the current version, to 5: 4 is under it, 5 is at it, and the 10 taken above still stands.
  await raiseFloor(rig, who, who.address, at(version, 0n), 5n);
  await cancelled(at(version, 4n), 'one under the floor, at the current version');
  await taken(at(version, 5n), 'at the floor, at the current version');

  // The highest floor a line can have is the top order number, 2^96 − 1, so that number is always signable: under that
  // floor the top number is taken and the one before it is not.
  const top = 2n ** 96n - 1n;
  const other = { scorer: rig.addresses.total, lineTicks: 2_915 };
  await raiseFloor(rig, who, who.address, at(version, 0n, other), top);
  await cancelled(at(version, top - 1n, other), 'one under the top order number, the floor at the top');
  await taken(at(version, top, other), 'the top order number, the floor at the top');

  // Each refusal here came after admission: a line, and no row.
  for (const order of refused) {
    const hash = (await contractHash(rig, order)).toLowerCase();
    assert.equal((await lines(`WHERE kind = 'order refused' AND reason = 'CANCELLED' AND order_hash = '${hash}'`)).length, 1, 'one line for the refusal');
    assert.equal(await orderRow(hash), null, 'a refused order holds no row');
  }
});

test("a cancel of everything moves the account to a new version: a new order at the version left is CANCELLED; every quote at the version left is marked cancelled at the block read, by the door's count and by the market's page alike; an order signed beforehand for the version the account moved to is taken and listed", async () => {
  const who = rig.account(21);
  await rig.fund(who);
  const T = await rig.time();
  const counted = { scorer: rig.addresses.spread, lineTicks: -2_025 };
  const paged = { scorer: rig.addresses.total, lineTicks: 2_925 };
  const countedHashes: string[] = [];
  for (let i = 0; i < 16; i++) {
    const answer = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...counted }));
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    countedHashes.push(answer.body.orderHash as string);
  }
  const pagedHashes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const answer = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...paged }));
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    pagedHashes.push(answer.body.orderHash as string);
  }

  // The version a cancel of everything moves to is the current one plus one plus the first eight bytes of the hash of
  // the block before the cancel's own, so it is known once that block is mined. An order for it is signed here,
  // before the cancel is sent.
  const before = await rig.publicClient.getBlock();
  const next = 1n + BigInt(before.hash.slice(0, 18));
  const ahead = orderOn(rig, who, { expiry: T + 3_600n, ...counted, nonce: nonceOf(next, 0, nextOrderNumber()) });
  const aheadSignature = await sign(who, ahead, 31337, rig.addresses.matching);
  assert.equal(await cancelAll(rig, who), next, 'the version the contract drew is the one the order was signed for');
  assert.equal(await unendedRows(who), 19, 'cancelled on chain, the nineteen stand in the records until a request asks the chain about them');

  // A new order at the version left is refused at the door.
  const stale = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...paged }));
  assert.equal(stale.status, 422, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'CANCELLED');

  // The door's count: the order signed beforehand finds sixteen standing on its side, asks the chain once about them,
  // marks the sixteen it shows at the version left, at the block it read, and is taken.
  const head = await rig.publicClient.getBlock();
  const callsBefore = stack.proxy.count('eth_call');
  const taken = await post(url(), '/v1/orders', { role: 'rest', order: wire(ahead), signature: aheadSignature });
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.equal(stack.proxy.count('eth_call') - callsBefore, 2, "the door's own read and one read of the sixteen");
  const countedMarks = await marks(countedHashes);
  assert.equal(countedMarks.length, 16);
  for (const m of countedMarks) assert.deepEqual(m, { ended: 'cancelled', block: head.number.toString(), hash: head.hash.toLowerCase() }, 'marked cancelled at the block the door read');

  // The market's page: the three at the version left are not listed, and the page marks them at the block it read.
  const page = await sideOf(paged, 'A');
  assert.deepEqual({ listed: page.quotes.length, live: page.live, ended: page.endedOnChain, cancelled: page.markedCancelled }, { listed: 0, live: 3, ended: 3, cancelled: 3 });
  const pagedMarks = await marks(pagedHashes);
  assert.equal(pagedMarks.length, 3);
  for (const m of pagedMarks) assert.deepEqual(m, { ended: 'cancelled', block: head.number.toString(), hash: head.hash.toLowerCase() }, 'marked cancelled at the block the page read');

  // The order signed beforehand for the new version stands: listed, alone on its side, and nothing more is marked.
  const stands = await sideOf(counted, 'A');
  assert.deepEqual(stands.quotes.map((q) => q.orderHash), [taken.body.orderHash]);
  assert.deepEqual({ ended: stands.endedOnChain, cancelled: stands.markedCancelled }, { ended: 0, cancelled: 0 });
});

test("an agent's order at the door: signed by its grant's agent within the cap and the list it is admitted, listed under its account, and fills on chain; signed by the account's own key or by a stranger it is BAD_SIGNATURE; one lot over the cap is AGENT_STAKE_ABOVE_CAP, naming the cap; a line outside a grant's list is LINE_NOT_IN_GRANT, and any line passes a grant with no list; each refusal is before admission, and is the contract's own refusal of the same order", async () => {
  const owner = rig.account(22);
  const listed = rig.account(23);
  const agent = rig.account(24);
  const stranger = rig.accounts.stranger;
  await rig.fund(owner);
  await rig.fund(listed);
  const T = await rig.time();
  const cap = 1_000_000n;
  const line = { scorer: rig.addresses.spread, lineTicks: -2_035 };
  const offList = { scorer: rig.addresses.spread, lineTicks: -2_045 };
  // Two grants to the one key: the owner's with no list, which passes every market; the other account's naming one line.
  const g = await grantAgent(rig, owner, agent.address, cap, T + 100_000n);
  const gListed = await grantAgent(rig, listed, agent.address, cap, T + 100_000n, [{ gameId: rig.gameId, ...line }]);
  assert.deepEqual([g, gListed], [1, 1], "each account's first grant");
  assert.equal(await rig.publicClient.readContract({ address: rig.addresses.matching, abi: MATCHING_ABI, functionName: 'isLiveAgent', args: [owner.address, agent.address] }), true, 'the chain holds the key as the live agent');
  const under = (account: HDAccount, grant: number, fields: Partial<Order> = {}): Order => orderOn(rig, account, { expiry: T + 3_600n, oddsTick: 200, riskAmount: 10_000n, ...line, nonce: nonceOf(0n, grant, nextOrderNumber()), ...fields });
  const countsBefore = await refusedBeforeAdmission();
  const linesBefore = (await lines()).length;

  // Admitted: the agent's signature, the stake at the cap, any line. The record is the account's, the signature the agent's.
  const atCap = under(owner, g, { riskAmount: cap });
  const admitted = await postOrderAs(url(), rig, agent, 'rest', atCap);
  assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
  const row = await orderRow(admitted.body.orderHash as string);
  assert.deepEqual({ account: row?.account, nonce: String(row?.nonce), signature: row?.signature }, { account: owner.address.toLowerCase(), nonce: atCap.nonce.toString(), signature: admitted.signature.toLowerCase() });
  const elsewhere = await postOrderAs(url(), rig, agent, 'rest', under(owner, g, offList));
  assert.equal(elsewhere.status, 201, `a grant with no list passes every line: ${JSON.stringify(elsewhere.body)}`);
  assert.deepEqual((await sideOf(line, 'A')).quotes.map((q) => [q.orderHash, q.account]), [[admitted.body.orderHash, owner.address]], 'listed, under its account');
  assert.equal((await lines()).length, linesBefore + 2, 'each admitted order is a line');

  // Refused, each before admission, and each the contract's own refusal of the same order in a Cross.
  const refusals: Array<{ what: string; order: Order; signer: HDAccount; code: string; onChain: string }> = [
    { what: "the account's own key on a nonce under its grant", order: under(owner, g), signer: owner, code: 'BAD_SIGNATURE', onChain: 'OspexMatching__BadSignature' },
    { what: 'a stranger on a nonce under the grant', order: under(owner, g), signer: stranger, code: 'BAD_SIGNATURE', onChain: 'OspexMatching__BadSignature' },
    { what: 'a grant number the account never made', order: under(owner, g + 6), signer: agent, code: 'BAD_SIGNATURE', onChain: 'OspexMatching__NoSuchGrant' },
    { what: 'one lot over the cap', order: under(owner, g, { riskAmount: cap + 100n }), signer: agent, code: 'AGENT_STAKE_ABOVE_CAP', onChain: 'OspexMatching__AgentStakeAboveCap' },
    { what: "a line outside the grant's list", order: under(listed, gListed, offList), signer: agent, code: 'LINE_NOT_IN_GRANT', onChain: 'OspexMatching__LineNotInGrant' },
  ];
  for (const r of refusals) {
    const signature = await sign(r.signer, r.order, 31337, rig.addresses.matching);
    const answer = await post(url(), '/v1/orders', { role: 'rest', order: wire(r.order), signature });
    assert.equal(answer.status, 422, `${r.what}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, r.code, r.what);
    assert.equal(await orderRow(await contractHash(rig, r.order)), null, `${r.what}: no row`);
    const refusal = await crossRefusal(rig, await betAgainst(r.order), [{ order: r.order, signature }]);
    assert.equal(refusal?.name, r.onChain, `${r.what}: the contract's own refusal of a Cross that lists it`);
  }
  assert.equal((await lines()).length, linesBefore + 2, 'no refusal before admission is a line');
  const countsAfter = await refusedBeforeAdmission();
  assert.deepEqual(
    { bad: (countsAfter.BAD_SIGNATURE ?? 0) - (countsBefore.BAD_SIGNATURE ?? 0), cap: countsAfter.AGENT_STAKE_ABOVE_CAP ?? 0, list: countsAfter.LINE_NOT_IN_GRANT ?? 0 },
    { bad: 3, cap: (countsBefore.AGENT_STAKE_ABOVE_CAP ?? 0) + 1, list: (countsBefore.LINE_NOT_IN_GRANT ?? 0) + 1 },
    'each counted by its code',
  );
  // The cap is named, in the sentence and beside it.
  const overCap = under(owner, g, { riskAmount: cap + 100n });
  const over = await postOrderAs(url(), rig, agent, 'rest', overCap);
  assert.equal(over.body.error, 'Grant 1 lets its agent sign an order for 1.00 USDC at most. This order is signed for 1.0001 USDC.');
  assert.equal(over.body.stakeCap, cap.toString());

  // The controls. On the listed line the other account's grant admits; and the admitted order fills: one Cross sent by
  // the test from the relay's sender, the agent's signature on the quote.
  const onList = await postOrderAs(url(), rig, agent, 'rest', under(listed, gListed));
  assert.equal(onList.status, 201, `the line the grant names: ${JSON.stringify(onList.body)}`);
  const fills = under(owner, g);
  const fillsSignature = await sign(agent, fills, 31337, rig.addresses.matching);
  const sent = await crossFromTheTest(rig, await betAgainst(fills), [{ order: fills, signature: fillsSignature }]);
  assert.equal(sent.filled, true, `an order its grant's agent signed fills on chain: ${JSON.stringify(sent)}`);
});

test("an agent's order on record, posted again, is answered from the record and writes nothing, whoever signed the repeat and whatever became of its grant: the first answer whole, no chain read, no line, both budget rows as they were; under the other role it is a conflict", async () => {
  const owner = rig.account(35);
  const agent = rig.account(36);
  await rig.fund(owner);
  const T = await rig.time();
  const line = { scorer: rig.addresses.spread, lineTicks: -2_095 };
  const g = await grantAgent(rig, owner, agent.address, 1_000_000n, T + 100_000n);
  const order = orderOn(rig, owner, { expiry: T + 3_600n, ...line, nonce: nonceOf(0n, g, nextOrderNumber()) });
  const first = await postOrderAs(url(), rig, agent, 'rest', order);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.signature, first.signature.toLowerCase(), "the record carries the agent's signature");
  const rowsBefore = await budgetRows(owner.address);
  const linesBefore = (await lines()).length;
  const chainCalls = stack.proxy.count();

  // The agent's own repeat is the record.
  const again = await post(url(), '/v1/orders', { role: 'rest', order: wire(order), signature: first.signature });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, first.body);
  // A repeat carrying a stranger's signature is answered with the same record, which anyone can read by its hash: it
  // is no admission, and the record still carries the agent's signature.
  const strangers = await postOrderAs(url(), rig, rig.accounts.stranger, 'rest', order);
  assert.equal(strangers.status, 200, JSON.stringify(strangers.body));
  assert.deepEqual(strangers.body, first.body);
  assert.deepEqual((await get(url(), `/v1/orders/${first.body.orderHash}`)).body, first.body, 'the record anyone is served by its hash');
  // The grant revoked, a repeat is still the record as it stands: a repeat judges nothing, and the quote's end is
  // the next read of the chain's to mark.
  await revokeAgent(rig, owner);
  const afterRevoke = await post(url(), '/v1/orders', { role: 'rest', order: wire(order), signature: first.signature });
  assert.equal(afterRevoke.status, 200, JSON.stringify(afterRevoke.body));
  assert.deepEqual(afterRevoke.body, first.body);
  // Under the other role: a conflict.
  const conflict = await post(url(), '/v1/orders', { role: 'take', order: wire(order), signature: first.signature });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, 'ROLE_CONFLICT');

  assert.equal(stack.proxy.count(), chainCalls, 'no repeat asked the chain anything');
  assert.deepEqual(await budgetRows(owner.address), rowsBefore, 'both budget rows are as they were');
  assert.equal((await lines()).length, linesBefore, 'no line was written');
  assert.equal(Number((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE account = $1', [owner.address.toLowerCase()])).rows[0]?.n), 1, 'one row, the first post\'s');
});

test("a grant number forged on another account's order costs that account nothing: a stranger's signature under the victim's standing grant, and under a number the victim never made, is BAD_SIGNATURE with both budget rows as they were, no line and no row; the grant's own agent's order is admitted and takes from both", async () => {
  const victim = rig.account(25);
  const agent = rig.account(26);
  const stranger = rig.accounts.stranger;
  await rig.fund(victim);
  const T = await rig.time();
  const line = { scorer: rig.addresses.spread, lineTicks: -2_055 };
  // The victim is registered, has an order admitted (so it holds a budget row, as the courier does), and has a grant standing.
  assert.equal((await postOrder(url(), rig, victim, 'rest', orderOn(rig, victim, { expiry: T + 3_600n, ...line }))).status, 201);
  const g = await grantAgent(rig, victim, agent.address, 1_000_000n, T + 100_000n);
  const under = (grant: number): Order => orderOn(rig, victim, { expiry: T + 3_600n, ...line, nonce: nonceOf(0n, grant, nextOrderNumber()) });
  const countsBefore = (await refusedBeforeAdmission()).BAD_SIGNATURE ?? 0;

  for (const [what, grant] of [['the standing grant', g], ['a number never made', g + 41]] as Array<[string, number]>) {
    for (const role of ['rest', 'take'] as const) {
      const forged = under(grant);
      const answer = await costsNothing(victim.address, forged, () => postOrderAs(url(), rig, stranger, role, forged));
      assert.equal(answer.status, 422, `${what}, ${role}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.code, 'BAD_SIGNATURE', `${what}, ${role}`);
    }
  }
  assert.equal(((await refusedBeforeAdmission()).BAD_SIGNATURE ?? 0) - countsBefore, 4, 'each counted, by its code');

  // The control: the same shape signed by the grant's agent is admitted, and both rows are written.
  const rowsBefore = await budgetRows(victim.address);
  const real = await postOrderAs(url(), rig, agent, 'rest', under(g));
  assert.equal(real.status, 201, JSON.stringify(real.body));
  const rowsAfter = await budgetRows(victim.address);
  assert.deepEqual(rowsAfter.map((r, i) => r.row_version !== rowsBefore[i]?.row_version), [true, true], 'an admitted order writes both budget rows: the witness above can see a debit');
});

test("a grant's standing, exact: its agent's order is taken while the grant ends at the chain's time plus two, and is GRANT_GONE once it ends at the chain's time plus one, with no margin; the quote taken is then marked cancelled; the contract's own side of the boundary; an order the account signs itself stands whatever its grant", async () => {
  const owner = rig.account(27);
  const agent = rig.account(28);
  await rig.fund(owner);
  const line = { scorer: rig.addresses.spread, lineTicks: -2_065 };
  const ends = (await rig.time()) + 300n;
  const g = await grantAgent(rig, owner, agent.address, 1_000_000n, ends);
  const under = (fields: Partial<Order> = {}): Order => orderOn(rig, owner, { expiry: ends + 3_600n, oddsTick: 200, riskAmount: 10_000n, ...line, nonce: nonceOf(0n, g, nextOrderNumber()), ...fields });

  // The latest block two seconds before the grant's end: an order under it can fill in the next block, and is taken.
  await rig.setNextBlockTime(ends - 2n);
  await rig.mine(1);
  assert.equal(await rig.time(), ends - 2n);
  const quote = under();
  const quoteSignature = await sign(agent, quote, 31337, rig.addresses.matching);
  const taken = await post(url(), '/v1/orders', { role: 'rest', order: wire(quote), signature: quoteSignature });
  assert.equal(taken.status, 201, `ending at the chain's time plus two: ${JSON.stringify(taken.body)}`);
  assert.equal(taken.body.chainTime, (ends - 2n).toString());
  const second = under();
  const secondSignature = await sign(agent, second, 31337, rig.addresses.matching);
  assert.equal((await post(url(), '/v1/orders', { role: 'rest', order: wire(second), signature: secondSignature })).status, 201);

  // The contract's side: a Cross on the first quote, mined at the last second before the grant's end, fills.
  const bet = await betAgainst(quote);
  await rig.setNextBlockTime(ends - 1n);
  const sent = await crossFromTheTest(rig, bet, [{ order: quote, signature: quoteSignature }]);
  assert.equal(sent.filled, true, JSON.stringify(sent));
  assert.equal(await rig.time(), ends - 1n);

  // The latest block one second before the grant's end: an order under it can fill in no later block, and is refused,
  // before admission.
  const late = under();
  const gone = await costsNothing(owner.address, late, () => postOrderAs(url(), rig, agent, 'rest', late));
  assert.equal(gone.status, 422, JSON.stringify(gone.body));
  assert.equal(gone.body.code, 'GRANT_GONE');
  assert.deepEqual({ grantNumber: gone.body.grantNumber, currentGrant: gone.body.currentGrant, endsAt: gone.body.endsAt, chainTime: gone.body.chainTime }, { grantNumber: g, currentGrant: g, endsAt: ends.toString(), chainTime: (ends - 1n).toString() });
  // The market's page, at the same block: both quotes taken two seconds before the end are under a grant that ends
  // at the chain's time plus one now, so neither is listed and both are marked, at the block read.
  const head = await rig.publicClient.getBlock();
  assert.equal(head.timestamp, ends - 1n);
  const page = await sideOf(line, 'A');
  assert.deepEqual({ listed: page.quotes.length, live: page.live, ended: page.endedOnChain, cancelled: page.markedCancelled }, { listed: 0, live: 2, ended: 2, cancelled: 2 });
  for (const m of await marks([taken.body.orderHash as string, await contractHash(rig, second)])) assert.deepEqual(m, { ended: 'cancelled', block: head.number.toString(), hash: head.hash.toLowerCase() });

  // The contract's side again, with the latest block at the grant's end: a Cross on the second quote, which nothing
  // has filled, is refused, the quote skipped for its grant (the eighth reason, numbered 7), and sent it fills nothing.
  await rig.setNextBlockTime(ends);
  await rig.mine(1);
  assert.equal(await rig.time(), ends);
  const refusal = await crossRefusal(rig, await betAgainst(second), [{ order: second, signature: secondSignature }]);
  assert.deepEqual({ name: refusal?.name, reasons: (refusal?.args[0] as number[] | undefined)?.map(Number) }, { name: 'OspexMatching__NothingFilled', reasons: [7] });
  const sent2 = await crossFromTheTest(rig, await betAgainst(second), [{ order: second, signature: secondSignature }]);
  assert.equal(sent2.filled, false);
  assert.equal(await rig.read<bigint>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_filledRisk', [await contractHash(rig, second)]), 0n);

  // An order the account signs itself, grant number 0, stands whatever became of its grant.
  const own = await postOrder(url(), rig, owner, 'rest', orderOn(rig, owner, { expiry: ends + 3_600n, ...line }));
  assert.equal(own.status, 201, JSON.stringify(own.body));
});

test("the former agent's order costs the account nothing: under its old number after the same key is granted again, under a grant another key's replaced, under a revoked grant and under one that has ended, each is GRANT_GONE before the budgets, with both budget rows as they were, no line and no row; the agent of the grant that stands is admitted each time", async () => {
  const owner = rig.account(29);
  const first = rig.account(30);
  const other = rig.account(31);
  await rig.fund(owner);
  const T = await rig.time();
  const far = T + 100_000n;
  const cap = 1_000_000n;
  const line = { scorer: rig.addresses.spread, lineTicks: -2_075 };
  const under = (grant: number): Order => orderOn(rig, owner, { expiry: far, ...line, nonce: nonceOf(0n, grant, nextOrderNumber()) });
  const admitted = async (signer: HDAccount, grant: number, what: string) => {
    const answer = await postOrderAs(url(), rig, signer, 'rest', under(grant));
    assert.equal(answer.status, 201, `${what}: ${JSON.stringify(answer.body)}`);
  };
  const gone = async (signer: HDAccount, grant: number, what: string) => {
    const order = under(grant);
    const answer = await costsNothing(owner.address, order, () => postOrderAs(url(), rig, signer, 'rest', order));
    assert.equal(answer.status, 422, `${what}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, 'GRANT_GONE', what);
    return answer;
  };
  const countsBefore = (await refusedBeforeAdmission()).GRANT_GONE ?? 0;

  const g1 = await grantAgent(rig, owner, first.address, cap, far);
  await admitted(first, g1, 'the live grant, the control');

  // The same key granted again: live under the new number, dead under the old.
  const g2 = await grantAgent(rig, owner, first.address, cap, far);
  assert.deepEqual([g1, g2], [1, 2]);
  const sameKey = await gone(first, g1, 'the same key under its old number');
  assert.deepEqual({ grantNumber: sameKey.body.grantNumber, currentGrant: sameKey.body.currentGrant }, { grantNumber: g1, currentGrant: g2 });
  await admitted(first, g2, 'the same key under its new number');

  // Another key granted: the first key's grant is replaced.
  const g3 = await grantAgent(rig, owner, other.address, cap, far);
  await gone(first, g2, "under a grant another key's replaced");
  await admitted(other, g3, 'the key the grant now names');

  // The grant revoked.
  await revokeAgent(rig, owner);
  const revoked = await gone(other, g3, 'under a revoked grant');
  assert.equal(revoked.body.currentGrant, 0);
  assert.equal(await rig.publicClient.readContract({ address: rig.addresses.matching, abi: MATCHING_ABI, functionName: 'isLiveAgent', args: [owner.address, other.address] }), false);

  // A grant that has ended: current, and ending at the chain's time plus one.
  const ends = (await rig.time()) + 300n;
  const g4 = await grantAgent(rig, owner, other.address, cap, ends);
  await rig.setNextBlockTime(ends - 2n);
  await rig.mine(1);
  await admitted(other, g4, "ending at the chain's time plus two, the control");
  await rig.setNextBlockTime(ends - 1n);
  await rig.mine(1);
  const ended = await gone(other, g4, "ending at the chain's time plus one");
  assert.deepEqual({ grantNumber: ended.body.grantNumber, currentGrant: ended.body.currentGrant, endsAt: ended.body.endsAt, chainTime: ended.body.chainTime }, { grantNumber: g4, currentGrant: g4, endsAt: ends.toString(), chainTime: (ends - 1n).toString() });

  assert.equal(((await refusedBeforeAdmission()).GRANT_GONE ?? 0) - countsBefore, 4, 'each counted, by its code');
  assert.equal((await lines(`WHERE kind = 'order refused' AND reason = 'GRANT_GONE'`)).length, 0, 'no refusal for a gone grant is a line: each was before admission');
});

test("a revoke ends the agent's quotes: the sixteen it posted on one side are marked cancelled at the block read by the door's count, and the account's own order is taken in their place; the two on the other side are not listed and are marked by the market's page; the agent's new post is GRANT_GONE; the account's own quote stands", async () => {
  const owner = rig.account(32);
  const agent = rig.account(33);
  await rig.fund(owner);
  const T = await rig.time();
  const line = { scorer: rig.addresses.total, lineTicks: 2_935 };
  const g = await grantAgent(rig, owner, agent.address, 1_000_000n, T + 100_000n);
  const under = (positionType: 0 | 1): Order => orderOn(rig, owner, { expiry: T + 3_600n, ...line, positionType, nonce: nonceOf(0n, g, nextOrderNumber()) });
  const sideA: string[] = [];
  for (let i = 0; i < 16; i++) {
    const answer = await postOrderAs(url(), rig, agent, 'rest', under(0));
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    sideA.push(answer.body.orderHash as string);
  }
  const sideB: string[] = [];
  for (let i = 0; i < 2; i++) {
    const answer = await postOrderAs(url(), rig, agent, 'rest', under(1));
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    sideB.push(answer.body.orderHash as string);
  }
  // One quote the account signs itself, on the other side: its end is not the grant's.
  const own = await postOrder(url(), rig, owner, 'rest', orderOn(rig, owner, { expiry: T + 3_600n, ...line, positionType: 1 }));
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal((await sideOf(line, 'B')).quotes.length, 3, 'listed while the grant stands');

  await revokeAgent(rig, owner);
  assert.deepEqual([await unendedRows(owner, 0), await unendedRows(owner, 1)], [16, 3], 'revoked on chain, the quotes stand in the records until a request asks the chain about them');

  // The agent's new post is refused, before admission.
  const late = under(0);
  const refused = await costsNothing(owner.address, late, () => postOrderAs(url(), rig, agent, 'rest', late));
  assert.equal(refused.body.code, 'GRANT_GONE', JSON.stringify(refused.body));

  // The door's count: the account's own order finds sixteen standing, asks the chain once, marks the sixteen under
  // the revoked grant at the block it read, and is taken.
  const head = await rig.publicClient.getBlock();
  const callsBefore = stack.proxy.count('eth_call');
  const taken = await postOrder(url(), rig, owner, 'rest', orderOn(rig, owner, { expiry: T + 3_600n, ...line }));
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.equal(stack.proxy.count('eth_call') - callsBefore, 2, "the door's own read and one read of the sixteen");
  const marked = await marks(sideA);
  assert.equal(marked.length, 16);
  for (const m of marked) assert.deepEqual(m, { ended: 'cancelled', block: head.number.toString(), hash: head.hash.toLowerCase() }, 'marked cancelled at the block the door read');

  // The market's page: of the three on the other side the agent's two are not listed and are marked; the account's own is listed.
  const page = await sideOf(line, 'B');
  assert.deepEqual({ listed: page.quotes.map((q) => q.orderHash), live: page.live, ended: page.endedOnChain, cancelled: page.markedCancelled }, { listed: [own.body.orderHash], live: 3, ended: 2, cancelled: 2 });
  for (const m of await marks(sideB)) assert.deepEqual(m, { ended: 'cancelled', block: head.number.toString(), hash: head.hash.toLowerCase() }, 'marked cancelled at the block the page read');
  assert.equal((await get(url(), `/v1/orders/${sideB[0]}`)).body.state, 'cancelled');
  assert.deepEqual((await marks([own.body.orderHash as string]))[0], { ended: null, block: null, hash: null }, "the account's own quote is not the grant's to end");
});

test("the signature is of the form the chain takes: a quote whose signature ends in the parity, 0 or 1, in place of 27 or 28, or whose s is in the upper half of the curve's order, is BAD_SIGNATURE though a lenient recovery reads the maker from it, and the contract refuses a Cross that lists it for its signature; the same order signed in the chain's form is admitted, and its Cross fills", async () => {
  const maker = rig.account(34);
  await rig.fund(maker);
  const T = await rig.time();
  const line = { scorer: rig.addresses.spread, lineTicks: -2_085 };
  const domain = domainOf(31337, rig.addresses.matching);
  const lenient = (order: Order, signature: Hex) => recoverTypedDataAddress({ domain, types: ORDER_TYPE, primaryType: 'OspexOrder', message: order, signature });
  // Quotes signed until both parities have come up, so the last byte written as the parity is 0 for one and 1 for another.
  const byParity = new Map<number, { order: Order; signature: Hex }>();
  for (let tries = 0; byParity.size < 2; tries++) {
    assert.ok(tries < 64, 'both parities come up within a few signatures');
    const order = orderOn(rig, maker, { expiry: T + 3_600n, oddsTick: 200, riskAmount: 10_000n, ...line });
    const signature = await sign(maker, order, 31337, rig.addresses.matching);
    byParity.set(Number.parseInt(signature.slice(130), 16) - 27, { order, signature });
  }
  const cases: Array<{ what: string; order: Order; chainForm: Hex; refused: Hex }> = [];
  for (const [parity, { order, signature }] of byParity) {
    const asParity = refusedForm(signature, 'v as parity');
    assert.equal(Number.parseInt(asParity.slice(130), 16), parity);
    cases.push({ what: `the last byte ${parity}`, order, chainForm: signature, refused: asParity });
  }
  const high = byParity.get(0) as { order: Order; signature: Hex };
  cases.push({ what: 'an s in the upper half', order: high.order, chainForm: high.signature, refused: refusedForm(high.signature, 'upper s') });
  assert.deepEqual(cases.map((c) => c.what).sort(), ['an s in the upper half', 'the last byte 0', 'the last byte 1'], 'the three forms');

  const countsBefore = (await refusedBeforeAdmission()).BAD_SIGNATURE ?? 0;
  const linesBefore = (await lines()).length;
  for (const c of cases) {
    // The form is the only fault: the same signer, read leniently, from the same hash.
    assert.equal((await lenient(c.order, c.refused)).toLowerCase(), maker.address.toLowerCase(), `${c.what}: a lenient recovery reads the maker`);
    assert.notEqual(c.refused, c.chainForm);
    const answer = await post(url(), '/v1/orders', { role: 'rest', order: wire(c.order), signature: c.refused });
    assert.equal(answer.status, 422, `${c.what}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, 'BAD_SIGNATURE', c.what);
    assert.match(String(answer.body.error), /27 or 28/, `${c.what}: the sentence names the form`);
    assert.equal(await orderRow(await contractHash(rig, c.order)), null, `${c.what}: no row`);
    // The contract's side: a Cross that lists the quote so signed is refused for that quote's signature, and for nothing else.
    const refusal = await crossRefusal(rig, await betAgainst(c.order), [{ order: c.order, signature: c.refused }]);
    assert.deepEqual({ name: refusal?.name, hash: String(refusal?.args[0]).toLowerCase() }, { name: 'OspexMatching__BadSignature', hash: (await contractHash(rig, c.order)).toLowerCase() }, c.what);
  }
  assert.equal(((await refusedBeforeAdmission()).BAD_SIGNATURE ?? 0) - countsBefore, 3, 'each counted');
  assert.equal((await lines()).length, linesBefore, 'none a line');

  // One Cross sent for each form of one quote: the refused form does not fill; the chain's form, with the same bet, does.
  const one = cases[0] as { order: Order; chainForm: Hex; refused: Hex };
  const bet = await betAgainst(one.order);
  const sentRefused = await crossFromTheTest(rig, bet, [{ order: one.order, signature: one.refused }]);
  assert.equal(sentRefused.filled, false, 'the Cross listing the refused form does not fill');
  assert.equal(await rig.read<bigint>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_filledRisk', [await contractHash(rig, one.order)]), 0n, 'nothing filled');

  // The controls: each order in the chain's form is admitted.
  for (const c of byParity.values()) {
    const answer = await post(url(), '/v1/orders', { role: 'rest', order: wire(c.order), signature: c.signature });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
  }
  const sentChainForm = await crossFromTheTest(rig, await betAgainst(one.order), [{ order: one.order, signature: one.chainForm }]);
  assert.equal(sentChainForm.filled, true, `the same quote in the chain's form fills: ${JSON.stringify(sentChainForm)}`);
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
  // The block before the close is named by its time, not reached by adding to the clock: a block mined after an
  // addition carries the wall clock's seconds since the last read as well, and can land on the close itself.
  const closesAt = firstStart + window;
  T = await rig.time();
  assert.ok(T < closesAt - 1n, 'the close is still ahead');
  await rig.setNextBlockTime(closesAt - 1n);
  await rig.mine(1);
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
  // The grant's three refusals and GRANT_GONE are of the checks before admission too: a grant is judged before the budgets.
  const before = new Set([
    'INVALID_PARAM', 'BODY_TOO_LARGE', 'RATE_LIMIT_EXCEEDED', 'PRICE_OUT_OF_RANGE', 'STAKE_NOT_IN_LOTS', 'MIN_FILL_ABOVE_STAKE', 'UNKNOWN_MARKET_CONTRACT', 'INVALID_LINE', 'BAD_SIGNATURE', 'ROLE_CONFLICT', 'CHAIN_UNREACHABLE', 'NOT_REGISTERED',
    'AGENT_STAKE_ABOVE_CAP', 'LINE_NOT_IN_GRANT', 'GRANT_GONE',
  ]);
  const { rows } = await pool.query<{ reason: string }>(`SELECT DISTINCT reason FROM events WHERE kind = 'order refused'`);
  const reasons = rows.map((r) => r.reason);
  assert.ok(reasons.length >= 8, `the refusals seen: ${reasons.join(', ')}`);
  // CHAIN_UNREACHABLE is the one code on both sides of admission: the door's own read (check 6) is before it and is
  // counted; the sixteen's read (check 13) is inside the admitted transaction, and a refusal there is a line.
  for (const reason of reasons) assert.ok(!before.has(reason) || reason === 'CHAIN_UNREACHABLE', `${reason} is a refusal before admission and must not be a line`);
  assert.ok(reasons.includes('CHAIN_UNREACHABLE'), "the sixteen's read failing twice left its line");
  const counts = await refusedBeforeAdmission();
  for (const code of Object.keys(counts)) assert.ok(before.has(code) || code === 'NOT_FOUND' || code === 'HTTPS_REQUIRED', `${code} was counted before admission`);
});
