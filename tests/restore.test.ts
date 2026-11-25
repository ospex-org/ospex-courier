import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import { encodeFunctionData, type Abi, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { RELAY_SENDER_SLOT } from '../courier/chain/abi';
import { startHookedCourier, type CourierProcess, type HookControl } from './support/courier';
import { testKeystoreFor } from './support/keystore';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { closeEach } from './support/close';
import { startStack, type Stack } from './support/stack';
import { postStop as postStopFrom, stopMessage } from './support/stops';

// A database restored from an older copy, from what the operator and the
// bettor would see. Each timeline takes its own copy while a bet waits, then
// lets the original courier go on; every courier process is stopped, the copy
// is put in the database's place, and the operator's shut runs before any
// courier starts on it. The database-wide hold stands throughout: the door
// takes no new bet and no lane, old or new, reserves, signs or hands off.
// The timelines: a withheld transaction released before its expiry, and after
// a rotation the restored courier has read; a rotation and a new key; the
// clear refused; a copy older than the key's introduction, and older than a
// bet's admission; a copy at the bet's signed record, and at its intent; and
// a stop recorded after the copy.
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
const postStop = (...a: Parameters<typeof postStopFrom>) => postStopFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

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

after(() => closeEach(...extra.map((c) => () => c.stop()), ...pools.map((p) => () => p.end()), () => original?.end(), () => stack?.close()));

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

/** The original database's lane free: no bet held and no Cross open. */
const laneFree = () =>
  until(async () => (await original.query<{ held_bet: string | null; open_cross: string | null }>('SELECT held_bet, open_cross FROM lanes')).rows.every((r) => r.held_bet === null && r.open_cross === null), (v) => v, 90_000, 'the lane free');

/** The relay's sender set to `who`, as the timelock's call leaves it, and `who` funded with POL. */
async function setRelaySender(who: string): Promise<void> {
  await stack.rig.rpc('anvil_setBalance', [who, '0x56bc75e2d63100000']);
  await stack.rig.rpc('anvil_setStorageAt', [stack.rig.addresses.relay, `0x${RELAY_SENDER_SLOT.toString(16)}`, `0x${who.slice(2).toLowerCase().padStart(64, '0')}`]);
}

/**
 * The original database's courier back on the old key, the relay's sender the old key again: the stack's courier
 * started there, every lane's open Cross settled from the chain, the new key's from an earlier timeline among them,
 * and the lane free.
 */
async function backToTheOriginal(): Promise<void> {
  await stopAll();
  await setRelaySender(stack.rig.accounts.sender.address);
  await stack.restartCourier({ hooked: true });
  await laneFree();
}

const zeroReservations = async (pool: pg.Pool) => ((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM lanes WHERE reservation IS NOT NULL')).rows[0] as { n: string }).n;

test("a withheld transaction released after the restored courier has read a rotation: the old key is no longer the relay's sender and the bet is still before its expiry; the relay refuses it, not the expiry, and recovery records that outcome while the hold stands", async () => {
  await backToTheOriginal();
  const hooks = stack.courier.hooks as HookControl;
  const oldKey = stack.rig.accounts.sender.address;
  await quote(await fresh(), url());
  await hooks.arm('after-reservation', 1);
  const b = await bet(await fresh(), url());
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const heldB = await hooks.reached('after-reservation');
  const copy = await copyDatabase('restored_rotated');
  const before = { s: signed(), h: handOffs() };
  const withheld = stack.proxy.withhold();
  try {
    await hooks.go(heldB);
    await until(() => crossState(original, b.hash), (s) => s === 'sent', 30_000, 'B sent');
    await stopAll();
    const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
    assert.equal(shut.status, 0, shut.out);
    // The rotation, as the timelock's call leaves it; the restored courier, on the old key, reads it at its start.
    await setRelaySender(stack.rig.account(33).address);
    const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: copy.url });
    extra.push(courier);
    await until(async () => (await copy.pool.query(`SELECT 1 FROM events WHERE kind = 'incident' AND reason = 'LANE_RETIRED'`)).rows.length, (n) => n > 0, 30_000, 'the rotation read');
    const expiry = BigInt(((await copy.pool.query<{ expiry: string }>('SELECT expiry::text AS expiry FROM orders WHERE hash = $1', [b.hash.toLowerCase()])).rows[0] as { expiry: string }).expiry);
    // B released while it is still live: the relay refuses it.
    await withheld.forward();
    const line = await until(
      async () => (await copy.pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'incident' AND reason = 'RESTORE_UNASSOCIATED' AND facts->>'carries' = $1`, [b.hash.toLowerCase()])).rows,
      (r) => r.length > 0,
      90_000,
      "the restore's incident records B's transaction",
    );
    assert.equal(line[0]?.facts.outcome, 'reverted', 'the chain-proved outcome');
    // Refused by the relay and not by its expiry: mined before the expiry, while the relay's sender was the other key.
    const receipt = (await stack.rig.rpc('eth_getTransactionReceipt', [line[0]?.facts.txHash])) as { blockNumber: Hex; status: Hex };
    const block = (await stack.rig.rpc('eth_getBlockByNumber', [receipt.blockNumber, false])) as { timestamp: Hex };
    assert.ok(BigInt(block.timestamp) < expiry, `mined at ${BigInt(block.timestamp)}, before the expiry ${expiry}`);
    const senderThen = (await stack.rig.publicClient.readContract({ address: stack.rig.addresses.relay, abi: stack.rig.abis.OspexCourierRelay as Abi, functionName: 's_sender', blockNumber: BigInt(receipt.blockNumber) })) as string;
    assert.notEqual(senderThen.toLowerCase(), oldKey.toLowerCase(), 'the old key was not the relay\'s sender there');
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 1, h: 1 }, 'one signature and one hand-off across every life');
    assert.equal(await zeroReservations(copy.pool), '0', 'nothing reserved on the restored database');
  } finally {
    withheld.stop();
    await setRelaySender(oldKey);
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a copy older than the sending key's introduction: the shut finds no lane and makes the relay's sender's lane under the hold; with the sender unreadable at the shut, the hold is recorded all the same and no lane is made; a courier started on either makes or finds its lane under the hold, takes no bet and reserves nothing", async () => {
  await backToTheOriginal();
  const key = stack.rig.accounts.sender.address.toLowerCase();
  try {
    for (const readable of [true, false]) {
      // The copy: the schema alone, as a database stands before any courier has run on it.
      const made = await stack.db.createWithSchema(`restored_empty_${readable ? 'read' : 'unread'}`);
      const pool = new pg.Pool({ connectionString: made.url, max: 2 });
      pools.push(pool);
      await stopAll();
      // The shut's own read of the relay's sender refused, and only it: the operator's read of the set, which reads the
      // same sender first, passes.
      const senderCall = encodeFunctionData({ abi: stack.rig.abis.OspexCourierRelay as Abi, functionName: 's_sender' }).toLowerCase();
      let senderReads = 0;
      if (!readable) {
        stack.proxy.rule('eth_call', {
          kind: 'refuseIf',
          refuse: (p) => {
            const c = p[0] as { to?: string; data?: string };
            if (String(c.to ?? '').toLowerCase() !== stack.rig.addresses.relay.toLowerCase() || String(c.data ?? '').toLowerCase() !== senderCall) return false;
            senderReads += 1;
            return senderReads > 1;
          },
          code: -32000,
          message: 'the node could not answer',
        });
      }
      let shut: { out: string; status: number | null };
      try {
        shut = await operator(made.url, ['shut', '--copy-time', new Date().toISOString()]);
      } finally {
        if (!readable) stack.proxy.rule('eth_call', null);
      }
      assert.equal(shut.status, 0, shut.out);
      const hold = Number(/restore's incident is line (\d+)/.exec(shut.out)?.[1]);
      const lanes = (await pool.query<{ sender: string; shut_line: string | null }>('SELECT sender, shut_line::text AS shut_line FROM lanes')).rows;
      if (readable) assert.deepEqual(lanes, [{ sender: key, shut_line: String(hold) }], "the relay's sender's lane, made under the hold");
      else {
        assert.deepEqual(lanes, [], 'no lane made from a sender not read');
        assert.match(shut.out, /could not be read, and sending is held all the same/);
      }
      const before = { s: signed(), h: handOffs() };
      const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: made.url });
      extra.push(courier);
      const lane = await until(async () => (await pool.query<{ shut_line: string | null }>('SELECT shut_line::text AS shut_line FROM lanes WHERE sender = $1', [key])).rows, (r) => r.length === 1, 30_000, "the courier's lane");
      assert.equal(lane[0]?.shut_line, String(hold), 'shut by the restore\'s line');
      const refused = await bet(await fresh(), courier.url);
      assert.equal(refused.status, 503, JSON.stringify(refused.body));
      assert.equal(refused.body.code, 'NOT_TAKING_BETS');
      assert.equal(await zeroReservations(pool), '0');
      assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 });
      await stopAll();
    }
  } finally {
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a copy older than a bet's admission, the bet since settled with a part of it filled: its exact signed order, posted again after a rotation to a new key, is not admitted on the restored database, and nothing is reserved, signed or handed off", async () => {
  await backToTheOriginal();
  const oldKey = stack.rig.accounts.sender.address;
  const copy = await copyDatabase('restored_before_bet');
  // B, after the copy: sent and confirmed with a part of it filled, a terminal outcome.
  const M = await fresh();
  const T = await stack.rig.time();
  const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 4_800n }), positionType: 0 };
  assert.equal((await postOrder(url(), stack.rig, M, 'rest', q)).status, 201);
  const B = await fresh();
  const order: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const posted = await postOrder(url(), stack.rig, B, 'take', order);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const hash = String(posted.body.orderHash).toLowerCase();
  await until(() => crossState(original, hash), (s) => s === 'confirmed', 60_000, 'B confirmed');
  const filled = ((await original.query<{ recorded: { betFilled: string } }>('SELECT recorded FROM crosses WHERE bet_hash = $1', [hash])).rows[0] as { recorded: { betFilled: string } }).recorded.betFilled;
  assert.ok(BigInt(filled) > 0n && BigInt(filled) < order.riskAmount, `a part filled: ${filled}`);
  await stopAll();
  try {
    const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
    assert.equal(shut.status, 0, shut.out);
    const K2 = stack.rig.account(34);
    await setRelaySender(K2.address);
    const store = testKeystoreFor(K2.address);
    assert.ok(store !== null);
    const before = { s: signed(), h: handOffs() };
    const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: copy.url, COURIER_ADDRESS: K2.address, COURIER_KEYSTORE_JSON: store.json, COURIER_KEYSTORE_PASSWORD: store.password });
    extra.push(courier);
    const again = await postOrder(courier.url, stack.rig, B, 'take', order);
    // Not admitted: the chain shows its stake used by its Cross, and the door refuses it there, before the hold.
    assert.equal(again.status, 422, JSON.stringify(again.body));
    assert.equal(again.body.code, 'FILLED');
    assert.equal((await copy.pool.query('SELECT 1 FROM orders WHERE hash = $1', [hash])).rows.length, 0, 'not admitted: no row');
    assert.equal(await zeroReservations(copy.pool), '0');
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 });
  } finally {
    await setRelaySender(oldKey);
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a copy taken at the bet's signed record: the take on the restored database does not close it not sent; released, its transaction is reconciled by the hash the copy kept, and the Cross reads the chain's outcome with the hand-offs the copy kept, while the hold stands", async () => {
  await backToTheOriginal();
  const hooks = stack.courier.hooks as HookControl;
  await quote(await fresh(), url());
  await hooks.arm('after-signed-record', 1);
  const b = await bet(await fresh(), url());
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const held = await hooks.reached('after-signed-record');
  const copy = await copyDatabase('restored_signed');
  const kept = (await copy.pool.query<{ state: string; tx_hash: string | null; hand_offs: number }>('SELECT state, tx_hash, hand_offs FROM crosses WHERE bet_hash = $1', [b.hash.toLowerCase()])).rows[0];
  assert.equal(kept?.state, 'signed');
  assert.ok(kept?.tx_hash !== null);
  const withheld = stack.proxy.withhold();
  try {
    await hooks.go(held);
    await until(() => crossState(original, b.hash), (s) => s === 'sent', 30_000, 'B sent');
    await stopAll();
    const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
    assert.equal(shut.status, 0, shut.out);
    const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: copy.url });
    extra.push(courier);
    await new Promise((r) => setTimeout(r, 3_000));
    assert.notEqual(await crossState(copy.pool, b.hash), 'not sent', 'the take does not close a restored signed row not sent');
    await withheld.forward();
    await until(() => crossState(copy.pool, b.hash), (s) => s === 'confirmed', 90_000, 'reconciled by its hash');
    const row = (await copy.pool.query<{ tx_hash: string | null; hand_offs: number }>('SELECT tx_hash, hand_offs FROM crosses WHERE bet_hash = $1', [b.hash.toLowerCase()])).rows[0];
    assert.deepEqual(row, { tx_hash: kept?.tx_hash, hand_offs: kept?.hand_offs }, 'the hash and the hand-offs the copy kept');
    assert.equal(await zeroReservations(copy.pool), '0', 'the hold stands');
  } finally {
    withheld.stop();
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a copy taken at the bet's intent, its transaction never reaching the chain: before the bet's expiry the recovery leaves it unresolved, and past it while the bet's total at the final block cannot be read; with the search complete, the final block past the expiry and the total read there, it is expired unmined with the hand-offs the copy kept; a retained waiting bet with no Cross gets its ACTION once", async () => {
  await backToTheOriginal();
  const hooks = stack.courier.hooks as HookControl;
  await quote(await fresh(), url());
  await hooks.arm('after-intent', 1);
  const b = await bet(await fresh(), url());
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const held = await hooks.reached('after-intent');
  const w = await bet(await fresh(), url());
  assert.equal(w.status, 202, JSON.stringify(w.body));
  const copy = await copyDatabase('restored_intent');
  assert.equal(await crossState(copy.pool, b.hash), 'intent');
  assert.equal(await crossState(copy.pool, w.hash), null, 'the waiting bet has no Cross');
  const withheld = stack.proxy.withhold();
  const totalOf = encodeFunctionData({ abi: stack.rig.abis.OspexMatching as Abi, functionName: 's_filledRisk', args: [b.hash] }).slice(2).toLowerCase();
  try {
    await hooks.go(held);
    await until(() => crossState(original, b.hash), (s) => s === 'sent', 30_000, 'B sent');
    await stopAll();
    // B's transaction never reaches the chain.
    withheld.stop();
    const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
    assert.equal(shut.status, 0, shut.out);
    const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: copy.url });
    extra.push(courier);
    await new Promise((r) => setTimeout(r, 4_000));
    assert.equal(await crossState(copy.pool, b.hash), 'intent', 'unresolved before the expiry');
    // Past the expiry, with the bet's total at the final block refused by the node: still unresolved.
    stack.proxy.rule('eth_call', { kind: 'refuseIf', refuse: (p) => JSON.stringify(p).toLowerCase().includes(totalOf), code: -32000, message: 'the node could not answer' });
    await stack.rig.increaseTime(40n);
    await stack.rig.mine(2);
    await until(() => Promise.resolve(courier.lines.some((l) => /the bet's total filled at the final block|a read at the final block failed twice/.test(l))), (v) => v, 60_000, 'the recovery says what it lacks');
    assert.equal(await crossState(copy.pool, b.hash), 'intent', 'unresolved while the total is missing');
    stack.proxy.rule('eth_call', null);
    await until(() => crossState(copy.pool, b.hash), (s) => s === 'expired unmined', 90_000, 'expired unmined');
    const line = (await copy.pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'cross expired unmined' AND bet_hash = $1`, [b.hash.toLowerCase()])).rows;
    assert.equal(line.length, 1);
    assert.deepEqual({ restored: line[0]?.facts.restored, handOffs: line[0]?.facts.handOffs, txHash: line[0]?.facts.txHash }, { restored: 'intent', handOffs: 0, txHash: null });
    const actions = async () => (await copy.pool.query(`SELECT 1 FROM events WHERE bet_hash = $1 AND facts->'action'->>'case' = 'unresolved-after-expiry'`, [w.hash.toLowerCase()])).rows.length;
    await until(actions, (n) => n === 1, 60_000, "the waiting bet's ACTION");
    await new Promise((r) => setTimeout(r, 4_000));
    assert.equal(await actions(), 1, 'once');
    assert.equal(await zeroReservations(copy.pool), '0', 'the hold stands');
  } finally {
    stack.proxy.rule('eth_call', null);
    withheld.stop();
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a stop recorded after the copy: lost with the restore, the stated exception, and its window on the restore's incident, the copy's time and the database's time at the shut; on the restored database nothing is sent", async () => {
  await backToTheOriginal();
  const M = await fresh();
  const q = await quote(M, url());
  const copy = await copyDatabase('restored_stop');
  const copiedAt = new Date().toISOString();
  // M's stop, recorded on the database that goes on, after the copy.
  const stop = await postStop(url(), stack.rig, M, stopMessage(M.address, [q as Hex]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  await stopAll();
  try {
    const shut = await operator(copy.url, ['shut', '--copy-time', copiedAt]);
    assert.equal(shut.status, 0, shut.out);
    const incident = (await copy.pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'incident' AND reason = 'RESTORE_SHUT'`)).rows[0];
    assert.equal(incident?.facts.copyTime, copiedAt, "the window's start, as the operator gives it");
    assert.ok(Date.parse(String(incident?.facts.databaseTime)) >= Date.parse(copiedAt), "and the database's own time at the shut");
    assert.equal((await copy.pool.query('SELECT 1 FROM stops WHERE hash = $1', [q.toLowerCase()])).rows.length, 0, 'the stop is not on the restored database');
    assert.equal((await original.query('SELECT 1 FROM stops WHERE hash = $1', [q.toLowerCase()])).rows.length, 1, 'it stands on the one that went on');
    const before = { s: signed(), h: handOffs() };
    const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: copy.url });
    extra.push(courier);
    const refused = await bet(await fresh(), courier.url);
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(await zeroReservations(copy.pool), '0');
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 });
  } finally {
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});
