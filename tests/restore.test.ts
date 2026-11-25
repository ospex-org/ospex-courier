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

// A database restored from an older copy, from what the operator and the
// bettor would see. Each timeline takes its own copy while a bet waits, then
// lets the original courier go on; every courier process is stopped, the copy
// is put in the database's place, and the operator's shut runs before any
// courier starts on it. The database-wide hold stands throughout: the door
// takes no new bet and no lane, old or new, reserves, signs or hands off.
// Signatures are counted at the signer and hand-offs at the proxy across every
// process's life: the restore resets none of the test's observations. A bet
// lives 30 seconds at most, so a timeline runs inside its bet's life.

let stack: Stack;
let original: pg.Pool;
const pools: pg.Pool[] = [];
const url = () => stack.courier.url;

let from: Record<string, string> = {};
let nextAddress = 0;
beforeEach(() => {
  const n = nextAddress++;
  from = { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
});
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

let extra: Array<CourierProcess & { hooks: HookControl }> = [];
/** Every courier process this file has started, each counted once: its signatures stay in its own record after it stops. */
const lives = new Set<CourierProcess & { hooks?: HookControl }>();
const signed = () => {
  lives.add(stack.courier);
  for (const c of extra) lives.add(c);
  return [...lives].reduce((n, c) => n + (c.hooks?.signed.length ?? 0), 0);
};
const handOffs = () => stack.proxy.count('eth_sendRawTransaction');

before(async () => {
  stack = await startStack('restore', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  original = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(async () => {
  for (const c of extra) await c.stop();
  for (const p of pools) await p.end();
  await original?.end();
  await stack?.close();
});

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
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the couriers' last lines: ${[...extra.flatMap((c) => c.lines.slice(-6)), ...stack.courier.lines.slice(-4)].join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function quote(M: HDAccount, on: string): Promise<string> {
  const T = await stack.rig.time();
  const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 9_600n }), positionType: 0 };
  const posted = await postOrder(on, stack.rig, M, 'rest', q);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return posted.body.orderHash as string;
}

async function bet(B: HDAccount, on: string): Promise<{ status: number; hash: string; body: Record<string, unknown> }> {
  const T = await stack.rig.time();
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(on, stack.rig, B, 'take', b);
  return { status: taken.status, hash: taken.body.orderHash as string, body: taken.body };
}

const crossState = async (pool: pg.Pool, h: string) => ((await pool.query<{ state: string }>('SELECT state FROM crosses WHERE bet_hash = $1', [h.toLowerCase()])).rows[0]?.state ?? null);

