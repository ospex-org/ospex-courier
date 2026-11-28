import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Abi } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { get as getFrom } from './support/courier';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { outcomes, postStop as postStopFrom, resultsOf, stopMessage } from './support/stops';
import { closeEach } from './support/close';
import { nodeText, PLANTED } from './support/named';
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
const postStop = (...a: Parameters<typeof postStopFrom>) => postStopFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

before(async () => {
  stack = await startStack('sender', {
    hooked: true,
    blockTime: 2,
    sending: true,
    sendsApart: { unsent: "the gate's acknowledgement lost leaves a hand-off in the records that never reached the node" },
  });
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

interface CrossSeen {
  state: string;
  hand_offs: number;
  tx_hash: string | null;
  nonce: string | null;
  not_sent_reason: string | null;
}

/** The Cross's state and the node's answer as recorded. */
async function answerOf(bet: string): Promise<{ state: string; node_answer: unknown } | null> {
  const { rows } = await pool.query<{ state: string; node_answer: unknown }>('SELECT state, node_answer FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()]);
  return rows[0] ?? null;
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

/**
 * A quote and a bet that meet: M quotes home at 204 for 9,600, which one bet of B's fills whole; B takes away at 196
 * for 10,000, to expire in `life` seconds. Each case's quote is used up or stopped by its own bet, so the next case's
 * bet lists its own quote and no earlier one.
 */
async function quoteAndBet(life = 30n): Promise<{ M: HDAccount; B: HDAccount; quote: Order; bet: Order; betHash: string; quoteHash: string }> {
  const M = await fresh();
  const B = await fresh();
  const T = await stack.rig.time();
  const quote: Order = { ...orderOn(stack.rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 9_600n }), positionType: 0 };
  const posted = await postOrder(url(), stack.rig, M, 'rest', quote);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const bet: Order = { ...orderOn(stack.rig, B, { expiry: T + life, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(url(), stack.rig, B, 'take', bet);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  return { M, B, quote, bet, betHash: taken.body.orderHash as string, quoteHash: posted.body.orderHash as string };
}

/** The counts every witness names: signatures at the signer, hand-offs at the proxy, across the courier's lives. */
const counts = () => ({ signed: stack.courier.hooks?.signed.length ?? 0, handOffs: stack.proxy.count('eth_sendRawTransaction') });

/** The final block's height as the proxy serves it in this file: one block under the head. */
const finalHeight = async (): Promise<bigint> => BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string) - 1n;

/** The key's count on the chain at the latest block, and its pending one. */
async function keyNonce(): Promise<{ latest: bigint; pending: bigint }> {
  const at = async (tag: string) => BigInt((await stack.rig.rpc('eth_getTransactionCount', [stack.rig.accounts.sender.address, tag])) as string);
  return { latest: await at('latest'), pending: await at('pending') };
}

async function balanceOf(who: HDAccount): Promise<bigint> {
  return stack.rig.read<bigint>(stack.rig.addresses.coin, stack.rig.abis.TestCoin as Abi, 'balanceOf', [who.address]);
}

async function linesOf(bet: string): Promise<Array<{ number: number; kind: string; reason: string | null; facts: Record<string, unknown> }>> {
  const { rows } = await pool.query(`SELECT number::int AS number, kind, reason, facts FROM events WHERE bet_hash = $1 ORDER BY events.number`, [bet.toLowerCase()]);
  return rows as Array<{ number: number; kind: string; reason: string | null; facts: Record<string, unknown> }>;
}

/** The lane free, its open Cross settled: what every case leaves behind, so the next starts clean. */
async function laneFree(): Promise<void> {
  await until(async () => (await pool.query<{ held_bet: string | null }>('SELECT held_bet FROM lanes')).rows.map((r) => r.held_bet), (v) => v.every((b) => b === null), 90_000, 'the lane');
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
  assert.equal(record.body.state, 'confirmed', JSON.stringify(record.body));
  const cross = record.body.cross as { message: string; txHash: string; betFilled: string; final: { number: string }; reconciled: boolean };
  assert.equal(cross.txHash, row2?.tx_hash);
  assert.ok(cross.message.startsWith(`Transaction ${cross.txHash} is in final block `), cross.message);
  assert.ok(cross.message.includes(`as of final block ${cross.final.number}.`), cross.message);
  assert.equal(cross.reconciled, true);
});

test('a listed quote stopped at the last moment, after the signed record and before the gate: one signature, no hand-off, the key\'s nonce unchanged on the chain, the Cross not sent STOPPED_AT_GATE with no hand-off, and no USDC moved; the control, the same hold and no stop, is handed off once and fills', async () => {
  const hooks = stack.courier.hooks as NonNullable<Stack['courier']['hooks']>;
  for (const stopIt of [true, false]) {
    await laneFree();
    const before = counts();
    await hooks.arm('after-signed-record', 1);
    const c = await quoteAndBet();
    const held = await hooks.reached('after-signed-record');
    const nonceBefore = await keyNonce();
    const [mBefore, bBefore] = [await balanceOf(c.M), await balanceOf(c.B)];
    if (stopIt) {
      const stop = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
      assert.equal(stop.status, 200, JSON.stringify(stop.body));
      assert.deepEqual(outcomes(stop), ['stopped']);
      assert.equal('handOff' in (resultsOf(stop)[0] as object), false, 'no hand-off to name before the gate');
    }
    await hooks.go(held);
    const row = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 60_000, 'the Cross');
    if (stopIt) {
      assert.deepEqual([row?.state, row?.not_sent_reason, row?.hand_offs], ['not sent', 'STOPPED_AT_GATE', 0]);
      assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 0 });
      assert.deepEqual(await keyNonce(), nonceBefore, "the key's nonce on the chain, latest and pending, unchanged");
      assert.deepEqual([await balanceOf(c.M), await balanceOf(c.B)], [mBefore, bBefore], 'no USDC moved');
      const lines = await linesOf(c.betHash);
      const gate = lines.find((l) => l.kind === 'cross not sent');
      assert.equal(gate?.reason, 'STOPPED_AT_GATE');
      assert.deepEqual(gate?.facts.stopped, [c.quoteHash.toLowerCase()]);
    } else {
      assert.equal(row?.state, 'confirmed', JSON.stringify(row));
      assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 1 });
      assert.ok((await balanceOf(c.B)) < bBefore, 'it filled');
    }
  }
});

