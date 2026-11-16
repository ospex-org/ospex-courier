import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { decodeFunctionData, getAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { MATCHING_ABI, MULTICALL_ABI, MULTICALL_ADDRESS } from '../courier/chain/abi';
import { AHEAD_COUNT_SQL } from '../courier/records/stops';
import { openPool } from '../courier/records/store';
import { get, startCourier, type CourierProcess } from './support/courier';
import { contractHash, grantAgent, nextOrderNumber, nonceOf, orderOn, post, postOrder, postOrderAs, refusedForm, revokeAgent, sign, wire, type Answer, type Order } from './support/orders';
import type { Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';
import { hashLockKey, outcomes, postStop, resultsOf, sendStop, signStop, stopBody, stopMessage, STOP_TYPE, type OriginalSent, type StopMessage } from './support/stops';

// The stop, from a user's side: stop messages signed with real keys and posted
// over HTTP to the courier running as its own process against the local chain
// and a real Postgres; judged by the answer, the rows and the lines read back,
// the market's page and the order's record. The cases are numbered as the plan
// numbers them, 1 to 16; a number with a letter is one part of that case.

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;

before(async () => {
  stack = await startStack('stops');
  rig = stack.rig;
  pool = openPool(stack.databaseUrl, null);
});

/** Every courier process a case starts beside the stack's own. */
const others: CourierProcess[] = [];

/** Another courier process on the stack's chain and database. The case that starts one stops it; the end of the file stops it again, so one a failing case left running does not keep this file's process alive. */
async function anotherCourier(): Promise<CourierProcess> {
  const courier = await startCourier(stack.env);
  others.push(courier);
  return courier;
}

after(async () => {
  for (const courier of others) await courier.stop().catch(() => undefined);
  await pool?.end();
  await stack?.close();
});

const url = () => stack.courier.url;

/**
 * The courier's own log of stop requests since a mark: one line, which names the route and the code of a refusal
 * before admission and nothing else, so nothing of the caller or of the message is in it.
 */
async function refusalLogged(since: number, code: string): Promise<void> {
  const ofStops = () => stack.courier.lines.slice(since).filter((line) => line.includes('POST /v1/stops'));
  await until(`the courier's log line for a stop refused ${code}`, async () => ofStops().length > 0);
  assert.deepEqual(ofStops(), [`refused before admission: POST /v1/stops ${code}`], 'the log line is the route and the code, with nothing of the caller or of the message');
}

/** Every case sends from a network address of its own, so no case's count on either of the courier's two minutes is another's. */
const at = (n: number) => ({ 'x-forwarded-for': `198.51.100.${n}` });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits for what `look` is looking for, and returns it: looked for every 25 ms until it is there, and failed, by the
 * name of the phase, when it is not there within the deadline. No case takes time passing as proof of anything.
 */
async function until<T>(phase: string, look: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = await look();
    if (found !== null && found !== undefined && found !== false) return found;
    if (Date.now() - started > ms) assert.fail(`not reached within ${ms} ms: ${phase}`);
    await sleep(25);
  }
}

/** An answer awaited no longer than a deadline: a request that is never answered fails the case by the name of its phase. */
async function within<T>(phase: string, work: Promise<T>, ms = 45_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not answered within ${ms} ms: ${phase}`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

let accountIndex = 20;
/** An account of the rig's no earlier case has used: with coin, an allowance and the relay registered, unless it is to stay a stranger to the set. */
async function freshAccount(funded = true): Promise<HDAccount> {
  const who = rig.account(accountIndex++);
  if (funded) await rig.fund(who);
  return who;
}

let lineTicks = 3_000;
/** A market of the rig's game no earlier case has used: a spread at a line of its own. */
const freshMarket = (): { scorer: Address; lineTicks: number } => ({ scorer: rig.addresses.spread, lineTicks: -(lineTicks += 5) });

interface Posted {
  order: Order;
  hash: Hex;
  signature: Hex;
}

/** A quote posted and admitted: signed by `signer`, the account itself unless its agent signs. */
async function quote(who: HDAccount, fields: Partial<Order> & { expiry: bigint }, headers: Record<string, string>, signer: HDAccount = who, courier = url()): Promise<Posted> {
  const order = orderOn(rig, who, fields);
  const answer = await postOrderAs(courier, rig, signer, 'rest', order, headers);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return { order, hash: answer.body.orderHash as Hex, signature: answer.signature };
}

/** An order signed and not posted, with its hash as the contract computes it: the original a stop ahead carries. */
async function unposted(who: HDAccount, fields: Partial<Order> & { expiry: bigint }, signer: HDAccount = who): Promise<OriginalSent> {
  const order = orderOn(rig, who, fields);
  return { orderHash: (await contractHash(rig, order)).toLowerCase() as Hex, order, signature: await sign(signer, order, 31337, rig.addresses.matching) };
}

/** The original posted at the door as a quote, by its own signature. */
const postOriginal = (o: OriginalSent, headers: Record<string, string>, courier = url()): Promise<Answer> =>
  post(courier, '/v1/orders', { role: 'rest', order: wire(o.order), signature: o.signature }, headers);

/** The hashes one side of a market's page lists, in the order served. */
async function listed(market: { scorer: Address; lineTicks: number }, side: 'A' | 'B', headers: Record<string, string>, courier = url()): Promise<string[]> {
  const page = await get(courier, `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=${side}`, headers);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return ((page.body.sides as Record<string, { quotes: Array<{ orderHash: string }> }>)[side]?.quotes ?? []).map((q) => q.orderHash);
}

/** What the records hold in all: the stops, their messages, the orders and how many have ended, and the lines of orders and stops. */
async function written(): Promise<Record<string, number>> {
  const { rows } = await pool.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM stops)::int AS stops,
            (SELECT count(*) FROM stop_messages)::int AS messages,
            (SELECT count(*) FROM orders)::int AS orders,
            (SELECT count(*) FROM orders o WHERE o.ended IS NOT NULL)::int AS ended,
            (SELECT count(*) FROM events e WHERE e.kind IN ('order received', 'order refused', 'stop received', 'stop refused'))::int AS lines`,
  );
  return rows[0] ?? assert.fail('no counts');
}

interface BudgetRow {
  row_version: string;
  account: string;
  budget: string;
  budget_at: Date;
  refused: string;
  last_refused_at: Date | null;
}

/** Every budget row there is, each whole and with its row version: any write to a row changes the version, even one that sets what the row already held. */
async function budgetRows(): Promise<BudgetRow[]> {
  const { rows } = await pool.query<BudgetRow>('SELECT a.xmin::text AS row_version, a.account, a.budget, a.budget_at, a.refused, a.last_refused_at FROM accounts a ORDER BY a.account');
  return rows;
}

/** The budget an account's row holds, and the courier's. */
async function budgetsOf(account: Address): Promise<{ account: number; courier: number; refused: number }> {
  const rows = await budgetRows();
  const own = rows.find((r) => r.account === account.toLowerCase());
  const courier = rows.find((r) => r.account === 'courier');
  return { account: Number(own?.budget ?? Number.NaN), courier: Number(courier?.budget ?? Number.NaN), refused: Number(own?.refused ?? 0) };
}

/** What was taken from a budget between two readings of it, to the row's own six places. */
const taken = (before: number, after: number): number => Math.round((before - after) * 1e6) / 1e6;

/** Everything a request that must write nothing must leave as it was: the counts, and every budget row. */
async function everything(): Promise<{ written: Record<string, number>; budgets: BudgetRow[] }> {
  return { written: await written(), budgets: await budgetRows() };
}

interface StopLine {
  number: string;
  kind: string;
  account: string | null;
  order_hash: string | null;
  reason: string | null;
  facts: Record<string, unknown>;
}

/** The number of the newest line of any kind. */
async function lastLine(): Promise<number> {
  const { rows } = await pool.query<{ last: string }>('SELECT coalesce(max(e.number), 0) AS last FROM events e');
  return Number(rows[0]?.last ?? 0);
}

/** The stop's lines written after the line of that number, in order. */
async function stopLinesSince(number: number): Promise<StopLine[]> {
  const { rows } = await pool.query<StopLine>(
    `SELECT e.number, e.kind, e.account, e.order_hash, e.reason, e.facts FROM events e WHERE e.number > $1 AND e.kind IN ('stop received', 'stop refused') ORDER BY e.number`,
    [number],
  );
  return rows;
}

interface StopRow {
  hash: string;
  account: string;
  ahead: boolean;
  message_id: string;
  original: { order: Record<string, string | number>; signature: string } | null;
  original_expiry: string | null;
  grant_number: string | null;
}

/** The stops on record for these hashes, by hash. */
async function stopRows(hashes: string[]): Promise<Map<string, StopRow>> {
  const { rows } = await pool.query<StopRow>('SELECT s.hash, s.account, s.ahead, s.message_id, s.original, s.original_expiry, s.grant_number FROM stops s WHERE s.hash = ANY($1::text[])', [hashes]);
  return new Map(rows.map((r) => [r.hash, r]));
}

interface MessageRow {
  id: string;
  account: string;
  signer: string;
  message: Record<string, unknown>;
  signature: string;
  block_number: string | null;
  block_hash: string | null;
  block_time: string | null;
}

async function messageRow(id: string): Promise<MessageRow> {
  const { rows } = await pool.query<MessageRow>('SELECT m.id, m.account, m.signer, m.message, m.signature, m.block_number, m.block_hash, m.block_time FROM stop_messages m WHERE m.id = $1', [id]);
  return rows[0] ?? assert.fail(`no stop message ${id}`);
}

/** How the records hold these orders ended, by hash; a hash with no row is not in the map. */
async function endedOf(hashes: string[]): Promise<Map<string, string | null>> {
  const { rows } = await pool.query<{ hash: string; ended: string | null }>('SELECT o.hash, o.ended FROM orders o WHERE o.hash = ANY($1::text[])', [hashes]);
  return new Map(rows.map((r) => [r.hash, r.ended]));
}

/** The bets of an account waiting their turn, as the door counts them. */
async function betsWaiting(account: Address): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders o WHERE o.role = 'take' AND o.bet_state IN ('waiting', 'held') AND o.ended IS NULL AND o.account = $1`, [account.toLowerCase()]);
  return rows[0]?.n ?? 0;
}

/** The counts of requests refused before admission, by code: the courier's own, whoever asks. */
async function refusedSoFar(headers: Record<string, string>, courier = url()): Promise<Record<string, number>> {
  return ((await get(courier, '/v1/status', headers)).body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode;
}

/** The latest block, read whole from the chain: the block a request made now names. */
const head = () => rig.publicClient.getBlock();

/** The next block mined carries this time, and is mined: the chain's time is then exactly this. */
async function chainTimeIs(time: bigint): Promise<void> {
  await rig.setNextBlockTime(time);
  await rig.mine(1);
  assert.equal(await rig.time(), time);
}

/** Two quotes and a bet of a fresh account, on a market of their own, and the message that names the three. */
async function threeCarried(headers: Record<string, string>): Promise<{ who: HDAccount; market: { scorer: Address; lineTicks: number }; q1: Posted; q2: Posted; bet: Posted; message: StopMessage }> {
  const who = await freshAccount();
  const market = freshMarket();
  const T = await rig.time();
  const q1 = await quote(who, { expiry: T + 3_600n, oddsTick: 210, ...market }, headers);
  const q2 = await quote(who, { expiry: T + 3_600n, oddsTick: 220, ...market }, headers);
  // A bet: recorded, and waiting its turn, since nothing examines it in this build.
  const betOrder = orderOn(rig, who, { expiry: T + 25n, riskAmount: 10_000n, positionType: 1, ...market });
  const posted = await postOrder(url(), rig, who, 'take', betOrder, headers);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const bet = { order: betOrder, hash: posted.body.orderHash as Hex, signature: posted.signature };
  return { who, market, q1, q2, bet, message: stopMessage(who.address, [q1.hash, bet.hash, q2.hash]) };
}

// ──────────────────────────── 1 to 3: the stop of carried orders ────────────────────────────

test("1. the signed message in, the answer out, the rows: a maker's stop of two quotes and a waiting bet is answered stopped for each, in the message's order, with no chain read and no budget taken; three stops point at one message row that holds the signed payload and no block; the three orders are marked stopped; one line; the page lists neither quote, each record says stopped, the bet has left the queue and the door takes another; the status no longer lists the stop as not yet built", async () => {
  const from = at(1);
  const { who, market, q1, q2, bet, message } = await threeCarried(from);
  assert.deepEqual(await listed(market, 'A', from), [q1.hash, q2.hash], 'both quotes are listed before the stop');
  // The account's queue: the one bet waiting, a second taken, a third refused for the count.
  const T = await rig.time();
  const aBet = (): Order => orderOn(rig, who, { expiry: T + 25n, riskAmount: 10_000n, positionType: 1, ...market });
  const second = await postOrder(url(), rig, who, 'take', aBet(), from);
  assert.equal(second.status, 202, JSON.stringify(second.body));
  assert.equal((await postOrder(url(), rig, who, 'take', aBet(), from)).body.code, 'QUEUE_FULL', 'two bets of the account wait: a third is refused for the count');
  assert.equal(await betsWaiting(who.address), 2);

  const before_ = await written();
  const budgets = await budgetRows();
  const asked = stack.proxy.count();
  const last = await lastLine();
  const answer = await postStop(url(), rig, who, message, undefined, from);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    account: getAddress(who.address),
    results: [
      { orderHash: q1.hash, status: 'stopped' },
      { orderHash: bet.hash, status: 'stopped' },
      { orderHash: q2.hash, status: 'stopped' },
    ],
  });
  assert.equal(stack.proxy.count(), asked, 'a stop of carried orders signed by the account reads no chain');
  assert.deepEqual(await budgetRows(), budgets, 'and takes none of the budgets: every budget row is as it was');

  // The rows: three stops, none ahead, each pointing at the one message; the message holds what was signed and no block.
  const stops = await stopRows(message.orderHashes);
  assert.equal(stops.size, 3);
  const ids = new Set([...stops.values()].map((s) => s.message_id));
  assert.equal(ids.size, 1, 'one message row for the three');
  for (const hash of message.orderHashes) {
    assert.deepEqual({ ...stops.get(hash), message_id: 'the one' }, { hash, account: who.address.toLowerCase(), ahead: false, message_id: 'the one', original: null, original_expiry: null, grant_number: null });
  }
  const kept = await messageRow([...ids][0] as string);
  assert.deepEqual(kept.message, { account: getAddress(who.address), orderHashes: message.orderHashes }, 'the signed payload, the account and the hashes in their order');
  assert.deepEqual(Object.keys(kept.message).sort(), ['account', 'orderHashes']);
  assert.deepEqual(
    { account: kept.account, signer: kept.signer, signature: kept.signature, block: [kept.block_number, kept.block_hash, kept.block_time] },
    { account: who.address.toLowerCase(), signer: who.address.toLowerCase(), signature: answer.signature.toLowerCase(), block: [null, null, null] },
    'the signer is the account, and no block: no chain was read',
  );
  assert.deepEqual([...(await endedOf(message.orderHashes)).values()], ['stopped', 'stopped', 'stopped']);
  assert.deepEqual(await written(), { ...before_, stops: (before_.stops ?? 0) + 3, messages: (before_.messages ?? 0) + 1, ended: (before_.ended ?? 0) + 3, lines: (before_.lines ?? 0) + 1 });

  // One line, with the counts.
  const lines = await stopLinesSince(last);
  assert.deepEqual(
    lines.map((l) => ({ kind: l.kind, account: l.account, order_hash: l.order_hash, facts: l.facts })),
    [{ kind: 'stop received', account: who.address.toLowerCase(), order_hash: null, facts: { messageId: Number(kept.id), stopped: 3, ahead: 0 } }],
  );

  // From outside: the page lists neither quote; each record says stopped; the bet has left the queue.
  assert.deepEqual(await listed(market, 'A', from), []);
  for (const hash of message.orderHashes) {
    const record = await get(url(), `/v1/orders/${hash}`, from);
    assert.deepEqual({ status: record.status, state: record.body.state, ended: record.body.ended }, { status: 200, state: 'stopped', ended: 'stopped' }, hash);
  }
  assert.equal(await betsWaiting(who.address), 1, 'the stopped bet waits no more: the count fell by one');
  const third = await postOrder(url(), rig, who, 'take', aBet(), from);
  assert.equal(third.status, 202, `the door takes another bet of the account: ${JSON.stringify(third.body)}`);

  // The status: the stop is built, and the messages' table is among the tables whose growth is served.
  const status = await get(url(), '/v1/status', from);
  assert.equal(status.status, 200);
  assert.deepEqual((status.body.notYetBuilt as string[]).filter((line) => /^stops\b/.test(line)), [], 'the stop is no longer listed as not yet built');
  const tables = (status.body.database as { tables: Array<{ table: string }> }).tables.map((t) => t.table);
  assert.ok(tables.includes('stop_messages') && tables.includes('stops'), tables.join(', '));

  // The two bets still waiting are stopped too, so no later case meets this one's queue.
  const rest = await postStop(url(), rig, who, stopMessage(who.address, [second.body.orderHash as Hex, third.body.orderHash as Hex]), undefined, from);
  assert.deepEqual(outcomes(rest), ['stopped', 'stopped']);
});

test("1a. a page is one block's and one scan's answer: a page whose scan ran before a stop was recorded, its read of the chain held meanwhile, lists the quote when it is answered; the next page does not", async () => {
  const from = at(18);
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const q = await quote(who, { expiry: far, oddsTick: 215, ...market }, from);
  const held = stack.proxy.hold('eth_call');
  let released = false;
  let reading: Promise<Awaited<ReturnType<typeof get>>> | null = null;
  try {
    // A market's page reads its two blocks, scans the records, and then asks the chain about the quotes the scan
    // returned: held there, its scan is behind it and its answer is not yet made.
    reading = get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=A`, from);
    await within("the page's read of the chain for the quotes it scanned, arriving at the proxy", held.arrived, 15_000);
    // The stop, recorded while the page waits: signed by the account, of a carried quote, it asks the chain nothing.
    assert.deepEqual(outcomes(await postStop(url(), rig, who, stopMessage(who.address, [q.hash]), undefined, from)), ['stopped']);
    assert.deepEqual([...(await endedOf([q.hash])).values()], ['stopped']);
    held.release();
    released = true;
    const page = await within('the page, its read let go', reading);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const quotes = ((page.body.sides as Record<string, { quotes: Array<{ orderHash: string }> }>).A?.quotes ?? []).map((x) => x.orderHash);
    assert.deepEqual(quotes, [q.hash], 'the page whose scan ran before the stop lists the quote: it is the answer of that scan, at the block it names');
    assert.deepEqual(await listed(market, 'A', from), [], 'the next page does not list it');
  } finally {
    if (!released) held.release();
    await reading?.catch(() => undefined);
  }
});

