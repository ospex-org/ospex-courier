import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionResult, type Hex } from 'viem';
import { MULTICALL_ABI, MULTICALL_ADDRESS } from '../courier/chain/abi';
import type { JsonRpc } from '../courier/chain/rpc';
import { createChainReader } from '../courier/chain/snapshot';
import { createAddressLimiter, createCounters } from '../courier/http/limits';
import { createRequestHandler, type ServiceDeps } from '../courier/http/service';
import { createConditions, type Conditions } from '../courier/records/conditions';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import { orderOn, postOrder } from './support/orders';
import { startStack, type Stack } from './support/stack';

// The status address and the conditions it can see in this build: the chain
// unreachable, opened when the records process a read that failed and failed
// again on its one retry, cleared when they next process a usable read that
// succeeded while it is open, each a numbered line, outcomes applied in the
// order the records process them; the database stopped, answered 503 and
// nothing claimed; and the one caller's minute.

let stack: Stack;

before(async () => {
  stack = await startStack('status');
});

after(async () => {
  await stack?.close();
});

test('a chain read that fails twice opens chain-unreachable, with a line; the next read that succeeds clears it, with a line', async () => {
  const url = stack.courier.url;
  stack.proxy.rule('eth_getBlockByNumber', { kind: 'refuse', code: -32000, message: 'held for the test' });
  const before = stack.proxy.count('eth_getBlockByNumber');
  const refused = await get(url, `/v1/book?gameId=${stack.rig.gameId}`);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, 'CHAIN_UNREACHABLE');
  assert.equal(stack.proxy.count('eth_getBlockByNumber'), before + 2, 'tried once more, and no more');

  let status = await get(url, '/v1/status');
  let conditions = status.body.conditions as Array<{ key: string; openedLine: number; facts: Record<string, unknown> }>;
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0]?.key, 'chain-unreachable');
  assert.equal(conditions[0]?.facts.kind, 'refused');
  assert.equal(conditions[0]?.facts.code, -32000);
  assert.equal(conditions[0]?.facts.method, 'eth_getBlockByNumber');
  const openedLine = conditions[0]?.openedLine;
  assert.equal(status.body.newestReportLine, openedLine);

  // A second failing read opens nothing new.
  await get(url, `/v1/book?gameId=${stack.rig.gameId}`);
  status = await get(url, '/v1/status');
  assert.equal((status.body.conditions as unknown[]).length, 1);
  assert.equal(status.body.newestReportLine, openedLine);

  stack.proxy.clear();
  const served = await get(url, `/v1/book?gameId=${stack.rig.gameId}`);
  assert.equal(served.status, 200);
  status = await get(url, '/v1/status');
  conditions = status.body.conditions as typeof conditions;
  assert.deepEqual(conditions, []);
  assert.equal(status.body.newestReportLine, (openedLine ?? 0) + 1, 'the clearing is the next report line');

  const pool = openPool(stack.databaseUrl, null);
  try {
    const { rows } = await pool.query("SELECT kind, reason, facts FROM events WHERE kind IN ('condition opened', 'condition cleared') ORDER BY number");
    assert.deepEqual(rows.map((r) => [r.kind, r.reason]), [['condition opened', 'chain-unreachable'], ['condition cleared', 'chain-unreachable']]);
    const { rows: conditionRows } = await pool.query('SELECT key, opened_line, cleared_line FROM conditions ORDER BY id');
    assert.equal(conditionRows.length, 1);
    assert.equal(Number(conditionRows[0]?.cleared_line), (openedLine ?? 0) + 1);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(stack.proxy.url), 'no line carries the node\'s address');
  } finally {
    await pool.end();
  }
});

// ──────────────── the condition across processes: the next read the records process that succeeds clears it, whichever process makes it ────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conditionsOf = async (url: string) => (await get(url, '/v1/status')).body.conditions as Array<{ key: string; openedLine: number }>;
const runOf = async (url: string) => ((await get(url, '/v1/status')).body.run as { id: number }).id;
const bookRead = (url: string) => get(url, `/v1/book?gameId=${stack.rig.gameId}`);

/**
 * The lines of the condition's openings and clearings as the records hold them, in order, each with its number and
 * the run it is under; and, every time they are read, that the lines and the rows agree: every such line is a row's
 * opening or clearing line (the line and the row change together, or neither does), and no row is cleared before it
 * opened.
 */