test('the bet itself stopped after the signed record: one signature, no hand-off, the Cross closed not sent with no hand-off, and the bet\'s record reads stopped', async () => {
  const hooks = stack.courier.hooks as NonNullable<Stack['courier']['hooks']>;
  await laneFree();
  const before = counts();
  await hooks.arm('after-signed-record', 1);
  const c = await quoteAndBet();
  const held = await hooks.reached('after-signed-record');
  const stop = await postStop(url(), stack.rig, c.B, stopMessage(c.B.address, [c.betHash as `0x${string}`]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  await hooks.go(held);
  const row = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 60_000, 'the Cross');
  assert.deepEqual([row?.state, row?.hand_offs], ['not sent', 0]);
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 0 });
  const lines = await linesOf(c.betHash);
  assert.ok(lines.some((l) => l.kind === 'bet refused' && l.reason === 'STOPPED'), JSON.stringify(lines));
  const record = await get(url(), `/v1/orders/${c.betHash}`);
  assert.equal(record.body.state, 'stopped', JSON.stringify(record.body));
  // M's quote, never used: stopped, so no later case's bet lists it.
  assert.deepEqual(outcomes(await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]))), ['stopped']);
});

test('a stop between the intent and the signature: the signature is allowed and the hand-off is not; the Cross not sent STOPPED_AT_GATE', async () => {
  const hooks = stack.courier.hooks as NonNullable<Stack['courier']['hooks']>;
  await laneFree();
  const before = counts();
  await hooks.arm('after-intent', 1);
  const c = await quoteAndBet();
  const held = await hooks.reached('after-intent');
  const stop = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  assert.deepEqual(outcomes(stop), ['stopped']);
  await hooks.go(held);
  const row = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 60_000, 'the Cross');
  assert.deepEqual([row?.state, row?.not_sent_reason, row?.hand_offs], ['not sent', 'STOPPED_AT_GATE', 0]);
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 0 });
});