test("2. the door's answer afterwards: a stopped order posted again under its role is answered with its record, ended stopped, and under the other role is a conflict; neither reads the chain and neither writes anything", async () => {
  const from = at(2);
  const { who, q1, bet, message } = await threeCarried(from);
  assert.deepEqual(outcomes(await postStop(url(), rig, who, message, undefined, from)), ['stopped', 'stopped', 'stopped']);
  const before_ = await everything();
  const asked = stack.proxy.count();
  const again = await postOrder(url(), rig, who, 'rest', q1.order, from);
  assert.deepEqual({ status: again.status, hash: again.body.orderHash, state: again.body.state, ended: again.body.ended }, { status: 200, hash: q1.hash, state: 'stopped', ended: 'stopped' }, JSON.stringify(again.body));
  const betAgain = await postOrder(url(), rig, who, 'take', bet.order, from);
  assert.deepEqual({ status: betAgain.status, hash: betAgain.body.orderHash, ended: betAgain.body.ended }, { status: 200, hash: bet.hash, ended: 'stopped' }, JSON.stringify(betAgain.body));
  const asBet = await postOrder(url(), rig, who, 'take', q1.order, from);
  assert.deepEqual({ status: asBet.status, code: asBet.body.code }, { status: 409, code: 'ROLE_CONFLICT' });
  const asQuote = await postOrder(url(), rig, who, 'rest', bet.order, from);
  assert.deepEqual({ status: asQuote.status, code: asQuote.body.code }, { status: 409, code: 'ROLE_CONFLICT' });
  assert.equal(stack.proxy.count(), asked, 'each is answered from the record, before the chain is read');
  assert.deepEqual(await everything(), before_, 'no row, no mark, no line, and no budget row touched');
});

test('3. already stopped, and nothing written: the same message again is answered already stopped for each hash, with no chain read; the rows, the lines, the messages and every budget row are as they were', async () => {
  const from = at(3);
  const { who, message } = await threeCarried(from);
  const first = await postStop(url(), rig, who, message, undefined, from);
  assert.deepEqual(outcomes(first), ['stopped', 'stopped', 'stopped']);
  const before_ = await everything();
  const last = await lastLine();
  const asked = stack.proxy.count();
  const again = await postStop(url(), rig, who, message, undefined, from);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.signature, first.signature, 'the same message, byte for byte');
  assert.deepEqual(again.body, { account: getAddress(who.address), results: message.orderHashes.map((orderHash) => ({ orderHash, status: 'already stopped' })) });
  assert.equal(stack.proxy.count(), asked, 'no chain read');
  assert.deepEqual(await everything(), before_, 'nothing written: the counts and every budget row are as they were');
  assert.deepEqual(await stopLinesSince(last), [], 'and no line');
  // The hashes in another order, and one of them alone: each a new message, each answered from the rows all the same.
  const reordered = await postStop(url(), rig, who, stopMessage(who.address, [...message.orderHashes].reverse()), undefined, from);
  assert.deepEqual(outcomes(reordered), ['already stopped', 'already stopped', 'already stopped']);
  assert.deepEqual(await everything(), before_);
});

// ──────────────────────────── 4: the stop ahead ────────────────────────────

/** A hash no order has: named by a stop, it is unknown to the courier. */
const noOrders = (seed: number): Hex => `0x${seed.toString(16).padStart(4, '0').repeat(16)}`;

/** An order's original signed until its signature ends in 27, so that its refused form, the parity written out, ends in 0. */
async function originalEndingIn27(who: HDAccount, fields: Partial<Order> & { expiry: bigint }): Promise<OriginalSent> {
  for (let tries = 0; tries < 64; tries++) {
    const o = await unposted(who, fields);
    if (o.signature.endsWith('1b')) return o;
  }
  return assert.fail('no signature ending in 27 in 64 orders');
}

test("4. the stop ahead: an order signed and not posted is stopped by its hash with its signed original beside it, in a block the message is recorded with; its post is then STOPPED, its record says stopped ahead and nothing of the order, the page never lists it, the original is kept in the stop's row and nowhere else, and the same order without the stop is admitted and listed; each fault of an original is its own hash's refusal, by its code, while the message's other hashes are decided; an original that names no hash of the message, or the hash another names, refuses the message whole", async () => {
  const from = at(4);
  const who = await freshAccount();
  const other = await freshAccount();
  const market = freshMarket();
  const T = await rig.time();
  const fields = { expiry: T + 3_600n, oddsTick: 230, ...market };

  // The stop ahead, and everything that follows from it.
  const o = await unposted(who, fields);
  const last = await lastLine();
  const before_ = await written();
  assert.ok(Number.isNaN((await budgetsOf(who.address)).account), 'the account has been admitted nothing yet: it holds no budget row');
  const answer = await postStop(url(), rig, who, stopMessage(who.address, [o.orderHash]), [o], from);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { account: getAddress(who.address), results: [{ orderHash: o.orderHash, status: 'stopped ahead' }] });
  const block = await head();
  const row = (await stopRows([o.orderHash])).get(o.orderHash) ?? assert.fail('no stop row');
  assert.deepEqual(
    { account: row.account, ahead: row.ahead, grant_number: row.grant_number, original_expiry: row.original_expiry, original: row.original },
    { account: who.address.toLowerCase(), ahead: true, grant_number: '0', original_expiry: o.order.expiry.toString(), original: { order: wire(o.order), signature: o.signature.toLowerCase() } },
  );
  const kept = await messageRow(row.message_id);
  assert.deepEqual(Object.keys(kept.message).sort(), ['account', 'orderHashes'], 'the message row holds the two signed fields and nothing else: no original');
  assert.deepEqual(kept.message, { account: getAddress(who.address), orderHashes: [o.orderHash] });
  assert.ok(!JSON.stringify(kept).includes(o.signature.toLowerCase().slice(2)), "the original's signature is nowhere in the message row");
  assert.deepEqual({ number: kept.block_number, hash: kept.block_hash, time: kept.block_time }, { number: block.number.toString(), hash: block.hash.toLowerCase(), time: block.timestamp.toString() }, 'recorded with the block the chain was read at');
  assert.equal((await endedOf([o.orderHash])).size, 0, 'the hash holds no order: the original never entered the orders');
  assert.deepEqual(await written(), { ...before_, stops: (before_.stops ?? 0) + 1, messages: (before_.messages ?? 0) + 1 , lines: (before_.lines ?? 0) + 1 });
  assert.deepEqual((await stopLinesSince(last)).map((l) => ({ kind: l.kind, facts: l.facts })), [{ kind: 'stop received', facts: { messageId: Number(kept.id), stopped: 0, ahead: 1 } }]);
  assert.equal((await budgetsOf(who.address)).account, 240 - 1, "a stop ahead is under the budgets: its account's row is made, one taken from its 240");
  // The same body again, its original beside it still: every hash of it is stopped, and that is answered from the
  // rows before anything else is asked: no chain read, no budget taken, nothing written.
  const stood = await everything();
  const askedBefore = stack.proxy.count();
  const again = await sendStop(url(), stopBody(stopMessage(who.address, [o.orderHash]), answer.signature, [o]), from);
  assert.deepEqual({ status: again.status, results: outcomes(again) }, { status: 200, results: ['already stopped'] }, JSON.stringify(again.body));
  assert.equal(stack.proxy.count(), askedBefore, 'a stop ahead sent again reads no chain');
  assert.deepEqual(await everything(), stood, 'and it takes no budget and writes nothing');

  // The order's record: the stop, and when; no field of the order.
  const record = await get(url(), `/v1/orders/${o.orderHash}`, from);
  assert.equal(record.status, 200);
  assert.deepEqual(Object.keys(record.body).sort(), ['orderHash', 'state', 'stoppedAt']);
  assert.deepEqual({ orderHash: record.body.orderHash, state: record.body.state }, { orderHash: o.orderHash, state: 'stopped ahead' });
  assert.ok(!Number.isNaN(Date.parse(String(record.body.stoppedAt))));
  // Another account that names the hash is told it is not its order: a stop reaches only the orders of the account it names.
  assert.deepEqual(outcomes(await postStop(url(), rig, other, stopMessage(other.address, [o.orderHash]), undefined, from)), ['NOT_YOUR_ORDER'], "another account naming a hash stopped ahead of its order");
  // Its post, when it comes: refused at the door for the stop on record, as a line; never a row, never listed.
  const posted = await postOriginal(o, from);
  assert.deepEqual({ status: posted.status, code: posted.body.code }, { status: 422, code: 'STOPPED' }, JSON.stringify(posted.body));
  assert.equal((await endedOf([o.orderHash])).size, 0);
  assert.deepEqual(await listed(market, 'A', from), []);
  // The paired control: the same order under another nonce, with no stop, is admitted and listed. The stop is what kept the first out.
  const twin = await quote(who, fields, from);
  assert.deepEqual(await listed(market, 'A', from), [twin.hash]);

  // Each fault of an original, in a message with a sound one beside it: the faulty hash refused by its code, the sound one decided.
  const refusedBeside = async (faulty: OriginalSent, code: string, what: string) => {
    const sound = await unposted(who, fields);
    const mixed = await postStop(url(), rig, who, stopMessage(who.address, [faulty.orderHash, sound.orderHash]), [faulty, sound], from);
    assert.equal(mixed.status, 200, `${what}: ${JSON.stringify(mixed.body)}`);
    assert.deepEqual(outcomes(mixed), [code, 'stopped ahead'], `${what}: ${JSON.stringify(mixed.body)}`);
    assert.equal((await stopRows([faulty.orderHash])).size, 0, `${what}: no stop for the refused hash`);
    return mixed;
  };
  // Fields that do not hash to the named hash.
  const real = await unposted(who, fields);
  await refusedBeside({ ...real, orderHash: noOrders(0x4a01) }, 'ORIGINAL_NOT_THE_HASH', 'an original whose fields hash to another hash');
  // Another account's order, by its own true hash and signature.
  await refusedBeside(await unposted(other, fields), 'NOT_YOUR_ORDER', "another account's original");
  // The contract's own rules on the order.
  await refusedBeside(await unposted(who, { ...fields, oddsTick: 100 }), 'PRICE_OUT_OF_RANGE', 'an original at a price the contract refuses');
  // A signature of the account's in a form the chain refuses, its last byte 0.
  const strict = await originalEndingIn27(who, fields);
  const lenient = { ...strict, signature: refusedForm(strict.signature, 'v as parity') };
  assert.ok(lenient.signature.endsWith('00'));
  const refusedForItsForm = await refusedBeside(lenient, 'BAD_SIGNATURE', 'an original signed with v of 0');
  assert.match(String(resultsOf(refusedForItsForm)[0]?.error), /27 or 28/);
  // The same original in the form the chain takes is stopped ahead: the form was its only fault.
  assert.deepEqual(outcomes(await postStop(url(), rig, who, stopMessage(who.address, [strict.orderHash]), [strict], from)), ['stopped ahead']);
  // A stranger's signature over the account's order.
  const forged = await unposted(who, fields, other);
  await refusedBeside(forged, 'BAD_SIGNATURE', 'an original another key signed');
  // The expiry, at the chain's time plus one and plus two: the first can fill in no later block; the second can.
  const now = await rig.time();
  await refusedBeside(await unposted(who, { ...fields, expiry: now + 1n }), 'EXPIRED', "an original expiring at the chain's time plus one");
  const justLive = await unposted(who, { ...fields, expiry: now + 2n });
  assert.deepEqual(outcomes(await postStop(url(), rig, who, stopMessage(who.address, [justLive.orderHash]), [justLive], from)), ['stopped ahead'], 'an original expiring a second later is stopped ahead');
  assert.equal(await rig.time(), now, 'no block was mined between the two: both were judged at one time');

  // Whole-message refusals of the shape: an original naming a hash the message does not, and two originals naming one hash.
  const a = await unposted(who, fields);
  const b = await unposted(who, fields);
  const everythingBefore = await everything();
  const signature = await signStop(who, stopMessage(who.address, [a.orderHash]), 31337, rig.addresses.relay);
  const astray = await sendStop(url(), stopBody(stopMessage(who.address, [a.orderHash]), signature, [a, b]), from);
  assert.deepEqual({ status: astray.status, code: astray.body.code }, { status: 400, code: 'INVALID_PARAM' }, JSON.stringify(astray.body));
  const twice = await sendStop(url(), stopBody(stopMessage(who.address, [a.orderHash]), signature, [a, { ...b, orderHash: a.orderHash }]), from);
  assert.deepEqual({ status: twice.status, code: twice.body.code }, { status: 400, code: 'INVALID_PARAM' }, JSON.stringify(twice.body));
  assert.deepEqual(await everything(), everythingBefore, 'neither wrote anything or took a budget');
});

test("4a. the stop ahead under a grant: the account's stop of its agent's unposted orders judges each as the door would judge its post, by the door's codes: over the grant's cap, off the grant's list, or under a grant that ends at the chain's time plus one, refused; under a grant that ends a second later, stopped ahead until the grant's end", async () => {
  const from = at(41);
  const owner = await freshAccount();
  const agent = await freshAccount(false);
  const market = freshMarket();
  const offList = freshMarket();
  const granted = await rig.time();
  const ends = granted + 500n;
  const cap = 1_000_000n;
  const g = await grantAgent(rig, owner, agent.address, cap, ends, [{ gameId: rig.gameId, ...market }]);
  const T = await rig.time();
  const under = (fields: Partial<Order>): Promise<OriginalSent> => unposted(owner, { expiry: T + 100_000n, oddsTick: 240, riskAmount: cap, ...market, nonce: nonceOf(0n, g, nextOrderNumber()), ...fields }, agent);
  const stopOf = async (o: OriginalSent) => outcomes(await postStop(url(), rig, owner, stopMessage(owner.address, [o.orderHash]), [o], from));

  assert.deepEqual(await stopOf(await under({ riskAmount: cap + 100n })), ['AGENT_STAKE_ABOVE_CAP'], 'one lot over the cap');
  assert.deepEqual(await stopOf(await under(offList)), ['LINE_NOT_IN_GRANT'], "a line the grant's list does not name");
  // Signed by the account's own key under the grant's number: not the grant's agent.
  const byAccount = await unposted(owner, { expiry: T + 100_000n, oddsTick: 240, riskAmount: cap, ...market, nonce: nonceOf(0n, g, nextOrderNumber()) }, owner);
  assert.deepEqual(await stopOf(byAccount), ['BAD_SIGNATURE'], "the account's own signature under a grant's number");
  // A grant number the account never made: no agent whose signature it could carry.
  const neverMade = await unposted(owner, { expiry: T + 100_000n, oddsTick: 240, riskAmount: cap, ...market, nonce: nonceOf(0n, g + 7, nextOrderNumber()) }, agent);
  assert.deepEqual(await stopOf(neverMade), ['BAD_SIGNATURE'], 'a grant number the account never made');
  // Two faults at once are answered by the first in the door's order: the cap before the list.
  assert.deepEqual(await stopOf(await under({ riskAmount: cap + 100n, ...offList })), ['AGENT_STAKE_ABOVE_CAP'], 'over the cap and off the list');
  // Two originals under the grant in one message, one on its list and one off it, each way round: each is answered for its own line.
  for (const offFirst of [true, false]) {
    const on = await under({});
    const off = await under(offList);
    assert.deepEqual(
      await stopAhead(owner, owner, offFirst ? [off, on] : [on, off], from),
      offFirst ? ['LINE_NOT_IN_GRANT', 'stopped ahead'] : ['stopped ahead', 'LINE_NOT_IN_GRANT'],
      `two originals under one grant, the one off its list ${offFirst ? 'first' : 'second'}`,
    );
  }

  // The grant's end. Two seconds before it: the order can fill in the next block, and is stopped ahead, until the grant's end and not its own far expiry.
  await chainTimeIs(ends - 2n);
  const stillLive = await under({});
  assert.deepEqual(await stopOf(stillLive), ['stopped ahead'], 'under a grant that ends at the time plus two');
  const row = (await stopRows([stillLive.orderHash])).get(stillLive.orderHash) ?? assert.fail('no stop row');
  assert.deepEqual({ grant_number: row.grant_number, original_expiry: row.original_expiry }, { grant_number: String(g), original_expiry: ends.toString() }, "the grant's number, and the grant's end as the second it can fill no more from");
  // One second before it: it can fill in no later block. Nothing to stop.
  await chainTimeIs(ends - 1n);
  assert.deepEqual(await stopOf(await under({})), ['GRANT_GONE'], 'under a grant that ends at the time plus one');
  // And there, two faults at once, each answered by the first in the door's order: the list before the grant's
  // standing, and the grant's standing before the order's own expiry.
  assert.deepEqual(await stopOf(await under(offList)), ['LINE_NOT_IN_GRANT'], 'off the list, under a grant that is gone');
  assert.deepEqual(await stopOf(await under({ expiry: ends })), ['GRANT_GONE'], 'under a grant that is gone, and itself expiring at the time plus one');
});

/** `n` unposted orders of `who`, each its own hash, all with one expiry. */
async function originals(who: HDAccount, n: number, fields: Partial<Order> & { expiry: bigint }, signer: HDAccount = who, nonce?: () => bigint): Promise<OriginalSent[]> {
  const out: OriginalSent[] = [];
  for (let i = 0; i < n; i++) out.push(await unposted(who, nonce === undefined ? fields : { ...fields, nonce: nonce() }, signer));
  return out;
}

/** A stop ahead of these originals, signed by `signer`: each result by its status or code. */
async function stopAhead(account: HDAccount, signer: HDAccount, sent: OriginalSent[], headers: Record<string, string>, courier = url()): Promise<string[]> {
  const answer = await postStop(courier, rig, signer, stopMessage(account.address, sent.map((o) => o.orderHash)), sent, headers);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return outcomes(answer);
}

const times = <T,>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

test("4b. the bound on stops ahead counts the ones whose orders have not expired: thirty-two are taken, the thirty-third is TOO_MANY_STOPS_AHEAD, within one message as across messages; a second before sixteen of them expire by the chain's clock the bound still holds, and at that second sixteen more are taken", async () => {
  const from = at(42);
  const who = await freshAccount();
  const market = freshMarket();
  const T = await rig.time();
  const soon = { expiry: T + 400n, oddsTick: 250, ...market };
  const far = { expiry: T + 100_000n, oddsTick: 250, ...market };
  assert.deepEqual(await stopAhead(who, who, await originals(who, 16, soon), from), times(16, 'stopped ahead'));
  assert.deepEqual(await stopAhead(who, who, await originals(who, 15, far), from), times(15, 'stopped ahead'));
  // Thirty-one stand. A message of three: the first takes the last slot, and the other two are over the bound.
  assert.deepEqual(await stopAhead(who, who, await originals(who, 3, far), from), ['stopped ahead', 'TOO_MANY_STOPS_AHEAD', 'TOO_MANY_STOPS_AHEAD']);
  assert.deepEqual(await stopAhead(who, who, await originals(who, 1, far), from), ['TOO_MANY_STOPS_AHEAD'], 'the thirty-third');
  // The sixteen that expire at T + 400 count while their expiry is above the chain's time plus one: at T + 398 they do.
  await chainTimeIs(T + 398n);
  assert.deepEqual(await stopAhead(who, who, await originals(who, 1, far), from), ['TOO_MANY_STOPS_AHEAD'], 'a second before they expire, the bound holds');
  // At T + 399 their expiry is the time plus one: they can fill in no later block, and count no more.
  await chainTimeIs(T + 399n);
  assert.deepEqual(await stopAhead(who, who, await originals(who, 16, far), from), times(16, 'stopped ahead'), 'sixteen more are taken');
  assert.deepEqual(await stopAhead(who, who, await originals(who, 1, far), from), ['TOO_MANY_STOPS_AHEAD'], 'and the bound holds again');
  // The expired stops stand all the same: a stop is permanent, and its hash is refused at the door for good.
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stops s WHERE s.account = $1 AND s.ahead', [who.address.toLowerCase()]);
  assert.equal(rows[0]?.n, 48);
});

