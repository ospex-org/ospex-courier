import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Abi } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { get as getFrom } from './support/courier';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { startStack, type Stack } from './support/stack';

// The sender, from what a user would see: signed orders posted over HTTP to the
// courier as its own process, on a chain that mines a block every 2 seconds
// with its pool open, and whose final block follows its head. Judged by the
// chain, by the rows and the lines read back, by the signatures counted at
// the signer (every signed attempt, in the test's memory) and by the hand-offs
// counted at the proxy.

let stack: Stack;
let pool: pg.Pool;
const url = () => stack.courier.url;

let from: Record<string, string> = {};
let nextAddress = 0;
beforeEach(() => {
  const n = nextAddress++;
  from = { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
});
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const get = (u: string, path: string) => getFrom(u, path, from);

before(async () => {
  stack = await startStack('sender', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

let nextAccount = 40;
async function fresh(): Promise<HDAccount> {
  const who = stack.rig.account(nextAccount++);
  await stack.rig.fund(who);
  return who;
}

interface CrossSeen {
  state: string;
  hand_offs: number;
  tx_hash: string | null;
  nonce: string | null;
  not_sent_reason: string | null;
}

async function crossRow(bet: string): Promise<CrossSeen | null> {
  const { rows } = await pool.query<CrossSeen>('SELECT state, hand_offs, tx_hash, nonce::text AS nonce, not_sent_reason FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()]);
  return rows[0] ?? null;
}

/** Read again until `done` holds, every quarter second, for at most `ms`. */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-12).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A quote and a bet that meet: M quotes home at 204 for 100,000; B takes away at 196 for 10,000, to expire in `life` seconds. */
async function quoteAndBet(life = 30n): Promise<{ M: HDAccount; B: HDAccount; quote: Order; bet: Order; betHash: string }> {
  const M = await fresh();
  const B = await fresh();
  const T = await stack.rig.time();
  const quote: Order = { ...orderOn(stack.rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 100_000n }), positionType: 0 };
  const posted = await postOrder(url(), stack.rig, M, 'rest', quote);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const bet: Order = { ...orderOn(stack.rig, B, { expiry: T + life, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(url(), stack.rig, B, 'take', bet);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  return { M, B, quote, bet, betHash: taken.body.orderHash as string };
}

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];

test('the control: a bet the book can fill is signed once, handed to the node once, mined, and confirmed from the final block; the lane is freed and the next bet is sent and filled the same way', async () => {
  const signedBefore = stack.courier.hooks?.signed.length ?? 0;
  const sendsBefore = stack.proxy.count('eth_sendRawTransaction');
  const coin = stack.rig.abis.TestCoin as Abi;
  const first = await quoteAndBet();
  const bBefore = await stack.rig.read<bigint>(stack.rig.addresses.coin, coin, 'balanceOf', [first.B.address]);
  const row = await until(() => crossRow(first.betHash), (r) => r !== null && FINAL.includes(r.state), 60_000, 'the first Cross');
  assert.equal(row?.state, 'confirmed', JSON.stringify(row));
  assert.equal(row?.hand_offs, 1);
  assert.equal((stack.courier.hooks?.signed.length ?? 0) - signedBefore, 1, 'one signature');
  assert.equal(stack.proxy.count('eth_sendRawTransaction') - sendsBefore, 1, 'one hand-off');
  const bAfter = await stack.rig.read<bigint>(stack.rig.addresses.coin, coin, 'balanceOf', [first.B.address]);
  assert.ok(bAfter < bBefore, 'the bettor paid in');
  const lane = await pool.query<{ held_bet: string | null; open_cross: string | null }>('SELECT held_bet, open_cross FROM lanes');
  assert.deepEqual(lane.rows.map((r) => [r.held_bet, r.open_cross]), [[null, null]], 'the lane is freed');

  const second = await quoteAndBet();
  const row2 = await until(() => crossRow(second.betHash), (r) => r !== null && FINAL.includes(r.state), 60_000, 'the second Cross');
  assert.equal(row2?.state, 'confirmed', JSON.stringify(row2));
  assert.equal(BigInt(row2?.nonce as string), BigInt(row?.nonce as string) + 1n, 'the next nonce');
  assert.equal((stack.courier.hooks?.signed.length ?? 0) - signedBefore, 2);
  assert.equal(stack.proxy.count('eth_sendRawTransaction') - sendsBefore, 2);
  const record = await get(url(), `/v1/orders/${second.betHash}`);
  assert.equal(record.status, 200);
});