test('a stop during the hand-off waits on the hash locks through the node\'s answer and its record, then reads stopped with handOff { txHash, state: "sent", bet }; the Cross fills the quote; the stop commits after the gate and after the answer', async () => {
  await laneFree();
  const before = counts();
  const held = stack.proxy.hold('eth_sendRawTransaction');
  const c = await quoteAndBet();
  await held.arrived;
  const answer = postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  await new Promise((r) => setTimeout(r, 2_000));
  held.release();
  const stop = await answer;
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const result = resultsOf(stop)[0] as unknown as { status: string; handOff?: { txHash: string; state: string; bet: string } };
  assert.equal(result.status, 'stopped');
  const row = await crossRow(c.betHash);
  assert.deepEqual(result.handOff, { txHash: row?.tx_hash, state: 'sent', bet: c.betHash.toLowerCase() });
  // The stop's commit time on its row is after the gate's; and it went past the hash locks only once the node's answer
  // was recorded, so its line follows the answer's line.
  const times = await pool.query<{ gate: Date; stopped: Date }>('SELECT c.gate_at AS gate, s.received_at AS stopped FROM crosses c, stops s WHERE c.bet_hash = $1 AND s.hash = $2', [
    c.betHash.toLowerCase(),
    c.quoteHash.toLowerCase(),
  ]);
  const t = times.rows[0] as { gate: Date; stopped: Date };
  assert.ok(t.stopped > t.gate, JSON.stringify(t));
  const answerLine = (await linesOf(c.betHash)).find((l) => l.kind === 'cross sent');
  const stopLine = await pool.query<{ number: number }>(`SELECT number::int AS number FROM events WHERE kind = 'stop received' AND account = $1 ORDER BY events.number DESC LIMIT 1`, [c.M.address.toLowerCase()]);
  assert.ok(answerLine !== undefined && (stopLine.rows[0]?.number ?? 0) > answerLine.number, 'the stop is recorded after the answer');
  const settled = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 60_000, 'the Cross');
  assert.equal(settled?.state, 'confirmed');
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 1 });
});

test('the node\'s answer lost: the request passed to the chain and its answer withheld until the client\'s ten seconds run out; the stop reads stopped with handOff state "uncertain"; the Cross fills and settles confirmed', async () => {
  await laneFree();
  const before = counts();
  const kept = stack.proxy.passAndHold('eth_sendRawTransaction');
  const c = await quoteAndBet();
  await kept.passed;
  const stop = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const result = resultsOf(stop)[0] as unknown as { status: string; handOff?: { state: string; bet: string } };
  assert.equal(result.status, 'stopped');
  assert.equal(result.handOff?.state, 'uncertain', JSON.stringify(result));
  assert.equal(result.handOff?.bet, c.betHash.toLowerCase());
  kept.release({ drop: true });
  const settled = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 90_000, 'the Cross');
  assert.equal(settled?.state, 'confirmed', JSON.stringify(settled));
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 1 });
});

test('the node\'s answer a named error: the request passed to the chain, and the node\'s answer replaced by the named error "nonce too low"; the Cross is unknown with the error\'s fixed words alone, and the stop reads stopped with handOff state "uncertain"; the Cross fills and settles confirmed', async () => {
  await laneFree();
  const before = counts();
  const named = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText('nonce too low') });
  let c: Awaited<ReturnType<typeof quoteAndBet>>;
  try {
    c = await quoteAndBet();
    const unknown = await until(() => answerOf(c.betHash), (r) => r !== null && r.state !== 'intent' && r.state !== 'signed' && r.state !== 'handing off', 30_000, 'the answer');
    assert.deepEqual(unknown, { state: 'unknown', node_answer: { kind: 'unknown', words: 'nonce too low' } }, 'not known, with the fixed words alone');
    assert.equal(named.forwarded.length, 1, 'the chain had the request');
  } finally {
    named.stop();
  }
  const stop = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const result = resultsOf(stop)[0] as unknown as { status: string; handOff?: { state: string; bet: string } };
  assert.equal(result.status, 'stopped');
  assert.equal(result.handOff?.state, 'uncertain', JSON.stringify(result));
  assert.equal(result.handOff?.bet, c.betHash.toLowerCase());
  for (const needle of PLANTED) assert.ok(!JSON.stringify(stop.body).toLowerCase().includes(needle), `${needle} is not on the stop's answer`);
  const settled = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 90_000, 'the Cross');
  assert.equal(settled?.state, 'confirmed', JSON.stringify(settled));
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 1 });
});

