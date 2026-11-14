import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { HDAccount } from 'viem/accounts';
import { openPool } from '../courier/records/store';
import { get, startCourier } from './support/courier';
import { cancelOnChain, orderOn, postOrder, type Answer, type Order } from './support/orders';
import type { Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';

// Posts in flight, from a user's side: a burst of one account's posts at the
// cap, on one process and on two, every one answered and none with a 5xx; the
// door's connection held by one post at a time, so a reader and another
// account are answered while a burst runs.

let stack: Stack;
let rig: Rig;
let pool: pg.Pool;
let who: HDAccount;
const market = { scorer: undefined as unknown as `0x${string}`, lineTicks: 2_505 };
const standing: Order[] = [];

before(async () => {
  stack = await startStack('burst');
  rig = stack.rig;
  pool = openPool(stack.databaseUrl, null);
  market.scorer = rig.addresses.total;
  who = rig.account(16);
  await rig.fund(who);
});

after(async () => {
  await pool?.end();
  await stack?.close();
});

const url = () => stack.courier.url;

function tally(answers: Answer[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of answers) out[String(a.status)] = (out[String(a.status)] ?? 0) + 1;
  return out;
}

const none5xx = (answers: Answer[], what: string) => assert.equal(answers.filter((a) => a.status >= 500).length, 0, `${what}: ${JSON.stringify(answers.filter((a) => a.status >= 500).map((a) => a.body))}`);

test('eight posts of one account at once, from fifteen standing: one 201, seven 422, nothing 5xx, and the burst ends in a small multiple of one post\'s time; the same across two processes', async () => {
  const T = await rig.time();
  let onePostMs = 0;
  for (let i = 0; i < 15; i++) {
    const q = orderOn(rig, who, { expiry: T + 3_600n, ...market });
    const started = Date.now();
    const answer = await postOrder(url(), rig, who, 'rest', q);
    onePostMs = Date.now() - started;
    assert.equal(answer.status, 201, `${i}: ${JSON.stringify(answer.body)}`);
    standing.push(q);
  }
  // The burst: eight signed posts sent together. Each finds fifteen or sixteen standing and asks the chain about
  // them inside the admission transaction, which is where the pool used to run out.
  const started = Date.now();
  const burst = await Promise.all(Array.from({ length: 8 }, () => postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }))));
  const elapsed = Date.now() - started;
  none5xx(burst, 'the burst of eight');
  assert.deepEqual(tally(burst), { '201': 1, '422': 7 }, JSON.stringify(burst.map((a) => a.body.code ?? a.body.state)));
  assert.ok(elapsed < 5_000, `the burst took ${elapsed} ms (one post alone took ${onePostMs} ms): not the pool's ten seconds`);
  console.log(`# burst of 8 from 15 standing: ${elapsed} ms; one post alone: ${onePostMs} ms`);
  const admitted = burst.find((a) => a.status === 201);
  standing.push({ ...orderOn(rig, who, { expiry: T + 3_600n, ...market }), nonce: BigInt((admitted?.body.order as { nonce: string }).nonce) });
  assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM orders WHERE account = $1 AND ended IS NULL`, [who.address.toLowerCase()])).rows[0]?.n), 16, 'sixteen stand');

  // Two processes: one standing quote cancelled on chain makes room for one; four posts to each process at once.
  await cancelOnChain(rig, who, standing[0] as Order);
  const second = await startCourier(stack.env);
  try {
    const started2 = Date.now();
    const two = await Promise.all([
      ...Array.from({ length: 4 }, () => postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }))),
      ...Array.from({ length: 4 }, () => postOrder(second.url, rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }))),
    ]);
    const elapsed2 = Date.now() - started2;
    none5xx(two, 'the burst across two processes');
    assert.deepEqual(tally(two), { '201': 1, '422': 7 }, JSON.stringify(two.map((a) => a.body.code ?? a.body.state)));
    assert.ok(elapsed2 < 5_000, `the two-process burst took ${elapsed2} ms`);
    console.log(`# burst of 8 across two processes: ${elapsed2} ms`);
  } finally {
    await second.stop();
  }
  assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM orders WHERE account = $1 AND ended IS NULL`, [who.address.toLowerCase()])).rows[0]?.n), 16, 'sixteen stand again');
});

test("a burst of 64 posts of one account at the cap holds no connection idle: a market's page and another account's post are answered while it runs, and every post of the burst is answered, none with a 5xx", async () => {
  const T = await rig.time();
  const maker = rig.accounts.maker;
  const started = Date.now();
  const burst = Promise.all(Array.from({ length: 64 }, () => postOrder(url(), rig, who, 'rest', orderOn(rig, who, { expiry: T + 3_600n, ...market }))));
  // A reader, and another account's post, in the middle of it.
  await new Promise((r) => setTimeout(r, 50));
  const readStarted = Date.now();
  const page = await get(url(), `/v1/book?gameId=${rig.gameId}&scorer=${market.scorer}&lineTicks=${market.lineTicks}&side=A`);
  const readMs = Date.now() - readStarted;
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.ok(readMs < 3_000, `the market's page was answered in ${readMs} ms during the burst`);
  const otherStarted = Date.now();
  const other = await postOrder(url(), rig, maker, 'rest', orderOn(rig, maker, { expiry: T + 3_600n, scorer: rig.addresses.spread, lineTicks: -2_505 }));
  const otherMs = Date.now() - otherStarted;
  assert.equal(other.status, 201, `another account's post during the burst: ${JSON.stringify(other.body)}`);
  const answers = await burst;
  const elapsed = Date.now() - started;
  none5xx(answers, 'the burst of 64');
  assert.deepEqual(tally(answers), { '422': 64 }, JSON.stringify(answers.filter((a) => a.status !== 422).map((a) => a.body)));
  assert.ok(elapsed < 9_000, `the burst of 64 took ${elapsed} ms`);
  console.log(`# burst of 64 at the cap: ${elapsed} ms; a market page meanwhile: ${readMs} ms; another account's post meanwhile: ${otherMs} ms`);
});