async function conditionLines(): Promise<Array<{ number: number; kind: string; run: number }>> {
  const pool = openPool(stack.databaseUrl, null);
  try {
    // The order is the column's, a number, named with its table: a bare `ORDER BY number` would be the output column, text.
    const { rows } = await pool.query<{ number: string; kind: string; run: string }>("SELECT e.number::text AS number, e.kind, e.run::text AS run FROM events e WHERE e.kind IN ('condition opened', 'condition cleared') AND e.reason = 'chain-unreachable' ORDER BY e.number");
    const { rows: orphans } = await pool.query("SELECT e.number FROM events e LEFT JOIN conditions c ON c.opened_line = e.number OR c.cleared_line = e.number WHERE e.kind IN ('condition opened', 'condition cleared') AND c.id IS NULL");
    assert.deepEqual(orphans, [], "every opening and clearing line is a row's: the line and the row change together");
    const { rows: disordered } = await pool.query('SELECT id FROM conditions WHERE cleared_at < opened_at');
    assert.deepEqual(disordered, [], 'no row is cleared before it opened');
    return rows.map((r) => ({ number: Number(r.number), kind: r.kind, run: Number(r.run) }));
  } finally {
    await pool.end();
  }
}

/** Opens the condition on one process: the node refuses its headers, one read of the book on that process fails twice, the node answers again. */
async function openOn(url: string): Promise<void> {
  stack.proxy.rule('eth_getBlockByNumber', { kind: 'refuse', code: -32000, message: 'held for the test' });
  try {
    const refused = await bookRead(url);
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'CHAIN_UNREACHABLE');
  } finally {
    stack.proxy.rule('eth_getBlockByNumber', null);
  }
}

test('two processes: a condition one of them opens is cleared by the next read that succeeds, on the other; both then list no condition, and the opener\'s own next read writes nothing more', async () => {
  const a = stack.courier.url;
  const second = await startCourier(stack.env);
  try {
    const b = second.url;
    assert.deepEqual(await conditionsOf(b), [], 'the second process starts with no condition open');
    const before = await conditionLines();
    await openOn(a);
    const openedOnA = await conditionsOf(a);
    assert.equal(openedOnA.length, 1, JSON.stringify(openedOnA));
    assert.equal(openedOnA[0]?.key, 'chain-unreachable');
    assert.deepEqual(await conditionsOf(b), openedOnA, 'both processes list the one condition: the records are one');

    // The other process's next read that succeeds clears it.
    const served = await bookRead(b);
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.deepEqual(await conditionsOf(a), [], 'the process that opened it lists it no more');
    assert.deepEqual(await conditionsOf(b), [], 'the process that cleared it lists it no more');
    const lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared'], 'one opening, one clearing');
    assert.equal(lines[lines.length - 2]?.run, await runOf(a), 'the opening is the run of the process whose read failed');
    assert.equal(lines[lines.length - 1]?.run, await runOf(b), 'the clearing is the run of the process whose read succeeded, not the one that opened it');

    // The opener's own next read that succeeds finds it cleared: no second clearing line.
    assert.equal((await bookRead(a)).status, 200);
    assert.deepEqual(await conditionsOf(a), []);
    assert.equal((await conditionLines()).length, lines.length, 'nothing more was written');
  } finally {
    await second.stop();
  }
});