test("4c. an agent's stops ahead fill the account's thirty-two slots beside the account's own, while its grant stands: with one stop ahead of the account's own standing, the agent's thirty-second is refused for the bound, and so is the account's own next; a stop ahead the agent sends again is already stopped and takes no budget; the account's revoke frees the agent's slots at the block read, and the account's own stop ahead is taken; the agent's thirty-one stand: each record still says stopped ahead, each row holds its order's own expiry, and a post of one is refused before and after the revoke", async () => {
  const from = at(43);
  const owner = await freshAccount();
  const agent = await freshAccount(false);
  const market = freshMarket();
  const T = await rig.time();
  const g = await grantAgent(rig, owner, agent.address, 5_000_000n, T + 100_000n);
  const far = { expiry: T + 90_000n, oddsTick: 260, ...market };
  const own = await originals(owner, 3, far);
  // One stop ahead of the account's own, of an order it signed itself: it counts whatever grant stands.
  assert.deepEqual(await stopAhead(owner, owner, [own[0] as OriginalSent], from), ['stopped ahead']);
  const byAgent = await originals(owner, 32, far, agent, () => nonceOf(0n, g, nextOrderNumber()));
  // The agent's own stops ahead of the orders it signed under its grant: sixteen a message.
  assert.deepEqual(await stopAhead(owner, agent, byAgent.slice(0, 16), from), times(16, 'stopped ahead'));
  // The same sixteen sent again, their originals beside them: every hash of the message is stopped, and that takes no budget.
  const budgets = await budgetRows();
  assert.deepEqual(await stopAhead(owner, agent, byAgent.slice(0, 16), from), times(16, 'already stopped'));
  assert.deepEqual(await budgetRows(), budgets, "an agent's stop ahead sent again takes no budget");
  assert.deepEqual(
    await stopAhead(owner, agent, byAgent.slice(16), from),
    [...times(15, 'stopped ahead'), 'TOO_MANY_STOPS_AHEAD'],
    "the account's own one and the agent's thirty-one fill the slots: the agent's thirty-second is over the bound",
  );
  assert.deepEqual(await stopAhead(owner, owner, [own[1] as OriginalSent], from), ['TOO_MANY_STOPS_AHEAD'], "and so is the account's own next, while the grant stands");
  // While the grant stands, the post of one of the thirty-one is refused for its stop.
  const stoodAhead = byAgent.slice(0, 31);
  const sample = byAgent[5] as OriginalSent;
  const stoppedAtTheDoor = await postOriginal(sample, from);
  assert.deepEqual({ status: stoppedAtTheDoor.status, code: stoppedAtTheDoor.body.code }, { status: 422, code: 'STOPPED' }, JSON.stringify(stoppedAtTheDoor.body));

  await revokeAgent(rig, owner);
  assert.deepEqual(await stopAhead(owner, owner, [own[2] as OriginalSent], from), ['stopped ahead'], "the revoke freed the agent's slots: the account's own stop ahead is taken, beside its first");
  // The thirty-one stand. Their records say so; a post of one is refused still, now for its grant, which the door
  // judges before it looks for a stop: the order can fill nowhere, and its stop is on record all the same.
  const stand = await stopRows(stoodAhead.map((o) => o.orderHash));
  assert.equal(stand.size, 31);
  assert.ok(
    [...stand.values()].every((s) => s.ahead && s.grant_number === String(g) && s.original_expiry === far.expiry.toString()),
    "each holds its grant's number, and its order's own expiry, which comes before the grant's end",
  );
  assert.equal((await stopRows([(byAgent[31] as OriginalSent).orderHash])).size, 0, 'the thirty-second, refused for the bound, holds no stop');
  for (const o of [byAgent[0], sample, byAgent[30]] as OriginalSent[]) {
    assert.equal((await get(url(), `/v1/orders/${o.orderHash}`, from)).body.state, 'stopped ahead');
  }
  const afterRevoke = await postOriginal(sample, from);
  assert.deepEqual({ status: afterRevoke.status, code: afterRevoke.body.code }, { status: 422, code: 'GRANT_GONE' }, JSON.stringify(afterRevoke.body));
  assert.equal((await endedOf(byAgent.map((o) => o.orderHash))).size, 0, 'none of the thirty-two ever entered the orders');
});

test('4d. two messages of one account for its last slot, one sent to each of two courier processes and both let go together: one is stopped ahead and the other is TOO_MANY_STOPS_AHEAD, and the account holds thirty-two', async () => {
  const from = at(44);
  const who = await freshAccount();
  const market = freshMarket();
  const T = await rig.time();
  const far = { expiry: T + 100_000n, oddsTick: 270, ...market };
  assert.deepEqual(await stopAhead(who, who, await originals(who, 16, far), from), times(16, 'stopped ahead'));
  assert.deepEqual(await stopAhead(who, who, await originals(who, 15, far), from), times(15, 'stopped ahead'));
  const [one, two] = (await originals(who, 2, far)) as [OriginalSent, OriginalSent];
  const second = await anotherCourier();
  const held = stack.proxy.hold('eth_call');
  let released = false;
  const pending: Array<Promise<unknown>> = [];
  try {
    const before_ = stack.proxy.counted.filter((c) => c.method === 'eth_call').length;
    const first = stopAhead(who, who, [one], from);
    const other = stopAhead(who, who, [two], from, second.url);
    pending.push(first.catch(() => undefined), other.catch(() => undefined));
    // Both messages' reads of the chain have arrived at the proxy and are held there: neither has reached its transaction.
    await until("both messages' chain reads held at the proxy", async () => stack.proxy.counted.filter((c) => c.method === 'eth_call').length - before_ >= 2);
    held.release();
    released = true;
    const results = [await within('the first message for the last slot', first), await within('the second message for the last slot', other)].flat().sort();
    assert.deepEqual(results, ['TOO_MANY_STOPS_AHEAD', 'stopped ahead'], 'one takes the slot and one is refused, whichever commits first');
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stops s WHERE s.account = $1 AND s.ahead', [who.address.toLowerCase()]);
    assert.equal(rows[0]?.n, 32);
  } finally {
    if (!released) held.release();
    await Promise.all(pending);
    await second.stop();
  }
});

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}

const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

