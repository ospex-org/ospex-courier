import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import type { Abi, Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { orderHash } from '../courier/orders/order';
import { openPool } from '../courier/records/store';
import { get as getFrom, startHookedCourier, type CourierProcess, type HookControl } from './support/courier';
import { cancelOnChain, orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import type { Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';
import { postStop as postStopFrom, stopMessage } from './support/stops';

// The lane, from what a user would see: one lane per sender key, one owner by
// its epoch, one bet at a time. Two processes on one database and one key; a
// bet posted to a process that lost the lane; the take behind a door; a wake
// that comes as the runner ends; a stop between the reservation's find and its
// update; the database lost in a lane step; and a stop while a bet is held,
// with the process gone before its outcome. Each case holds the courier at the
// lane's own points, through the tests' start file, and reads the bet's record,
// the rows and the lines.

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;
const url = () => stack.courier.url;

/**
 * Every test sends from a network address of its own, as the courier's other tests do, so the courier's count of an
 * address's minute, 600 requests, limits none: the last value of X-Forwarded-For, an address of 198.19.0.0/16 new for
 * each. The requests below go out from it unless a case names another address.
 */
let from: Record<string, string> = {};
let nextAddress = 0;
const ownAddress = (): Record<string, string> => {
  const n = nextAddress++;
  return { 'x-forwarded-for': `198.19.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
};
beforeEach(() => {
  from = ownAddress();
});
const get = (...a: Parameters<typeof getFrom>) => getFrom(a[0], a[1], a[2] ?? from);
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const postStop = (...a: Parameters<typeof postStopFrom>) => postStopFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const hooks = (): HookControl => {
  const h = stack.courier.hooks;
  if (h === undefined) throw new Error("the stack's courier was not started through the tests' start file");
  return h;
};

before(async () => {
  stack = await startStack('lane', { hooked: true });
  rig = stack.rig;
  pool = openPool(stack.databaseUrl, null);
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

let nextAccount = 60;
async function freshAccount(): Promise<HDAccount> {
  const who = rig.account(nextAccount++);
  await rig.fund(who);
  return who;
}

/** A market of a case's own: a spread line no other case uses, so its book holds the case's quotes alone. */
let nextLine = 1;
const ownMarket = () => ({ scorer: rig.addresses.spread, lineTicks: 100 + 5 * nextLine++ });

/** A bet with no quote on its market: the check refuses it NO_DEPTH. */
async function lonelyBet(who: HDAccount, market = ownMarket()): Promise<{ hash: Hex; order: Order; posted: Awaited<ReturnType<typeof postOrder>> }> {
  const T = await rig.time();
  const order: Order = { ...orderOn(rig, who, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
  const posted = await postOrder(url(), rig, who, 'take', order);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as Hex, order, posted };
}

/** A quote and a bet that meets it on a market of their own: the check finds the bet ready. */
async function readyPair(market = ownMarket()): Promise<{ hash: Hex; order: Order; quote: Hex; bettor: HDAccount }> {
  const M = await freshAccount();
  const B = await freshAccount();
  const T = await rig.time();
  const q: Order = { ...orderOn(rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 100_000n, ...market }), positionType: 0 };
  const quote = await postOrder(url(), rig, M, 'rest', q);
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const order: Order = { ...orderOn(rig, B, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
  const posted = await postOrder(url(), rig, B, 'take', order);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as Hex, order, quote: quote.body.orderHash as Hex, bettor: B };
}

/** The bet's record once an outcome is written: read again until it is no longer queued. */
async function judged(hash: string, on = url()): Promise<Record<string, unknown>> {
  // Read every tenth of a second, at most 300 times: well under the address's 600 a minute.
  for (let i = 0; i < 300; i++) {
    const r = await get(on, `/v1/orders/${hash}`);
    if (r.body.state !== 'queued') return r.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the bet ${hash} was still queued after 30 seconds`);
}

/** The bet's outcome lines: kind, reason and run, in order. */
async function outcomeLines(hash: string): Promise<Array<{ kind: string; reason: string | null; run: number }>> {
  const { rows } = await pool.query(`SELECT kind, reason, run::int AS run FROM events WHERE bet_hash = $1 AND kind IN ('bet refused', 'bet lapsed', 'cross not sent') ORDER BY number`, [hash.toLowerCase()]);
  return rows as Array<{ kind: string; reason: string | null; run: number }>;
}

/** Waits until the bet's outcome line is written: read every tenth of a second, at most 300 times. */
async function outcomeWritten(hash: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if ((await outcomeLines(hash)).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the bet ${hash} had no outcome line after 30 seconds`);
}

/** The run a courier process writes its lines under, from its listening line. */
function runOf(courier: CourierProcess): number {
  const line = courier.lines.find((l) => /^courier: listening on port \d+, run \d+/.test(l));
  if (line === undefined) throw new Error('the courier has no listening line');
  return Number(/run (\d+)/.exec(line)?.[1]);
}

/** Waits until the courier has logged a line matching `pattern`: a step the process is seen to reach. */
async function logged(courier: CourierProcess, pattern: RegExp): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (courier.lines.some((l) => pattern.test(l))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the courier did not log ${pattern}: ${courier.lines.slice(-5).join(' | ')}`);
}

const LOST = /^lane: the outcome of a bet was not written/;

/** The lane's row, as the database holds it. */
async function laneRow(): Promise<{ epoch: string; held_bet: string | null; reservation: string | null; reserved_at: Date | null }> {
  const { rows } = await pool.query(`SELECT epoch::text AS epoch, held_bet, reservation::text AS reservation, reserved_at FROM lanes WHERE sender = $1`, [rig.accounts.sender.address.toLowerCase()]);
  return rows[0] as { epoch: string; held_bet: string | null; reservation: string | null; reserved_at: Date | null };
}

test('one process, one bet, checked: the control. The bet is held under a reservation while its check runs, and the lane is free once its outcome is written', async () => {
  const B = await freshAccount();
  await hooks().arm('after-reservation');
  const bet = await lonelyBet(B);
  const held = await hooks().reached('after-reservation');
  assert.equal(held.bet, bet.hash.toLowerCase());
  const during = await laneRow();
  assert.equal(during.held_bet, bet.hash.toLowerCase());
  assert.ok(during.reservation !== null && during.reserved_at !== null, 'the reservation and its time are written with the bet');
  assert.equal((await get(url(), `/v1/orders/${bet.hash}`)).body.turn, 'checking');
  await hooks().go(held);
  const record = await judged(bet.hash);
  assert.equal(record.state, 'refused');
  assert.equal((record.verdict as { code: string }).code, 'NO_DEPTH');
  const freed = await laneRow();
  assert.deepEqual({ held_bet: freed.held_bet, reservation: freed.reservation, reserved_at: freed.reserved_at }, { held_bet: null, reservation: null, reserved_at: null }, 'freed: the three emptied together');
});

for (const point of ['after-reservation', 'after-read-c', 'before-result'] as const) {
  for (const kind of ['NO_DEPTH', 'ready'] as const) {
    test(`two processes, one database, one key: the first held ${point} with a ${kind} bet, the second takes the lane and checks the bet; the first, let go, writes nothing; exactly one outcome, the second's. A bet posted to the first is refused NOT_TAKING_BETS and recorded nowhere; posted to the second it is taken and checked`, async () => {
      const first = stack.courier as CourierProcess & { hooks: HookControl };
      await first.hooks.arm(point);
      const bet = kind === 'ready' ? await readyPair() : await lonelyBet(await freshAccount());
      const held = await first.hooks.reached(point);
      assert.equal(held.bet, bet.hash.toLowerCase());
      const second = await startHookedCourier(stack.env);
      try {
        const record = await judged(bet.hash, second.url);
        assert.equal(record.state, kind === 'ready' ? 'not sent' : 'refused', JSON.stringify(record));
        // A bet posted to the first, which lost the lane: refused, and no row.
        const late = await freshAccount();
        const T = await rig.time();
        const refusedBet: Order = { ...orderOn(rig, late, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...ownMarket() }), positionType: 1 };
        const refused = await postOrder(first.url, rig, late, 'take', refusedBet);
        assert.equal(refused.status, 503, JSON.stringify(refused.body));
        assert.equal(refused.body.code, 'NOT_TAKING_BETS');
        assert.equal(refused.body.error, 'The courier is not taking bets right now. This bet was not recorded. Post the same signed bet again.');
        const { rows } = await pool.query('SELECT 1 FROM orders WHERE hash = $1', [String(refused.body.orderHash ?? '').toLowerCase()]);
        assert.equal(rows.length, 0, 'no orders row');
        // The same signed bet posted to the second: taken, and checked.
        const again = await postOrder(second.url, rig, late, 'take', refusedBet);
        assert.equal(again.status, 202, JSON.stringify(again.body));
        assert.equal((await judged(again.body.orderHash as string, second.url)).state, 'refused');
        // The first is let go: it finds the lane is not its own, and writes nothing.
        await first.hooks.go(held);
        await logged(first, LOST);
        const lines = await outcomeLines(bet.hash);
        assert.deepEqual(lines, [{ kind: kind === 'ready' ? 'cross not sent' : 'bet refused', reason: kind === 'ready' ? 'SENDER_NOT_BUILT' : 'NO_DEPTH', run: runOf(second) }], 'one outcome, the second\'s');
        const crosses = await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()]);
        assert.equal(crosses.rows[0].n, kind === 'ready' ? 1 : 0);
      } finally {
        await second.stop();
        await stack.restartCourier({ hooked: true });
      }
    });
  }
}