test('two processes read successfully at once while the condition stands open: one clearing line, not two, in each of five rounds', async () => {
  const a = stack.courier.url;
  const second = await startCourier(stack.env);
  try {
    const b = second.url;
    for (let round = 1; round <= 5; round++) {
      const before = await conditionLines();
      await openOn(round % 2 === 1 ? a : b);
      // Both reads held at their first request of the chain until both have arrived there, then released together,
      // so the two reach the records as near to at once as the test can make them.
      const held = stack.proxy.hold('eth_getBlockByNumber');
      const arrived = stack.proxy.count('eth_getBlockByNumber');
      const reads = Promise.all([bookRead(a), bookRead(b)]);
      for (let i = 0; i < 300 && stack.proxy.count('eth_getBlockByNumber') < arrived + 2; i++) await sleep(10);
      assert.equal(stack.proxy.count('eth_getBlockByNumber'), arrived + 2, `round ${round}: both processes are at the chain`);
      held.release();
      const [onA, onB] = await reads;
      assert.equal(onA.status, 200, JSON.stringify(onA.body));
      assert.equal(onB.status, 200, JSON.stringify(onB.body));
      assert.deepEqual(await conditionsOf(a), [], `round ${round}`);
      assert.deepEqual(await conditionsOf(b), [], `round ${round}`);
      const after = await conditionLines();
      assert.deepEqual(after.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared'], `round ${round}: one opening, one clearing, whichever process wrote it`);
    }
  } finally {
    await second.stop();
  }
});

test("a deploy's overlap: a process that started while the condition was closed clears the one an older process opened and then stopped on", async () => {
  const older = await startCourier(stack.env);
  const newer = await startCourier(stack.env);
  try {
    assert.deepEqual(await conditionsOf(newer.url), [], 'the newer process starts while the condition is closed');
    const before = await conditionLines();
    await openOn(older.url);
    assert.equal((await conditionsOf(newer.url)).length, 1, 'the newer process lists what the older opened');
    await older.stop();
    // The newer process's next read that succeeds clears it: no restart, and no process that knew it open is left.
    const served = await bookRead(newer.url);
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.deepEqual(await conditionsOf(newer.url), []);
    assert.deepEqual(await conditionsOf(stack.courier.url), [], 'a third process, which read nothing meanwhile, lists none either');
    const after = await conditionLines();
    assert.deepEqual(after.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared']);
    assert.equal(after[after.length - 1]?.run, await runOf(newer.url), 'the clearing is the newer process\'s');
  } finally {
    await newer.stop();
    await older.stop();
  }
});

// ──────────────── the condition's lifecycle: four cases, one writer, the records' own order ────────────────

const marketRead = (url: string) => get(url, `/v1/book?gameId=${stack.rig.gameId}&scorer=${stack.rig.addresses.moneyline}&lineTicks=0&side=A`);

/** A quote on the market, so the market's page asks the chain about it. */
async function quoteOnTheMarket(url: string): Promise<void> {
  const rig = stack.rig;
  const T = await rig.time();
  const posted = await postOrder(url, rig, rig.accounts.maker, 'rest', orderOn(rig, rig.accounts.maker, { expiry: T + 600n }));
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
}

/** The test starts with the node honest, the condition closed and the first process holding nothing from an earlier test. */
async function closedAtTheStart(): Promise<void> {
  stack.proxy.clear();
  stack.dbRelay.release();
  const served = await bookRead(stack.courier.url);
  assert.equal(served.status, 200, JSON.stringify(served.body));
  assert.deepEqual(await conditionsOf(stack.courier.url), [], 'the condition is closed at the start');
}

/**
 * The node's answer to the quotes' read with its envelope whole and its block probes true, and every return data
 * after them one byte that decodes as nothing: an answer the read cannot use.
 */
function withReturnDataGarbled(params: unknown[], result: unknown): unknown {
  const call = params[0] as { to?: string; data?: Hex } | undefined;
  if (typeof result !== 'string' || call?.to?.toLowerCase() !== MULTICALL_ADDRESS.toLowerCase() || call.data === undefined) return result;
  if (decodeFunctionData({ abi: MULTICALL_ABI, data: call.data }).functionName !== 'aggregate3') return result;
  const answers = [...(decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result as Hex }) as ReadonlyArray<{ success: boolean; returnData: Hex }>)];
  return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', result: answers.map((a, i) => (i < 3 ? a : { success: true, returnData: '0x01' as Hex })) });
}

test("an answer the read cannot use, twice, is the chain unreachable: with an opening made after this request's own good headers, the market page is 503 CHAIN_UNREACHABLE, the quotes' read was made twice, and the condition stands", async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  const second = await startCourier(stack.env);
  try {
    const b = second.url;
    await quoteOnTheMarket(a);
    const before = await conditionLines();
    // A's market read: its two headers read and good, then its quotes' read held at the proxy.
    const held = stack.proxy.hold('eth_call');
    const arrived = stack.proxy.count('eth_call');
    const reading = marketRead(a);
    await held.arrived;
    assert.equal(stack.proxy.count('eth_call'), arrived + 1, "A's quotes' read is at the chain, held; its headers were read before it");
    // B's read fails twice meanwhile and opens the condition: an opening after A's good headers.
    await openOn(b);
    assert.equal((await conditionsOf(b)).length, 1, "B opened it after A's headers");
    // A's quotes' read is answered now with bytes that do not decode, and so is its one retry.
    held.release({ kind: 'rewriteResult', result: withReturnDataGarbled });
    const answer = await reading;
    stack.proxy.rule('eth_call', null);
    assert.equal(answer.status, 503, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'CHAIN_UNREACHABLE');
    assert.equal(stack.proxy.count('eth_call'), arrived + 2, 'tried once more, and no more');
    assert.equal((await conditionsOf(a)).length, 1, 'the opening stands: an answer the read cannot use is not a read that succeeded');
    assert.deepEqual((await conditionLines()).slice(before.length).map((l) => l.kind), ['condition opened'], 'open and a failure: nothing written');
    // The node honest again: the next usable read clears it.
    const served = await marketRead(a);
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.deepEqual(await conditionsOf(a), []);
    assert.deepEqual(await conditionsOf(b), []);
    const lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared']);
    assert.equal(lines[lines.length - 1]?.run, await runOf(a), "the clearing is A's, the usable read's");
  } finally {
    stack.proxy.clear();
    await second.stop();
  }
});

test("an answer the read cannot use, once, then a usable retry: the page is served, the quotes' read was made twice, and nothing is opened or written", async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  await quoteOnTheMarket(a);
  const before = await conditionLines();
  const arrived = stack.proxy.count('eth_call');
  let answered = 0;
  stack.proxy.rule('eth_call', { kind: 'rewriteResult', result: (params, result) => (answered++ === 0 ? withReturnDataGarbled(params, result) : result) });
  let answer;
  try {
    answer = await marketRead(a);
  } finally {
    stack.proxy.rule('eth_call', null);
  }
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(stack.proxy.count('eth_call'), arrived + 2, 'the first answer was unusable, the one retry was good');
  assert.equal(answered, 2, 'the proxy garbled the first and passed the second');
  assert.deepEqual(await conditionsOf(a), [], 'a read that succeeded on its retry opens nothing');
  assert.deepEqual((await conditionLines()).slice(before.length), [], 'and writes nothing');
});