test("4e. the count of an account's stops ahead that still count is one range of its own index, read from the statement's own plan: the account's thirty-two unexpired stops ahead are what the index returns, at two sizes of history, and the account's own stops ahead that expired, which grow with the history, its carried stops and other accounts' stops are not among them and are not read and set aside; the buffers the count reads are the same at both sizes", async () => {
  const T = 2_000_000_000n;
  const account = `0x${'c3'.repeat(20)}`;
  const figures: Array<{ history: number; rows: number; removed: number; buffers: number; index: string | undefined }> = [];
  for (const history of [4_000, 40_000]) {
    const made = await stack.db.createWithSchema('stops_plan');
    const plan = openPool(made.url, null);
    try {
      const message = await plan.query<{ id: string }>(`INSERT INTO stop_messages (account, signer, message, signature) VALUES ($1, $1, '{}'::jsonb, $2) RETURNING id`, [account, `0x${'ab'.repeat(65)}`]);
      const id = message.rows[0]?.id;
      const original = JSON.stringify({ order: { account, gameId: '1', lineTicks: 0, oddsTick: 200, riskAmount: '1000000', nonce: '1', expiry: '1', minFill: '0' }, signature: `0x${'ab'.repeat(65)}` });
      /** `n` stops from hash number `from`: of the account, or spread over five hundred other accounts; ahead with the expiry given, or carried. */
      const lay = (from: number, n: number, whose: 'the account' | 'others', ahead: boolean, expiry: string) =>
        plan.query(
          `INSERT INTO stops (hash, account, ahead, message_id, original, original_expiry, grant_number)
           SELECT '0x' || lpad(to_hex(i), 64, '0'), ${whose === 'the account' ? '$6::text' : "'0x' || lpad(to_hex(i % 500), 40, '0')"}, $1::boolean, $2::bigint,
                  CASE WHEN $1::boolean THEN $3::jsonb END, CASE WHEN $1::boolean THEN (${expiry})::numeric END, CASE WHEN $1::boolean THEN 0 END
           FROM generate_series($4::int, $5::int) AS i WHERE $6::text IS NOT NULL`,
          [ahead, id, original, from, from + n - 1, account],
        );
      // The history, which grows: other accounts' stops ahead, half expired and half not, and their carried stops.
      await lay(1, history / 2, 'others', true, `${T} - 1 - i`);
      await lay(1_000_001, history / 2, 'others', true, `${T} + 100000 + i`);
      await lay(2_000_001, history, 'others', false, '0');
      // The account's own: stops ahead that have expired, which grow with the history, an eighth of its size; carried
      // stops; and last the thirty-two that count.
      await lay(3_000_001, history / 8, 'the account', true, `${T} - 1 - i`);
      await lay(4_000_001, 100, 'the account', false, '0');
      await lay(5_000_001, 32, 'the account', true, `${T} + 5000 + i`);
      await plan.query('VACUUM ANALYZE stops');
      const explained = await plan.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${AHEAD_COUNT_SQL}`, [account, (T + 1n).toString(), 0]);
      const root = (explained.rows[0]?.['QUERY PLAN'][0] as { Plan: PlanNode }).Plan;
      const scan = nodesOf(root).find((n) => n['Index Name'] !== undefined) ?? assert.fail(`no index scan in the plan: ${JSON.stringify(root)}`);
      const counted = await plan.query<{ standing: string }>(AHEAD_COUNT_SQL, [account, (T + 1n).toString(), 0]);
      assert.equal(Number(counted.rows[0]?.standing), 32, `the count at a history of ${history}`);
      const removed = nodesOf(root).reduce((n, node) => n + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0), 0);
      figures.push({ history, rows: scan['Actual Rows'] ?? -1, removed, buffers: (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0), index: scan['Index Name'] });
    } finally {
      await plan.end();
    }
  }
  console.log(`# the count of stops ahead, from its own plan: ${JSON.stringify(figures)}`);
  for (const f of figures) {
    assert.equal(f.index, 'stops_ahead_by_account', `history ${f.history}: the statement runs along the index made for it`);
    assert.equal(f.rows, 32, `history ${f.history}: the index returned the account's unexpired stops ahead and no other row`);
    assert.equal(f.removed, 0, `history ${f.history}: no row was read and then set aside: the account's expired stops ahead lie outside the range the index walks`);
  }
  const [small, large] = figures as [(typeof figures)[number], (typeof figures)[number]];
  assert.ok(Math.abs(large.buffers - small.buffers) <= 3, `the buffers the count reads do not grow with the history: ${small.buffers} at ${small.history}, ${large.buffers} at ${large.history}`);
});

// ──────────────────────────── 4f: the original's isolation, read from the courier's own SQL ────────────────────────────
//
// A stop ahead keeps its order's signed original, which nothing may list, serve or fill. This reads every SQL
// statement written under courier/ and fails where one outside the stops' own records module reads a stop's
// original. What is read, and the bound of the reading: every string literal of a .ts file under courier/ whose text
// begins with a statement keyword, a `${NAME}` inside it replaced by the string constant NAME of the same file. A
// statement is taken to read an original where it names the stops table and either names the column `original`,
// qualified by the table, by an alias or by nothing, or takes every column (`SELECT *`, `alias.*`, `RETURNING *`).
// Not read: a statement put together at run time from pieces, a read through a view or a function, and what the
// code does with a row once it holds it. So this is a reading of the statements as written, not a proof of where a
// value flows; the route's and the page's own cases above are the other half.

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SQL_STATEMENT = /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|EXPLAIN)\b/i;

interface Literal {
  text: string;
  start: number;
}

/** The index after the closing quote of a '…' or "…" literal opened at `i`, or -1 where a newline comes first. */
function quotedEnd(source: string, i: number, quote: string): number {
  for (let j = i + 1; j < source.length; j++) {
    const ch = source.charAt(j);
    if (ch === '\\') { j++; continue; }
    if (ch === '\n') return -1;
    if (ch === quote) return j + 1;
  }
  return -1;
}

/** The index after the closing backtick of a template opened at `i`; its `${…}` are stepped over whole. */
function templateEnd(source: string, i: number): number {
  for (let j = i + 1; j < source.length; j++) {
    const ch = source.charAt(j);
    if (ch === '\\') { j++; continue; }
    if (ch === '`') return j + 1;
    if (ch === '$' && source.charAt(j + 1) === '{') { j = expressionEnd(source, j + 2) - 1; continue; }
  }
  return source.length;
}

/** The index after the `}` that closes a template's `${` whose body starts at `j`. */
function expressionEnd(source: string, j: number): number {
  let depth = 1;
  while (j < source.length) {
    const ch = source.charAt(j);
    const next = source.charAt(j + 1);
    if (ch === '{') { depth++; j++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return j + 1; j++; continue; }
    if (ch === '\'' || ch === '"') { const end = quotedEnd(source, j, ch); j = end < 0 ? j + 1 : end; continue; }
    if (ch === '`') { j = templateEnd(source, j); continue; }
    if (ch === '/' && next === '/') { while (j < source.length && source.charAt(j) !== '\n') j++; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', j + 2); j = end < 0 ? source.length : end + 2; continue; }
    j++;
  }
  return source.length;
}

/** Every string literal of a TypeScript source; comments are skipped. */
function literalsOf(source: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (ch === '/' && next === '/') { while (i < source.length && source.charAt(i) !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (ch === '\'' || ch === '"') {
      const end = quotedEnd(source, i, ch);
      if (end < 0) { i++; continue; }
      out.push({ text: source.slice(i + 1, end - 1), start: i });
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = templateEnd(source, i);
      out.push({ text: source.slice(i + 1, end - 1), start: i });
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/** The SQL statements written in a source: its literals that begin with a statement keyword, the file's string constants resolved into them. */
function statementsIn(source: string): string[] {
  const lits = literalsOf(source);
  const byStart = new Map(lits.map((l) => [l.start, l.text]));
  const consts = new Map<string, string>();
  for (const m of source.matchAll(/(?:^|[\n;{])[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?=['"`])/g)) {
    const text = byStart.get(m.index + m[0].length);
    if (text !== undefined) consts.set(m[1] ?? '', text);
  }
  const resolve = (text: string, depth = 0): string =>
    depth > 4 ? text : text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_, name: string) => (consts.has(name) ? resolve(consts.get(name) ?? '', depth + 1) : '$__')).replace(/\$\{[^}]*\}/g, '$__');
  return lits.map((l) => resolve(l.text)).filter((text) => SQL_STATEMENT.test(text));
}

/** How a statement reads a stop's original, or null where it does not: see the bound of the reading above. */
function readsAnOriginal(sql: string): string | null {
  const text = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (!/\bstops\b/i.test(text)) return null;
  if (/\boriginal\b/i.test(text)) return 'names the column original';
  if (/\bSELECT\s+(?:ALL\s+|DISTINCT\s+)?\*/i.test(text) || /\b[A-Za-z_]\w*\s*\.\s*\*/.test(text) || /\bRETURNING\s+\*/i.test(text)) return 'takes every column';
  return null;
}

test("4f. the original's isolation, read from the courier's SQL: no statement under courier/ outside the stops' records module names a stop's original or takes every column of the stops table, and inside that module the one statement that names it is the insert; the reading finds each form it is for, and passes the ones it is not", () => {
  // The reading itself: each form found, qualified or not, and its neighbours passed.
  const found = (sql: string) => readsAnOriginal(sql) !== null;
  assert.ok(found('SELECT s.original FROM stops s WHERE s.hash = $1'), 'qualified by an alias');
  assert.ok(found('SELECT original FROM stops WHERE hash = $1'), 'unqualified');
  assert.ok(found('SELECT stops.original FROM stops'), 'qualified by the table');
  assert.ok(found('SELECT s.hash, s.original -> \'order\' AS o FROM stops AS s'), 'inside an expression, under AS');
  assert.ok(found('SELECT * FROM stops WHERE hash = $1'), 'every column');
  assert.ok(found('SELECT s.* FROM stops s'), "every column, by the alias");
  assert.ok(found('DELETE FROM stops WHERE hash = $1 RETURNING *'), 'every column, returned');
  assert.ok(found('UPDATE stops SET original = NULL WHERE hash = $1'), 'written');
  assert.ok(!found('SELECT 1 FROM stops WHERE hash = $1'), "the door's read of a stop by its hash");
  assert.ok(!found('SELECT s.hash, s.original_expiry FROM stops s'), "the original's expiry is another column");
  assert.ok(!found('SELECT count(*) AS standing FROM stops s WHERE s.account = $1'), 'a count takes no column');
  assert.ok(!found("SELECT o.hash FROM orders o WHERE o.ended = 'original'"), 'another table, and a word inside a string');
  assert.ok(!found('SELECT m.message FROM stop_messages m'), 'the messages are another table');

  const files = readdirSync(join(REPO, 'courier'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const read = files.map((path) => ({ file: relative(REPO, path).split(sep).join('/'), statements: statementsIn(readFileSync(path, 'utf8')) }));
  const all = read.flatMap((f) => f.statements.map((text) => ({ file: f.file, text })));
  // The reading read what is there: the files, the statements, the door's read of a stop, and the stops module's own.
  assert.ok(files.length >= 20, `${files.length} files read`);
  assert.ok(all.length >= 30, `${all.length} statements read`);
  assert.ok(all.some((s) => s.file === 'courier/orders/door.ts' && /SELECT 1 FROM stops WHERE hash = \$1/.test(s.text)), "the door's read of a stop was read");
  const own = all.filter((s) => s.file === 'courier/records/stops.ts');
  assert.ok(own.length >= 5, `${own.length} statements of the stops module read`);

  const outside = all.filter((s) => s.file !== 'courier/records/stops.ts').flatMap((s) => {
    const how = readsAnOriginal(s.text);
    return how === null ? [] : [`${s.file}: ${how}: ${s.text.replace(/\s+/g, ' ').slice(0, 120)}`];
  });
  console.log(`# the original's isolation: ${files.length} files, ${all.length} statements, ${own.length} of the stops module, ${outside.length} outside it that read an original`);
  assert.deepEqual(outside, [], "no statement outside the stops' records module reads a stop's original");
  // Inside the module: the insert names the column, and nothing reads it back.
  const naming = own.filter((s) => readsAnOriginal(s.text) !== null).map((s) => s.text.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.deepEqual(naming, ['INSERT INTO stops'], 'within the module the one statement that names the original is the insert');
});

// ──────────────────────────── 5: both ways round the first post ────────────────────────────

/** A session of the test's own on the stack's database, and its backend's number: for a lock the test holds across requests. */
async function ownSession(): Promise<{ client: pg.PoolClient; pid: number }> {
  const client = await pool.connect();
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return { client, pid: rows[0]?.pid ?? assert.fail('no backend') };
}

interface HashLock {
  pid: number;
  /** The lock's 64-bit key, as a signed number. */
  key: bigint;
  granted: boolean;
}

/** The advisory locks on the stack's database held or waited for by sessions other than the test's own: the couriers'. */
async function courierHashLocks(own: number[]): Promise<HashLock[]> {
  const { rows } = await pool.query<{ pid: number; key: string; granted: boolean }>(
    `SELECT l.pid, ((l.classid::bigint << 32) | l.objid::bigint)::text AS key, l.granted FROM pg_locks l
     WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()) AND l.pid <> ALL($1::int[])`,
    [own],
  );
  return rows.map((r) => ({ pid: r.pid, key: BigInt(r.key), granted: r.granted }));
}

test("5. both ways round the first post: the first post of an order and the stop ahead of it, each made to wait on the order's hash lock behind a lock the test holds, and let go. The post first: it is recorded, and the stop, deciding under the lock on what stands then, answers stopped and not stopped ahead, marks the order, and takes no slot. The stop first: it is recorded ahead, and the post is STOPPED. Either way the order is listed on no page after its stop", async () => {
  const from = at(5);
  const who = await freshAccount();
  const market = freshMarket();
  const T = await rig.time();
  const fields = { expiry: T + 3_600n, oddsTick: 280, ...market };
  const second = await anotherCourier();
  const mine = await ownSession();
  let holding: bigint | null = null;
  const pending: Array<Promise<unknown>> = [];
  const waitingOn = async (key: bigint) => (await courierHashLocks([mine.pid])).filter((l) => l.key === key && !l.granted).length;
  const hold = async (key: bigint) => {
    await mine.client.query('SELECT pg_advisory_lock($1::bigint)', [key.toString()]);
    holding = key;
  };
  const letGo = async () => {
    await mine.client.query('SELECT pg_advisory_unlock($1::bigint)', [(holding as bigint).toString()]);
    holding = null;
  };
  try {
    // The post first. It waits on the hash lock in one process; the stop ahead, sent to the other, waits behind it.
    const first = await unposted(who, fields);
    await hold(hashLockKey(first.orderHash));
    const posting = postOriginal(first, from);
    pending.push(posting.catch(() => undefined));
    await until("the post waiting on its order's hash lock", async () => (await waitingOn(hashLockKey(first.orderHash))) === 1);
    const stopping = postStop(second.url, rig, who, stopMessage(who.address, [first.orderHash]), [first], from);
    pending.push(stopping.catch(() => undefined));
    await until('the stop ahead waiting on the same hash lock, behind the post', async () => (await waitingOn(hashLockKey(first.orderHash))) === 2);
    assert.equal((await endedOf([first.orderHash])).size + (await stopRows([first.orderHash])).size, 0, 'neither has written anything while both wait');
    await letGo();
    const posted = await within('the post, let go', posting);
    const stopped = await within('the stop, let go after the post', stopping);
    assert.equal(posted.status, 201, `the post, first in the queue, was recorded: ${JSON.stringify(posted.body)}`);
    assert.deepEqual(outcomes(stopped), ['stopped'], `the stop found the order carried under the lock: ${JSON.stringify(stopped.body)}`);
    const row = (await stopRows([first.orderHash])).get(first.orderHash) ?? assert.fail('no stop row');
    assert.deepEqual({ ahead: row.ahead, original: row.original, original_expiry: row.original_expiry, grant_number: row.grant_number }, { ahead: false, original: null, original_expiry: null, grant_number: null }, 'a carried stop: no original kept, no slot taken');
    assert.deepEqual([...(await endedOf([first.orderHash])).values()], ['stopped'], 'the order is marked');
    assert.deepEqual(await listed(market, 'A', from), [], 'and is listed on no page');
    assert.equal((await get(url(), `/v1/orders/${first.orderHash}`, from)).body.ended, 'stopped');

    // The stop first. It waits on the hash lock in one process; the post, sent to the other, waits behind it.
    const later = await unposted(who, fields);
    await hold(hashLockKey(later.orderHash));
    const stoppingFirst = postStop(second.url, rig, who, stopMessage(who.address, [later.orderHash]), [later], from);
    pending.push(stoppingFirst.catch(() => undefined));
    await until("the stop ahead waiting on its order's hash lock", async () => (await waitingOn(hashLockKey(later.orderHash))) === 1);
    const postingBehind = postOriginal(later, from);
    pending.push(postingBehind.catch(() => undefined));
    await until('the post waiting on the same hash lock, behind the stop', async () => (await waitingOn(hashLockKey(later.orderHash))) === 2);
    await letGo();
    const stoppedFirst = await within('the stop, let go', stoppingFirst);
    const postedBehind = await within('the post, let go after the stop', postingBehind);
    assert.deepEqual(outcomes(stoppedFirst), ['stopped ahead'], JSON.stringify(stoppedFirst.body));
    assert.deepEqual({ status: postedBehind.status, code: postedBehind.body.code }, { status: 422, code: 'STOPPED' }, JSON.stringify(postedBehind.body));
    assert.equal((await endedOf([later.orderHash])).size, 0, 'the order was never recorded');
    assert.equal(((await stopRows([later.orderHash])).get(later.orderHash) as StopRow).ahead, true);
    assert.deepEqual(await listed(market, 'A', from), []);
  } finally {
    if (holding !== null) await letGo().catch(() => undefined);
    mine.client.release();
    await Promise.all(pending);
    await second.stop();
  }
});

// ──────────────────────────── 6: the forged and the stranger's ────────────────────────────

/** The recipe a refusal ends with, in the test's own copy of the plan's words. */
const RECIPE =
  "Send the stop of your own carried orders as a message of its own, with no other hash and no original: it takes none of your budgets, and signed by the account's key it reads no chain; the only limit on it is this route's count for your network address (its `retry-after`, when it refuses, names the next free slot and promises nothing), and the on-chain cancel does not go through this courier.";

test("6. the forged and the stranger's: a stop is taken on no signature but the account's, or its live agent's, over this message under the courier's domain. Each apart: a signature nothing recovers from; a stranger's key; the quote's own order signature; the message signed under the matching contract's domain, under the order's domain name and version, on another chain; and the account's own signature in each form the chain refuses. Each is BAD_SIGNATURE for the whole message, never AGENT_NOT_LIVE; nothing is written and no budget touched; the quotes stay listed and a bet still finds them; and the account's own signature then stops them", async () => {
  const from = at(6);
  const who = await freshAccount();
  const stranger = await freshAccount(false);
  const market = freshMarket();
  const T = await rig.time();
  const quotes = [
    await quote(who, { expiry: T + 3_600n, oddsTick: 300, ...market }, from),
    await quote(who, { expiry: T + 3_600n, oddsTick: 301, ...market }, from),
    await quote(who, { expiry: T + 3_600n, oddsTick: 302, ...market }, from),
  ];
  const hashes = quotes.map((q) => q.hash);
  const message = stopMessage(who.address, hashes);
  const relay = rig.addresses.relay;
  const countedBefore = (await refusedSoFar(from)).BAD_SIGNATURE ?? 0;
  let cases = 0;

  const refusedWhole = async (what: string, body: Record<string, unknown>): Promise<Answer> => {
    const before_ = await everything();
    const answer = await sendStop(url(), body, from);
    assert.deepEqual({ status: answer.status, code: answer.body.code, results: answer.body.results }, { status: 422, code: 'BAD_SIGNATURE', results: undefined }, `${what}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(await everything(), before_, `${what}: nothing written and no budget row touched`);
    assert.deepEqual(await listed(market, 'A', from), hashes, `${what}: the quotes are still listed`);
    cases++;
    return answer;
  };

  // A signature in the form the chain takes that no key made: nothing recovers from it.
  const nothing = await refusedWhole('a signature nothing recovers from', stopBody(message, `0x${'00'.repeat(63)}011b`));
  assert.match(String(nothing.body.error), /No signer recovers/);
  // A stranger's key over the very message.
  await refusedWhole("a stranger's key", stopBody(message, await signStop(stranger, message, 31337, relay)));
  // The quote's own order signature, offered as the stop's.
  await refusedWhole("the quote's own order signature", stopBody(message, (quotes[0] as Posted).signature));
  // The account's own key, over the same two fields, under a domain that is not the courier's.
  const under = (domain: { name: string; version: string; chainId: number; verifyingContract: Address }) => who.signTypedData({ domain, types: STOP_TYPE, primaryType: 'OspexStop', message });
  await refusedWhole("signed under the matching contract's domain", stopBody(message, await under({ name: 'Ospex', version: '3', chainId: 31337, verifyingContract: rig.addresses.matching })));
  await refusedWhole("signed under the order's domain name and version, with the relay", stopBody(message, await under({ name: 'Ospex', version: '3', chainId: 31337, verifyingContract: relay })));
  await refusedWhole("signed under the courier's domain on another chain", stopBody(message, await under({ name: 'Ospex Courier', version: '1', chainId: 137, verifyingContract: relay })));
  await refusedWhole("signed under the courier's domain with the matching contract in place of the relay", stopBody(message, await under({ name: 'Ospex Courier', version: '1', chainId: 31337, verifyingContract: rig.addresses.matching })));
  // Signed for another account's name: the account named is not the signer, and the signer is no agent of it.
  const misnamed = stopMessage(stranger.address, hashes);
  const misnamedAnswer = await sendStop(url(), stopBody(misnamed, await signStop(who, misnamed, 31337, relay)), from);
  assert.deepEqual({ status: misnamedAnswer.status, code: misnamedAnswer.body.code }, { status: 422, code: 'BAD_SIGNATURE' }, `the account's key over a message that names another account: ${JSON.stringify(misnamedAnswer.body)}`);
  cases++;

  // The account's own signature in each form the chain refuses: the last byte written 0 or 1, and the upper-half s.
  // A lenient recovery reads the account from each, so the form is the only fault. Messages of the same quotes in
  // other orders are signed until a signature of each last byte, 27 and 28, is in hand.
  const byLastByte = new Map<number, { message: StopMessage; signature: Hex }>();
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 1], [1, 0], [0, 2], [2, 0], [1, 2], [2, 1], [0], [1], [2]];
  for (const order of orders) {
    const m = stopMessage(who.address, order.map((i) => hashes[i] as Hex));
    const signature = await signStop(who, m, 31337, relay);
    const v = Number.parseInt(signature.slice(130), 16);
    if (!byLastByte.has(v)) byLastByte.set(v, { message: m, signature });
  }
  assert.deepEqual([...byLastByte.keys()].sort(), [27, 28], 'a signature of each last byte');
  for (const [v, signed] of byLastByte) {
    for (const how of ['v as parity', 'upper s'] as const) {
      const reshaped = refusedForm(signed.signature, how);
      const lenient = await recoverTypedDataAddress({ domain: { name: 'Ospex Courier', version: '1', chainId: 31337, verifyingContract: relay }, types: STOP_TYPE, primaryType: 'OspexStop', message: signed.message, signature: reshaped });
      assert.equal(lenient.toLowerCase(), who.address.toLowerCase(), `${how} of a signature ending in ${v}: a lenient recovery reads the account`);
      const answer = await refusedWhole(`the account's signature, ${how}, from one ending in ${v}`, stopBody(signed.message, reshaped));
      assert.match(String(answer.body.error), /27 or 28/, 'the sentence names the form');
    }
  }
  assert.equal(((await refusedSoFar(from)).BAD_SIGNATURE ?? 0) - countedBefore, cases, 'each refusal counted by its code, before admission');

  // A bet on the other side still finds the quotes: the book lists them, which is what a bet is filled from.
  const bet = orderOn(rig, who, { expiry: (await rig.time()) + 25n, riskAmount: 10_000n, positionType: 1, oddsTick: 300, ...market });
  const taken = await postOrder(url(), rig, who, 'take', bet, from);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  assert.deepEqual(await listed(market, 'A', from), hashes);

  // The control: the account's own signature, in the form the chain takes, stops them all, and the waiting bet with them.
  const stopped = await postStop(url(), rig, who, stopMessage(who.address, [...hashes, taken.body.orderHash as Hex]), undefined, from);
  assert.deepEqual(outcomes(stopped), ['stopped', 'stopped', 'stopped', 'stopped'], JSON.stringify(stopped.body));
  assert.deepEqual(await listed(market, 'A', from), []);

  // With every hash of the message now stopped, a stranger's signature over it is refused all the same: who signed is
  // judged before anything on record is said, and a stranger is told nothing of the records.
  const stood = await everything();
  const late = await sendStop(url(), stopBody(message, await signStop(stranger, message, 31337, relay)), from);
  assert.deepEqual({ status: late.status, code: late.body.code, results: late.body.results }, { status: 422, code: 'BAD_SIGNATURE', results: undefined }, `a stranger's key over hashes all stopped: ${JSON.stringify(late.body)}`);
  assert.deepEqual(await everything(), stood);
});

// ──────────────────────────── 7: the agent's stop ────────────────────────────

const CAP = 5_000_000n;

test("7. the agent's stop: an agent stops the orders signed under its own grant, the account's current one, and no other. A stops its quote, free of the budgets, in a block the message is recorded with. The account grants B: A's stop is then AGENT_NOT_LIVE for the whole message; B's stop of A's quote, of the account's own quote and of A's unposted order is refused hash by hash, under the budgets, with one line; B stops its own; the account's key stops them all. The account grants A again: A stops the new grant's quote, is refused an unstopped quote of its old grant, and its first message, sent again byte for byte, is answered already stopped with nothing written", async () => {
  const from = at(7);
  const owner = await freshAccount();
  const agentA = await freshAccount(false);
  const agentB = await freshAccount(false);
  const market = freshMarket();
  const T = await rig.time();
  const far = T + 100_000n;
  const under = (grant: number) => ({ expiry: far, oddsTick: 310, ...market, nonce: nonceOf(0n, grant, nextOrderNumber()) });

  // Grant 1, to A. A posts three quotes under it and signs a fourth it does not post; the account posts one of its own.
  const g1 = await grantAgent(rig, owner, agentA.address, CAP, far);
  const a1 = await quote(owner, under(g1), from, agentA);
  const a2 = await quote(owner, under(g1), from, agentA);
  const a3 = await quote(owner, under(g1), from, agentA);
  const a0 = await unposted(owner, under(g1), agentA);
  const k = await quote(owner, { expiry: far, oddsTick: 311, ...market }, from);

  // A's stop of its quote: stopped, and free of the budgets; recorded with its signer and the block it was judged at.
  let before_ = await everything();
  let last = await lastLine();
  const firstMessage = stopMessage(owner.address, [a1.hash]);
  const first = await postStop(url(), rig, agentA, firstMessage, undefined, from);
  assert.deepEqual(outcomes(first), ['stopped'], JSON.stringify(first.body));
  assert.deepEqual(await budgetRows(), before_.budgets, "an agent's stop of its own grant's orders takes no budget");
  const block = await head();
  const kept = await messageRow(((await stopRows([a1.hash])).get(a1.hash) as StopRow).message_id);
  assert.deepEqual(
    { account: kept.account, signer: kept.signer, block: [kept.block_number, kept.block_hash, kept.block_time] },
    { account: owner.address.toLowerCase(), signer: agentA.address.toLowerCase(), block: [block.number.toString(), block.hash.toLowerCase(), block.timestamp.toString()] },
  );
  assert.deepEqual((await stopLinesSince(last)).map((l) => ({ kind: l.kind, account: l.account, facts: l.facts })), [{ kind: 'stop received', account: owner.address.toLowerCase(), facts: { messageId: Number(kept.id), stopped: 1, ahead: 0 } }]);

  // Grant 2, to B, ending later than grant 1 did: grant 1 is gone. B posts a quote under its own.
  const g2 = await grantAgent(rig, owner, agentB.address, CAP, far + 500n);
  assert.deepEqual([g1, g2], [1, 2]);
  const b1 = await quote(owner, under(g2), from, agentB);

  // A, a former agent now, naming a quote of its own old grant and one of B's: refused whole, by the grant it was
  // the agent of and that grant's own end, and nothing written; counted and logged by its code.
  const notLiveBefore = (await refusedSoFar(from)).AGENT_NOT_LIVE ?? 0;
  const logged = stack.courier.lines.length;
  before_ = await everything();
  const stale = await postStop(url(), rig, agentA, stopMessage(owner.address, [a2.hash, b1.hash]), undefined, from);
  assert.deepEqual({ status: stale.status, code: stale.body.code, grant: stale.body.grantNumber, endsAt: stale.body.endsAt, current: stale.body.currentGrant }, { status: 422, code: 'AGENT_NOT_LIVE', grant: g1, endsAt: far.toString(), current: g2 }, JSON.stringify(stale.body));
  assert.match(String(stale.body.error), new RegExp(`grant ${g1} .*ends at ${far}\\b`), 'the sentence names the grant and its end');
  assert.equal(stale.body.results, undefined);
  assert.deepEqual(await everything(), before_, 'nothing written, no budget row touched');
  assert.equal(((await refusedSoFar(from)).AGENT_NOT_LIVE ?? 0) - notLiveBefore, 1, 'counted by its code, before admission');
  await refusalLogged(logged, 'AGENT_NOT_LIVE');
  // Its first message, byte for byte, whose one hash is stopped: refused the same. A former agent is told nothing of
  // the records, not even that a hash is stopped already.
  const staleOfStopped = await sendStop(url(), stopBody(firstMessage, first.signature), from);
  assert.deepEqual({ status: staleOfStopped.status, code: staleOfStopped.body.code, results: staleOfStopped.body.results }, { status: 422, code: 'AGENT_NOT_LIVE', results: undefined }, JSON.stringify(staleOfStopped.body));
  assert.deepEqual(await everything(), before_);

  // B, the live agent, over what is not its grant's: A's quote, the account's own quote, and A's unposted order.
  last = await lastLine();
  const budget = await budgetsOf(owner.address);
  const writtenBefore = await written();
  const beyond = await postStop(url(), rig, agentB, stopMessage(owner.address, [a2.hash, k.hash, a0.orderHash]), [a0], from);
  assert.equal(beyond.status, 200, JSON.stringify(beyond.body));
  assert.deepEqual(outcomes(beyond), ['NOT_THE_GRANTS_AGENT', 'NOT_THE_GRANTS_AGENT', 'GRANT_GONE'], JSON.stringify(beyond.body));
  assert.deepEqual((await stopLinesSince(last)).map((l) => ({ kind: l.kind, account: l.account, facts: l.facts })), [
    {
      kind: 'stop refused',
      account: owner.address.toLowerCase(),
      facts: { messageId: null, refused: [{ hash: a2.hash, code: 'NOT_THE_GRANTS_AGENT' }, { hash: k.hash, code: 'NOT_THE_GRANTS_AGENT' }, { hash: a0.orderHash, code: 'GRANT_GONE' }] },
    },
  ]);
  assert.deepEqual(await written(), { ...writtenBefore, lines: (writtenBefore.lines ?? 0) + 1 }, 'one line, and nothing stopped: no stop, no message, no mark');
  const after_ = await budgetsOf(owner.address);
  assert.deepEqual({ account: taken(budget.account, after_.account), courier: taken(budget.courier, after_.courier) }, { account: 1, courier: 1 }, 'the message was under the budgets: one taken from each');
  // An order the account signed itself and has not posted, sent ahead by B: an agent stops ahead only what was signed
  // under its own grant, as it stops only that among the orders carried.
  const ownAhead = await unposted(owner, { expiry: far, oddsTick: 312, ...market });
  last = await lastLine();
  assert.deepEqual(outcomes(await postStop(url(), rig, agentB, stopMessage(owner.address, [ownAhead.orderHash]), [ownAhead], from)), ['NOT_THE_GRANTS_AGENT'], "the account's own unposted order, sent ahead by its agent");
  assert.deepEqual((await stopLinesSince(last)).map((l) => ({ kind: l.kind, facts: l.facts })), [{ kind: 'stop refused', facts: { messageId: null, refused: [{ hash: ownAhead.orderHash, code: 'NOT_THE_GRANTS_AGENT' }] } }]);
  assert.equal((await stopRows([ownAhead.orderHash])).size, 0);

  // B's own.
  before_ = await everything();
  assert.deepEqual(outcomes(await postStop(url(), rig, agentB, stopMessage(owner.address, [b1.hash]), undefined, from)), ['stopped']);
  assert.deepEqual(await budgetRows(), before_.budgets, 'free of the budgets');
  // The account's key stops any of its orders, whatever grant they were signed under; one stopped already is said so.
  const byKey = await postStop(url(), rig, owner, stopMessage(owner.address, [a2.hash, k.hash, b1.hash]), undefined, from);
  assert.deepEqual(outcomes(byKey), ['stopped', 'stopped', 'already stopped'], JSON.stringify(byKey.body));
  assert.deepEqual(await budgetRows(), before_.budgets, 'free of the budgets too');
  // And the account's own key stops ahead what its agent could not.
  assert.deepEqual(outcomes(await postStop(url(), rig, owner, stopMessage(owner.address, [ownAhead.orderHash]), [ownAhead], from)), ['stopped ahead']);

  // Grant 3, to A again: live again by the account's own act, under the new number, for the new number's orders.
  const g3 = await grantAgent(rig, owner, agentA.address, CAP, far + 900n);
  assert.equal(g3, 3);
  const a5 = await quote(owner, under(g3), from, agentA);
  assert.deepEqual(outcomes(await postStop(url(), rig, agentA, stopMessage(owner.address, [a5.hash]), undefined, from)), ['stopped']);
  // The regrant revives nothing over an unstopped quote of grant 1.
  last = await lastLine();
  const old = await postStop(url(), rig, agentA, stopMessage(owner.address, [a3.hash]), undefined, from);
  assert.deepEqual(outcomes(old), ['NOT_THE_GRANTS_AGENT'], JSON.stringify(old.body));
  assert.deepEqual((await stopLinesSince(last)).map((l) => ({ kind: l.kind, facts: l.facts })), [{ kind: 'stop refused', facts: { messageId: null, refused: [{ hash: a3.hash, code: 'NOT_THE_GRANTS_AGENT' }] } }]);
  assert.equal((await stopRows([a3.hash])).size, 0);
  // A's first message, byte for byte: its quote is stopped already, and that is answered from its row before any
  // grant is compared, though the quote was signed under a grant that is no longer A's. Nothing is written.
  before_ = await everything();
  const repeat = await sendStop(url(), stopBody(firstMessage, first.signature), from);
  assert.deepEqual({ status: repeat.status, results: outcomes(repeat) }, { status: 200, results: ['already stopped'] }, JSON.stringify(repeat.body));
  assert.deepEqual(await everything(), before_, 'no row, no line, and neither budget row touched');

  // The account revokes. A was the agent of grants 1 and 3 and neither stands: its message naming a quote of each is
  // refused whole, by the later of the two and that grant's own end.
  await revokeAgent(rig, owner);
  before_ = await everything();
  const gone = await postStop(url(), rig, agentA, stopMessage(owner.address, [a3.hash, a5.hash]), undefined, from);
  assert.deepEqual(
    { status: gone.status, code: gone.body.code, grant: gone.body.grantNumber, endsAt: gone.body.endsAt, current: gone.body.currentGrant },
    { status: 422, code: 'AGENT_NOT_LIVE', grant: g3, endsAt: (far + 900n).toString(), current: 0 },
    JSON.stringify(gone.body),
  );
  assert.deepEqual(await everything(), before_, 'nothing written, no budget row touched');
});

test("7a. the boundary of an agent's authority is the contract's own, with no margin: at the block whose time is one second before its grant's end the agent's stop is taken, and at the block whose time is the grant's end it is AGENT_NOT_LIVE, with nothing written; the account's own key stops the same quote", async () => {
  const from = at(71);
  const owner = await freshAccount();
  const agent = await freshAccount(false);
  const market = freshMarket();
  const T = await rig.time();
  const ends = T + 600n;
  const g = await grantAgent(rig, owner, agent.address, CAP, ends);
  const under = () => ({ expiry: T + 100_000n, oddsTick: 320, ...market, nonce: nonceOf(0n, g, nextOrderNumber()) });
  const q1 = await quote(owner, under(), from, agent);
  const q2 = await quote(owner, under(), from, agent);

  await chainTimeIs(ends - 1n);
  const taken = await postStop(url(), rig, agent, stopMessage(owner.address, [q1.hash]), undefined, from);
  assert.deepEqual(outcomes(taken), ['stopped'], `one second before the grant's end the agent is live: ${JSON.stringify(taken.body)}`);
  assert.equal((await messageRow(((await stopRows([q1.hash])).get(q1.hash) as StopRow).message_id)).block_time, (ends - 1n).toString());

  await chainTimeIs(ends);
  const before_ = await everything();
  const ended = await postStop(url(), rig, agent, stopMessage(owner.address, [q2.hash]), undefined, from);
  assert.deepEqual(
    { status: ended.status, code: ended.body.code, grant: ended.body.grantNumber, endsAt: ended.body.endsAt, current: ended.body.currentGrant, chainTime: ended.body.chainTime },
    { status: 422, code: 'AGENT_NOT_LIVE', grant: g, endsAt: ends.toString(), current: g, chainTime: ends.toString() },
    `at the grant's end the grant has ended: ${JSON.stringify(ended.body)}`,
  );
  assert.deepEqual(await everything(), before_, 'nothing written, no budget row touched');
  assert.equal((await stopRows([q2.hash])).size, 0);
  // The control: the quote was stoppable all along, by the account's own key.
  assert.deepEqual(outcomes(await postStop(url(), rig, owner, stopMessage(owner.address, [q2.hash]), undefined, from)), ['stopped']);
});

test("7b. an agent's stop is judged at the block the courier named, and recorded with it: with the agent's read of the chain held and the account's revoke mined meanwhile, the stop, let go, is taken, and its message names the block before the revoke; a stop sent after the revoke is AGENT_NOT_LIVE", async () => {
  const from = at(72);
  const owner = await freshAccount();
  const agent = await freshAccount(false);
  const market = freshMarket();
  const T = await rig.time();
  const g = await grantAgent(rig, owner, agent.address, CAP, T + 100_000n);
  const under = () => ({ expiry: T + 90_000n, oddsTick: 330, ...market, nonce: nonceOf(0n, g, nextOrderNumber()) });
  const q1 = await quote(owner, under(), from, agent);
  const q2 = await quote(owner, under(), from, agent);

  const named = await head();
  const held = stack.proxy.hold('eth_call');
  let released = false;
  let stopping: Promise<Answer> | null = null;
  try {
    stopping = postStop(url(), rig, agent, stopMessage(owner.address, [q1.hash]), undefined, from);
    await within("the agent's read of the chain arriving at the proxy", held.arrived, 15_000);
    // The revoke, mined while the read is held: a block after the one the stop named.
    await revokeAgent(rig, owner);
    assert.ok((await head()).number > named.number);
    held.release();
    released = true;
    const answer = await within("the agent's stop, its read let go", stopping);
    assert.deepEqual(outcomes(answer), ['stopped'], `judged at the block named, where the agent was live: ${JSON.stringify(answer.body)}`);
    const kept = await messageRow(((await stopRows([q1.hash])).get(q1.hash) as StopRow).message_id);
    assert.deepEqual({ number: kept.block_number, hash: kept.block_hash }, { number: named.number.toString(), hash: named.hash.toLowerCase() }, 'recorded with the block it was judged at, the one before the revoke');
  } finally {
    if (!released) held.release();
    await stopping?.catch(() => undefined);
  }
  // After the revoke: a block at which the account has no grant standing.
  const before_ = await everything();
  const late = await postStop(url(), rig, agent, stopMessage(owner.address, [q2.hash]), undefined, from);
  assert.deepEqual({ status: late.status, code: late.body.code, grant: late.body.grantNumber, current: late.body.currentGrant }, { status: 422, code: 'AGENT_NOT_LIVE', grant: g, current: 0 }, JSON.stringify(late.body));
  assert.deepEqual(await everything(), before_);
});

test("7c. while an agent's read of the chain hangs, the account's own stop of a carried quote is answered, with no chain read and no budget row; the agent's stop, its read refused twice, is CHAIN_UNREACHABLE with the recipe, and nothing is written for it; with the chain back, the agent's stop is taken", async () => {
  const from = at(73);
  const owner = await freshAccount();
  const agent = await freshAccount(false);
  const market = freshMarket();
  const T = await rig.time();
  const g = await grantAgent(rig, owner, agent.address, CAP, T + 100_000n);
  const byAgent = await quote(owner, { expiry: T + 90_000n, oddsTick: 340, ...market, nonce: nonceOf(0n, g, nextOrderNumber()) }, from, agent);
  const byKey = await quote(owner, { expiry: T + 90_000n, oddsTick: 341, ...market }, from);
  const unreachableBefore = (await refusedSoFar(from)).CHAIN_UNREACHABLE ?? 0;

  const held = stack.proxy.hold('eth_call');
  let released = false;
  let stopping: Promise<Answer> | null = null;
  try {
    stopping = postStop(url(), rig, agent, stopMessage(owner.address, [byAgent.hash]), undefined, from);
    await within("the agent's read of the chain arriving at the proxy", held.arrived, 15_000);
    const budgets = await budgetRows();
    const asked = stack.proxy.count();
    const started = Date.now();
    const own = await within("the account's own stop while the agent's read hangs", postStop(url(), rig, owner, stopMessage(owner.address, [byKey.hash]), undefined, from), 8_000);
    console.log(`# the account's own stop, answered while the agent's read of the chain hung: ${Date.now() - started} ms`);
    assert.deepEqual(outcomes(own), ['stopped'], JSON.stringify(own.body));
    assert.equal(stack.proxy.count(), asked, 'it asked the chain nothing');
    assert.deepEqual(await budgetRows(), budgets, 'and touched no budget row');
    // The held read is let go into a node that refuses it, and refuses the one retry.
    const before_ = await everything();
    held.release({ kind: 'refuse', code: -32000, message: 'refused by the test' });
    released = true;
    const answer = await within("the agent's stop, its read refused twice", stopping);
    assert.deepEqual({ status: answer.status, code: answer.body.code }, { status: 503, code: 'CHAIN_UNREACHABLE' }, JSON.stringify(answer.body));
    assert.ok(String(answer.body.error).endsWith(RECIPE), `the sentence ends with the recipe: ${String(answer.body.error)}`);
    assert.deepEqual(await everything(), before_, 'nothing written for it, no budget row touched');
    assert.equal((await stopRows([byAgent.hash])).size, 0);
    assert.equal(((await refusedSoFar(from)).CHAIN_UNREACHABLE ?? 0) - unreachableBefore, 1, 'counted by its code, before admission');
  } finally {
    if (!released) held.release();
    stack.proxy.rule('eth_call', null);
    await stopping?.catch(() => undefined);
  }
  // The chain back: the same stop is taken.
  assert.deepEqual(outcomes(await postStop(url(), rig, agent, stopMessage(owner.address, [byAgent.hash]), undefined, from)), ['stopped']);
});

// ──────────────────────────── 8: the budgets, and what is outside them ────────────────────────────

/** Runs `n` requests `width` at a time, each from the case's own address. */
async function many<T>(n: number, width: number, one: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array<T>(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        out[i] = await one(i);
      }
    }),
  );
  return out;
}

test("8. the budgets, and what is outside them: an account that has spent its 240 admitted requests is refused a post, and its stop of its own carried quotes is taken all the same, free; a message that mixes its carried quotes with one unknown hash is under the budgets and is refused whole, 429 naming the account's budget and ending with the recipe, the quotes still listed; the recipe followed, they are stopped; after a minute's refill the unknown hash alone is admitted, refused by its hash, and leaves one line. Its live agent's message over the account's own quotes is under the budgets, one line and one taken; over its own grant's, free. A key that registered nothing is NOT_REGISTERED and leaves no row. A message of one stopped and one carried hash is free. The count is one for two processes and across a restart", async () => {
  const from = at(8);
  const who = await freshAccount();
  const agent = await freshAccount(false);
  const marketOne = freshMarket();
  const marketTwo = freshMarket();
  const T = await rig.time();
  const far = T + 100_000n;
  // The grant is made first, so that no block is mined, and the chain's time stands still, while the budget is counted.
  const g = await grantAgent(rig, who, agent.address, CAP, far);
  const T0 = await rig.time();

  // 240 admitted posts in all: two sets of eight quotes, and 224 orders admitted and then refused for their expiry.
  const setOne: Posted[] = [];
  const setTwo: Posted[] = [];
  for (let i = 0; i < 8; i++) setOne.push(await quote(who, { expiry: far, oddsTick: 350 + i, ...marketOne }, from));
  for (let i = 0; i < 8; i++) setTwo.push(await quote(who, { expiry: far, oddsTick: 350 + i, ...marketTwo }, from));
  const spent = await many(224, 8, (i) => postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T0 - BigInt(i), ...marketOne }), from));
  assert.equal(spent.filter((a) => a.body.code === 'EXPIRED').length, 224, JSON.stringify(spent.find((a) => a.body.code !== 'EXPIRED')?.body));
  const over = await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: far, ...marketOne }), from);
  assert.deepEqual({ status: over.status, code: over.body.code, budget: over.body.budget }, { status: 429, code: 'RATE_LIMIT_EXCEEDED', budget: 'account' }, `the 241st: ${JSON.stringify(over.body)}`);
  assert.equal(await rig.time(), T0, "the chain's time has stood still: the budget has refilled nothing");

  // The stop of set one: free. The account has no budget left, and it is not asked for one.
  let budgets = await budgetRows();
  const one = await postStop(url(), rig, who, stopMessage(who.address, setOne.map((q) => q.hash)), undefined, from);
  assert.deepEqual(outcomes(one), times(8, 'stopped'), JSON.stringify(one.body));
  assert.deepEqual(await budgetRows(), budgets, 'the stop of carried orders touched no budget row');
  assert.deepEqual(await listed(marketOne, 'A', from), []);

  // Set two with one unknown hash: under the budgets, whole. The account's is spent: 429, by the budget and not by the
  // address's count, which this case's few stop requests are nowhere near; the recipe; the quotes still carried.
  const unknown = noOrders(0x8a01);
  let before_ = await written();
  const refusedBefore = (await budgetsOf(who.address)).refused;
  const overBefore = (await refusedSoFar(from)).RATE_LIMIT_EXCEEDED ?? 0;
  const mixed = await postStop(url(), rig, who, stopMessage(who.address, [...setTwo.map((q) => q.hash), unknown]), undefined, from);
  assert.deepEqual({ status: mixed.status, code: mixed.body.code, budget: mixed.body.budget }, { status: 429, code: 'RATE_LIMIT_EXCEEDED', budget: 'account' }, JSON.stringify(mixed.body));
  assert.equal(((await refusedSoFar(from)).RATE_LIMIT_EXCEEDED ?? 0) - overBefore, 1, 'counted by its code, before admission');
  assert.ok(Number(mixed.headers.get('retry-after')) >= 1 && mixed.body.retryAfterSeconds === Number(mixed.headers.get('retry-after')));
  assert.match(String(mixed.body.error), /^This account has used its budget of admitted requests/);
  assert.ok(String(mixed.body.error).endsWith(RECIPE), String(mixed.body.error));
  assert.equal(mixed.body.results, undefined);
  assert.deepEqual(await written(), before_, 'nothing written: no stop, no message, no mark, no line');
  assert.equal((await budgetsOf(who.address)).refused, refusedBefore + 1, "the refusal is a number on the account's row");
  assert.deepEqual(await listed(marketTwo, 'A', from), setTwo.map((q) => q.hash), 'set two is still listed');
  // The recipe followed: set two alone, a message of its own.
  budgets = await budgetRows();
  const two = await postStop(url(), rig, who, stopMessage(who.address, setTwo.map((q) => q.hash)), undefined, from);
  assert.deepEqual(outcomes(two), times(8, 'stopped'), JSON.stringify(two.body));
  assert.deepEqual(await budgetRows(), budgets);
  assert.deepEqual(await listed(marketTwo, 'A', from), []);

  // A minute on the chain's clock refills twelve. The unknown hash alone: admitted, refused by its hash, one line.
  await chainTimeIs(T0 + 60n);
  let last = await lastLine();
  let budget = await budgetsOf(who.address);
  before_ = await written();
  const alone = await postStop(url(), rig, who, stopMessage(who.address, [unknown]), undefined, from);
  assert.deepEqual({ status: alone.status, results: outcomes(alone) }, { status: 200, results: ['UNKNOWN_ORDER'] }, JSON.stringify(alone.body));
  assert.deepEqual((await stopLinesSince(last)).map((l) => ({ kind: l.kind, account: l.account, facts: l.facts })), [{ kind: 'stop refused', account: who.address.toLowerCase(), facts: { messageId: null, refused: [{ hash: unknown, code: 'UNKNOWN_ORDER' }] } }]);
  assert.deepEqual(await written(), { ...before_, lines: (before_.lines ?? 0) + 1 });
  let now = await budgetsOf(who.address);
  assert.ok(budget.account < 1 && now.account >= 10 && now.account < 12, `refilled by the minute's twelve, and one taken: ${budget.account} before, ${now.account} after`);

  // The live agent. Two quotes of the account's own, and one the agent signs under its grant.
  const ownOne = await quote(who, { expiry: far, oddsTick: 360, ...marketOne }, from);
  const ownTwo = await quote(who, { expiry: far, oddsTick: 361, ...marketOne }, from);
  const underGrant = await quote(who, { expiry: far, oddsTick: 362, ...marketOne, nonce: nonceOf(0n, g, nextOrderNumber()) }, from, agent);
  last = await lastLine();
  budget = await budgetsOf(who.address);
  const beyond = await postStop(url(), rig, agent, stopMessage(who.address, [ownOne.hash, ownTwo.hash]), undefined, from);
  assert.deepEqual(outcomes(beyond), ['NOT_THE_GRANTS_AGENT', 'NOT_THE_GRANTS_AGENT'], JSON.stringify(beyond.body));
  assert.deepEqual((await stopLinesSince(last)).map((l) => l.kind), ['stop refused'], 'one line');
  now = await budgetsOf(who.address);
  assert.deepEqual({ account: taken(budget.account, now.account), courier: taken(budget.courier, now.courier) }, { account: 1, courier: 1 }, "the budget down by one, the account's and the courier's");
  budgets = await budgetRows();
  assert.deepEqual(outcomes(await postStop(url(), rig, agent, stopMessage(who.address, [underGrant.hash]), undefined, from)), ['stopped']);
  assert.deepEqual(await budgetRows(), budgets, "its own grant's quote: free, every budget row as it was");

  // A registered account's message of one hash stopped already and one carried: free.
  const mixedOwn = await postStop(url(), rig, who, stopMessage(who.address, [(setOne[0] as Posted).hash, ownOne.hash]), undefined, from);
  assert.deepEqual(outcomes(mixedOwn), ['already stopped', 'stopped'], JSON.stringify(mixedOwn.body));
  assert.deepEqual(await budgetRows(), budgets);

  // A key that has registered nothing, naming one unknown hash: refused before any row. No budget row is made for it.
  const unregistered = await freshAccount(false);
  const everythingBefore = await everything();
  const unregisteredBefore = (await refusedSoFar(from)).NOT_REGISTERED ?? 0;
  const stranger = await postStop(url(), rig, unregistered, stopMessage(unregistered.address, [noOrders(0x8a02)]), undefined, from);
  assert.deepEqual({ status: stranger.status, code: stranger.body.code }, { status: 422, code: 'NOT_REGISTERED' }, JSON.stringify(stranger.body));
  assert.ok(String(stranger.body.error).endsWith(RECIPE));
  assert.deepEqual(await everything(), everythingBefore, "no accounts row for it, the courier's budget as it was, nothing written");
  assert.equal(((await refusedSoFar(from)).NOT_REGISTERED ?? 0) - unregisteredBefore, 1, 'counted by its code, before admission');

  // Two processes and a restart: one count. The account's remaining budget is spent by messages of one unknown hash,
  // sent to each process in turn; then each process refuses the next, and so does the second one started again.
  let second = await anotherCourier();
  try {
    // What the account's row holds now, in whole requests: that many are admitted, by the two processes in turn, and the next is refused.
    const left = Math.floor((await budgetsOf(who.address)).account);
    assert.ok(left >= 2 && left < 40, `the account's budget holds enough for both processes to take from it: ${left}`);
    let refusedAt = -1;
    for (let i = 0; i < 40 && refusedAt < 0; i++) {
      const answer = await postStop(i % 2 === 0 ? url() : second.url, rig, who, stopMessage(who.address, [noOrders(0x8b00 + i)]), undefined, from);
      if (answer.status === 429) refusedAt = i;
      else assert.deepEqual({ status: answer.status, results: outcomes(answer) }, { status: 200, results: ['UNKNOWN_ORDER'] }, JSON.stringify(answer.body));
    }
    assert.equal(refusedAt, left, `the ${left} requests the account's row held were admitted by the two processes between them, and the next was refused: one count, not one a process`);
    const viaFirst = await postStop(url(), rig, who, stopMessage(who.address, [noOrders(0x8c01)]), undefined, from);
    const viaSecond = await postStop(second.url, rig, who, stopMessage(who.address, [noOrders(0x8c02)]), undefined, from);
    assert.deepEqual([viaFirst.status, viaFirst.body.budget, viaSecond.status, viaSecond.body.budget], [429, 'account', 429, 'account'], 'each process sees the one count');
    await second.stop();
    second = await anotherCourier();
    const afterRestart = await postStop(second.url, rig, who, stopMessage(who.address, [noOrders(0x8c03)]), undefined, from);
    assert.deepEqual([afterRestart.status, afterRestart.body.budget], [429, 'account'], 'a restart keeps the count');
  } finally {
    await second.stop();
  }
});

test("8a. an original beside a carried hash decides nothing and puts its message under the budgets: the stop of a carried quote sent with that quote's own signed original is answered stopped, as a carried stop with no original kept, in a block the message is recorded with, and one is taken from each budget; the stop of another carried quote with no original takes none", async () => {
  const from = at(81);
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const withOriginal = await quote(who, { expiry: far, oddsTick: 365, ...market }, from);
  const alone = await quote(who, { expiry: far, oddsTick: 366, ...market }, from);
  const chainTime = await rig.time();
  const before_ = await budgetsOf(who.address);
  const answer = await postStop(url(), rig, who, stopMessage(who.address, [withOriginal.hash]), [{ orderHash: withOriginal.hash, order: withOriginal.order, signature: withOriginal.signature }], from);
  assert.deepEqual({ status: answer.status, results: outcomes(answer) }, { status: 200, results: ['stopped'] }, JSON.stringify(answer.body));
  const after_ = await budgetsOf(who.address);
  assert.equal(await rig.time(), chainTime, "the chain's time stood still: nothing refilled between the readings");
  assert.deepEqual({ account: taken(before_.account, after_.account), courier: taken(before_.courier, after_.courier) }, { account: 1, courier: 1 }, 'a message with an original is under the budgets, whatever its hashes are: one taken from each');
  const row = (await stopRows([withOriginal.hash])).get(withOriginal.hash) ?? assert.fail('no stop row');
  assert.deepEqual({ ahead: row.ahead, original: row.original, original_expiry: row.original_expiry, grant_number: row.grant_number }, { ahead: false, original: null, original_expiry: null, grant_number: null }, 'a carried stop: the original decided nothing and is not kept');
  const block = await head();
  const kept = await messageRow(row.message_id);
  assert.deepEqual({ number: kept.block_number, hash: kept.block_hash }, { number: block.number.toString(), hash: block.hash.toLowerCase() }, 'recorded with the block the chain was read at');
  // The control: a carried quote with no original beside it is free.
  const budgets = await budgetRows();
  assert.deepEqual(outcomes(await postStop(url(), rig, who, stopMessage(who.address, [alone.hash]), undefined, from)), ['stopped']);
  assert.deepEqual(await budgetRows(), budgets, 'the stop of a carried quote with no original took no budget');
});

// ──────────────────────────── 9: the lock span and the other maker ────────────────────────────

/** An account with sixteen quotes standing on one side of one market: its next post there makes the door ask the chain about them inside its transaction, the courier's budget row locked. */
async function sixteenStanding(headers: Record<string, string>): Promise<{ who: HDAccount; hashes: Hex[]; next(): Order }> {
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const hashes: Hex[] = [];
  for (let i = 0; i < 16; i++) hashes.push((await quote(who, { expiry: far, oddsTick: 400 + i, ...market }, headers)).hash);
  return { who, hashes, next: () => orderOn(rig, who, { expiry: far, oddsTick: 450, ...market }) };
}

/**
 * Picks, among the requests the courier makes of the chain, the door's read of an account's standing quotes: one call
 * to the multicall contract at the block named by this hash, among whose calls the matching contract is asked whether
 * one of these quotes is cancelled. The door's first read of a post asks that of the new order's own hash and of no
 * standing quote, and a stop's read asks it of none, so neither is picked.
 */
function quotesReadOf(standing: readonly Hex[], blockHash: Hex): (params: unknown[]) => boolean {
  const wanted = new Set(standing.map((h) => h.toLowerCase()));
  return (params) => {
    const call = params[0] as { to?: string; data?: Hex } | undefined;
    const block = params[1] as { blockHash?: string } | string | undefined;
    if (call?.to?.toLowerCase() !== MULTICALL_ADDRESS.toLowerCase() || call.data === undefined) return false;
    if (typeof block !== 'object' || block === null || block.blockHash?.toLowerCase() !== blockHash.toLowerCase()) return false;
    try {
      const outer = decodeFunctionData({ abi: MULTICALL_ABI, data: call.data });
      if (outer.functionName !== 'aggregate3') return false;
      return (outer.args[0] as ReadonlyArray<{ callData: Hex }>).some((c) => {
        try {
          const inner = decodeFunctionData({ abi: MATCHING_ABI, data: c.callData });
          return inner.functionName === 's_cancelledOrders' && wanted.has(String(inner.args[0]).toLowerCase());
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };
}

/** Whether a session of the database is waiting on a lock now. */
async function waitingOnALock(pid: number): Promise<boolean> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.pid = $1 AND a.wait_event_type = 'Lock'`, [pid]);
  return rows[0]?.n === 1;
}

test("9. the lock span and the other maker: while a post hangs at its read of the chain inside its transaction, the courier's budget row locked, another maker's free stop of its own carried quote is answered on the same process; its stop ahead, under the budgets, waits on that process for the door's one connection and is answered 503 at the pool's wait, having recorded nothing, and on a second process is answered when the hang ends. Each wait is printed, and no bound is put on one", async () => {
  const from = at(9);
  const hanger = await sixteenStanding(from);
  const maker = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const carried = await quote(maker, { expiry: far, oddsTick: 370, ...market }, from);
  const aheadHere = await unposted(maker, { expiry: far, oddsTick: 371, ...market });
  const aheadThere = await unposted(maker, { expiry: far, oddsTick: 372, ...market });
  const second = await anotherCourier();
  const held = stack.proxy.hold('eth_call', quotesReadOf(hanger.hashes, (await head()).hash));
  let released = false;
  let hung = true;
  const pending: Array<Promise<unknown>> = [];
  try {
    const hanging = postOrder(url(), rig, hanger.who, 'rest', hanger.next(), from);
    pending.push(hanging.then(() => (hung = false)).catch(() => undefined));
    await within("the post's read of its account's standing quotes, inside its transaction, arriving at the proxy", held.arrived, 15_000);
    const arrivedAt = Date.now();

    // A free stop on the same process: the reads' pool, no budget row.
    let started = Date.now();
    const free = await within("another maker's free stop on the process whose post hangs", postStop(url(), rig, maker, stopMessage(maker.address, [carried.hash]), undefined, from), 9_000);
    console.log(`# 9: another maker's free stop, on the process whose post hangs: answered ${free.status} in ${Date.now() - started} ms`);
    assert.deepEqual(outcomes(free), ['stopped'], JSON.stringify(free.body));
    assert.ok(hung, 'answered while the post still hangs');

    // A stop ahead, under the budgets, on a second process: it has a connection of its own, and waits for the courier's row.
    const startedThere = Date.now();
    const there = postStop(second.url, rig, maker, stopMessage(maker.address, [aheadThere.orderHash]), [aheadThere], from);
    pending.push(there.catch(() => undefined));
    // Seen waiting, not taken to be: its session holds its order's hash lock and waits on a row's lock, the courier's.
    const waiter = await until("the second process's stop ahead holding its order's hash lock", async () => (await courierHashLocks([])).find((l) => l.key === hashLockKey(aheadThere.orderHash) && l.granted));
    await until("the second process's stop ahead waiting on the courier's budget row", () => waitingOnALock(waiter.pid));
    // The same on the process whose post hangs: it waits for the door's one connection, holding nothing.
    started = Date.now();
    const here = await within('the stop ahead on the process whose post hangs', postStop(url(), rig, maker, stopMessage(maker.address, [aheadHere.orderHash]), [aheadHere], from), 40_000);
    console.log(`# 9: a stop ahead, under the budgets, on the process whose post hangs: answered ${here.status} after ${Date.now() - started} ms`);
    assert.deepEqual({ status: here.status, code: here.body.code }, { status: 503, code: 'DATABASE_UNREADABLE' }, JSON.stringify(here.body));
    assert.equal((await stopRows([aheadHere.orderHash])).size, 0, "the 503 at the pool's wait has recorded no stop");
    assert.ok(await waitingOnALock(waiter.pid), "the second process's stop ahead waits still");

    // The proxy lets the post's read go: the hang ends. The courier asks the chain twice, ten seconds each: let go
    // later than that, the post would end as the chain unreachable and not as it would have ended.
    assert.ok(Date.now() - arrivedAt < 18_000, `this schedule ran too slowly to be read: ${Date.now() - arrivedAt} ms since the post's read arrived, and the courier gives the chain twenty seconds`);
    held.release();
    released = true;
    const answeredThere = await within('the stop ahead on the second process, the hang over', there, 45_000);
    console.log(`# 9: the same on a second process: answered ${answeredThere.status} after ${Date.now() - startedThere} ms, when the hang ended`);
    assert.deepEqual(outcomes(answeredThere), ['stopped ahead'], JSON.stringify(answeredThere.body));
    const posted = await within('the post that hung', hanging, 45_000);
    assert.equal(posted.body.code, 'TOO_MANY_QUOTES', `the post that hung ends as it would have: its account holds sixteen quotes there: ${JSON.stringify(posted.body)}`);
    // The stop refused at the pool's wait, sent again: taken.
    assert.deepEqual(outcomes(await postStop(url(), rig, maker, stopMessage(maker.address, [aheadHere.orderHash]), [aheadHere], from)), ['stopped ahead']);
  } finally {
    if (!released) held.release();
    await Promise.all(pending);
    await second.stop();
  }
});

test("9a. the two-process schedule a registered account can set up with its own orders: a post hangs on P; on Q the account's budgeted message of its own quote q and one unknown hash takes q's hash lock and waits for the courier's row; four free stops of q on P take the reads' pool's four connections and wait on q's lock. Another maker's free stop on P is then 503 at the pool's wait and has recorded no stop, and the same stop on Q is taken. The post let go, it finishes with its condition's bookkeeping dropped and said; Q's message has both budgets and commits q as stopped; the four waiters on P each answer already stopped and write nothing; the other maker's stop on P is already stopped", async () => {
  const from = at(91);
  const hanger = await sixteenStanding(from);
  const owner = await freshAccount();
  const other = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const q = await quote(owner, { expiry: far, oddsTick: 375, ...market }, from);
  const theirs = await quote(other, { expiry: far, oddsTick: 376, ...market }, from);
  const unknown = noOrders(0x9a01);
  const qKey = hashLockKey(q.hash);
  const second = await anotherCourier();
  const logged = stack.courier.lines.length;
  const last = await lastLine();
  const held = stack.proxy.hold('eth_call', quotesReadOf(hanger.hashes, (await head()).hash));
  let released = false;
  const pending: Array<Promise<unknown>> = [];
  try {
    const hanging = postOrder(url(), rig, hanger.who, 'rest', hanger.next(), from);
    pending.push(hanging.catch(() => undefined));
    await within("the post's read of its account's standing quotes, inside its transaction, arriving at the proxy", held.arrived, 15_000);
    const arrivedAt = Date.now();

    // On Q: the budgeted message. It takes q's hash lock, then waits for the courier's budget row, which P's post holds.
    const mixed = postStop(second.url, rig, owner, stopMessage(owner.address, [q.hash, unknown]), undefined, from);
    pending.push(mixed.catch(() => undefined));
    const holder = await until("Q's budgeted message holding q's hash lock", async () => (await courierHashLocks([])).find((l) => l.key === qKey && l.granted));
    await until("Q's budgeted message waiting on the courier's budget row", () => waitingOnALock(holder.pid));

    // On P: four free stops of q. Each takes a connection of the reads' pool and waits on q's lock.
    const four = [1, 2, 3, 4].map(() => postStop(url(), rig, owner, stopMessage(owner.address, [q.hash]), undefined, from));
    pending.push(...four.map((p) => p.catch(() => undefined)));
    await until("four free stops of q waiting on q's hash lock, on P", async () => (await courierHashLocks([])).filter((l) => l.key === qKey && !l.granted).length === 4);

    // Another maker's free stop of its own quote, on P: no connection of the reads' pool comes free within its wait.
    const started = Date.now();
    const starved = await within("the other maker's free stop on P", postStop(url(), rig, other, stopMessage(other.address, [theirs.hash]), undefined, from), 40_000);
    console.log(`# 9a: another maker's free stop on P, its reads' pool held by four stops waiting on a lock Q holds: answered ${starved.status} after ${Date.now() - started} ms`);
    assert.deepEqual({ status: starved.status, code: starved.body.code }, { status: 503, code: 'DATABASE_UNREADABLE' }, JSON.stringify(starved.body));
    assert.equal((await stopRows([theirs.hash])).size, 0, "the 503 at the pool's wait has recorded no stop: the quote is carried still");
    assert.deepEqual(await listed(market, 'A', from, second.url), [q.hash, theirs.hash], 'and listed still, with q, which no stop has yet recorded');
    // The same stop on Q: taken.
    const onQ = await within("the other maker's free stop on Q", postStop(second.url, rig, other, stopMessage(other.address, [theirs.hash]), undefined, from), 9_000);
    assert.deepEqual(outcomes(onQ), ['stopped'], JSON.stringify(onQ.body));

    // The proxy lets the post's read go, within the twenty seconds the courier gives the chain.
    assert.ok(Date.now() - arrivedAt < 18_000, `this schedule ran too slowly to be read: ${Date.now() - arrivedAt} ms since the post's read arrived, and the courier gives the chain twenty seconds`);
    held.release();
    released = true;
    // Q's budgeted message: both budgets were there for it, and it commits q as stopped. Asserted before the four replies.
    const committed = await within("Q's budgeted message, the courier's row free", mixed, 60_000);
    assert.deepEqual({ status: committed.status, results: outcomes(committed) }, { status: 200, results: ['stopped', 'UNKNOWN_ORDER'] }, JSON.stringify(committed.body));
    // q was stopped before its lock was let go, so each of the four waiters on P finds it stopped, and writes nothing.
    const replies = await Promise.all(four.map((p, i) => within(`free stop ${i + 1} of q on P`, p, 60_000)));
    for (const reply of replies) assert.deepEqual({ status: reply.status, results: outcomes(reply) }, { status: 200, results: ['already stopped'] }, JSON.stringify(reply.body));
    assert.equal((await stopRows([q.hash])).size, 1);
    const messages = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stop_messages m WHERE m.account = $1', [owner.address.toLowerCase()]);
    assert.equal(messages.rows[0]?.n, 1, "one message row for q's account: Q's, and none from the four");
    const lines = (await stopLinesSince(last)).filter((l) => l.account === owner.address.toLowerCase());
    assert.deepEqual(lines.map((l) => l.kind), ['stop received', 'stop refused'], "Q's message's two lines, and none from the four");
    assert.deepEqual((lines[1] as StopLine).facts.refused, [{ hash: unknown, code: 'UNKNOWN_ORDER' }]);
    // The other maker's stop on P, sent again: its stop was recorded on Q.
    assert.deepEqual(outcomes(await postStop(url(), rig, other, stopMessage(other.address, [theirs.hash]), undefined, from)), ['already stopped']);
    // P's post finished, its condition's bookkeeping dropped for want of a connection, and said so in its log.
    const posted = await within('the post that hung', hanging, 60_000);
    assert.equal(posted.body.code, 'TOO_MANY_QUOTES', JSON.stringify(posted.body));
    assert.ok(
      stack.courier.lines.slice(logged).some((line) => line.startsWith('condition: the chain-unreachable bookkeeping could not be read or written')),
      `P's post said its bookkeeping was dropped: ${stack.courier.lines.slice(logged).join(' | ')}`,
    );
  } finally {
    if (!released) held.release();
    await Promise.all(pending);
    await second.stop();
  }
});

// ──────────────────────────── 10: the rollback ────────────────────────────

/** While it stands, the database refuses every row written to the table: a check no row can pass, added with no scan of the rows that stand. */
async function refusingRows(table: 'stops' | 'orders'): Promise<() => Promise<void>> {
  await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_refused_by_the_test CHECK (false) NOT VALID`);
  return async () => {
    await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_refused_by_the_test`);
  };
}