test('the take behind a door: a door holding its share lock on the lane, with its bet not yet committed, holds the take of a process starting; the bet commits at the first, and the second\'s runner checks it', async () => {
  const B = await freshAccount();
  const firstRun = runOf(stack.courier);
  // The door's line needs a share of this run's row; the test holds the row, so the door stands after check 17 with
  // the lane's row under its share lock.
  const holder = await pool.connect();
  const firstLogged = stack.courier.lines.length;
  let second: CourierProcess | null = null;
  let posting: Promise<Awaited<ReturnType<typeof postOrder>>> | null = null;
  let starting: Promise<CourierProcess> | null = null;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM runs WHERE id = $1 FOR UPDATE', [firstRun]);
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const T = await rig.time();
    const order: Order = { ...orderOn(rig, B, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...ownMarket() }), positionType: 1 };
    let posted_ = false;
    posting = postOrder(url(), rig, B, 'take', order);
    posting.then(
      () => (posted_ = true),
      () => (posted_ = true),
    );
    // The door is answered, or seen waiting on the test's row: a step it is seen to reach.
    const door = await seen(async () => (posted_ ? 'answered' : await waitingOn(holderPid)));
    // Then the door holds the lane's row under its share lock: the row cannot be locked for update.
    const doorHoldsTheLane = !(await laneLockable());
    let started = false;
    starting = startHookedCourier(stack.env);
    starting.then(
      () => (started = true),
      () => (started = true),
    );
    // The process starting has listened, or is seen waiting on the door.
    const take = typeof door === 'number' ? await seen(async () => (started ? 'listened' : (await waitingOn(door)) === null ? null : 'waited on the door')) : 'no door to wait on';
    await holder.query('COMMIT');
    const posted = await posting;
    second = await starting;
    const hash = String(posted.body.orderHash ?? '');
    const record = posted.status === 202 ? await judged(hash, second.url).catch((err: unknown) => ({ unjudged: String(err) }) as Record<string, unknown>) : null;
    const lines = posted.status === 202 ? await outcomeLines(hash) : [];
    const endedForADeadlock = [...stack.courier.lines.slice(firstLogged), ...second.lines].filter((l) => l.includes('40P01'));
    // Everything the schedule showed, in one assertion.
    assert.deepStrictEqual(
      { door: typeof door === 'number' ? 'waited on the test' : door, doorHoldsTheLane, take, posted: posted.status, bet: record?.state ?? null, lines, endedForADeadlock },
      { door: 'waited on the test', doorHoldsTheLane: true, take: 'waited on the door', posted: 202, bet: 'refused', lines: [{ kind: 'bet refused', reason: 'NO_DEPTH', run: runOf(second) }], endedForADeadlock: [] },
      `the door held its share of the lane; the take waited behind it; the bet the door committed was checked once, by the new owner (the bet: ${JSON.stringify(record)})`,
    );
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await posting?.catch(() => undefined);
    second = second ?? (await starting?.catch(() => null)) ?? null;
    await second?.stop();
    await stack.restartCourier({ hooked: true });
  }
});