test('an allowed negative is a usable read: a quote for a game the set does not know is refused 422 UNKNOWN_GAME and opens nothing; with the condition open, the same refusal clears it', async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  const second = await startCourier(stack.env);
  try {
    const rig = stack.rig;
    const T = await rig.time();
    const before = await conditionLines();
    const refused = await postOrder(a, rig, rig.accounts.maker, 'rest', orderOn(rig, rig.accounts.maker, { expiry: T + 600n, gameId: 999_999_999n }));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'UNKNOWN_GAME');
    assert.deepEqual(await conditionsOf(a), [], "the set's refusal of the game is an answer the read can use: nothing opened");
    assert.deepEqual((await conditionLines()).slice(before.length), [], 'and nothing written');
    // The condition open, by another process: the same refused post is a usable read, and clears it.
    await openOn(second.url);
    assert.equal((await conditionsOf(a)).length, 1);
    const again = await postOrder(a, rig, rig.accounts.maker, 'rest', orderOn(rig, rig.accounts.maker, { expiry: T + 600n, gameId: 999_999_999n }));
    assert.equal(again.status, 422, JSON.stringify(again.body));
    assert.equal(again.body.code, 'UNKNOWN_GAME');
    assert.deepEqual(await conditionsOf(a), [], 'the read that carried the refusal was usable: it cleared the condition');
    const lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared']);
    assert.equal(lines[lines.length - 1]?.run, await runOf(a), "the clearing is A's, the refused post's read");
  } finally {
    await second.stop();
  }
});

test("B opens, A's later read that succeeds clears, and the node refuses again: B's failed read opens it again, whatever B remembers", async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  const second = await startCourier(stack.env);
  try {
    const b = second.url;
    const before = await conditionLines();
    await openOn(b);
    assert.equal((await conditionsOf(a)).length, 1, 'B opened it; A lists it');
    assert.equal((await bookRead(a)).status, 200);
    assert.deepEqual(await conditionsOf(b), [], "A's read cleared what B opened; B lists it no more");
    assert.deepEqual((await conditionLines()).slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared']);
    // The node refuses again, and B's read fails twice: a second outage, which B opens, though B never read the
    // clearing. What B remembers of the condition decides nothing; the records do.
    await openOn(b);
    assert.equal((await conditionsOf(b)).length, 1, "B's failed read opened the condition again: the records showed none open");
    assert.equal((await conditionsOf(a)).length, 1);
    const lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared', 'condition opened']);
    assert.equal(lines[lines.length - 1]?.run, await runOf(b), "the second opening is B's");
    assert.equal((await bookRead(a)).status, 200);
    assert.deepEqual(await conditionsOf(b), []);
    assert.deepEqual((await conditionLines()).slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared', 'condition opened', 'condition cleared']);
  } finally {
    await second.stop();
  }
});

test("a read begun before another process's opening and answered after it clears the opening: its success is processed while the condition is open", async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  const second = await startCourier(stack.env);
  try {
    const b = second.url;
    await quoteOnTheMarket(a);
    const before = await conditionLines();
    // A's market read: its headers read, then its quotes' read held at the proxy.
    const held = stack.proxy.hold('eth_call');
    const arrived = stack.proxy.count('eth_call');
    const reading = marketRead(a);
    await held.arrived;
    assert.equal(stack.proxy.count('eth_call'), arrived + 1, "A's read is at the chain, held");
    // B's read fails twice meanwhile and opens the condition.
    await openOn(b);
    assert.equal((await conditionsOf(b)).length, 1, "B opened it while A's read was held");
    // A's read is answered now and succeeds; the records process it while the condition is open. It clears.
    held.release();
    const served = await reading;
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.deepEqual(await conditionsOf(a), [], 'the held read, answered after the opening, cleared it');
    assert.deepEqual(await conditionsOf(b), []);
    const lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared']);
    assert.equal(lines[lines.length - 1]?.run, await runOf(a), "the clearing is A's, the held read's");
  } finally {
    stack.proxy.clear();
    await second.stop();
  }
});

/**
 * Another process's side of the records: the conditions on a pool of the test's own, under a run of its own, on the
 * address given (straight to the database, or through the relay the test can hold), so an outcome can be applied when
 * the test says and its statements held in transit.
 */
async function recordsAs(databaseUrl: string): Promise<{ conditions: Conditions; run: number; close(): Promise<void> }> {
  const pool = openPool(databaseUrl, null);
  const { rows } = await pool.query<{ id: string }>('INSERT INTO runs DEFAULT VALUES RETURNING id');
  return { conditions: createConditions(pool), run: Number(rows[0]?.id), close: () => pool.end() };
}