test('a stop sent again after its answer was lost: the first commits after the gate and its answer goes unread; the second is answered already stopped with the same handOff, once with the Cross pending and once with it unknown', async () => {
  for (const how of ['pending', 'unknown'] as const) {
    await laneFree();
    let c: Awaited<ReturnType<typeof quoteAndBet>>;
    if (how === 'unknown') {
      // The hand-off dropped with no answer and kept from the chain: the Cross stays unknown until a final block passes its expiry.
      stack.proxy.drop('eth_sendRawTransaction');
      c = await quoteAndBet();
      await until(() => crossRow(c.betHash), (r) => r?.state === 'unknown', 30_000, 'the Cross unknown');
      stack.proxy.rule('eth_sendRawTransaction', null);
    } else {
      // The final block held at the head as it stands, so the receipt lands above it: the Cross waits pending.
      const head = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
      stack.proxy.finalFollows(null);
      stack.proxy.setFinal(head);
      c = await quoteAndBet();
      await until(() => crossRow(c.betHash), (r) => r?.state === 'pending', 30_000, 'the Cross pending');
    }
    const first = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
    // The first answer is read here only to compare with the second: the case is that the maker never saw it.
    const again = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
    assert.deepEqual(outcomes(again), ['already stopped']);
    const h1 = (resultsOf(first)[0] as unknown as { handOff?: unknown }).handOff;
    const h2 = (resultsOf(again)[0] as unknown as { handOff?: unknown }).handOff;
    assert.deepEqual(h2, h1, 'the same handOff');
    assert.equal((h2 as { state: string } | undefined)?.state, how === 'pending' ? 'pending' : 'uncertain', JSON.stringify(h2));
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
    await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 90_000, 'the Cross');
  }
});

test('a stop sent again after a named error\'s answer: the node refuses the hand-off by the named error "txpool is full" and the chain never has it; the Cross is unknown with the error\'s fixed words alone; the second stop is answered already stopped with the same handOff, uncertain, as the first; the Cross ends expired unmined', async () => {
  await laneFree();
  const before = counts();
  stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuse', code: -32000, message: nodeText('txpool is full') });
  let c: Awaited<ReturnType<typeof quoteAndBet>>;
  try {
    c = await quoteAndBet();
    const unknown = await until(() => answerOf(c.betHash), (r) => r !== null && r.state !== 'intent' && r.state !== 'signed' && r.state !== 'handing off', 30_000, 'the answer');
    assert.deepEqual(unknown, { state: 'unknown', node_answer: { kind: 'unknown', words: 'txpool is full' } }, 'not known, with the fixed words alone');
  } finally {
    stack.proxy.rule('eth_sendRawTransaction', null);
  }
  const first = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  // The first answer is read here only to compare with the second: the case is that the maker never saw it.
  const again = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  assert.deepEqual(outcomes(again), ['already stopped']);
  const h1 = (resultsOf(first)[0] as unknown as { handOff?: unknown }).handOff;
  const h2 = (resultsOf(again)[0] as unknown as { handOff?: unknown }).handOff;
  assert.deepEqual(h2, h1, 'the same handOff');
  const cross = await crossRow(c.betHash);
  assert.deepEqual(h2, { txHash: cross?.tx_hash, state: 'uncertain', bet: c.betHash.toLowerCase() }, JSON.stringify(h2));
  const settled = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 120_000, 'the Cross');
  assert.equal(settled?.state, 'expired unmined', JSON.stringify(settled));
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 1 });
});

