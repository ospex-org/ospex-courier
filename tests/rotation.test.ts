import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { RELAY_SENDER_SLOT } from '../courier/chain/abi';
import { startHookedCourier, type CourierProcess, type HookControl } from './support/courier';
import { testKeystoreFor } from './support/keystore';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { startStack, type Stack } from './support/stack';
import { postStop as postStopFrom, resultsOf, stopMessage } from './support/stops';

// A rotation and the key's hold, on a database that was never restored. The
// drain: while a retired key's Cross is open, the new key's lane reserves and
// signs nothing, a stop names that one open Cross, and the new lane goes on
// once the chain shows the old Cross's outcome. The key's hold: a transaction
// of the key the records do not hold takes the nonce of the courier's Cross,
// which is then replaced and not the courier's own; the lane shuts and stays
// shut on every later read, until the operator's clear with every nonce
// explained opens it; a second time, a rotation retires the lane and the new
// key's lane sends.

let stack: Stack;
let pool: pg.Pool;
let extra: Array<CourierProcess & { hooks: HookControl }> = [];
const lives = new Set<CourierProcess & { hooks?: HookControl }>();
const signed = () => {
  lives.add(stack.courier);
  for (const c of extra) lives.add(c);
  return [...lives].reduce((n, c) => n + (c.hooks?.signed.length ?? 0), 0);
};
const handOffs = () => stack.proxy.count('eth_sendRawTransaction');

let from: Record<string, string> = {};
let nextAddress = 0;
beforeEach(() => {
  const n = nextAddress++;
  from = { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
});
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const postStop = (...a: Parameters<typeof postStopFrom>) => postStopFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

before(async () => {
  stack = await startStack('rotation', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(async () => {
  for (const c of extra) await c.stop();
  await pool?.end();
  await stack?.close();
});

let nextAccount = 40;
async function fresh(): Promise<HDAccount> {
  const who = stack.rig.account(nextAccount++);
  await stack.rig.fund(who);
  return who;
}

let current: () => string = () => stack.courier.url;

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the couriers' last lines: ${[...extra.flatMap((c) => c.lines.slice(-6)), ...stack.courier.lines.slice(-4)].join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function quote(M: HDAccount): Promise<string> {
  const T = await stack.rig.time();
  const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 19_200n }), positionType: 0 };
  const posted = await postOrder(current(), stack.rig, M, 'rest', q);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return posted.body.orderHash as string;
}

async function bet(B: HDAccount): Promise<string> {
  const T = await stack.rig.time();
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(current(), stack.rig, B, 'take', b);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  return taken.body.orderHash as string;
}

const cross = async (h: string) => (await pool.query<{ state: string; replaced_by_ours: boolean | null; tx_hash: string | null; nonce: string | null }>('SELECT state, replaced_by_ours, tx_hash, nonce::text AS nonce FROM crosses WHERE bet_hash = $1', [h.toLowerCase()])).rows[0] ?? null;
const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];

function operator(args: string[], env: Record<string, string> = {}): Promise<{ out: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/operator.ts', ...args],
      { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...stack.env, ...env, DATABASE_URL: stack.databaseUrl }, encoding: 'utf8', timeout: 120_000 },
      (err, stdout, stderr) => resolve({ out: `${stdout}${stderr}`.trim(), status: err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null }),
    );
  });
}

/** The relay's sender set to the key, as the timelock's call leaves it, and the key funded with POL. */
async function rotateTo(next: HDAccount): Promise<void> {
  await stack.rig.rpc('anvil_setBalance', [next.address, '0x56bc75e2d63100000']);
  await stack.rig.rpc('anvil_setStorageAt', [stack.rig.addresses.relay, `0x${RELAY_SENDER_SLOT.toString(16)}`, `0x${next.address.slice(2).toLowerCase().padStart(64, '0')}`]);
}