/** The backend seen waiting on `pid` now, or null. */
async function waitingOn(pid: number): Promise<number | null> {
  const { rows } = await pool.query(`SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
  return rows.length > 0 ? (rows[0].pid as number) : null;
}

/** Looks until `look` answers: each answer a step the database or a process is seen to reach, never a time waited out. */
async function seen<T>(look: () => Promise<T | null>): Promise<T> {
  for (;;) {
    const answer = await look();
    if (answer !== null) return answer;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("two waiting bets of one account, the first recorded with the higher hash, stopped by one message while the runner stands between its find of the first and its update: the stop takes their rows from the lower hash and waits on the first, the runner's update waits behind it, and once the test lets the row go the stop commits first. The update then matches no row and its transaction ends, holding neither bet: neither is reserved, neither gets an outcome, no statement is ended for a deadlock, and the lane is free", async () => {
  const W = await freshAccount();
  const market = ownMarket();
  const T = await rig.time();
  // Two bets signed, the first with the higher hash: the record's order and the hashes' order run contrary.
  const pair = [0, 1].map((): Order => ({ ...orderOn(rig, W, { expiry: T + 28n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 }));
  const signed = pair.sort((a, b) => (orderHash(a, 31337n, rig.addresses.matching).toLowerCase() < orderHash(b, 31337n, rig.addresses.matching).toLowerCase() ? 1 : -1));
  assert.equal(signed.length, 2, 'a second bet with a lower hash among 64 signed');
  const [first, second] = signed as [Order, Order];
  const firstHash = orderHash(first, 31337n, rig.addresses.matching).toLowerCase() as Hex;
  const secondHash = orderHash(second, 31337n, rig.addresses.matching).toLowerCase() as Hex;
  // Both posted while a bet of another account holds the lane, so both wait.
  await hooks().arm('after-reservation');
  const setup = await lonelyBet(await freshAccount());
  const setupHeld = await hooks().reached('after-reservation');
  for (const o of [first, second]) assert.equal((await postOrder(url(), rig, W, 'take', o)).status, 202);
  // The runner, let go, takes the setup bet's outcome and then finds the first bet: held between its find and update.
  await hooks().arm('between-find-and-update');
  await hooks().go(setupHeld);
  assert.equal((await judged(setup.hash)).state, 'refused');
  const between = await hooks().reached('between-find-and-update');
  assert.equal(between.bet, firstHash, 'the runner found the first bet recorded');
  const holder = await pool.connect();
  const logged0 = stack.courier.lines.length;
  let stopping: Promise<Awaited<ReturnType<typeof postStop>>> | null = null;
  try {
    // The test holds the first bet's row; the stop takes the second's, the lower hash, and waits on the first.
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM orders WHERE hash = $1 FOR NO KEY UPDATE', [firstHash]);
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    stopping = postStop(url(), rig, W, stopMessage(W.address, [firstHash, secondHash]));
    const stopPid = await seen(() => waitingOn(holderPid));
    const stopHoldsTheSecond = !(await rowLockable(secondHash));
    // The runner's update of the first bet, let go, waits on the first bet's row, behind the test and the stop. Once
    // past it the runner reserves again, and is held when that reservation finds nothing: a step it is seen to reach.
    await hooks().arm('after-empty-reservation');
    await hooks().go(between);
    const updateWaits = await seen(async () => {
      const { rows } = await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND pid <> $2 AND (pg_blocking_pids(pid) && ARRAY[$1, $2]::int[])`, [stopPid, holderPid]);
      return rows.length > 0 ? true : null;
    });
    await holder.query('ROLLBACK');
    const stop = await stopping;
    const idle = await hooks().reached('after-empty-reservation');
    const rows = (await pool.query<{ hash: string; bet_state: string; ended: string | null }>('SELECT hash, bet_state, ended FROM orders WHERE hash = ANY($1) ORDER BY record_number', [[firstHash, secondHash]])).rows;
    const lines = [...(await outcomeLines(firstHash)), ...(await outcomeLines(secondHash))];
    const lane = await laneRow();
    const endedForADeadlock = stack.courier.lines.slice(logged0).filter((l) => l.includes('40P01'));
    assert.deepStrictEqual(
      { stopHoldsTheSecond, updateWaits, stop: { status: stop.status, results: (stop.body.results as Array<{ status: string }>).map((r) => r.status) }, rows: rows.map((r) => ({ bet_state: r.bet_state, ended: r.ended })), lines, laneHolds: lane.held_bet, endedForADeadlock },
      { stopHoldsTheSecond: true, updateWaits: true, stop: { status: 200, results: ['stopped', 'stopped'] }, rows: [{ bet_state: 'waiting', ended: 'stopped' }, { bet_state: 'waiting', ended: 'stopped' }], lines: [], laneHolds: null, endedForADeadlock: [] },
      'the stop took the lower hash and waited on the higher; the update waited behind it; the stop committed first; neither bet was reserved or judged; no deadlock; the lane free',
    );
    await hooks().go(idle);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await stopping?.catch(() => undefined);
    await hooks().disarm('between-find-and-update').catch(() => undefined);
    await hooks().disarm('after-empty-reservation').catch(() => undefined);
  }
});