test("10. the rollback: a stop's message row, its lines, its stops and its marks commit together or not at all. With the database refusing the stops, and then, the stops written, refusing the marks, the stop is answered DATABASE_UNREADABLE and nothing of it stands: no message, no stop, no mark, no line. The refusal lifted, the same message is stopped; sent again, already stopped, with the rows and the lines as they were", async () => {
  const from = at(10);
  const { who, market, q1, q2, message } = await threeCarried(from);
  for (const table of ['stops', 'orders'] as const) {
    const before_ = await everything();
    const last = await lastLine();
    const lift = await refusingRows(table);
    let answer: Answer;
    try {
      answer = await postStop(url(), rig, who, message, undefined, from);
    } finally {
      await lift();
    }
    assert.deepEqual({ status: answer.status, code: answer.body.code }, { status: 503, code: 'DATABASE_UNREADABLE' }, `${table} refused: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(await everything(), before_, `${table} refused: no message row, no stop, no mark, and no line of an order or a stop`);
    assert.equal(await lastLine(), last, `${table} refused: no line of any kind was committed`);
    assert.deepEqual(await listed(market, 'A', from), [q1.hash, q2.hash], `${table} refused: the quotes are carried still`);
  }
  // The refusal lifted: the same message is taken, whole.
  const before_ = await written();
  const taken_ = await postStop(url(), rig, who, message, undefined, from);
  assert.deepEqual(outcomes(taken_), ['stopped', 'stopped', 'stopped'], JSON.stringify(taken_.body));
  assert.deepEqual(await written(), { ...before_, stops: (before_.stops ?? 0) + 3, messages: (before_.messages ?? 0) + 1, ended: (before_.ended ?? 0) + 3, lines: (before_.lines ?? 0) + 1 });
  // Sent again: nothing is written a second time.
  const stood = await everything();
  const last = await lastLine();
  assert.deepEqual(outcomes(await postStop(url(), rig, who, message, undefined, from)), ['already stopped', 'already stopped', 'already stopped']);
  assert.deepEqual(await everything(), stood);
  assert.equal(await lastLine(), last);
});

// ──────────────────────────── 11: two processes and a restart ────────────────────────────

test("11. across two processes and a restart: a stop one process recorded is honoured by another at once, and by a process started afterwards: the stopped quote is listed by none, its post again is answered from its record as stopped, the hash stopped ahead is STOPPED at each door and its record says stopped ahead, and the stop sent again is already stopped", async () => {
  const from = at(11);
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const carried = await quote(who, { expiry: far, oddsTick: 380, ...market }, from);
  const ahead = await unposted(who, { expiry: far, oddsTick: 381, ...market });
  const message = stopMessage(who.address, [carried.hash, ahead.orderHash]);
  let second = await anotherCourier();
  try {
    assert.deepEqual(await listed(market, 'A', from, second.url), [carried.hash]);
    assert.deepEqual(outcomes(await postStop(url(), rig, who, message, [ahead], from)), ['stopped', 'stopped ahead']);
    const honoured = async (courier: string, where: string) => {
      assert.deepEqual(await listed(market, 'A', from, courier), [], `${where}: the stopped quote is not listed`);
      const reposted = await postOrder(courier, rig, who, 'rest', carried.order, from);
      assert.deepEqual({ status: reposted.status, ended: reposted.body.ended }, { status: 200, ended: 'stopped' }, `${where}: ${JSON.stringify(reposted.body)}`);
      const posted = await postOriginal(ahead, from, courier);
      assert.deepEqual({ status: posted.status, code: posted.body.code }, { status: 422, code: 'STOPPED' }, `${where}: ${JSON.stringify(posted.body)}`);
      assert.equal((await get(courier, `/v1/orders/${carried.hash}`, from)).body.ended, 'stopped', where);
      assert.equal((await get(courier, `/v1/orders/${ahead.orderHash}`, from)).body.state, 'stopped ahead', where);
      assert.deepEqual(outcomes(await postStop(courier, rig, who, message, [ahead], from)), ['already stopped', 'already stopped'], where);
    };
    await honoured(second.url, 'the second process, at once');
    await second.stop();
    second = await anotherCourier();
    await honoured(second.url, 'a process started afterwards');
    await honoured(url(), 'the process that recorded it');
  } finally {
    await second.stop();
  }
});

// ──────────────────────────── 12: the cost, from rows the route wrote ────────────────────────────

interface Stored {
  relation: string;
  rows: number;
  /** The relation whole: its rows, its indexes and what it keeps out of line. Moves a page of 8,192 bytes at a time. */
  totalBytes: number;
  indexBytes: number;
  /** The rows themselves, as the database sizes each row's data, added up. */
  rowBytes: number;
}

/** What the three relations a stop writes hold now: the stops, their messages and the lines. */
async function stored(): Promise<Record<'stops' | 'stop_messages' | 'events', Stored>> {
  const one = async (relation: 'stops' | 'stop_messages' | 'events'): Promise<Stored> => {
    const { rows } = await pool.query<{ rows: number; total: string; indexes: string; data: string }>(
      `SELECT (SELECT count(*) FROM ${relation})::int AS rows, pg_total_relation_size('${relation}'::regclass)::text AS total, pg_indexes_size('${relation}'::regclass)::text AS indexes,
              (SELECT coalesce(sum(pg_column_size(t.*)), 0) FROM ${relation} t)::text AS data`,
    );
    const r = rows[0] ?? assert.fail('no sizes');
    return { relation, rows: r.rows, totalBytes: Number(r.total), indexBytes: Number(r.indexes), rowBytes: Number(r.data) };
  };
  return { stops: await one('stops'), stop_messages: await one('stop_messages'), events: await one('events') };
}

/** What a step added to each relation. */
function added(before_: Record<string, Stored>, after_: Record<string, Stored>): Record<string, { rows: number; rowBytes: number; totalBytes: number; indexBytes: number }> {
  return Object.fromEntries(
    Object.keys(after_).map((k) => {
      const a = after_[k] as Stored;
      const b = before_[k] as Stored;
      return [k, { rows: a.rows - b.rows, rowBytes: a.rowBytes - b.rowBytes, totalBytes: a.totalBytes - b.totalBytes, indexBytes: a.indexBytes - b.indexBytes }];
    }),
  );
}

test("12. the cost: the two stop shapes written through the route by a real signer, and their rows read back. One message stopping a hundred carried quotes is a hundred stops, one message row and one line; one message stopping sixteen orders ahead is sixteen stops, each with its original, one message row and one line: the signed message is kept once a message, not once a hash. The rows and the bytes each step added are printed", async () => {
  const from = at(12);
  const who = await freshAccount();
  const far = (await rig.time()) + 100_000n;
  const markets = [freshMarket(), freshMarket(), freshMarket(), freshMarket()];
  const atStart = await stored();
  // The carried book: a hundred quotes, within sixteen a side of a market: four markets, two sides, twelve or thirteen each.
  const carried: Hex[] = [];
  for (let i = 0; i < 100; i++) {
    const posted = await quote(who, { expiry: far, oddsTick: 500 + i, positionType: (Math.floor(i / 4) % 2) as 0 | 1, ...(markets[i % 4] as { scorer: Address; lineTicks: number }) }, from);
    carried.push(posted.hash);
  }
  const booked = await stored();
  const hundred = await postStop(url(), rig, who, stopMessage(who.address, carried), undefined, from);
  assert.deepEqual(outcomes(hundred), times(100, 'stopped'), JSON.stringify(hundred.body).slice(0, 400));
  const afterHundred = await stored();
  const sixteen = await originals(who, 16, { expiry: far, oddsTick: 600, ...(markets[0] as { scorer: Address; lineTicks: number }) });
  assert.deepEqual(await stopAhead(who, who, sixteen, from), times(16, 'stopped ahead'));
  const afterSixteen = await stored();

  const setup = added(atStart, booked);
  const stopOfHundred = added(booked, afterHundred);
  const stopAheadOfSixteen = added(afterHundred, afterSixteen);
  console.log(`# 12: the order set-up, a hundred quotes posted (their own rows are the orders table's; here, their lines): ${JSON.stringify(setup)}`);
  console.log(`# 12: one stop of a hundred carried quotes, as the route wrote it: ${JSON.stringify(stopOfHundred)}`);
  console.log(`# 12: one stop ahead of sixteen originals, as the route wrote it: ${JSON.stringify(stopAheadOfSixteen)}`);
  console.log(`# 12: the three relations as they then stood, the whole file's rows in them: ${JSON.stringify(afterSixteen)}`);

  // The shape, exactly: the rows each message wrote.
  assert.deepEqual({ stops: setup.stops?.rows, messages: setup.stop_messages?.rows, lines: setup.events?.rows }, { stops: 0, messages: 0, lines: 100 }, 'the set-up wrote no stop: a line an order');
  assert.deepEqual({ stops: stopOfHundred.stops?.rows, messages: stopOfHundred.stop_messages?.rows, lines: stopOfHundred.events?.rows }, { stops: 100, messages: 1, lines: 1 });
  assert.deepEqual({ stops: stopAheadOfSixteen.stops?.rows, messages: stopAheadOfSixteen.stop_messages?.rows, lines: stopAheadOfSixteen.events?.rows }, { stops: 16, messages: 1, lines: 1 });
  // The message of a hundred hashes is in its one row, and in no stop's.
  const rows = await stopRows(carried);
  const ids = new Set([...rows.values()].map((s) => s.message_id));
  assert.equal(ids.size, 1);
  const kept = await messageRow([...ids][0] as string);
  assert.deepEqual(kept.message, { account: getAddress(who.address), orderHashes: carried });
  assert.ok((stopOfHundred.stop_messages?.rowBytes ?? 0) > 100 * 32, `the one message row holds the hundred hashes: ${stopOfHundred.stop_messages?.rowBytes} bytes`);
  assert.ok((stopOfHundred.stops?.rowBytes ?? 0) / 100 < 400, `a carried stop's row holds no message: ${(stopOfHundred.stops?.rowBytes ?? 0) / 100} bytes a row`);
  // Each of the sixteen holds its own original.
  const ahead = await stopRows(sixteen.map((o) => o.orderHash));
  assert.ok([...ahead.values()].every((s) => s.ahead && s.original !== null && s.grant_number === '0'));
});

// ──────────────────────────── 13: the lines ────────────────────────────

test("13. the lines: a message that stopped something leaves one line with its counts; one that also refused a hash leaves a second, with the hashes and their codes and the same message's number; one that only refused leaves one, with no message; one that did neither leaves none. Every line carries the message's account, and none carries a caller's address, a signature or an original", async () => {
  const from = at(13);
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const c1 = await quote(who, { expiry: far, oddsTick: 610, ...market }, from);
  const c2 = await quote(who, { expiry: far, oddsTick: 611, ...market }, from);
  const c3 = await quote(who, { expiry: far, oddsTick: 612, ...market }, from);
  const o1 = await unposted(who, { expiry: far, oddsTick: 613, ...market });
  const u1 = noOrders(0xd101);
  const u2 = noOrders(0xd102);
  const last = await lastLine();

  // Stopped something, refused nothing: one line.
  const free = await postStop(url(), rig, who, stopMessage(who.address, [c1.hash, c2.hash]), undefined, from);
  assert.deepEqual(outcomes(free), ['stopped', 'stopped']);
  // Stopped two, one of them ahead, and refused one: two lines.
  const mixed = await postStop(url(), rig, who, stopMessage(who.address, [c3.hash, u1, o1.orderHash]), [o1], from);
  assert.deepEqual(outcomes(mixed), ['stopped', 'UNKNOWN_ORDER', 'stopped ahead'], JSON.stringify(mixed.body));
  // Refused only: one line, with no message.
  const refusedOnly = await postStop(url(), rig, who, stopMessage(who.address, [u2]), undefined, from);
  assert.deepEqual(outcomes(refusedOnly), ['UNKNOWN_ORDER']);
  // Neither: every hash stopped already.
  const neither = await postStop(url(), rig, who, stopMessage(who.address, [c2.hash, c3.hash, o1.orderHash]), undefined, from);
  assert.deepEqual(outcomes(neither), ['already stopped', 'already stopped', 'already stopped']);

  const stops = await stopRows([c1.hash, c3.hash, o1.orderHash]);
  const freeId = Number((stops.get(c1.hash) as StopRow).message_id);
  const mixedId = Number((stops.get(c3.hash) as StopRow).message_id);
  assert.equal(Number((stops.get(o1.orderHash) as StopRow).message_id), mixedId, 'the carried stop and the stop ahead of one message point at its one row');
  const account = who.address.toLowerCase();
  const lines = await stopLinesSince(last);
  assert.deepEqual(
    lines.map((l) => ({ kind: l.kind, account: l.account, order_hash: l.order_hash, reason: l.reason, facts: l.facts })),
    [
      { kind: 'stop received', account, order_hash: null, reason: null, facts: { messageId: freeId, stopped: 2, ahead: 0 } },
      { kind: 'stop received', account, order_hash: null, reason: null, facts: { messageId: mixedId, stopped: 1, ahead: 1 } },
      { kind: 'stop refused', account, order_hash: null, reason: null, facts: { messageId: mixedId, refused: [{ hash: u1, code: 'UNKNOWN_ORDER' }] } },
      { kind: 'stop refused', account, order_hash: null, reason: null, facts: { messageId: null, refused: [{ hash: u2, code: 'UNKNOWN_ORDER' }] } },
    ],
  );
  // What no line holds: where the request came from, what signed it, and the order kept for the stop ahead.
  const text = JSON.stringify(lines).toLowerCase();
  assert.ok(!text.includes('198.51.100'), "no line carries the caller's address");
  for (const signature of [free.signature, mixed.signature, refusedOnly.signature, o1.signature]) assert.ok(!text.includes(signature.slice(2).toLowerCase()), 'no line carries a signature');
  for (const field of ['riskamount', 'oddstick', 'minfill', 'expiry', 'original', 'signature']) assert.ok(!text.includes(field), `no line carries an original: ${field}`);
});

test("13a. a signed stop is not used up by being answered, and its refusal is not remembered: one stop message naming one unknown hash, signed once by its registered account and presented twice with no original, is admitted twice, refused by its hash twice, takes one from each budget twice and leaves two lines, each with no message; no stop and no message row is written. Whoever holds the signed message can do the same while the account is registered and the budgets last. The controls: a stop of a carried quote takes no budget, and presented again writes nothing. Recorded as an exposure of the route as it is built, not as a guard", async () => {
  const from = at(131);
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const carried = await quote(who, { expiry: far, oddsTick: 620, ...market }, from);
  const unknown = noOrders(0xd301);
  const message = stopMessage(who.address, [unknown]);
  const body = stopBody(message, await signStop(who, message, 31337, rig.addresses.relay));
  const last = await lastLine();
  const before_ = await written();
  const chainTime = await rig.time();
  const readings = [await budgetsOf(who.address)];
  for (const presented of ['first', 'second']) {
    const answer = await sendStop(url(), body, from);
    assert.deepEqual({ status: answer.status, results: outcomes(answer) }, { status: 200, results: ['UNKNOWN_ORDER'] }, `${presented}: ${JSON.stringify(answer.body)}`);
    readings.push(await budgetsOf(who.address));
  }
  assert.equal(await rig.time(), chainTime, "the chain's time stood still: nothing refilled between the readings");
  const [start, afterFirst, afterSecond] = readings as [(typeof readings)[number], (typeof readings)[number], (typeof readings)[number]];
  assert.deepEqual(
    [
      { account: taken(start.account, afterFirst.account), courier: taken(start.courier, afterFirst.courier), refused: afterFirst.refused - start.refused },
      { account: taken(afterFirst.account, afterSecond.account), courier: taken(afterFirst.courier, afterSecond.courier), refused: afterSecond.refused - afterFirst.refused },
    ],
    [{ account: 1, courier: 1, refused: 0 }, { account: 1, courier: 1, refused: 0 }],
    "each presentation took one from the account's budget and one from the courier's",
  );
  assert.deepEqual(
    (await stopLinesSince(last)).map((l) => ({ kind: l.kind, account: l.account, facts: l.facts })),
    times(2, { kind: 'stop refused', account: who.address.toLowerCase(), facts: { messageId: null, refused: [{ hash: unknown, code: 'UNKNOWN_ORDER' }] } }),
    'each left its own refusal line, naming no message',
  );
  assert.deepEqual(await written(), { ...before_, lines: (before_.lines ?? 0) + 2 }, 'no stop and no message row: nothing on record says the message was seen before');

  // The controls. A stop of the account's own carried quote: free. The same stop again, every hash stopped: nothing at all.
  const budgets = await budgetRows();
  const own = stopMessage(who.address, [carried.hash]);
  assert.deepEqual(outcomes(await postStop(url(), rig, who, own, undefined, from)), ['stopped']);
  assert.deepEqual(await budgetRows(), budgets, 'the stop of a carried quote took no budget');
  const stood = await everything();
  assert.deepEqual(outcomes(await postStop(url(), rig, who, own, undefined, from)), ['already stopped']);
  assert.deepEqual(await everything(), stood, 'presented again, it wrote nothing and took nothing');
});

// ──────────────────────────── 14: the scan and the stop, both writers of an order's end ────────────────────────────

test("14. the scan and the stop, both writers of an order's end: a quote expired at the final block is being stopped in a transaction not yet committed when a page of its market is read; the page's scan goes to mark it expired and waits on its row; the stop commits; the page is answered, and the quote's record says stopped, the first end, not expired. It is listed by no page either way", async () => {
  const from = at(14);
  const who = await freshAccount();
  const market = freshMarket();
  const expiry = (await rig.time()) + 120n;
  const q = await quote(who, { expiry, oddsTick: 630, ...market }, from);
  // The chain's time at the quote's expiry, and that block named the final one: the final block's time plus one has passed the expiry.
  await chainTimeIs(expiry);
  const mine = await ownSession();
  let open = false;
  let reading: Promise<Awaited<ReturnType<typeof get>>> | null = null;
  try {
    stack.proxy.setFinal((await head()).number);
    // The stop's mark, as the stop writes it, in a transaction of the test's own: made, and not committed.
    await mine.client.query('BEGIN');
    open = true;
    const marked = await mine.client.query(`UPDATE orders SET ended = 'stopped', ended_at = now() WHERE hash = $1 AND ended IS NULL`, [q.hash]);
    assert.equal(marked.rowCount, 1);
    reading = get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=A`, from);
    // The page's scan was returned the quote, which still reads as unended to it, found it expired at the final block,
    // and went to mark it: its statement waits on the row the stop holds.
    await until("the scan's mark waiting on the row the stop holds", async () => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.pid <> $1 AND a.wait_event_type = 'Lock' AND a.query LIKE 'WITH scanned AS%'`,
        [mine.pid],
      );
      return rows[0]?.n === 1;
    });
    await mine.client.query('COMMIT');
    open = false;
    const page = await within('the page, the stop committed', reading, 20_000);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const blocks = { block: (page.body.block as { time: string }).time, final: (page.body.final as { time: string }).time };
    assert.deepEqual(blocks, { block: expiry.toString(), final: expiry.toString() }, "the page's two blocks: the final block's time plus one is past the expiry");
    const side = (page.body.sides as Record<string, { quotes: unknown[]; marked: number; scanned: number }>).A;
    assert.deepEqual({ quotes: side?.quotes, scanned: side?.scanned, marked: side?.marked }, { quotes: [], scanned: 1, marked: 0 }, 'the scan was returned the quote and marked nothing: it had ended first');
    const record = await get(url(), `/v1/orders/${q.hash}`, from);
    assert.deepEqual({ state: record.body.state, ended: record.body.ended }, { state: 'stopped', ended: 'stopped' }, 'the first end stands: stopped, not expired');
    assert.deepEqual(await listed(market, 'A', from), []);
  } finally {
    if (open) await mine.client.query('ROLLBACK').catch(() => undefined);
    mine.client.release();
    await reading?.catch(() => undefined);
    stack.proxy.setFinal(null);
  }
});