function envFor(key: HDAccount): Stack['env'] {
  const store = testKeystoreFor(key.address);
  assert.ok(store !== null);
  return { ...stack.env, COURIER_ADDRESS: key.address, COURIER_KEYSTORE_JSON: store.json, COURIER_KEYSTORE_PASSWORD: store.password };
}

async function stopAll(): Promise<void> {
  signed();
  await stack.courier.stop();
  for (const c of extra) await c.stop();
  extra = [];
}

const shutLine = async (key: string) => (await pool.query<{ shut_line: string | null }>('SELECT shut_line::text AS shut_line FROM lanes WHERE sender = $1', [key.toLowerCase()])).rows[0]?.shut_line ?? null;

test("the drain: a rotation while the old key's Cross is open. The new key's lane reserves and signs nothing while it is open, a stop of the quote names that one Cross, and once the chain shows its outcome the new lane sends the bet that waited", async () => {
  const hooks = stack.courier.hooks as HookControl;
  const M = await fresh();
  const shared = await quote(M);
  const withheld = stack.proxy.withhold();
  const old = await bet(await fresh());
  await until(() => cross(old), (c) => c?.state === 'sent', 30_000, 'the old Cross sent');
  void hooks;
  await stopAll();
  const K2 = stack.rig.account(31);
  await rotateTo(K2);
  const before = { s: signed(), h: handOffs() };
  const k2 = await startHookedCourier(envFor(K2));
  extra.push(k2);
  current = () => k2.url;
  const waiting = await bet(await fresh());
  await new Promise((r) => setTimeout(r, 3_000));
  const reserved = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM lanes WHERE sender = $1 AND reservation IS NOT NULL', [K2.address.toLowerCase()]);
  assert.equal((reserved.rows[0] as { n: string }).n, '0', "the new lane reserves nothing while the old Cross is open");
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 });
  // One stop identity: the open Cross is the old lane's, and the stop names it.
  const stop = await postStop(k2.url, stack.rig, M, stopMessage(M.address, [shared as `0x${string}`]));
  const named = resultsOf(stop)[0] as unknown as { handOff?: { bet: string } };
  assert.equal(named.handOff?.bet, old.toLowerCase(), JSON.stringify(stop.body));
  // A quote for the bet that waits, behind the stopped one.
  await quote(await fresh());
  // The old Cross released: the relay refuses the old key now, and the chain shows it reverted.
  await withheld.forward();
  withheld.stop();
  const settled = await until(() => cross(old), (c) => c !== null && FINAL.includes(c.state), 90_000, 'the old Cross settled');
  assert.ok(['reverted', 'confirmed'].includes(settled?.state as string), JSON.stringify(settled));
  // Then progress: the bet that waited is sent by the new lane, once, and fills.
  const row = await until(() => cross(waiting), (c) => c !== null && FINAL.includes(c.state), 60_000, 'the waiting bet sent by the new lane');
  assert.equal(row?.state, 'confirmed', JSON.stringify(row));
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 1, h: 1 });
  await stopAll();
});