test('the gate\'s acknowledgement lost, with no restart: the commit of handing off reaches the database and its answer is dropped; nothing is handed over, the uncertain session goes with its locks, a stop of a listed quote succeeds, the Cross settles from the final block, and the next new bet fills', async () => {
  await laneFree();
  const before = counts();
  const cut = stack.dbRelay.dropCommitAfter("SET state = 'handing off'");
  const c = await quoteAndBet(12n);
  await cut;
  const stop = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const settled = await until(() => crossRow(c.betHash), (r) => r !== null && FINAL.includes(r.state), 90_000, 'the Cross');
  assert.equal(settled?.state, 'expired unmined', JSON.stringify(settled));
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 1, handOffs: 0 });
  await laneFree();
  const next = await quoteAndBet();
  const row = await until(() => crossRow(next.betHash), (r) => r !== null && FINAL.includes(r.state), 60_000, 'the next Cross');
  assert.equal(row?.state, 'confirmed', JSON.stringify(row));
});

test('on the stack: a nonce of the key used at a final block by a transaction the records do not hold. The next bet signs nothing: cross-unreconciled opens with the nonce, the lane is shut by its line, and the bet waits; the watermark stays where the records proved it', async () => {
  await laneFree();
  const before = counts();
  const key = stack.rig.accounts.sender.address;
  const wm = await pool.query<{ to: string; at: string | null }>('SELECT verified_nonce_to::text AS to, verified_block_number::text AS at FROM lanes');
  const used = await keyNonce();
  const own = (await stack.rig.rpc('eth_sendTransaction', [{ from: key, to: key, value: '0x0' }])) as string;
  await until(keyNonce, (n) => n.latest === used.latest + 1n, 20_000, "the key's own transaction mined");
  // The final block past it, read as the proxy serves it here: one block under the head.
  const minedAt = BigInt(((await stack.rig.rpc('eth_getTransactionReceipt', [own])) as { blockNumber: string }).blockNumber);
  await until(finalHeight, (f) => f >= minedAt, 30_000, "the final block past the key's own transaction");
  const c = await quoteAndBet();
  const shut = await until(async () => (await pool.query<{ shut_line: string | null }>('SELECT shut_line::text AS shut_line FROM lanes')).rows[0]?.shut_line ?? null, (v) => v !== null, 30_000, 'the lane shut');
  const opened = await pool.query<{ reason: string; facts: Record<string, unknown> }>('SELECT reason, facts FROM events WHERE number = $1', [shut]);
  assert.equal(opened.rows[0]?.reason, 'cross-unreconciled');
  assert.equal(opened.rows[0]?.facts.nonce, used.latest.toString(), JSON.stringify(opened.rows[0]?.facts));
  assert.deepEqual({ signed: counts().signed - before.signed, handOffs: counts().handOffs - before.handOffs }, { signed: 0, handOffs: 0 });
  assert.equal(await crossRow(c.betHash), null, 'no Cross');
  const bet = await pool.query<{ bet_state: string }>('SELECT bet_state FROM orders WHERE hash = $1', [c.betHash.toLowerCase()]);
  assert.equal(bet.rows[0]?.bet_state, 'waiting');
  const after = await pool.query<{ to: string; at: string | null }>('SELECT verified_nonce_to::text AS to, verified_block_number::text AS at FROM lanes');
  assert.deepEqual(after.rows, wm.rows, 'the watermark did not move');
});

test("the reserved NODE_REFUSED, produced by nothing in this file's runs: no row and no line holds it, after every hand-off here, its answer taken, lost, dropped, refused by its connection or answered by a named error", async () => {
  const crosses = await pool.query(`SELECT 1 FROM crosses WHERE not_sent_reason = 'NODE_REFUSED'`);
  const events = await pool.query(`SELECT 1 FROM events WHERE reason = 'NODE_REFUSED' OR facts::text LIKE '%NODE_REFUSED%'`);
  assert.deepEqual([crosses.rowCount, events.rowCount], [0, 0]);
});