/** Every table of the schema copied row for row, and every sequence where it stood: a copy as a dump restores it. */
async function copyDatabase(prefix: string): Promise<{ url: string; pool: pg.Pool }> {
  const made = await stack.db.createWithSchema(prefix);
  const to = new pg.Pool({ connectionString: made.url, max: 2 });
  pools.push(to);
  for (const table of ['runs', 'orders', 'stop_messages', 'stops', 'events', 'lanes', 'crosses', 'legs', 'conditions', 'accounts', 'games']) {
    const { rows } = await original.query<{ j: string }>(`SELECT coalesce(json_agg(t), '[]')::text AS j FROM ${table} t`);
    await to.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(null::${table}, $1::json)`, [(rows[0] as { j: string }).j]);
  }
  for (const seq of ['runs_id_seq', 'stop_messages_id_seq', 'events_number_seq', 'conditions_id_seq', 'orders_record_number', 'lane_reservations']) {
    const { rows } = await original.query<{ last_value: string; is_called: boolean }>(`SELECT last_value::text AS last_value, is_called FROM ${seq}`);
    const r = rows[0] as { last_value: string; is_called: boolean };
    await to.query('SELECT setval($1, $2::bigint, $3)', [seq, r.last_value, r.is_called]);
  }
  return { url: made.url, pool: to };
}

/**
 * The operator's command as the operator runs it, against the database named: its printed line and its exit. Run as a
 * child the test waits for without blocking, since the chain's proxy answers it from this process.
 */
function operator(databaseUrl: string, args: string[], env: Record<string, string> = {}): Promise<{ out: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/operator.ts', ...args],
      { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...stack.env, ...env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 120_000 },
      (err, stdout, stderr) => resolve({ out: `${stdout}${stderr}`.trim(), status: err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null }),
    );
  });
}

/** Stops every courier process this file started: the stack's and the extra ones. */
async function stopAll(): Promise<void> {
  signed();
  await stack.courier.stop();
  for (const c of extra) await c.stop();
  extra = [];
}

const keyLane = (pool: pg.Pool) => pool.query<{ to: string; shut_line: string | null }>('SELECT verified_nonce_to::text AS to, shut_line::text AS shut_line FROM lanes WHERE sender = $1', [stack.rig.accounts.sender.address.toLowerCase()]);

let timelineA: { url: string; pool: pg.Pool } | null = null;

test('a restore from a copy taken while the bet waits: the operator\'s shut on the copy before any courier starts; then no new bet is taken and nothing is reserved, signed or handed off, across every process\'s life; the bet\'s withheld transaction released before its expiry mines and fills, and recovery records the chain\'s outcome and total while the hold stands', async () => {
  const hooks = stack.courier.hooks as HookControl;
  // A first bet, to completion: the lane's watermark has its anchor before the copy.
  await quote(await fresh(), url());
  const first = await bet(await fresh(), url());
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await until(() => crossState(original, first.hash), (s) => s === 'confirmed', 60_000, 'the first bet');
  // B waits, held at its reservation; the copy is taken now.
  await quote(await fresh(), url());
  await hooks.arm('after-reservation', 1);
  const b = await bet(await fresh(), url());
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const heldB = await hooks.reached('after-reservation');
  const copy = await copyDatabase('restored_a');
  timelineA = copy;
  // B signed and handed off once, its transaction kept from the chain.
  const before = { s: signed(), h: handOffs() };
  const withheld = stack.proxy.withhold();
  await hooks.go(heldB);
  await until(() => crossState(original, b.hash), (s) => s === 'sent', 30_000, 'B sent');
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 1, h: 1 });
  // Every courier process stopped; the copy in the database's place; the shut before any courier starts on it.
  await stopAll();
  const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
  assert.equal(shut.status, 0, shut.out);
  assert.match(shut.out, /restore's incident is line \d+/);
  const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: copy.url });
  extra.push(courier);
  // The hold: the door takes no new bet, and nothing is reserved.
  const refused = await bet(await fresh(), courier.url);
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'NOT_TAKING_BETS');
  const lanes = await copy.pool.query<{ reservation: string | null; shut_line: string | null }>('SELECT reservation::text AS reservation, shut_line::text AS shut_line FROM lanes');
  assert.ok(lanes.rows.length > 0 && lanes.rows.every((l) => l.reservation === null && l.shut_line !== null), JSON.stringify(lanes.rows));
  assert.equal(await crossState(copy.pool, b.hash), null, 'the copy holds no Cross for B, and none is made');
  // B released before its expiry: it mines and fills; recovery records its outcome and its total under the hold.
  await withheld.forward();
  withheld.stop();
  const line = await until(
    async () => (await copy.pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'incident' AND reason = 'RESTORE_UNASSOCIATED'`)).rows,
    (r) => r.length > 0,
    90_000,
    "the restore's incident records B's transaction",
  );
  assert.equal(String(line[0]?.facts.carries), b.hash.toLowerCase());
  assert.equal(line[0]?.facts.outcome, 'success', 'the chain-proved outcome');
  assert.ok(BigInt(String(line[0]?.facts.betFilled)) > 0n, 'and the total filled at that final block');
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 1, h: 1 }, 'still one signature and one hand-off across every life');
  const held = await copy.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM lanes WHERE reservation IS NOT NULL OR shut_line IS NULL`);
  assert.equal((held.rows[0] as { n: string }).n, '0', 'every lane still shut, none reserved');
  await stopAll();
  // The stack's own courier back on the database that was not restored, for the next timeline.
  await stack.restartCourier({ hooked: true });
});

test('a rotation and a new key on a restored database: its lane is first made after the restore, and a retained waiting bet with no Cross, valid and live, is not reserved, signed or handed off; the control, the same new key on the database that was not restored, sends it', async () => {
  const hooks = stack.courier.hooks as HookControl;
  await until(async () => (await original.query<{ held_bet: string | null }>('SELECT held_bet FROM lanes')).rows.every((r) => r.held_bet === null), (v) => v, 90_000, 'the lane free');
  await quote(await fresh(), url());
  await hooks.arm('after-reservation', 1);
  const b2 = await bet(await fresh(), url());
  assert.equal(b2.status, 202, JSON.stringify(b2.body));
  await hooks.reached('after-reservation');
  const copy = await copyDatabase('restored_c');
  await stopAll();
  const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
  assert.equal(shut.status, 0, shut.out);
  // The rotation, as the timelock's call leaves it: the relay's sender is the new key, funded.
  const K2 = stack.rig.account(30);
  await stack.rig.rpc('anvil_setBalance', [K2.address, '0x56bc75e2d63100000']);
  await stack.rig.rpc('anvil_setStorageAt', [stack.rig.addresses.relay, `0x${RELAY_SENDER_SLOT.toString(16)}`, `0x${K2.address.slice(2).toLowerCase().padStart(64, '0')}`]);
  const store = testKeystoreFor(K2.address);
  assert.ok(store !== null);
  const k2env = { ...stack.env, COURIER_ADDRESS: K2.address, COURIER_KEYSTORE_JSON: store.json, COURIER_KEYSTORE_PASSWORD: store.password };
  const before = { s: signed(), h: handOffs() };
  const onCopy = await startHookedCourier({ ...k2env, DATABASE_URL: copy.url });
  extra.push(onCopy);
  await new Promise((r) => setTimeout(r, 3_000));
  const lane = await copy.pool.query<{ shut_line: string | null }>('SELECT shut_line::text AS shut_line FROM lanes WHERE sender = $1', [K2.address.toLowerCase()]);
  assert.equal(lane.rows.length, 1, "the new key's lane, made after the restore");
  assert.notEqual(lane.rows[0]?.shut_line, null, 'made under the hold');
  const reservations = await copy.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM lanes WHERE reservation IS NOT NULL');
  assert.equal((reservations.rows[0] as { n: string }).n, '0', 'zero reservations');
  const waiting = await copy.pool.query<{ bet_state: string; expiry: string }>('SELECT bet_state, expiry::text AS expiry FROM orders WHERE hash = $1', [b2.hash.toLowerCase()]);
  assert.equal(waiting.rows[0]?.bet_state, 'waiting');
  assert.ok(BigInt(waiting.rows[0]?.expiry as string) > (await stack.rig.time()), 'the retained bet is still live');
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 }, 'no signature and no hand-off on the restored database');
  await stopAll();
  // The control: the same new key on the database that was not restored: the same lane and bet progress.
  const onOriginal = await startHookedCourier({ ...k2env, DATABASE_URL: stack.databaseUrl });
  extra.push(onOriginal);
  await until(() => crossState(original, b2.hash), (s) => s !== null && s !== 'intent' && s !== 'signed', 60_000, 'the control sends the bet');
  assert.ok(signed() - before.s >= 1 && handOffs() - before.h >= 1, 'the control signs and hands off');
  await stopAll();
});

test('the clear refuses a lane shut at a restore, with a final block far past the bet\'s expiry and every nonce of the key explained: the lane\'s shut line stays', async () => {
  assert.ok(timelineA !== null);
  const copy = timelineA;
  // Recovery explained the key's nonce use on the restored database: two Crosses, two nonces.
  await until(async () => (await keyLane(copy.pool)).rows[0]?.to, (v) => v === '2', 30_000, 'the nonce account explained');
  await stack.rig.increaseTime(600n);
  await stack.rig.mine(3);
  const before = (await keyLane(copy.pool)).rows[0]?.shut_line;
  const clear = await operator(copy.url, ['clear', '--lane', stack.rig.accounts.sender.address, '--found', 'the restore and its recovery, read whole']);
  assert.equal(clear.status, 1, clear.out);
  assert.match(clear.out, /shut at a restore/);
  assert.equal((await keyLane(copy.pool)).rows[0]?.shut_line, before, 'the restore hold retained');
});
