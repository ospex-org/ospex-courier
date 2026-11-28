import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { closeEach } from './support/close';
import { startStack, type Stack } from './support/stack';
import { outcomes, postStop as postStopFrom, stopMessage } from './support/stops';

// The marks, read again at the final block, before the next bet's candidates.
// A quote's mark written at a block that is not on the final block's chain is
// a mark made at an orphaned block; it is put there as such a mark would be,
// with the hash a branch the chain dropped would have given, and no fabricated
// hash of the chain's own is needed. With no open Cross, the next bet's
// pre-check reads it again before its candidate query.

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

before(async () => {
  stack = await startStack('marks', { hooked: true, blockTime: 2, sending: true });
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

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The sole quote on its side of a market of a game of its own: one quote, and nothing else a bet can list. */
async function soleQuote(): Promise<{ M: HDAccount; hash: string; gameId: bigint }> {
  const M = await fresh();
  const gameId = await stack.rig.createGame({ startWritten: true });
  const T = await stack.rig.time();
  const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 9_600n, gameId }), positionType: 0 };
  const posted = await postOrder(url(), stack.rig, M, 'rest', q);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return { M, hash: posted.body.orderHash as string, gameId };
}

async function betOn(gameId: bigint): Promise<string> {
  const B = await fresh();
  const T = await stack.rig.time();
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, gameId }), positionType: 1 };
  const taken = await postOrder(url(), stack.rig, B, 'take', b);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  return taken.body.orderHash as string;
}

/** A height below F, and the hash its block has on the chain. */
async function blockAt(depth: bigint): Promise<{ number: bigint; hash: string }> {
  const head = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
  const number = head - 1n - depth;
  const b = (await stack.rig.rpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])) as { hash: string };
  return { number, hash: b.hash.toLowerCase() };
}

const orphanHash = (n: bigint) => `0x${'0d'.repeat(24)}${n.toString(16).padStart(16, '0')}`;

async function markRow(hash: string): Promise<{ ended: string | null; ended_block: string | null; ended_final: boolean }> {
  const { rows } = await pool.query('SELECT ended, ended_block::text AS ended_block, ended_final FROM orders WHERE hash = $1', [hash.toLowerCase()]);
  return rows[0] as never;
}

async function judged(bet: string): Promise<{ state: string | null; bet_state: string }> {
  return until(
    async () => {
      const c = await pool.query<{ state: string }>('SELECT state FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()]);
      const o = await pool.query<{ bet_state: string }>('SELECT bet_state FROM orders WHERE hash = $1', [bet.toLowerCase()]);
      return { state: c.rows[0]?.state ?? null, bet_state: (o.rows[0] as { bet_state: string }).bet_state };
    },
    (v) => v.bet_state === 'refused' || v.bet_state === 'lapsed' || ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'].includes(v.state ?? ''),
    60_000,
    `the bet ${bet}`,
  );
}

test('a quote marked cancelled at an orphaned block, the sole quote, with no open Cross: the next bet\'s pre-check reads the order again at F before its candidates, the mark is lifted, and the bet is sent on it and fills', async () => {
  const q = await soleQuote();
  const at = await blockAt(1n);
  await pool.query(`UPDATE orders SET ended = 'cancelled', ended_at = now(), ended_block = $2, ended_block_hash = $3, ended_final = false WHERE hash = $1`, [q.hash.toLowerCase(), at.number.toString(), orphanHash(at.number)]);
  const b = await betOn(q.gameId);
  const r = await judged(b);
  assert.equal(r.state, 'confirmed', JSON.stringify(r));
  const legs = await pool.query<{ order_hash: string }>('SELECT order_hash FROM legs WHERE bet_hash = $1', [b.toLowerCase()]);
  assert.deepEqual(legs.rows.map((l) => l.order_hash), [q.hash.toLowerCase()]);
});

test('the same, with a stop retained for the quote: the mark is set stopped, never cleared, and the bet finds no depth', async () => {
  const q = await soleQuote();
  const stop = await postStop(url(), stack.rig, q.M, stopMessage(q.M.address, [q.hash as `0x${string}`]));
  assert.deepEqual(outcomes(stop), ['stopped']);
  const at = await blockAt(1n);
  await pool.query(`UPDATE orders SET ended = 'cancelled', ended_at = now(), ended_block = $2, ended_block_hash = $3, ended_final = false WHERE hash = $1`, [q.hash.toLowerCase(), at.number.toString(), orphanHash(at.number)]);
  const b = await betOn(q.gameId);
  const r = await judged(b);
  assert.equal(r.bet_state, 'refused', JSON.stringify(r));
  assert.deepEqual(await markRow(q.hash), { ended: 'stopped', ended_block: null, ended_final: false });
});

test('a mark more than 256 blocks below F, where the chain\'s own hash of its height cannot be read at F: its order is read at F as an orphaned one\'s, and the mark is lifted', async () => {
  const q = await soleQuote();
  await stack.rig.mine(300);
  const at = await blockAt(290n);
  await pool.query(`UPDATE orders SET ended = 'cancelled', ended_at = now(), ended_block = $2, ended_block_hash = $3, ended_final = false WHERE hash = $1`, [q.hash.toLowerCase(), at.number.toString(), at.hash]);
  const b = await betOn(q.gameId);
  const r = await judged(b);
  assert.equal(r.state, 'confirmed', JSON.stringify(r));
});

test('a mark migrated from before this build, unproved and at a block on F\'s chain: it stands, now final, and the bet does not list the quote', async () => {
  const q = await soleQuote();
  const at = await blockAt(2n);
  await pool.query(`UPDATE orders SET ended = 'cancelled', ended_at = now(), ended_block = $2, ended_block_hash = $3, ended_final = false WHERE hash = $1`, [q.hash.toLowerCase(), at.number.toString(), at.hash]);
  const b = await betOn(q.gameId);
  const r = await judged(b);
  assert.equal(r.bet_state, 'refused', JSON.stringify(r));
  assert.deepEqual(await markRow(q.hash), { ended: 'cancelled', ended_block: at.number.toString(), ended_final: true });
});