test('two processes starting at once on one database, a bet held by a third that is gone, the two takes seen waiting together on the lane\'s row the test holds: each take locks the lane, raises its epoch and returns the held bet, one after the other, so the epoch rises by two; no statement is ended for a deadlock; one owns the lane and the other takes no bets; and the bet is judged exactly once', async () => {
  // The stack's courier holds a bet just after its reservation, and is stopped there: the bet stays held.
  await hooks().arm('after-reservation');
  const bet = await lonelyBet(await freshAccount());
  await hooks().reached('after-reservation');
  await stack.courier.stop();
  const before = await laneRow();
  assert.equal(before.held_bet, bet.hash.toLowerCase(), 'held by a process that is gone');
  // The two takes made to overlap: the test holds the lane's row, starts both, and lets the row go only once the lock
  // view shows both waiting on the lane. A process takes the lane before it listens, so neither start is awaited while
  // the row is held; a start that ends first ends the look.
  const holder = await pool.connect();
  let starting: Promise<Array<PromiseSettledResult<CourierProcess>>> | null = null;
  let waiting = -1;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM lanes WHERE sender = $1 FOR UPDATE', [rig.accounts.sender.address.toLowerCase()]);
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid as number;
    starting = Promise.allSettled([startHookedCourier(stack.env), startHookedCourier(stack.env)]);
    let ended = false;
    void starting.then(() => {
      ended = true;
    });
    waiting = await seen(async () => {
      if (ended) return 0;
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 AND query ILIKE '%lanes%'`,
        [holderPid],
      );
      return (rows[0]?.n ?? 0) >= 2 ? (rows[0]?.n as number) : null;
    });
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  const both = await (starting ?? Promise.resolve([]));
  const started = both.flatMap((b) => (b.status === 'fulfilled' ? [b.value] : []));
  try {
    assert.equal(waiting, 2, "both takes seen waiting on the lane's row before the test let it go");
    const anyOne = started[0] ?? assert.fail(`neither process started: ${both.map((b) => (b.status === 'rejected' ? String(b.reason) : 'started')).join('; ')}`);
    const record = await judged(bet.hash, anyOne.url).catch((err: unknown) => ({ unjudged: String(err) }) as Record<string, unknown>);
    const lane = await laneRow();
    const runs = started.map((c) => runOf(c));
    const { rows } = await pool.query<{ owner_run: string }>('SELECT owner_run::text FROM lanes');
    const owner = Number(rows[0]?.owner_run);
    const taking = await Promise.all(started.map(async (c) => ((await get(c.url, '/v1/status')).body.sender as { lane: { takingBets: boolean } }).lane.takingBets));
    const lines = (await outcomeLines(bet.hash)).map((l) => ({ kind: l.kind, reason: l.reason, byOneOfThem: runs.includes(l.run) }));
    const endedForADeadlock = started.flatMap((c) => c.lines).filter((l) => l.includes('40P01'));
    // Which take came last is the database's order, not the runs' numbers: the owner is one of the two, and the
    // other takes no bets. The bet is judged once, by whichever held it last; a take after its outcome finds it judged.
    assert.deepStrictEqual(
      { started: both.map((b) => b.status), epochRose: Number(BigInt(lane.epoch) - BigInt(before.epoch)), ownerIsOneOfThem: runs.includes(owner), taking: [...taking].sort(), bet: record.state, lines, laneHolds: lane.held_bet, endedForADeadlock },
      { started: ['fulfilled', 'fulfilled'], epochRose: 2, ownerIsOneOfThem: true, taking: [false, true], bet: 'refused', lines: [{ kind: 'bet refused', reason: 'NO_DEPTH', byOneOfThem: true }], laneHolds: null, endedForADeadlock: [] },
      'both started; each take raised the epoch once; one owns the lane and the other takes no bets; the held bet was judged once; no deadlock',
    );
  } finally {
    for (const c of started) await c.stop();
    await stack.restartCourier({ hooked: true });
  }
});

/** Whether the lane's row can be locked for update now: a NOWAIT attempt, rolled back. */
async function laneLockable(): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM lanes WHERE sender = $1 FOR UPDATE NOWAIT', [rig.accounts.sender.address.toLowerCase()]);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return false;
    throw err;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

test('a late wake: a bet posted while the runner is held just after a reservation that found nothing is checked', async () => {
  const courier = await stack.restartCourier({ hooked: true, holds: 'after-empty-reservation:1' });
  const h = courier.hooks as HookControl;
  const held = await h.reached('after-empty-reservation');
  const bet = await lonelyBet(await freshAccount());
  await h.go(held);
  assert.equal((await judged(bet.hash)).state, 'refused');
});

test('a stop between the reservation\'s find and its update: the update matches no row, the bet is never reserved, it gets no verdict line, its record says stopped, and it leaves the queue', async () => {
  const B = await freshAccount();
  await hooks().arm('between-find-and-update');
  const bet = await lonelyBet(B);
  const held = await hooks().reached('between-find-and-update');
  assert.equal(held.bet, bet.hash.toLowerCase());
  const stop = await postStop(url(), rig, B, stopMessage(B.address, [bet.hash]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  await hooks().go(held);
  // The runner goes on to the next attempt, which finds the queue empty; the lane is free and holds nothing.
  for (let i = 0; i < 200 && (await laneRow()).held_bet !== null; i++) await new Promise((r) => setTimeout(r, 25));
  const record = (await get(url(), `/v1/orders/${bet.hash}`)).body;
  assert.equal(record.state, 'stopped');
  assert.equal(record.verdict, undefined, 'no verdict: the stop came before any judgment');
  assert.deepEqual(await outcomeLines(bet.hash), []);
  const { rows } = await pool.query(`SELECT bet_state, ended FROM orders WHERE hash = $1`, [bet.hash.toLowerCase()]);
  assert.deepEqual(rows[0], { bet_state: 'waiting', ended: 'stopped' }, 'never reserved');
  const queue = await pool.query(`SELECT count(*)::int AS n FROM orders o WHERE o.role = 'take' AND o.bet_state IN ('waiting', 'held') AND o.ended IS NULL AND o.bet_state = 'waiting'`);
  assert.equal(queue.rows[0].n, 0, 'the queue holds no bet');
});

test('the database lost in a lane step: the outcome\'s transaction fails, and this process takes no more bets, even once the database is whole again, while quotes are still admitted; after a restart the held bet goes back to waiting and is judged exactly once, in record order ahead of a bet posted after the restart', async () => {
  const pair = await (async () => {
    await pool.query('ALTER TABLE crosses ADD CONSTRAINT crosses_refused_by_the_test CHECK (false) NOT VALID');
    return readyPair();
  })();
  try {
    await logged(stack.courier, /^lane: the database failed in a lane step/);
    const late = await freshAccount();
    const T = await rig.time();
    const another: Order = { ...orderOn(rig, late, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n, ...ownMarket() }), positionType: 1 };
    const refused = await postOrder(url(), rig, late, 'take', another);
    assert.equal(refused.body.code, 'NOT_TAKING_BETS', JSON.stringify(refused.body));
    const q: Order = { ...orderOn(rig, late, { expiry: T + 600n, oddsTick: 250, riskAmount: 10_000n, ...ownMarket() }), positionType: 0 };
    assert.equal((await postOrder(url(), rig, late, 'rest', q)).status, 201, 'quotes are still admitted');
  } finally {
    await pool.query('ALTER TABLE crosses DROP CONSTRAINT IF EXISTS crosses_refused_by_the_test');
  }
  // The database is whole; the process still takes no bets.
  const late2 = await freshAccount();
  const T2 = await rig.time();
  const still = await postOrder(url(), rig, late2, 'take', { ...orderOn(rig, late2, { expiry: T2 + 25n, oddsTick: 196, riskAmount: 10_000n, ...ownMarket() }), positionType: 1 });
  assert.equal(still.body.code, 'NOT_TAKING_BETS', JSON.stringify(still.body));
  const { rows: heldRows } = await pool.query('SELECT bet_state FROM orders WHERE hash = $1', [pair.hash.toLowerCase()]);
  assert.equal(heldRows[0].bet_state, 'held', 'the bet is left held: nothing of its outcome committed');
  // The restart holds its runner at its first reservation, so a new bet is posted while the old one waits its turn.
  const restarted = await stack.restartCourier({ hooked: true, holds: 'after-reservation:1' });
  const first = await (restarted.hooks as HookControl).reached('after-reservation');
  const fresh = await lonelyBet(await freshAccount());
  await (restarted.hooks as HookControl).go(first);
  const record = await judged(pair.hash);
  const next = await judged(fresh.hash);
  const { rows: order } = await pool.query<{ bet_hash: string }>(`SELECT bet_hash FROM events WHERE bet_hash = ANY($1) AND kind IN ('bet refused', 'bet lapsed', 'cross not sent') ORDER BY number`, [[pair.hash.toLowerCase(), fresh.hash.toLowerCase()]]);
  assert.deepEqual(
    { firstReserved: first.bet, state: record.state, next: next.state, order: order.map((r) => r.bet_hash), lines: (await outcomeLines(pair.hash)).length },
    { firstReserved: pair.hash.toLowerCase(), state: 'not sent', next: 'refused', order: [pair.hash.toLowerCase(), fresh.hash.toLowerCase()], lines: 1 },
    'the held bet went back to waiting, was reserved first, in record order, and judged exactly once',
  );
});

test('the database lost as the outcome commits: the result commits and its acknowledgement is lost; the process takes no more bets; after a restart the committed result is not repeated', async () => {
  await hooks().arm('before-result');
  const pair = await readyPair();
  const held = await hooks().reached('before-result');
  const dropped = stack.dbRelay.dropAnswerAfter('COMMIT');
  await hooks().go(held);
  await dropped;
  await logged(stack.courier, /^lane: the database failed in a lane step/);
  assert.equal((await pool.query('SELECT bet_state FROM orders WHERE hash = $1', [pair.hash.toLowerCase()])).rows[0].bet_state, 'sent', 'the result committed');
  await stack.restartCourier({ hooked: true });
  const record = await judged(pair.hash);
  assert.equal(record.state, 'not sent');
  assert.equal((await outcomeLines(pair.hash)).length, 1, 'the committed result is not repeated');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [pair.hash.toLowerCase()])).rows[0].n, 1);
});

for (const variant of ['the process ended at the kill point', "the outcome's transaction failed"] as const) {
  test(`a stop while the bet is held, and ${variant} before any outcome committed: after the restart the bet's record is stopped with the verdict STOPPED and no block, one STOPPED line from the new run, no Cross; the same bet posted again is answered with that record and nothing is written; a new bet is checked and found ready; a second restart writes nothing more`, async () => {
    await hooks().arm('after-read-a');
    const pair = await readyPair();
    const held = await hooks().reached('after-read-a');
    const stop = await postStop(url(), rig, pair.bettor, stopMessage(pair.bettor.address, [pair.hash]));
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    if (variant === 'the process ended at the kill point') {
      stack.courier.process.kill('SIGKILL');
      await stack.courier.exited;
    } else {
      await pool.query('ALTER TABLE events ADD CONSTRAINT events_refused_by_the_test CHECK (false) NOT VALID');
      try {
        await hooks().go(held);
        await logged(stack.courier, /^lane: the database failed in a lane step/);
      } finally {
        await pool.query('ALTER TABLE events DROP CONSTRAINT IF EXISTS events_refused_by_the_test');
      }
    }
    assert.equal((await pool.query('SELECT bet_state FROM orders WHERE hash = $1', [pair.hash.toLowerCase()])).rows[0].bet_state, 'held');
    const restarted = await stack.restartCourier({ hooked: true });
    const record = (await get(url(), `/v1/orders/${pair.hash}`)).body;
    assert.equal(record.state, 'stopped', JSON.stringify(record));
    assert.ok(record.verdict, JSON.stringify(record));
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict.code, 'STOPPED');
    assert.equal(verdict.error, 'A stop for this bet was recorded while it was being checked. Nothing was sent.');
    assert.equal(verdict.block, null);
    assert.equal('lastObservedBlock' in verdict, false);
    assert.deepEqual(await outcomeLines(pair.hash), [{ kind: 'bet refused', reason: 'STOPPED', run: runOf(restarted) }]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [pair.hash.toLowerCase()])).rows[0].n, 0);
    assert.equal((await laneRow()).held_bet, null, 'the lane is free');
    // The same bet posted again, in the same role: the whole record, and nothing written.
    const linesBefore = (await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n as number;
    const again = await postOrder(url(), rig, pair.bettor, 'take', pair.order);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body, record);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n, linesBefore, 'nothing written');
    // A new bet: checked, and found ready. The lane is not stuck.
    const next = await readyPair();
    assert.equal((await judged(next.hash)).state, 'not sent');
    // A second restart: still one STOPPED line, and the ready bet's result unchanged.
    await stack.restartCourier({ hooked: true });
    assert.deepEqual(await outcomeLines(pair.hash), [{ kind: 'bet refused', reason: 'STOPPED', run: runOf(restarted) }]);
    assert.equal((await outcomeLines(next.hash)).length, 1);
  });
}

