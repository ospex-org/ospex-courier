import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { keccak256, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import type { HoldPoint } from '../courier/check/hooks';
import { get as getFrom, startHookedCourier, type CourierProcess, type HookControl } from './support/courier';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { closeEach } from './support/close';
import { startStack, type Stack } from './support/stack';
import { outcomes, postStop as postStopFrom, stopMessage } from './support/stops';

// Send once, across the lives of the process: the courier killed with no chance
// to clean up at each point where it can stop, a commit whose acknowledgement
// is lost, two processes on one database and one key, and a stop recorded
// before a kill. Signatures are counted at the signer in test memory across
// every process's life; hand-offs at the proxy, which outlives the courier.
// Each case ends with its bet's record final and the next bet sent and filled.

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
const postStop = (...a: Parameters<typeof postStopFrom>) => postStopFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

/** Signatures of processes that have ended: their counts, kept when each was killed or stopped. */
let pastSigned = 0;
const signed = () => pastSigned + (stack.courier.hooks?.signed.length ?? 0);
const handOffs = () => stack.proxy.count('eth_sendRawTransaction');
const hooks = () => stack.courier.hooks as HookControl;
/** One bet's requests: those at the proxy, across every life, that carried its transaction's own bytes. None for a Cross with no transaction. */
const requestsOf = (txHash: string | null | undefined): number =>
  txHash === null || txHash === undefined ? 0 : stack.proxy.counted.filter((r) => r.sent !== undefined && keccak256(r.sent as Hex).toLowerCase() === txHash.toLowerCase()).length;

before(async () => {
  stack = await startStack('sendonce', {
    hooked: true,
    blockTime: 2,
    sending: true,
    sendsApart: { unsent: 'a process killed between the gate and the request leaves a hand-off in the records that never reached the node' },
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

async function crossRow(bet: string): Promise<{ state: string; hand_offs: number; tx_hash: string | null; nonce: string | null; not_sent_reason: string | null } | null> {
  const { rows } = await pool.query('SELECT state, hand_offs, tx_hash, nonce::text AS nonce, not_sent_reason FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()]);
  return (rows[0] as never) ?? null;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-10).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];
const final = (bet: string, ms = 90_000) => until(() => crossRow(bet), (r) => r !== null && FINAL.includes(r.state), ms, `the Cross of ${bet}`);

/** Where the door refused a post: what the node check found, from the status address, and the courier's last lines. */
async function whyRefused(): Promise<string> {
  const status = await getFrom(url(), '/v1/status').catch(() => null);
  const node = (status?.body as { node?: Record<string, unknown> } | undefined)?.node ?? null;
  const notOk = (v: unknown) => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
  const failing =
    node === null
      ? null
      : {
          ...Object.fromEntries(Object.entries(node).filter(([, v]) => notOk(v))),
          verdicts: ((node.verdicts as Array<Record<string, unknown>> | undefined) ?? []).filter((v) => Object.values(v).some(notOk)),
        };
  return `the node check's failing parts: ${JSON.stringify(failing)}; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`;
}

/** A quote of 9,600 that one bet fills whole, and a bet of 10,000 against it, to expire in `life` seconds. */
async function quoteAndBet(life = 30n): Promise<{ M: HDAccount; B: HDAccount; quote: Order; betHash: string; quoteHash: string }> {
  const M = await fresh();
  const B = await fresh();
  const T = await stack.rig.time();
  const quote: Order = { ...orderOn(stack.rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 9_600n }), positionType: 0 };
  const posted = await postOrder(url(), stack.rig, M, 'rest', quote);
  if (posted.status !== 201) assert.fail(`${JSON.stringify(posted.body)}; ${await whyRefused()}`);
  const bet: Order = { ...orderOn(stack.rig, B, { expiry: T + life, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(url(), stack.rig, B, 'take', bet);
  if (taken.status !== 202) assert.fail(`${JSON.stringify(taken.body)}; ${await whyRefused()}`);
  return { M, B, quote, betHash: taken.body.orderHash as string, quoteHash: posted.body.orderHash as string };
}

async function keyCount(): Promise<bigint> {
  return BigInt((await stack.rig.rpc('eth_getTransactionCount', [stack.rig.accounts.sender.address, 'latest'])) as string);
}

/** The process killed by the operating system, with no chance to clean up, then a new one started through the tests' start file. */
async function killAndRestart(): Promise<void> {
  pastSigned += stack.courier.hooks?.signed.length ?? 0;
  stack.courier.process.kill('SIGKILL');
  await stack.courier.exited;
  await stack.restartCourier({ hooked: true });
}

/** After every case: no transaction of the key the records do not hold. Every nonce the key used is a Cross the chain ran. */
async function noForeignTransactions(): Promise<void> {
  const ran = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM crosses WHERE state IN ('confirmed', 'reverted')`);
  assert.equal(await keyCount(), BigInt((ran.rows[0] as { n: string }).n), "the key's transactions on the chain are the Crosses the records hold as run");
}

/** The next bet, sent once and filled. */
async function nextFills(): Promise<void> {
  await until(async () => (await pool.query<{ held_bet: string | null }>('SELECT held_bet FROM lanes')).rows.every((r) => r.held_bet === null), (v) => v, 90_000, 'the lane free');
  const before = { s: signed(), h: handOffs() };
  const c = await quoteAndBet();
  const row = await final(c.betHash);
  assert.equal(row?.state, 'confirmed', JSON.stringify(row));
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 1, h: 1 }, 'the next bet: one signature, one hand-off');
}

/** Each of the points where the process can stop, and what its bet ends as after the restart. */
const KILLS: Array<{ point: HoldPoint; life: bigint; ends: string; reason?: string; signedAtMost: number; handOffs: number }> = [
  { point: 'after-reservation', life: 30n, ends: 'confirmed', signedAtMost: 1, handOffs: 1 },
  { point: 'after-intent', life: 30n, ends: 'not sent', reason: 'COURIER_RESTARTED', signedAtMost: 0, handOffs: 0 },
  { point: 'after-signature', life: 30n, ends: 'not sent', reason: 'COURIER_RESTARTED', signedAtMost: 1, handOffs: 0 },
  { point: 'after-signed-record', life: 30n, ends: 'not sent', reason: 'COURIER_RESTARTED', signedAtMost: 1, handOffs: 0 },
  { point: 'after-gate', life: 14n, ends: 'expired unmined', signedAtMost: 1, handOffs: 0 },
  { point: 'after-hand-off', life: 30n, ends: 'confirmed', signedAtMost: 1, handOffs: 1 },
];

for (const k of KILLS) {
  test(`the process killed at ${k.point}, then a restart: at most ${k.signedAtMost} signature and ${k.handOffs} hand-off for the bet across both lives, at most one transaction of the key at its nonce, the bet's record ${k.ends}${k.reason === undefined ? '' : ` ${k.reason}`}, and the next bet sent and filled`, async () => {
    const before = { s: signed(), h: handOffs(), n: await keyCount() };
    await hooks().arm(k.point, 1);
    const c = await quoteAndBet(k.life);
    await hooks().reached(k.point);
    await killAndRestart();
    const row = await final(c.betHash);
    assert.equal(row?.state, k.ends, JSON.stringify(row));
    if (k.reason !== undefined) assert.equal(row?.not_sent_reason, k.reason);
    assert.ok(signed() - before.s <= k.signedAtMost, `signatures ${signed() - before.s}`);
    assert.equal(handOffs() - before.h, k.handOffs, 'hand-offs');
    assert.ok((await keyCount()) - before.n <= 1n, 'at most one transaction of the key');
    await noForeignTransactions();
    await nextFills();
  });
}

for (const at of [
  { name: 'the signed record', marker: "SET state = 'signed'", ends: ['not sent'], handOffs: 0 },
  { name: 'the gate', marker: "SET state = 'handing off'", ends: ['expired unmined'], handOffs: 0 },
]) {
  test(`the commit of ${at.name} acknowledged to nobody, the row standing, then a restart: one signature, no hand-off, the bet's record final, and the next bet sent and filled`, async () => {
    const before = { s: signed(), h: handOffs() };
    const cut = stack.dbRelay.dropCommitAfter(at.marker);
    const c = await quoteAndBet(14n);
    await cut;
    // The process stops sending, or settles from the chain; either way it is killed here and a new one starts.
    await new Promise((r) => setTimeout(r, 1_000));
    await killAndRestart();
    const row = await final(c.betHash);
    assert.ok(at.ends.includes(row?.state as string), JSON.stringify(row));
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 1, h: at.handOffs });
    await noForeignTransactions();
    await nextFills();
  });
}

test("the node's answer lost, then a restart, with the proxy refusing the first attempt's connection: one request for the bet, by its own bytes, and no second; the Cross settles from the chain, expired unmined, before the lane reserves anything", async () => {
  // F held at the head as it stands, so the first life records no answer and cannot settle.
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string));
  // The first attempt's connection refused: closed before the request reaches the node, with no answer.
  stack.proxy.dropNext('eth_sendRawTransaction');
  const c = await quoteAndBet(14n);
  await until(() => crossRow(c.betHash), (r) => r !== null && ['unknown', 'sent', 'pending'].includes(r.state), 30_000, 'the hand-off made');
  // A second bet waits behind it, and is reserved only after the first is settled.
  const second = await quoteAndBet();
  await killAndRestart();
  stack.proxy.setFinal(null);
  stack.proxy.finalFollows(1n);
  // Both bets final before anything is counted, so no request of either is still to come.
  const row = await final(c.betHash);
  const row2 = await final(second.betHash);
  assert.deepEqual({ first: requestsOf(row?.tx_hash), second: requestsOf(row2?.tx_hash) }, { first: 1, second: 1 }, 'one request for each bet: the first never sent again');
  // Its transaction never reached the node: in no block up to a final block at or past the bet's expiry.
  assert.equal(row?.state, 'expired unmined', JSON.stringify(row));
  const settled = await pool.query<{ outcome: Date; intent: Date | null }>(
    `SELECT a.outcome_at AS outcome, b.intent_at AS intent FROM crosses a LEFT JOIN crosses b ON b.bet_hash = $2 WHERE a.bet_hash = $1`,
    [c.betHash.toLowerCase(), second.betHash.toLowerCase()],
  );
  const t = settled.rows[0] as { outcome: Date; intent: Date | null };
  assert.ok(t.intent === null || t.intent >= t.outcome, 'the lane reserved the second bet only after the first was settled');
  await noForeignTransactions();
});

test('the node\'s answer lost, then a restart: the Cross settles confirmed from the chain before the lane reserves anything, with no second request', async () => {
  // F held at the head as it stands, so the first life records the answer lost and cannot settle.
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string));
  const kept = stack.proxy.passAndHold('eth_sendRawTransaction');
  const c = await quoteAndBet();
  await kept.passed;
  kept.release({ drop: true });
  await until(() => crossRow(c.betHash), (r) => r !== null && ['unknown', 'pending'].includes(r.state), 30_000, 'the answer lost');
  // A second bet waits behind it, and is reserved only after the first is settled.
  const second = await quoteAndBet();
  await killAndRestart();
  stack.proxy.setFinal(null);
  stack.proxy.finalFollows(1n);
  // Both bets final before anything is counted, so no request of either is still to come.
  const row = await final(c.betHash);
  const row2 = await final(second.betHash);
  assert.deepEqual({ first: requestsOf(row?.tx_hash), second: requestsOf(row2?.tx_hash) }, { first: 1, second: 1 }, 'one request for each bet: the first never sent again');
  assert.equal(row?.state, 'confirmed', JSON.stringify(row));
  const order = await pool.query<{ bet: string }>(`SELECT bet_hash AS bet FROM crosses WHERE bet_hash IN ($1, $2) ORDER BY intent_at`, [c.betHash.toLowerCase(), second.betHash.toLowerCase()]);
  assert.equal(order.rows[0]?.bet, c.betHash.toLowerCase());
  const settled = await pool.query<{ outcome: Date; intent: Date | null }>(
    `SELECT a.outcome_at AS outcome, b.intent_at AS intent FROM crosses a LEFT JOIN crosses b ON b.bet_hash = $2 WHERE a.bet_hash = $1`,
    [c.betHash.toLowerCase(), second.betHash.toLowerCase()],
  );
  const t = settled.rows[0] as { outcome: Date; intent: Date | null };
  assert.ok(t.intent === null || t.intent >= t.outcome, 'the lane reserved the second bet only after the first was settled');
  await noForeignTransactions();
});