const SUCCESS = { block: '7', hash: '0x0000000000000000000000000000000000000000000000000000000000000007' };
const FAILURE = { kind: 'refused', code: -32000, method: 'eth_getBlockByNumber', first: { kind: 'refused', code: -32000, method: 'eth_getBlockByNumber' } };

test('the two reorderings the records allow, as the sentence states them: a success recorded late clears a failure observed after it, and a failure recorded late opens after a success observed after it', async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  const late = await recordsAs(stack.relayedUrl);
  const prompt = await recordsAs(stack.databaseUrl);
  try {
    const before = await conditionLines();
    // 1. The condition open. A read of `late`'s succeeds and its statement is held in transit; a read of `prompt`'s
    // fails twice after that and is recorded first: open and a failure, nothing. Then the success is recorded: it
    // clears, though the failure was observed after it.
    await openOn(a);
    stack.dbRelay.hold();
    const success = late.conditions.applySuccess('chain-unreachable', SUCCESS, late.run);
    await sleep(100);
    assert.deepEqual(await prompt.conditions.applyFailure('chain-unreachable', FAILURE, prompt.run), { opened: false }, 'open and a failure: nothing');
    stack.dbRelay.release();
    assert.deepEqual(await success, { cleared: true }, 'the success, processed after the failure, clears');
    assert.deepEqual(await conditionsOf(a), [], 'closed: the last decision the records made was a clearing');
    assert.deepEqual((await conditionLines()).slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared']);
    // 2. The condition closed. A read of `late`'s fails twice and its statement is held; a read of `prompt`'s succeeds
    // after that and is recorded first: closed and a success, nothing. Then the failure is recorded: it opens, though
    // the success was observed after it.
    stack.dbRelay.hold();
    const failure = late.conditions.applyFailure('chain-unreachable', FAILURE, late.run);
    await sleep(100);
    assert.deepEqual(await prompt.conditions.applySuccess('chain-unreachable', SUCCESS, prompt.run), { cleared: false }, 'closed and a success: nothing');
    stack.dbRelay.release();
    assert.deepEqual(await failure, { opened: true }, 'the failure, processed after the success, opens');
    assert.equal((await conditionsOf(a)).length, 1, 'listed: the last decision the records made was an opening');
    let lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared', 'condition opened']);
    assert.equal(lines[lines.length - 1]?.run, late.run);
    // The next read that succeeds clears it, as ever.
    assert.equal((await bookRead(a)).status, 200);
    assert.deepEqual(await conditionsOf(a), []);
    lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared', 'condition opened', 'condition cleared']);
  } finally {
    stack.dbRelay.release();
    await late.close();
    await prompt.close();
  }
});

/**
 * A pool whose clients can be stopped at one statement: once armed with a pattern, the first statement after the
 * one matching it waits until released, the client holding whatever it holds (its locks, its transaction). The way
 * to stand a writer still between its recheck and its write, or between its lookup and its transaction.
 */
function pausingPool(databaseUrl: string): { pool: pg.Pool; arm(after: RegExp): { reached: Promise<void>; release(): void }; end(): Promise<void> } {
  const real = openPool(databaseUrl, null);
  let plan: { after: RegExp; reached: () => void; held: Promise<void> } | null = null;
  let pauseNext = false;
  // Every statement of the writer's goes through here, the pool's own and its clients': the one after the match waits.
  async function through(run: (...a: unknown[]) => unknown, args: unknown[]): Promise<unknown> {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
    if (pauseNext && plan !== null) {
      pauseNext = false;
      const p = plan;
      plan = null;
      p.reached();
      await p.held;
    }
    if (plan !== null && plan.after.test(text)) pauseNext = true;
    return run(...args);
  }
  const pool = {
    async connect() {
      const client = await real.connect();
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      const stopped = Object.create(client) as pg.PoolClient;
      stopped.query = ((...args: unknown[]) => through(query, args)) as pg.PoolClient['query'];
      stopped.release = (...a: Parameters<pg.PoolClient['release']>) => client.release(...a);
      return stopped;
    },
    query: (...args: unknown[]) => through(real.query.bind(real) as (...a: unknown[]) => unknown, args),
  } as unknown as pg.Pool;
  return {
    pool,
    arm(after) {
      let reached = () => undefined as void;
      let release = () => undefined as void;
      const reachedPromise = new Promise<void>((r) => (reached = r));
      const held = new Promise<void>((r) => (release = r));
      plan = { after, reached, held };
      // A writer that is never stopped where the test expects is a red assertion within five seconds, not a hang.
      const reachedOrNot = Promise.race([
        reachedPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('the writer was not stopped at the statement the test expected')), 5_000).unref()),
      ]);
      return { reached: reachedOrNot, release: () => release() };
    },
    end: () => real.end(),
  };
}

