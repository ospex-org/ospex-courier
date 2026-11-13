import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionResult, type Hex } from 'viem';
import { MULTICALL_ABI, MULTICALL_ADDRESS } from '../courier/chain/abi';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import { orderOn, postOrder } from './support/orders';
import { startStack, type Stack } from './support/stack';

// The status address and the conditions it can see in this build: the chain
// unreachable, opened after a read fails twice and cleared by the next that
// succeeds, whichever process makes it, each a numbered line; the database
// stopped, answered 503 and nothing claimed; and the one caller's minute.

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

// ──────────────── the condition across processes: the next read that succeeds clears it, whichever process makes it ────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conditionsOf = async (url: string) => (await get(url, '/v1/status')).body.conditions as Array<{ key: string; openedLine: number }>;
const runOf = async (url: string) => ((await get(url, '/v1/status')).body.run as { id: number }).id;
const bookRead = (url: string) => get(url, `/v1/book?gameId=${stack.rig.gameId}`);

/** The lines of the condition's openings and clearings as the records hold them, in order, each with the run that wrote it. */
async function conditionLines(): Promise<Array<{ kind: string; run: number }>> {
  const pool = openPool(stack.databaseUrl, null);
  try {
    const { rows } = await pool.query<{ kind: string; run: string }>("SELECT kind, run::text AS run FROM events WHERE kind IN ('condition opened', 'condition cleared') AND reason = 'chain-unreachable' ORDER BY number");
    return rows.map((r) => ({ kind: r.kind, run: Number(r.run) }));
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
      // so the two settle as near to at once as the test can make them.
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

/** One request over a raw socket, as the bytes given; the whole answer, once the courier closes the connection. */
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

/**
 * The node's answer to the quotes' read with its envelope whole and its block probes true, and every return data
 * after them one byte that decodes as nothing: a read that succeeds, whose decoding then fails inside the route.
 */
function withReturnDataGarbled(params: unknown[], result: unknown): unknown {
  const call = params[0] as { to?: string; data?: Hex } | undefined;
  if (typeof result !== 'string' || call?.to?.toLowerCase() !== MULTICALL_ADDRESS.toLowerCase() || call.data === undefined) return result;
  if (decodeFunctionData({ abi: MULTICALL_ABI, data: call.data }).functionName !== 'aggregate3') return result;
  const answers = [...(decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result as Hex }) as ReadonlyArray<{ success: boolean; returnData: Hex }>)];
  return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', result: answers.map((a, i) => (i < 3 ? a : { success: true, returnData: '0x01' as Hex })) });
}

test("a request that enters the catch-all is logged under the route it matched and nothing else: its target's text, in the path and in the query, is in no line of the courier's", async () => {
  const url = stack.courier.url;
  const rig = stack.rig;
  const marker = 'PRIVATE_SENTINEL_c4e1';
  // No request from outside enters the catch-all on its own at this head: every refusal and every failure the routes
  // classify is answered before it. One does with the node's help: a market page whose quotes' state the node answers
  // with bytes that do not decode. So a quote stands on the market, and the node is made to answer that way.
  const T = await rig.time();
  const posted = await postOrder(url, rig, rig.accounts.maker, 'rest', orderOn(rig, rig.accounts.maker, { expiry: T + 600n }));
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  // The target carries the marker twice: in a path segment the URL's own rules remove (`/v1/<marker>/../book` is
  // `/v1/book`), so the route is matched, and in the query. The raw socket sends it as written; a client library would
  // tidy the path first.
  const market = `gameId=${rig.gameId}&scorer=${rig.addresses.moneyline}&lineTicks=0&side=A`;
  const target = `/v1/${marker}/../book?${market}&${marker}=1`;
  const failedBefore = stack.courier.lines.filter((l) => l.startsWith('request GET /v1/book failed')).length;
  stack.proxy.rule('eth_call', { kind: 'rewriteResult', result: withReturnDataGarbled });
  let answer: string;
  try {
    answer = await raw(stack.courier.port, `GET ${target} HTTP/1.1\r\nHost: courier\r\nConnection: close\r\n\r\n`);
  } finally {
    stack.proxy.rule('eth_call', null);
  }
  assert.match(answer, /^HTTP\/1\.1 500 /, `the catch-all's own answer: ${JSON.stringify(answer.slice(0, 160))}`);
  assert.match(answer, /"code":"INTERNAL_ERROR"/);
  assert.ok(!answer.includes(marker), 'the answer carries nothing of the target either');
  for (let i = 0; i < 50 && stack.courier.lines.filter((l) => l.startsWith('request GET /v1/book failed')).length === failedBefore; i++) await new Promise((r) => setTimeout(r, 20));
  const logged = stack.courier.lines.filter((l) => l.startsWith('request GET /v1/book failed'));
  assert.equal(logged.length, failedBefore + 1, `the failure was logged once, under the route matched: ${JSON.stringify(stack.courier.lines.slice(-5))}`);
  assert.match(logged[logged.length - 1] as string, /^request GET \/v1\/book failed: [A-Za-z]+$/, 'the line: the route, the failure\'s class, and nothing of the request');
  assert.deepEqual(stack.courier.lines.filter((l) => l.includes(marker) || l.includes('/..')), [], 'no log line carries the marker, or any of the target');
  // The same request with the node answering honestly is the page, with the quote on it: the failure was the node's
  // answer and nothing of the request's.
  const honest = await raw(stack.courier.port, `GET ${target} HTTP/1.1\r\nHost: courier\r\nConnection: close\r\n\r\n`);
  assert.match(honest, /^HTTP\/1\.1 200 /, JSON.stringify(honest.slice(0, 160)));
  assert.ok(honest.includes(`"orderHash":"${String(posted.body.orderHash)}"`), 'the quote is listed');
  assert.equal(stack.courier.lines.filter((l) => l.startsWith('request GET /v1/book failed')).length, failedBefore + 1, 'the honest answer logged no failure');
  const status = await get(url, '/v1/status');
  assert.deepEqual(status.body.conditions, [], 'a read that succeeded and did not decode is the courier\'s failure, not the chain unreachable');
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