test('the normal restart, the control: a bet held when its process ends goes back to waiting at the next start and is judged once', async () => {
  await hooks().arm('after-read-a');
  const bet = await lonelyBet(await freshAccount());
  await hooks().reached('after-read-a');
  stack.courier.process.kill('SIGKILL');
  await stack.courier.exited;
  await stack.restartCourier({ hooked: true });
  assert.equal((await judged(bet.hash)).state, 'refused');
  assert.equal((await outcomeLines(bet.hash)).length, 1);
});

// ──────────────────────────── stops and the lane ────────────────────────────

/** A quote by `who` on side A of the market. */
async function quoteOf(who: HDAccount, market: { scorer: Hex; lineTicks: number }, fields: Partial<Order> = {}): Promise<{ hash: Hex; order: Order }> {
  const T = await rig.time();
  const order: Order = { ...orderOn(rig, who, { expiry: T + 600n, oddsTick: 200, riskAmount: 100_000n, ...market, ...fields }), positionType: 0 };
  const posted = await postOrder(url(), rig, who, 'rest', order);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as Hex, order };
}

async function betOf(who: HDAccount, market: { scorer: Hex; lineTicks: number }, fields: Partial<Order> = {}): Promise<{ hash: Hex; order: Order }> {
  const T = await rig.time();
  const order: Order = { ...orderOn(rig, who, { expiry: T + 25n, oddsTick: 200, riskAmount: 10_000n, ...market, ...fields }), positionType: 1 };
  const posted = await postOrder(url(), rig, who, 'take', order);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as Hex, order };
}