test('one writer for every write: a writer stopped between its recheck and its write holds the lock, and the writer behind it finds the condition cleared; one stopped between its lookup and its transaction rechecks and writes nothing; one clearing for one opening, every line a row\'s', async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  const paused = pausingPool(stack.databaseUrl);
  const prompt = await recordsAs(stack.databaseUrl);
  const pool = openPool(stack.databaseUrl, null);
  try {
    const { rows } = await pool.query<{ id: string }>('INSERT INTO runs DEFAULT VALUES RETURNING id');
    const run = Number(rows[0]?.id);
    const stopped = createConditions(paused.pool);
    const before = await conditionLines();
    // 1. Stopped after its recheck (the row locked, under the key's lock), before its write. The other writer's
    // clearing must wait behind it, then find the row cleared and write nothing.
    await openOn(a);
    let stop = paused.arm(/SELECT id FROM conditions WHERE key = \$1 AND cleared_at IS NULL/);
    const first = stopped.applySuccess('chain-unreachable', SUCCESS, run);
    await stop.reached;
    const other = prompt.conditions.applySuccess('chain-unreachable', SUCCESS, prompt.run);
    await sleep(150);
    stop.release();
    assert.deepEqual(await first, { cleared: true }, 'the stopped writer, resumed, clears: its recheck held');
    assert.deepEqual(await other, { cleared: false }, 'the writer behind it finds the condition cleared and writes nothing');
    assert.deepEqual(await conditionsOf(a), []);
    let lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared'], 'one clearing for one opening');
    assert.equal(lines[lines.length - 1]?.run, run, 'the clearing is the stopped writer\'s');
    // 2. Stopped between its lookup (the condition open) and its transaction. The other writer clears meanwhile; the
    // stopped one, resumed, takes the lock, rechecks, finds nothing open and writes nothing.
    await openOn(a);
    stop = paused.arm(/SELECT 1 FROM conditions WHERE key = \$1 AND cleared_at IS NULL/);
    const second = stopped.applySuccess('chain-unreachable', SUCCESS, run);
    await stop.reached;
    assert.deepEqual(await prompt.conditions.applySuccess('chain-unreachable', SUCCESS, prompt.run), { cleared: true }, 'the other writer clears while the first stands between its lookup and its transaction');
    stop.release();
    assert.deepEqual(await second, { cleared: false }, 'the stopped writer rechecks on fresh state and writes nothing: its lookup authorized no write');
    assert.deepEqual(await conditionsOf(a), []);
    lines = await conditionLines();
    assert.deepEqual(lines.slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared', 'condition opened', 'condition cleared'], 'one clearing for each opening');
    assert.equal(lines[lines.length - 1]?.run, prompt.run, 'the second clearing is the other writer\'s');
  } finally {
    await paused.end();
    await prompt.close();
    await pool.end();
  }
});