test('a stop of a listed quote committed while the courier runs, then a kill after the signed record: the next start closes the Cross not sent COURIER_RESTARTED, nothing reaches the proxy, and the quote stays stopped for every later bet', async () => {
  const before = { h: handOffs() };
  await hooks().arm('after-signed-record', 1);
  const c = await quoteAndBet();
  await hooks().reached('after-signed-record');
  const stop = await postStop(url(), stack.rig, c.M, stopMessage(c.M.address, [c.quoteHash as `0x${string}`]));
  assert.deepEqual(outcomes(stop), ['stopped']);
  await killAndRestart();
  const row = await final(c.betHash);
  assert.deepEqual([row?.state, row?.not_sent_reason, row?.hand_offs], ['not sent', 'COURIER_RESTARTED', 0]);
  assert.equal(handOffs() - before.h, 0);
  // A later bet at the same price does not list the stopped quote.
  const later = await quoteAndBet();
  await final(later.betHash);
  const legs = await pool.query<{ order_hash: string }>('SELECT order_hash FROM legs WHERE bet_hash = $1', [later.betHash.toLowerCase()]);
  assert.ok(!legs.rows.some((l) => l.order_hash === c.quoteHash.toLowerCase()), 'the stopped quote listed for no later bet');
  // M's quote stays stopped; the case's own stays used up.
  await noForeignTransactions();
});