test("14a. the first end is kept the other way round too: a quote a page's scan has marked expired is then stopped by its account; the stop is taken and recorded, and the quote's record still says expired", async () => {
  const from = at(141);
  const who = await freshAccount();
  const market = freshMarket();
  const expiry = (await rig.time()) + 120n;
  const q = await quote(who, { expiry, oddsTick: 635, ...market }, from);
  await chainTimeIs(expiry);
  try {
    stack.proxy.setFinal((await head()).number);
    const page = await get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=A`, from);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const side = (page.body.sides as Record<string, { quotes: unknown[]; marked: number; scanned: number }>).A;
    assert.deepEqual({ quotes: side?.quotes, scanned: side?.scanned, marked: side?.marked }, { quotes: [], scanned: 1, marked: 1 }, "the page's scan marked the quote expired");
    assert.deepEqual([...(await endedOf([q.hash])).values()], ['expired']);
    const before_ = await written();
    assert.deepEqual(outcomes(await postStop(url(), rig, who, stopMessage(who.address, [q.hash]), undefined, from)), ['stopped'], 'the stop of an order that has ended is taken');
    const row = (await stopRows([q.hash])).get(q.hash) ?? assert.fail('no stop row');
    assert.equal(row.ahead, false);
    assert.deepEqual(await written(), { ...before_, stops: (before_.stops ?? 0) + 1, messages: (before_.messages ?? 0) + 1, lines: (before_.lines ?? 0) + 1 }, 'a stop, its message and its line; no order newly ended');
    assert.deepEqual([...(await endedOf([q.hash])).values()], ['expired'], 'the first end stands: expired, not stopped');
    assert.equal((await get(url(), `/v1/orders/${q.hash}`, from)).body.ended, 'expired');
  } finally {
    stack.proxy.setFinal(null);
  }
});

// ──────────────────────────── 15: the locks a message holds ────────────────────────────

/** These unposted orders by their hash locks' keys, ascending as numbers. */
const byLockKey = (list: OriginalSent[]): OriginalSent[] => [...list].sort((a, b) => (hashLockKey(a.orderHash) < hashLockKey(b.orderHash) ? -1 : 1));

test("15. the locks a message holds: a message naming its account's own carried quote, another maker's carried quote whose key is lower, an unknown hash with an original that is not its order and an unknown hash with none, their keys the two lowest there are, asks for one hash lock, its own quote's, and holds no other while it waits for it; let go, it answers stopped, NOT_YOUR_ORDER, ORIGINAL_NOT_THE_HASH and UNKNOWN_ORDER", async () => {
  const from = at(15);
  const who = await freshAccount();
  const other = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  // Ten orders signed for each maker, of which one each is posted: the account's own is the one whose lock key is the
  // highest, the other maker's the one whose key is the lowest, so that the other maker's sorts below the account's
  // own and would be locked before it by a message that locked it at all.
  const ownOrders = byLockKey(await originals(who, 10, { expiry: far, oddsTick: 640, ...market }));
  const own = ownOrders[ownOrders.length - 1] as OriginalSent;
  const foreign = byLockKey(await originals(other, 10, { expiry: far, oddsTick: 641, ...market }))[0] as OriginalSent;
  assert.equal((await postOriginal(own, from)).status, 201, "the account's own quote, posted");
  assert.equal((await postOriginal(foreign, from)).status, 201, "the other maker's quote, posted");
  // Two unknown hashes whose lock keys are the two lowest a key can be: one comes with an original that is some other order, one with none.
  const unknown: Hex = `0x8000000000000000${'00'.repeat(24)}`;
  const bare: Hex = `0x8000000000000001${'00'.repeat(24)}`;
  const junk: OriginalSent = { ...(await unposted(who, { expiry: far, oddsTick: 642, ...market })), orderHash: unknown };
  const keys = { own: hashLockKey(own.orderHash), foreign: hashLockKey(foreign.orderHash), unknown: hashLockKey(unknown), bare: hashLockKey(bare) };
  assert.equal(keys.unknown, -(2n ** 63n));
  assert.ok(keys.unknown < keys.bare && keys.bare < keys.foreign && keys.foreign < keys.own, `four keys, the account's own the highest: ${keys.unknown}, ${keys.bare}, ${keys.foreign}, ${keys.own}`);
  const mine = await ownSession();
  let holding = false;
  let stopping: Promise<Answer> | null = null;
  try {
    await mine.client.query('SELECT pg_advisory_lock($1::bigint)', [keys.own.toString()]);
    holding = true;
    stopping = postStop(url(), rig, who, stopMessage(who.address, [own.orderHash, foreign.orderHash, unknown, bare]), [junk], from);
    const locks = await until("the message waiting on its own quote's hash lock", async () => {
      const seen = await courierHashLocks([mine.pid]);
      return seen.some((l) => l.key === keys.own && !l.granted) ? seen : null;
    });
    assert.deepEqual(
      locks.map((l) => ({ key: l.key, granted: l.granted })),
      [{ key: keys.own, granted: false }],
      "the courier's session waits for its own quote's lock and holds no other: not the other maker's and not either unknown hash's, whose keys are all lower and would have been taken first",
    );
    await mine.client.query('SELECT pg_advisory_unlock($1::bigint)', [keys.own.toString()]);
    holding = false;
    const answer = await within('the message, its lock let go', stopping);
    assert.deepEqual(outcomes(answer), ['stopped', 'NOT_YOUR_ORDER', 'ORIGINAL_NOT_THE_HASH', 'UNKNOWN_ORDER'], JSON.stringify(answer.body));
    assert.deepEqual([...(await endedOf([own.orderHash, foreign.orderHash])).entries()].sort(), [[foreign.orderHash, null], [own.orderHash, 'stopped']].sort());
    assert.deepEqual(await listed(market, 'A', from), [foreign.orderHash], "the other maker's quote is listed still");
  } finally {
    if (holding) await mine.client.query('SELECT pg_advisory_unlock($1::bigint)', [keys.own.toString()]).catch(() => undefined);
    mine.client.release();
    await stopping?.catch(() => undefined);
  }
});

test("15a. the hash locks are taken ascending by their keys as numbers, whatever order the message names them in: of a message naming two of its account's quotes, the higher key first, with the test holding the higher key's lock, the courier holds the lower key's lock and waits for the higher. The two keys are negative numbers of one length, which as text sort the other way round", async () => {
  const from = at(151);
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  // Orders signed and not posted, until two are in hand whose lock keys are negative and as long as each other
  // written out: as numbers the one further from zero is the lower, and as text it sorts the higher.
  const negative = byLockKey(await originals(who, 32, { expiry: far, oddsTick: 645, ...market })).filter((o) => hashLockKey(o.orderHash) < 0n);
  const lo = negative.find((o, i) => i + 1 < negative.length && hashLockKey(o.orderHash).toString().length === hashLockKey((negative[i + 1] as OriginalSent).orderHash).toString().length) ?? assert.fail('no two negative keys of one length among thirty-two orders');
  const hi = negative[negative.indexOf(lo) + 1] as OriginalSent;
  const keys = { lo: hashLockKey(lo.orderHash), hi: hashLockKey(hi.orderHash) };
  assert.ok(keys.lo < keys.hi && keys.hi < 0n && keys.lo.toString() > keys.hi.toString(), `as numbers ${keys.lo} is below ${keys.hi}; as text it is above`);
  assert.equal((await postOriginal(lo, from)).status, 201);
  assert.equal((await postOriginal(hi, from)).status, 201);
  const mine = await ownSession();
  let holding = false;
  let stopping: Promise<Answer> | null = null;
  try {
    await mine.client.query('SELECT pg_advisory_lock($1::bigint)', [keys.hi.toString()]);
    holding = true;
    // The message names the higher key first.
    stopping = postStop(url(), rig, who, stopMessage(who.address, [hi.orderHash, lo.orderHash]), undefined, from);
    const locks = await until('the message waiting on a hash lock', async () => {
      const seen = await courierHashLocks([mine.pid]);
      return seen.some((l) => !l.granted) ? seen : null;
    });
    assert.deepEqual(
      locks.map((l) => ({ key: l.key, granted: l.granted })).sort((a, b) => (a.key < b.key ? -1 : 1)),
      [{ key: keys.lo, granted: true }, { key: keys.hi, granted: false }],
      "the courier took the lower key's lock first and waits for the higher: by the message's order, or by the keys as text, it would wait for the higher holding nothing",
    );
    await mine.client.query('SELECT pg_advisory_unlock($1::bigint)', [keys.hi.toString()]);
    holding = false;
    const answer = await within('the message, its lock let go', stopping);
    assert.deepEqual(outcomes(answer), ['stopped', 'stopped'], JSON.stringify(answer.body));
  } finally {
    if (holding) await mine.client.query('SELECT pg_advisory_unlock($1::bigint)', [keys.hi.toString()]).catch(() => undefined);
    mine.client.release();
    await stopping?.catch(() => undefined);
  }
});

// ──────────────────────────── 16: the stop route's own count of an address's minute ────────────────────────────

/** What a stop over its address's count is answered with, in the test's own copy of the plan's words. */
const STOP_MINUTE =
  "Too many stop requests from this address in the last minute: the count is this route's own, and nothing else you send counts against it. `retry-after` is when the next slot frees — the next slot's eligibility, not success within a minute, since continued stop traffic from this address can take the next slots too; the on-chain cancel (`cancelOrder`, `raiseFloor`, `cancelAll`) does not go through this courier.";

test("16. the stop route's own count of an address's minute: six hundred stop requests from one address, each refused for its body, spend that address's stops; the maker's stop of its own carried quote from that address is then 429 by the stop route's own sentence, with a retry-after and no budget named, and nothing is written; the same message from another address is taken. From a third address six hundred reads and one refused, the maker's stop is taken all the same; and the first address, its stops spent, is served the status. Neither count is the other's", async () => {
  const fixtures = at(160);
  const A = at(161);
  const B = at(162);
  const C = at(163);
  const who = await freshAccount();
  const market = freshMarket();
  const far = (await rig.time()) + 100_000n;
  const q1 = await quote(who, { expiry: far, oddsTick: 650, ...market }, fixtures);
  const q2 = await quote(who, { expiry: far, oddsTick: 651, ...market }, fixtures);
  const refusedBefore = (await refusedSoFar(fixtures)).RATE_LIMIT_EXCEEDED ?? 0;

  // From A: six hundred requests to the stop route whose body does not parse. Each is answered for its body, and each took one of A's stops.
  for (let i = 0; i < 600; i++) {
    const answer = await post(url(), '/v1/stops', '{"account":', A);
    assert.deepEqual({ status: answer.status, code: answer.body.code }, { status: 400, code: 'INVALID_PARAM' }, `request ${i + 1}`);
  }
  // The maker's stop of its own carried quote, from A: refused by the stop route's own count.
  const before_ = await everything();
  const message = stopMessage(who.address, [q1.hash]);
  const refused = await postStop(url(), rig, who, message, undefined, A);
  assert.deepEqual({ status: refused.status, code: refused.body.code, budgetNamed: 'budget' in refused.body }, { status: 429, code: 'RATE_LIMIT_EXCEEDED', budgetNamed: false }, JSON.stringify(refused.body));
  assert.equal(refused.body.error, STOP_MINUTE);
  const retry = Number(refused.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 60, `retry-after: ${refused.headers.get('retry-after')}`);
  assert.deepEqual(await everything(), before_, 'nothing written, no budget row touched');
  assert.deepEqual(await listed(market, 'A', fixtures), [q1.hash, q2.hash], 'the quote is carried still');
  // The same message, the same signature, from B: taken. The count is an address's.
  assert.deepEqual(outcomes(await sendStop(url(), stopBody(message, refused.signature), B)), ['stopped']);

  // From C: six hundred reads, and the next refused by the general count. C's stop is taken: its other traffic counts for nothing against its stop.
  for (let i = 0; i < 600; i++) assert.equal((await get(url(), '/v1/nothing-here', C)).status, 404, `read ${i + 1}`);
  const overRead = await get(url(), '/v1/nothing-here', C);
  assert.deepEqual({ status: overRead.status, code: overRead.body.code, error: overRead.body.error }, { status: 429, code: 'RATE_LIMIT_EXCEEDED', error: 'Too many requests from this address in the last minute.' });
  assert.deepEqual(outcomes(await postStop(url(), rig, who, stopMessage(who.address, [q2.hash]), undefined, C)), ['stopped'], "the maker's stop from an address whose reads are spent");

  // From A, its stops spent: every other route is served. The stop count counts for nothing against the other minute.
  const status = await get(url(), '/v1/status', A);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const stopsMinute = status.body.stopsMinute as { addresses: number; perMinute: number };
  const addressMinute = status.body.addressMinute as { addresses: number; perMinute: number };
  assert.deepEqual({ stops: stopsMinute.perMinute, all: addressMinute.perMinute }, { stops: 600, all: 600 });
  assert.ok(stopsMinute.addresses >= 3, `the addresses holding a stop request in the last minute: ${stopsMinute.addresses}`);
  assert.equal(((status.body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode.RATE_LIMIT_EXCEEDED ?? 0) - refusedBefore, 2, "the two refusals, A's stop and C's read, each counted");
  assert.ok(!JSON.stringify(status.body).includes('198.51.100.16'), 'no address is served');

  // Each count's own addresses, on a process started for this: one address has sent it a stop request and two others
  // anything else, and the status says one and two.
  const fresh = await anotherCourier();
  try {
    assert.equal((await post(fresh.url, '/v1/stops', '{"account":', at(164))).status, 400);
    assert.equal((await get(fresh.url, '/v1/nothing-here', at(165))).status, 404);
    const served = await get(fresh.url, '/v1/status', at(166));
    assert.deepEqual(
      { stops: (served.body.stopsMinute as { addresses: number }).addresses, all: (served.body.addressMinute as { addresses: number }).addresses },
      { stops: 1, all: 2 },
      'the stop count holds the one address that sent a stop, and the other count the two that sent anything else',
    );
  } finally {
    await fresh.stop();
  }
});

// ──────────────────────────── the body ────────────────────────────

test("the body of a stop: its shape and its size are judged before anything else, each fault INVALID_PARAM or BODY_TOO_LARGE for the whole message, counted, with nothing written: a body that is no object, a missing or an unknown key, an account that is no address, no hash, a hundred and one hashes, a hash twice in another case, a hash of the wrong length, a signature that is not 65 bytes, originals that are no list, seventeen originals, an original with an unknown key; a hundred hashes is a shape that passes", async () => {
  const from = at(17);
  const who = await freshAccount();
  const hash = noOrders(0xb001);
  const signature = `0x${'11'.repeat(65)}`;
  const good = { account: who.address, orderHashes: [hash], signature };
  const before_ = await everything();
  const countedBefore = (await refusedSoFar(from)).INVALID_PARAM ?? 0;
  const shapes: Array<[string, unknown]> = [
    ['a list', [good]],
    ['a string', 'stop'],
    ['no signature', { account: who.address, orderHashes: [hash] }],
    ['an unknown key', { ...good, nonce: 1 }],
    ['an account that is no address', { ...good, account: '0x1234' }],
    ['no hash', { ...good, orderHashes: [] }],
    ['a hundred and one hashes', { ...good, orderHashes: Array.from({ length: 101 }, (_, i) => noOrders(0xb100 + i)) }],
    ['a hash twice, once in upper case', { ...good, orderHashes: [hash, `0x${hash.slice(2).toUpperCase()}`] }],
    ['a hash of 31 bytes', { ...good, orderHashes: [hash.slice(0, 64)] }],
    ['hashes that are no list', { ...good, orderHashes: hash }],
    ['a signature of 64 bytes', { ...good, signature: signature.slice(0, 130) }],
    ['originals that are no list', { ...good, originals: {} }],
    ['seventeen originals', { ...good, originals: Array.from({ length: 17 }, () => ({})) }],
    ['an original with an unknown key', { ...good, originals: [{ orderHash: hash, order: {}, signature, role: 'rest' }] }],
    ['an original whose order is not the ten fields', { ...good, originals: [{ orderHash: hash, order: { account: who.address }, signature }] }],
  ];
  for (const [what, body] of shapes) {
    const answer = await sendStop(url(), body, from);
    assert.deepEqual({ status: answer.status, code: answer.body.code }, { status: 400, code: 'INVALID_PARAM' }, `${what}: ${JSON.stringify(answer.body)}`);
  }
  assert.equal(((await refusedSoFar(from)).INVALID_PARAM ?? 0) - countedBefore, shapes.length, 'each counted by its code');
  // The size: a body over 32,768 bytes is refused before it is read whole.
  const large = await sendStop(url(), JSON.stringify({ ...good, originals: [], padding: 'x'.repeat(33 * 1024) }), from);
  assert.deepEqual({ status: large.status, code: large.body.code }, { status: 413, code: 'BODY_TOO_LARGE' }, JSON.stringify(large.body));
  // The control: a hundred hashes passes the shape, and is judged by its signature, which no key made.
  const hundred = await sendStop(url(), { ...good, orderHashes: Array.from({ length: 100 }, (_, i) => noOrders(0xb200 + i)) }, from);
  assert.deepEqual({ status: hundred.status, code: hundred.body.code }, { status: 422, code: 'BAD_SIGNATURE' }, JSON.stringify(hundred.body));
  assert.deepEqual(await everything(), before_, 'nothing written by any of them');
});