test("the key's hold: a transaction of the key the records do not hold takes the nonce of the courier's withheld Cross. The Cross is replaced and not the courier's own, the lane shuts and stays shut on every later read, the operator's clear with every nonce explained opens it, and the next bet is sent", async () => {
  // The key is the relay's sender again, and its courier runs.
  const key = stack.rig.accounts.sender;
  await rotateTo(key as unknown as HDAccount);
  await stack.restartCourier({ hooked: true });
  current = () => stack.courier.url;
  await quote(await fresh());
  const withheld = stack.proxy.withhold();
  const b = await bet(await fresh());
  const sent = await until(() => cross(b), (c) => c?.state === 'sent', 30_000, 'the Cross sent');
  // The key's own transaction at that nonce, at a higher fee, outside the courier: it mines.
  await stack.rig.rpc('eth_sendTransaction', [{ from: key.address, to: key.address, value: '0x0', nonce: `0x${BigInt(sent?.nonce as string).toString(16)}`, maxFeePerGas: '0x174876e800', maxPriorityFeePerGas: '0x174876e800' }]);
  withheld.stop();
  const replaced = await until(() => cross(b), (c) => c !== null && FINAL.includes(c.state), 90_000, 'the Cross replaced');
  assert.deepEqual([replaced?.state, replaced?.replaced_by_ours], ['replaced', false]);
  const line = await until(() => shutLine(key.address), (v) => v !== null, 30_000, 'the lane shut');
  const opened = await pool.query<{ reason: string }>('SELECT reason FROM events WHERE number = $1', [line]);
  assert.equal(opened.rows[0]?.reason, 'cross-unreconciled');
  // Reads again leave it shut: the Cross is final, and the key's hold is apart from it.
  await new Promise((r) => setTimeout(r, 6_000));
  assert.equal(await shutLine(key.address), line);
  const R = await fresh();
  const refused = await postOrder(stack.courier.url, stack.rig, R, 'take', { ...orderOn(stack.rig, R, { expiry: (await stack.rig.time()) + 30n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 });
  assert.equal(refused.status, 503, 'the door admits no bet for a shut lane');
  // The operator's clear, every nonce explained: the lane opens, and the next bet is sent.
  await stopAll();
  const clear = await operator(['clear', '--lane', key.address, '--found', "the key's own transaction at the Cross's nonce, sent outside the courier by the test"]);
  assert.equal(clear.status, 0, clear.out);
  assert.equal(await shutLine(key.address), null);
  await stack.restartCourier({ hooked: true });
  await quote(await fresh());
  const next = await bet(await fresh());
  const row = await until(() => cross(next), (c) => c !== null && FINAL.includes(c.state), 60_000, 'the next Cross');
  assert.equal(row?.state, 'confirmed', JSON.stringify(row));
});

test("the key's hold, a second time, closed by a rotation: the lane shut by a transaction the records do not hold is retired once the relay's sender at the final block is another key; the condition closes with its line, and the new key's lane sends", async () => {
  const key = stack.rig.accounts.sender;
  await quote(await fresh());
  const withheld = stack.proxy.withhold();
  const b = await bet(await fresh());
  const sent = await until(() => cross(b), (c) => c?.state === 'sent', 30_000, 'the Cross sent');
  await stack.rig.rpc('eth_sendTransaction', [{ from: key.address, to: key.address, value: '0x0', nonce: `0x${BigInt(sent?.nonce as string).toString(16)}`, maxFeePerGas: '0x174876e800', maxPriorityFeePerGas: '0x174876e800' }]);
  withheld.stop();
  await until(() => shutLine(key.address), (v) => v !== null, 90_000, 'the lane shut');
  await stopAll();
  const K3 = stack.rig.account(32);
  await rotateTo(K3);
  await new Promise((r) => setTimeout(r, 5_000));
  const k3 = await startHookedCourier(envFor(K3));
  extra.push(k3);
  current = () => k3.url;
  await until(async () => (await pool.query(`SELECT 1 FROM conditions WHERE key = 'cross-unreconciled' AND cleared_at IS NULL`)).rowCount ?? 0, (n) => n === 0, 30_000, 'the condition closed by the rotation');
  const retired = await pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'incident' AND reason = 'LANE_RETIRED' AND facts->>'lane' = $1`, [key.address.toLowerCase()]);
  assert.equal(retired.rows.length, 1);
  assert.notEqual(await shutLine(key.address), null, 'the retired lane stays shut, and never reserves again');
  await quote(await fresh());
  const next = await bet(await fresh());
  const row = await until(() => cross(next), (c) => c !== null && FINAL.includes(c.state), 60_000, "the new key's Cross");
  assert.equal(row?.state, 'confirmed', JSON.stringify(row));
  await stopAll();
});