/**
 * Two processes on one database and one key: the first held at each of the points where it can stop (the kills' list)
 * while the second starts, then let go; and once more with the first one's database session cut while it is held, the
 * second on a session of its own, straight to the database, so that the cut reaches the first alone. What the second's
 * start does with the bet (`take`), what the bet ends as, and whose hand-off may carry it: none; the first's, which had
 * passed the gate; or the second's, which sent the bet that its start put back to waiting.
 */
const TWO: Array<{ point: HoldPoint; cut?: true; take: 'returned' | 'closed' | 'left'; ends: string[]; reason?: string; by: 'none' | 'first' | 'second' }> = [
  { point: 'after-reservation', take: 'returned', ends: ['confirmed'], by: 'second' },
  { point: 'after-intent', take: 'closed', ends: ['not sent'], reason: 'COURIER_RESTARTED', by: 'none' },
  { point: 'after-signature', take: 'closed', ends: ['not sent'], reason: 'COURIER_RESTARTED', by: 'none' },
  { point: 'after-signed-record', take: 'closed', ends: ['not sent'], reason: 'COURIER_RESTARTED', by: 'none' },
  { point: 'after-gate', take: 'left', ends: ['confirmed', 'expired unmined'], by: 'first' },
  { point: 'after-hand-off', take: 'left', ends: ['confirmed'], by: 'first' },
  { point: 'after-signed-record', cut: true, take: 'closed', ends: ['not sent'], reason: 'COURIER_RESTARTED', by: 'none' },
];