const ownerOf = async (hash: Hex) => (await pool.query('SELECT bet_state, ended FROM orders WHERE hash = $1', [hash.toLowerCase()])).rows[0] as { bet_state: string | null; ended: string | null };

test('a stopped quote is listed for no bet whose candidate query begins after the stop: stopped before the bet\'s turn, it is not listed, and the bet is NO_DEPTH where it was the only quote; the control, not stopped, is ready', async () => {
  const market = ownMarket() as { scorer: Hex; lineTicks: number };
  const M = await freshAccount();
  const q = await quoteOf(M, market);
  const stop = await postStop(url(), rig, M, stopMessage(M.address, [q.hash]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const bet = await betOf(await freshAccount(), market);
  const record = await judged(bet.hash);
  assert.ok(record.verdict, JSON.stringify(record));
  assert.equal((record.verdict as { code: string }).code, 'NO_DEPTH');
  const other = ownMarket() as { scorer: Hex; lineTicks: number };
  await quoteOf(await freshAccount(), other);
  assert.equal((await judged((await betOf(await freshAccount(), other)).hash)).state, 'not sent', 'the control');
});

test('a bet stopped while it waits, another bet holding the lane: it is never reserved, it gets no verdict line, its record says stopped, and the queue holds one bet fewer', async () => {
  await hooks().arm('after-reservation');
  const first = await lonelyBet(await freshAccount());
  const held = await hooks().reached('after-reservation');
  assert.equal(held.bet, first.hash.toLowerCase());
  const W = await freshAccount();
  const waiting = await lonelyBet(W);
  const queued = async () => (await pool.query(`SELECT count(*)::int AS n FROM orders o WHERE o.role = 'take' AND o.bet_state IN ('waiting', 'held') AND o.ended IS NULL AND o.bet_state = 'waiting'`)).rows[0].n as number;
  assert.equal(await queued(), 1);
  const stop = await postStop(url(), rig, W, stopMessage(W.address, [waiting.hash]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(await queued(), 0, 'one fewer');
  await hooks().go(held);
  assert.equal((await judged(first.hash)).state, 'refused');
  for (let i = 0; i < 200 && (await laneRow()).held_bet !== null; i++) await new Promise((r) => setTimeout(r, 25));
  const record = (await get(url(), `/v1/orders/${waiting.hash}`)).body;
  assert.equal(record.state, 'stopped');
  assert.equal(record.verdict, undefined);
  assert.deepEqual(await outcomeLines(waiting.hash), []);
  assert.deepEqual(await ownerOf(waiting.hash), { bet_state: 'waiting', ended: 'stopped' }, 'never reserved');
});

for (const kind of ['ready', 'NO_DEPTH', 'lapsed'] as const) {
  test(`a bet stopped while it is held, whatever its check would have found (${kind}): its outcome is STOPPED with no block, no Cross row, and its record says stopped`, async () => {
    const point = kind === 'lapsed' ? 'after-reservation' : 'after-read-a';
    await hooks().arm(point);
    let bettor: HDAccount;
    let bet: { hash: Hex; order: Order };
    if (kind === 'ready') {
      const pair = await readyPair();
      bettor = pair.bettor;
      bet = pair;
    } else {
      bettor = await freshAccount();
      bet = await lonelyBet(bettor);
    }
    const held = await hooks().reached(point);
    const stop = await postStop(url(), rig, bettor, stopMessage(bettor.address, [bet.hash]));
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    if (kind === 'lapsed') {
      // H is mined at the bet's expiry less one: its check would lapse it.
      await rig.setNextBlockTime(bet.order.expiry - 1n);
      await rig.mine(1);
    }
    await hooks().go(held);
    // The record says stopped from the stop's commit; its verdict comes with the outcome the lane writes. So the
    // outcome's line is waited for, and the record read after it.
    await outcomeWritten(bet.hash);
    const record = (await get(url(), `/v1/orders/${bet.hash}`)).body;
    assert.equal(record.state, 'stopped', JSON.stringify(record));
    const verdict = record.verdict as Record<string, unknown>;
    assert.equal(verdict?.code, 'STOPPED', JSON.stringify(record));
    assert.equal(verdict.block, null);
    assert.deepEqual(await outcomeLines(bet.hash), [{ kind: 'bet refused', reason: 'STOPPED', run: runOf(stack.courier) }]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()])).rows[0].n, 0);
  });
}


test("a stop committed after the candidate statement and before the result leaves the quote in this build's Cross row, as the rule says; the figures hold the time the candidate statement ran, before the stop's; and the next bet does not list it", async () => {
  const market = ownMarket() as { scorer: Hex; lineTicks: number };
  const M = await freshAccount();
  const q = await quoteOf(M, market);
  await hooks().arm('after-read-c');
  const bet = await betOf(await freshAccount(), market);
  const held = await hooks().reached('after-read-c');
  const stop = await postStop(url(), rig, M, stopMessage(M.address, [q.hash]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  await hooks().go(held);
  const record = await judged(bet.hash);
  assert.equal(record.state, 'not sent', JSON.stringify(record));
  assert.deepEqual(((record.cross as { legs: Array<{ orderHash: string }> }).legs).map((l) => l.orderHash), [q.hash.toLowerCase()], 'the stale-scan quote is in the Cross row');
  const { rows } = await pool.query<{ checked: { candidateStatementAt: string } }>('SELECT checked FROM crosses WHERE bet_hash = $1', [bet.hash.toLowerCase()]);
  const stoppedAt = (await pool.query<{ received_at: Date }>('SELECT received_at FROM stops WHERE hash = $1', [q.hash.toLowerCase()])).rows[0]?.received_at as Date;
  assert.ok(new Date(rows[0]?.checked.candidateStatementAt as string).getTime() <= stoppedAt.getTime(), 'the statement ran before the stop');
  const next = await betOf(await freshAccount(), market);
  assert.equal(((await judged(next.hash)).verdict as { code: string }).code, 'NO_DEPTH', 'the next bet does not list it');
});

test('a stop after the judgment: the record keeps its judged state, and its end shows the stop beside it', async () => {
  const B = await freshAccount();
  const bet = await lonelyBet(B);
  assert.equal((await judged(bet.hash)).state, 'refused');
  const stop = await postStop(url(), rig, B, stopMessage(B.address, [bet.hash]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const record = (await get(url(), `/v1/orders/${bet.hash}`)).body;
  assert.equal(record.state, 'refused');
  assert.equal(record.ended, 'stopped');
  assert.equal((record.verdict as { code: string }).code, 'NO_DEPTH');
});

// ──────────────────────────── no order-row lock carried from the candidate scan ────────────────────────────

test("no order-row lock is carried from the bet's candidate statement into another statement: with the check held between the candidate statement, which marked a high-hashed quote expired, and its marks, which will mark a low-hashed quote cancelled, a stop naming both takes both rows at once and commits; no statement fails on a deadlock; the expired quote keeps its end and the cancelled one is the stop's", async () => {
  const market = ownMarket() as { scorer: Hex; lineTicks: number };
  const S = await freshAccount();
  // Two quotes of one account whose hashes fall high and low, the high one about to expire and the low one cancelled
  // on chain: the candidate statement marks the first, the check's marks the second.
  const T = await rig.time();
  // The high one expires in seconds; the low one stands, to be cancelled on chain. Each hash is computed before
  // anything is posted, a fresh nonce at each try and up to 24 tries a side, and only the two that fit are posted.
  const fitting = (terms: { expiry: bigint; oddsTick: number }, high: boolean): { nonce: bigint; hash: string } | null => {
    for (let i = 0; i < 24; i++) {
      const order: Order = { ...orderOn(rig, S, { riskAmount: 100_000n, ...market, ...terms }), positionType: 0 };
      const hash = orderHash(order, 31337n, rig.addresses.matching).toLowerCase();
      if (high ? hash > '0x8' : hash < '0x8') return { nonce: order.nonce, hash };
    }
    return null;
  };
  const highTerms = { expiry: T + 8n, oddsTick: 200 };
  const lowTerms = { expiry: T + 600n, oddsTick: 220 };
  const highFit = fitting(highTerms, true);
  const lowFit = fitting(lowTerms, false);
  assert.ok(highFit !== null && lowFit !== null, 'a high and a low hash among 24 tries each');
  const high = await quoteOf(S, market, { ...highTerms, nonce: highFit.nonce });
  const low = await quoteOf(S, market, { ...lowTerms, nonce: lowFit.nonce });
  assert.deepStrictEqual([high.hash.toLowerCase(), low.hash.toLowerCase()], [highFit.hash, lowFit.hash], 'the two quotes posted are the two the search found');
  // The low one lives on in the records, cancelled on chain: the check's read shows it ended and marks it.
  const lowLive: Order = { ...low.order };
  await cancelOnChain(rig, S, lowLive);
  // Past the high one's expiry, with the final block there too, so the candidate statement marks it expired.
  await rig.increaseTime(20n);
  stack.proxy.setFinal(BigInt(((await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { number: string }).number));
  let stopping: Promise<Awaited<ReturnType<typeof postStop>>> | null = null;
  try {
    const logged = stack.courier.lines.length;
    await hooks().arm('after-read-c');
    const bet = await betOf(await freshAccount(), market, { oddsTick: 150 });
    const held = await hooks().reached('after-read-c');
    // Held between the candidate statement and the marks: what the check holds is read before the stop is sent.
    const highMarked = (await ownerOf(high.hash)).ended;
    const rowsFree = { high: await rowLockable(high.hash), low: await rowLockable(low.hash) };
    // The stop names both, and takes their rows from the lower hash. It is answered, or seen waiting on a row; either
    // is a step the database or the courier is seen to reach, and no time is waited out.
    let answered = false;
    stopping = postStop(url(), rig, S, stopMessage(S.address, [low.hash, high.hash]));
    stopping.then(
      () => (answered = true),
      () => (answered = true),
    );
    let how: 'answered' | 'waiting' | null = null;
    for (let i = 0; i < 800 && how === null; i++) {
      if (answered) how = 'answered';
      else if (await aSessionWaitsOnALock()) how = 'waiting';
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Then the check is let go: it makes its marks, the low one's among them.
    await hooks().go(held);
    const stop = await stopping;
    const record = await judged(bet.hash).catch((err: unknown) => ({ unjudged: String(err) }) as Record<string, unknown>);
    const endedForADeadlock = stack.courier.lines.slice(logged).filter((l) => l.includes('40P01'));
    const ends = { high: (await ownerOf(high.hash)).ended, low: (await ownerOf(low.hash)).ended };
    // Everything the schedule showed, in one assertion. A check that carried the candidate statement's row lock on into
    // its marks would hold the high row while held, the stop would wait on it, and once the check was let go the two
    // would wait on each other until the database ended one: its 40P01 in the log, and one of the two answers changed.
    assert.deepStrictEqual(
      { endedForADeadlock, highMarked, rowsFree, stop: how, stopAnswered: stop.status, bet: record.state, ends },
      { endedForADeadlock: [], highMarked: 'expired', rowsFree: { high: true, low: true }, stop: 'answered', stopAnswered: 200, bet: 'refused', ends: { high: 'expired', low: 'stopped' } },
      `the candidate statement marked the high one and holds neither row; the stop committed while the check was held; no statement was ended for a deadlock; each quote keeps its first end (the bet: ${JSON.stringify(record)})`,
    );
  } finally {
    await stopping?.catch(() => undefined);
    stack.proxy.setFinal(null);
  }
});

/** Whether a session of this database waits on a lock now. */
async function aSessionWaitsOnALock(): Promise<boolean> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`);
  return (rows[0]?.n ?? 0) > 0;
}

/** Whether an order's row can be locked at once: a NOWAIT attempt, rolled back. */
async function rowLockable(hash: Hex): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM orders WHERE hash = $1 FOR NO KEY UPDATE NOWAIT', [hash.toLowerCase()]);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return false;
    throw err;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

// ──────────────────────────── the counted paths: commands to the database ────────────────────────────

test("the cost, in commands to the database, counted at the relay the courier's connections pass through: a refusal's outcome is 7 (BEGIN, the lane's lock, the bet read again, the line, the bet's state, the lane freed, COMMIT); a reservation lost to a stop is 5 and one won is 6, so one loss and then a win is 11", async () => {
  const relay = stack.dbRelay;
  // A set-up bet holds the lane; behind it, two bets of two accounts wait.
  await hooks().arm('after-reservation');
  const setup = await lonelyBet(await freshAccount());
  const setupHeld = await hooks().reached('after-reservation');
  const L = await freshAccount();
  const lost = await lonelyBet(L);
  const won = await lonelyBet(await freshAccount());
  // The set-up bet's check runs to its result, and is held there; then the runner, let go, writes the outcome and
  // takes up the first waiting bet, and is held between its find and its update.
  await hooks().arm('before-result');
  await hooks().go(setupHeld);
  const beforeResult = await hooks().reached('before-result');
  await hooks().arm('between-find-and-update');
  const c0 = relay.commands();
  await hooks().go(beforeResult);
  const between = await hooks().reached('between-find-and-update');
  const c1 = relay.commands();
  assert.equal(between.bet, lost.hash.toLowerCase());
  // The first bet stopped, by its account: the stop's own commands are counted apart.
  const c2 = relay.commands();
  const stop = await postStop(url(), rig, L, stopMessage(L.address, [lost.hash]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const c3 = relay.commands();
  await hooks().arm('after-reservation');
  await hooks().go(between);
  const wonHeld = await hooks().reached('after-reservation');
  const c4 = relay.commands();
  assert.equal(wonHeld.bet, won.hash.toLowerCase());
  await hooks().go(wonHeld);
  assert.equal((await judged(won.hash)).state, 'refused');
  assert.equal((await judged(setup.hash)).state, 'refused');
  // The outcome (7) and the first attempt's BEGIN, lock and find (3); then its update and ROLLBACK (2) and the second
  // attempt, won (6). The reservation's whole contended path is the 3, the 2 and the 6: 11.
  const counted = { outcomeAndFirstAttemptBegun: c1 - c0, stop: c3 - c2, rest: c4 - c3, reservation: c1 - c0 - 7 + (c4 - c3) };
  console.log(`# the counted path: ${JSON.stringify(counted)}`);
  assert.deepEqual({ outcomeAndFirstAttemptBegun: counted.outcomeAndFirstAttemptBegun, rest: counted.rest, reservation: counted.reservation }, { outcomeAndFirstAttemptBegun: 10, rest: 8, reservation: 11 });
});

test('the cost, in requests to the node at the proxy, for one round by its path: a lapse is 1; a refusal at read A is 2; a refusal after the walk with nothing listed is 3; a ready bet is 9 to 12', async () => {
  const counted = async (post: () => Promise<{ hash: Hex }>, between: () => Promise<void> = async () => undefined): Promise<{ state: unknown; requests: number }> => {
    await hooks().arm('after-reservation');
    const posted = await post();
    const held = await hooks().reached('after-reservation');
    await between();
    const before = stack.proxy.count();
    await hooks().go(held);
    const record = await judged(posted.hash);
    return { state: record.state, requests: stack.proxy.count() - before };
  };
  const lapsedBettor = await freshAccount();
  const lapsed = await counted(
    async () => {
      const T = await rig.time();
      const order: Order = { ...orderOn(rig, lapsedBettor, { expiry: T + 3n, oddsTick: 196, riskAmount: 10_000n, ...ownMarket() }), positionType: 1 };
      const posted = await postOrder(url(), rig, lapsedBettor, 'take', order);
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return { hash: posted.body.orderHash as Hex };
    },
    async () => {
      await rig.setNextBlockTime((await rig.time()) + 2n);
      await rig.mine(1);
    },
  );
  const unregistered = await freshAccount();
  const atReadA = await counted(
    () => lonelyBet(unregistered),
    async () => void (await rig.write(unregistered, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'unregisterCourier', [rig.addresses.relay])),
  );
  const afterWalk = await counted(async () => lonelyBet(await freshAccount()));
  const ready = await counted(() => readyPair());
  const paths = { lapsed, atReadA, afterWalk, ready: { state: ready.state, inRange: ready.requests >= 9 && ready.requests <= 12, requests: ready.requests } };
  console.log(`# node requests by path: ${JSON.stringify(paths)}`);
  assert.deepEqual(
    { lapsed, atReadA, afterWalk, ready: { state: ready.state, inRange: paths.ready.inRange } },
    { lapsed: { state: 'lapsed', requests: 1 }, atReadA: { state: 'refused', requests: 2 }, afterWalk: { state: 'refused', requests: 3 }, ready: { state: 'not sent', inRange: true } },
    `requests by path: ${JSON.stringify(paths)}`,
  );
});

test('idle: an hour of blocks mined with no request made: no row, no line, and no request to the node', async () => {
  const rows = async () => (await pool.query<{ orders: number; events: number; crosses: number }>('SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM events) AS events, (SELECT count(*)::int FROM crosses) AS crosses')).rows[0];
  const before = { rows: await rows(), requests: stack.proxy.count(), commands: stack.dbRelay.commands() };
  await rig.rpc('anvil_mine', ['0xe10', '0x1']);
  // Nothing runs on a schedule; a short look for anything that would.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.deepEqual({ rows: await rows(), requests: stack.proxy.count(), commands: stack.dbRelay.commands() }, before);
});
