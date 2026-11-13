import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openPool } from '../courier/records/store';
import { get } from './support/courier';
import { orderOn, postOrder } from './support/orders';
import { startStack, type Stack } from './support/stack';

// The status address and the conditions it can see in this build: the chain
// unreachable, opened after a read fails twice and cleared by the next that
// succeeds, each a numbered line; the database stopped, answered 503 and
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