for (const two of TWO) {
  test(`two processes on one database and one key, the first held ${two.point}${two.cut === true ? ' with its database session cut while it lives' : ''} while the second starts: at most one hand-off for the bet, none by a process that had not passed the gate, and the first sends nothing more`, async () => {
    const before = { s: signed(), h: handOffs(), requests: stack.proxy.counted.length };
    await hooks().arm(two.point, 1);
    const c = await quoteAndBet();
    const held = await hooks().reached(two.point);
    if (two.cut === true) {
      stack.dbRelay.cut();
      // The cut reached the first: its pool says an idle connection of its failed.
      await until(async () => stack.courier.lines.some((l) => /^database: (an |the door's |the lane's )idle connection failed/.test(l)), (v) => v, 10_000, "the first's session cut");
    }
    const second: CourierProcess & { hooks: HookControl } = await startHookedCourier(two.cut === true ? { ...stack.env, DATABASE_URL: stack.databaseUrl } : stack.env);
    try {
      if (two.cut === true) stack.dbRelay.restore();
      // What the second's start did with the bet, from its own line: put back to waiting, closed not sent, or left open.
      const started = await pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'run started' ORDER BY number DESC LIMIT 1`);
      const f = started.rows[0]?.facts ?? {};
      assert.deepEqual([f.heldReturnedToWaiting, f.crossesClosedRestarted], two.take === 'returned' ? [1, 0] : two.take === 'closed' ? [0, 1] : [0, 0], `the second's start: ${JSON.stringify(f)}`);
      await hooks().go(held);
      // Ends at the first's next step refused, or at a hand-off beyond the one the case allows: one fails at once, by name.
      const allowed = two.by === 'none' ? 0 : 1;
      const LOST = /no longer holds its lane or its reservation/;
      const FAILED = /the database failed in .*; this process takes no more bets/;
      const seen = await until(
        async () => ({ lost: stack.courier.lines.some((l) => LOST.test(l)), failed: stack.courier.lines.some((l) => FAILED.test(l)), h: handOffs() - before.h }),
        (v) => v.lost || v.failed || v.h > allowed,
        60_000,
        "the first's next step refused, or a hand-off beyond the case's",
      );
      assert.ok(seen.h <= allowed, `hand-offs ${seen.h}, where at most ${allowed}`);
      // The first's next step fails the lane's check. Where its session was cut, the cut may meet it first, as the database's failure.
      assert.ok(seen.lost || (two.cut === true && seen.failed), `the first's next step: ${stack.courier.lines.slice(-4).join(' | ')}`);
      const row = await final(c.betHash);
      assert.ok(two.ends.includes(row?.state as string), JSON.stringify(row));
      if (two.reason !== undefined) assert.equal(row?.not_sent_reason, two.reason, JSON.stringify(row));
      const total = handOffs() - before.h;
      assert.ok(total <= allowed, `hand-offs ${total}`);
      // Whose hand-off, by the transaction's own bytes: the first's only where it had passed the gate, the second's only
      // where its start put the bet back to waiting.
      const ofFirst = new Set((stack.courier.hooks?.signed ?? []).map((x) => x.toLowerCase()));
      const ofSecond = new Set(second.hooks.signed.map((x) => x.toLowerCase()));
      const sends = stack.proxy.counted.slice(before.requests).filter((r) => r.method === 'eth_sendRawTransaction').map((r) => String(r.sent).toLowerCase());
      for (const s of sends) {
        const by = ofFirst.has(s) ? 'first' : ofSecond.has(s) ? 'second' : 'neither';
        assert.equal(by, two.by, `a hand-off by ${by}`);
      }
      assert.ok(signed() - before.s + second.hooks.signed.length <= 1, 'one signature at most');
    } finally {
      if (two.cut === true) stack.dbRelay.restore();
      pastSigned += second.hooks.signed.length;
      await second.stop();
      // The stack's process owns the lanes again.
      pastSigned += stack.courier.hooks?.signed.length ?? 0;
      await stack.restartCourier({ hooked: true });
    }
    await nextFills();
  });
}
