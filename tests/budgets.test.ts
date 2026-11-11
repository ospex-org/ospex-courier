import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { HDAccount } from 'viem/accounts';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import { orderOn, postOrder, type Answer } from './support/orders';
import type { Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';

// Admission: before it nothing is kept; the two budgets, rows in the
// database, one count for every process and across a restart; the bucket's
// two numbers told apart, on the chain's clock.

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;

before(async () => {
  stack = await startStack('budgets');
  rig = stack.rig;
  pool = openPool(stack.databaseUrl, null);
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

const url = () => stack.courier.url;

/** Spreads requests over network addresses, since one address has 600 a minute, and runs them `width` at a time. */
async function many(n: number, width: number, one: (i: number, headers: Record<string, string>) => Promise<Answer>): Promise<Answer[]> {
  const out: Answer[] = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        out[i] = await one(i, { 'x-forwarded-for': `198.51.100.${(i % 8) + 1}` });
      }
    }),
  );
  return out;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await pool.query(sql, params)).rows[0].n);
}

test('a key that has not registered the relay posts a thousand orders: not one row, not one line, each refused NOT_REGISTERED before admission', async () => {
  const stranger = rig.accounts.stranger;
  const T = await rig.time();
  const answers = await many(1_000, 16, (i, headers) => postOrder(url(), rig, stranger, i % 2 === 0 ? 'rest' : 'take', orderOn(rig, stranger, { expiry: T + 20n, riskAmount: 10_000n }), headers));
  assert.equal(answers.filter((a) => a.body.code === 'NOT_REGISTERED').length, 1_000, JSON.stringify(answers.find((a) => a.body.code !== 'NOT_REGISTERED')?.body));
  const account = stranger.address.toLowerCase();
  assert.equal(await count('SELECT count(*)::int AS n FROM orders WHERE account = $1', [account]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM events WHERE account = $1', [account]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE account = $1', [account]), 0);
  const counts = ((await get(url(), '/v1/status')).body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode;
  assert.equal(counts.NOT_REGISTERED, 1_000);
});

test("a registered account's requests, each different and each failing a later check: one line each up to its budget of 240, then 429 naming the account's budget and no line, and its count of refusals rises", async () => {
  const maker = rig.accounts.maker;
  const T = await rig.time();
  const linesBefore = await count(`SELECT count(*)::int AS n FROM events WHERE kind = 'order refused'`);
  // Each fails the expiry check, after admission: a line each.
  const answers = await many(240, 8, (i, headers) => postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T - BigInt(i) }), headers));
  assert.equal(answers.filter((a) => a.body.code === 'EXPIRED').length, 240, JSON.stringify(answers.find((a) => a.body.code !== 'EXPIRED')?.body));
  assert.equal(await count(`SELECT count(*)::int AS n FROM events WHERE kind = 'order refused'`), linesBefore + 240, 'one line each');
  const rowsNow = (await pool.query(`SELECT account, budget::text AS budget, floor(extract(epoch FROM budget_at))::bigint::text AS at, refused FROM accounts ORDER BY account`)).rows;
  const over = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T - 500n }));
  assert.equal(over.status, 429, `${JSON.stringify(over.body)}; T ${T}; rows ${JSON.stringify(rowsNow)}; chain ${await rig.time()}`);
  assert.equal(over.body.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(over.body.budget, 'account');
  assert.match(String(over.body.error), /This account has used its budget of admitted requests \(240 at once, 12 a minute after\)/);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM events WHERE kind = 'order refused'`), linesBefore + 240, 'a refusal over the budget is not a line');
  const row = (await pool.query('SELECT budget::text AS budget, refused::int AS refused, last_refused_at FROM accounts WHERE account = $1', [maker.address.toLowerCase()])).rows[0] as Record<string, unknown>;
  assert.equal(row.refused, 1);
  assert.ok(row.last_refused_at instanceof Date);
  assert.ok(Number(row.budget) < 1);
  for (let i = 0; i < 5; i++) assert.equal((await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T - 600n - BigInt(i) }))).status, 429);
  assert.equal(Number((await pool.query('SELECT refused::int AS refused FROM accounts WHERE account = $1', [maker.address.toLowerCase()])).rows[0].refused), 6, 'the count rises; a number, not a line');
  const courier = (await pool.query(`SELECT budget::text AS budget FROM accounts WHERE account = 'courier'`)).rows[0] as { budget: string };
  assert.ok(Number(courier.budget) <= 2_400 - 240, 'each admitted request took one from the courier\'s budget too');
});

test('the budgets across two processes, and across a restart: one count', async () => {
  const who = rig.accounts.taker;
  const T = await rig.time();
  let second = await startCourier(stack.env);
  try {
    const viaFirst = await many(120, 8, (i, headers) => postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T - BigInt(i) }), headers));
    const viaSecond = await many(120, 8, (i, headers) => postOrder(second.url, rig, who, 'rest', orderOn(rig, who, { expiry: T - BigInt(i) }), headers));
    assert.equal([...viaFirst, ...viaSecond].filter((a) => a.body.code === 'EXPIRED').length, 240);
    assert.equal((await postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T - 300n }))).status, 429, 'the first process sees the count');
    assert.equal((await postOrder(second.url, rig, who, 'rest', orderOn(rig, who, { expiry: T - 301n }))).status, 429, 'the second process sees the count');
    await second.stop();
    second = await startCourier(stack.env);
    assert.equal((await postOrder(second.url, rig, who, 'rest', orderOn(rig, who, { expiry: T - 302n }))).status, 429, 'a restart keeps the count');
  } finally {
    await second.stop();
  }
});

test("the courier's budget: 2,400 admitted at once after a quiet hour, then 60 a minute; the two numbers are told apart, on the chain's clock", async () => {
  // Eleven fresh accounts, each with room for 240: the courier's bucket runs out first.
  const accounts: HDAccount[] = [];
  for (let i = 20; i < 31; i++) {
    const who = rig.account(i);
    await rig.fund(who);
    accounts.push(who);
  }
  // A quiet hour on the chain's clock: every bucket is full.
  await rig.increaseTime(3_600n);
  let T = await rig.time();
  const answers = await many(2_400, 16, (i, headers) => {
    const who = accounts[i % accounts.length] as HDAccount;
    return postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T - 1n - BigInt(i) }), headers);
  });
  const refused = answers.filter((a) => a.body.code !== 'EXPIRED');
  assert.equal(refused.length, 0, `admitted at once: ${JSON.stringify(refused[0]?.body)}`);
  const next = await postOrder(url(), rig, accounts[0] as HDAccount, 'rest', orderOn(rig, accounts[0] as HDAccount, { expiry: T - 5_000n }));
  assert.equal(next.status, 429, JSON.stringify(next.body));
  assert.equal(next.body.budget, 'courier', 'the courier\'s bucket, not the account\'s');
  assert.match(String(next.body.error), /The courier has used its budget of admitted requests for all accounts together \(2,400 at once, 60 a minute after\)/);
  const courierRow = (await pool.query(`SELECT refused::int AS refused FROM accounts WHERE account = 'courier'`)).rows[0] as { refused: number };
  assert.equal(courierRow.refused, 1);

  // A minute later on the chain's clock, exactly: a mined block's time follows the wall clock plus the offset, and
  // the 2,400 posts took real seconds, so the block's time is set rather than advanced. Then 60 more, and the 61st refused.
  await rig.setNextBlockTime(T + 60n);
  await rig.mine(1);
  T = await rig.time();
  const minute = await many(61, 8, (i, headers) => {
    const who = accounts[(i + 3) % accounts.length] as HDAccount;
    return postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T - 6_000n - BigInt(i) }), headers);
  });
  assert.equal(minute.filter((a) => a.body.code === 'EXPIRED').length, 60, 'the refill is 60 a minute, not the bucket\'s size');
  assert.equal(minute.filter((a) => a.status === 429 && a.body.budget === 'courier').length, 1);
});

test('a body over the bound is refused before it is read whole, with no row', async () => {
  const rowsBefore = await count('SELECT count(*)::int AS n FROM orders');
  const res = await fetch(`${url()}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"role":"rest","order":{},"signature":"${'x'.repeat(9 * 1024)}"}` });
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { code: string }).code, 'BODY_TOO_LARGE');
  assert.equal(await count('SELECT count(*)::int AS n FROM orders'), rowsBefore);
});