test("a fault of the courier's own inside a read is no failure of the node's: thrown at once, not tried again, recorded as nothing; the node's failures are tried once more and recorded", async () => {
  const header = { number: '0x10', hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'2'.repeat(64)}`, timestamp: '0x5f' };
  const applied: string[] = [];
  const conditions = {
    applyFailure: async () => {
      applied.push('failure');
      return { opened: true };
    },
    applySuccess: async () => {
      applied.push('success');
      return { cleared: false };
    },
    open_: async () => [],
  } as unknown as Conditions;
  // A node that answers the header, and the multicall's three block probes true to it; a read whose decoding of
  // what came back is the courier's own fault, thrown as a plain error.
  const probes = encodeFunctionResult({
    abi: MULTICALL_ABI,
    functionName: 'aggregate3',
    result: [
      { success: true, returnData: encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getBlockNumber', result: 16n }) },
      { success: true, returnData: encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getCurrentBlockTimestamp', result: 95n }) },
      { success: true, returnData: encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getLastBlockHash', result: header.parentHash as Hex }) },
    ],
  });
  let requests = 0;
  const rpc = { request: async (method: string) => { requests++; return method === 'eth_call' ? probes : header; } } as unknown as JsonRpc;
  const reader = createChainReader({ rpc, conditions, run: 1 });
  const ours = new TypeError('planted by the test: a fault of the courier\'s own');
  await assert.rejects(reader.read({ number: 16n, hash: header.hash as Hex, parentHash: header.parentHash as Hex, timestamp: 95n }, [], () => { throw ours; }), (err: unknown) => err === ours);
  assert.equal(requests, 1, 'not tried again');
  assert.deepEqual(applied, [], 'recorded as nothing: no opening, no success');
  // The node's own failure of the read (its answer unusable) is tried once more and recorded.
  const refusing = { request: async () => { requests++; return null; } } as unknown as JsonRpc;
  const other = createChainReader({ rpc: refusing, conditions, run: 1 });
  requests = 0;
  await assert.rejects(other.latestHeader(), { name: 'ChainUnreachable' });
  assert.equal(requests, 2, 'tried once more, and no more');
  assert.deepEqual(applied, ['failure'], 'recorded as the condition\'s opening');
});

test('three processes whose reads fail twice at once write one opening; three whose reads succeed at once, the condition open, write one clearing', async () => {
  await closedAtTheStart();
  const a = stack.courier.url;
  const second = await startCourier(stack.env);
  const third = await startCourier(stack.env);
  try {
    const urls = [a, second.url, third.url];
    const before = await conditionLines();
    // The node refuses, and the relay holds every statement of the three processes: their openings reach the records
    // together when it lets go.
    stack.proxy.rule('eth_getBlockByNumber', { kind: 'refuse', code: -32000, message: 'held for the test' });
    stack.dbRelay.hold();
    let failing: Promise<Array<Awaited<ReturnType<typeof bookRead>>>>;
    try {
      failing = Promise.all(urls.map((u) => bookRead(u)));
      await sleep(300);
    } finally {
      stack.dbRelay.release();
    }
    for (const r of await failing) assert.equal(r.status, 503, JSON.stringify(r.body));
    stack.proxy.rule('eth_getBlockByNumber', null);
    for (const u of urls) assert.equal((await conditionsOf(u)).length, 1, 'every process lists the one condition');
    assert.deepEqual((await conditionLines()).slice(before.length).map((l) => l.kind), ['condition opened'], 'three failures at once: one opening');
    // The node answers again, and the relay holds again: the three successes reach the records together.
    stack.dbRelay.hold();
    let serving: Promise<Array<Awaited<ReturnType<typeof bookRead>>>>;
    try {
      serving = Promise.all(urls.map((u) => bookRead(u)));
      await sleep(300);
    } finally {
      stack.dbRelay.release();
    }
    for (const r of await serving) assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const u of urls) assert.deepEqual(await conditionsOf(u), []);
    assert.deepEqual((await conditionLines()).slice(before.length).map((l) => l.kind), ['condition opened', 'condition cleared'], 'three successes at once: one clearing');
  } finally {
    stack.dbRelay.release();
    stack.proxy.clear();
    await second.stop();
    await third.stop();
  }
});

test('with the database stopped, the status answers 503 and claims nothing; /readyz 503; /healthz still answers; then it recovers', async () => {
  const url = stack.courier.url;
  stack.dbRelay.cut();
  try {
    const status = await get(url, '/v1/status');
    assert.equal(status.status, 503);
    assert.equal(status.body.code, 'DATABASE_UNREADABLE');
    assert.deepEqual(Object.keys(status.body).sort(), ['code', 'error'], 'nothing of what it last knew is served');
    assert.equal((await get(url, '/readyz')).status, 503);
    assert.equal((await get(url, '/v1/runs')).status, 503);
    assert.deepEqual((await get(url, '/healthz')).body, { ok: true });
    // The book and the door say the same, and neither claims a record: nothing was written.
    const book = await get(url, `/v1/book?gameId=${stack.rig.gameId}`);
    assert.equal(book.status, 503, JSON.stringify(book.body));
    assert.equal(book.body.code, 'DATABASE_UNREADABLE');
    const market = await get(url, `/v1/book?gameId=${stack.rig.gameId}&scorer=${stack.rig.addresses.moneyline}&lineTicks=0`);
    assert.equal(market.body.code, 'DATABASE_UNREADABLE');
    const T = await stack.rig.time();
    const posted = await postOrder(url, stack.rig, stack.rig.accounts.maker, 'rest', orderOn(stack.rig, stack.rig.accounts.maker, { expiry: T + 600n }));
    assert.equal(posted.status, 503, JSON.stringify(posted.body));
    assert.equal(posted.body.code, 'DATABASE_UNREADABLE');
    assert.match(String(posted.body.error), /nothing was recorded/);
  } finally {
    stack.dbRelay.restore();
  }
  let recovered = await get(url, '/v1/status');
  for (let i = 0; i < 20 && recovered.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    recovered = await get(url, '/v1/status');
  }
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.ok(typeof (recovered.body.run as { id: number }).id === 'number');
});

/** One request over a raw socket, as the bytes given; the whole answer, once the server closes the connection. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let answer = '';
    socket.on('data', (c: Buffer) => {
      answer += c.toString('utf8');
    });
    socket.on('connect', () => socket.write(request));
    socket.on('close', () => resolve(answer));
    socket.on('error', () => resolve(answer));
    setTimeout(() => socket.destroy(), 5_000).unref();
  });
}

test("a request whose target does not parse is refused by the courier, and no log line carries the target: a failure is logged under the route matched, or one fixed word, never the caller's text", async () => {
  const address = '203.0.113.77';
  const marker = 'PRIVATE_SENTINEL_f3a9';
  const before = ((await get(stack.courier.url, '/v1/status')).body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode.INVALID_PARAM ?? 0;
  for (const target of [`http://[${address}/${marker}`, `//[${address}/${marker}`]) {
    const answer = await raw(stack.courier.port, `GET ${target} HTTP/1.1\r\nHost: courier\r\nConnection: close\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 400 /, `the courier's own answer to ${target}: ${JSON.stringify(answer.slice(0, 120))}`);
    assert.match(answer, /"code":"INVALID_PARAM"/);
  }
  // A refusal the courier does log, sent after the two: once its line is captured, every line of theirs has been too.
  assert.equal((await get(stack.courier.url, '/v1/orders/abc')).body.code, 'INVALID_PARAM');
  for (let i = 0; i < 50 && !stack.courier.lines.some((l) => l.includes('GET /v1/orders/{hash} INVALID_PARAM')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(stack.courier.lines.some((l) => l.includes('GET /v1/orders/{hash} INVALID_PARAM')), 'the later refusal was logged');
  const leaked = stack.courier.lines.filter((l) => l.includes(address) || l.includes(marker));
  assert.deepEqual(leaked, [], 'no log line carries the address or the marker');
  const after_ = ((await get(stack.courier.url, '/v1/status')).body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode.INVALID_PARAM ?? 0;
  assert.equal(after_, before + 3, 'the two targets and the hash: each counted, none kept');
});

test("a request that enters the catch-all is answered 500 INTERNAL_ERROR and logged under the route it matched and nothing else: its target's text, in the path and in the query, is in no line; the witness is the handler, since no request from outside reaches the catch-all once an answer the read cannot use is a failure of the read", async () => {
  const marker = 'PRIVATE_SENTINEL_c4e1';
  const lines: string[] = [];
  // The handler as the courier builds it, over a chain reader that fails inside the courier with a fault of the
  // courier's own, which no route classifies (not the chain unreachable, not the database), so it falls to the catch-all.
  const limiter = createAddressLimiter(600);
  const deps = {
    store: {},
    chain: { latestHeader: async () => { throw new Error('planted by the test: a fault of the courier\'s own'); } },
    set: {},
    node: {},
    run: { id: 1 },
    counters: createCounters(() => new Date()),
    limiter,
    settings: { lowPol: 0 },
    published: [],
    notYetBuilt: [],
    log: (line: string) => lines.push(line),
  } as unknown as ServiceDeps;
  const server = createServer(createRequestHandler(deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    // The marker twice in the target: in a path segment the URL's own rules remove (`/v1/<marker>/../book` is
    // `/v1/book`), so the route is matched, and in the query. The raw socket sends it as written.
    const target = `/v1/${marker}/../book?gameId=1&${marker}=1`;
    const answer = await raw(port, `GET ${target} HTTP/1.1\r\nHost: courier\r\nConnection: close\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 500 /, `the catch-all's own answer: ${JSON.stringify(answer.slice(0, 160))}`);
    assert.match(answer, /"code":"INTERNAL_ERROR"/);
    assert.ok(!answer.includes(marker), 'the answer carries nothing of the target');
    for (let i = 0; i < 50 && lines.filter((l) => l.startsWith('request ')).length === 0; i++) await sleep(20);
    const logged = lines.filter((l) => l.startsWith('request '));
    assert.deepEqual(logged, ['request GET /v1/book failed: Error'], 'logged once, under the route matched, with the failure\'s class and nothing of the request');
    assert.deepEqual(lines.filter((l) => l.includes(marker) || l.includes('/..')), [], 'no line carries the marker, or any of the target');
  } finally {
    limiter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('one network address has 600 requests a minute; the 601st is refused with a retry-after, counted, and another address is not touched', async () => {
  const url = stack.courier.url;
  const from = { 'x-forwarded-for': '203.0.113.9' };
  for (let i = 0; i < 600; i++) {
    const r = await get(url, '/v1/nothing-here', from);
    assert.equal(r.status, 404, `request ${i + 1}`);
  }
  const refused = await get(url, '/v1/nothing-here', from);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'RATE_LIMIT_EXCEEDED');
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  const other = await get(url, '/v1/status', { 'x-forwarded-for': '203.0.113.10' });
  assert.equal(other.status, 200);
  const byCode = (other.body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode;
  assert.equal(byCode.NOT_FOUND, 600);
  assert.equal(byCode.RATE_LIMIT_EXCEEDED, 1);
  // What is kept of addresses is a count on the status address, never an address: the two forwarded here and the
  // test's own socket, each one entry however many requests it made.
  const minute = other.body.addressMinute as { addresses: number; perMinute: number };
  assert.equal(minute.perMinute, 600);
  assert.ok(minute.addresses >= 2 && minute.addresses <= 3, `addresses in the last minute: ${minute.addresses}`);
  assert.ok(!JSON.stringify(other.body).includes('203.0.113.9'), 'no address is served');
});
