import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, type Abi, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { MULTICALL_ABI, RELAY_SENDER_SLOT } from '../courier/chain/abi';
import { coinAmount } from '../courier/orders/order';
import { get, startHookedCourier, type CourierProcess, type HookControl } from './support/courier';
import { testKeystoreFor } from './support/keystore';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { closeEach } from './support/close';
import { nodeText } from './support/named';
import { startStack, type Stack } from './support/stack';
import { postStop as postStopFrom, stopMessage } from './support/stops';
import { startTcpRelay, type TcpRelay } from './support/tcp';

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
  stack = await startStack('restore', {
    hooked: true,
    blockTime: 2,
    sending: true,
    sendsApart: { copies: "this file's couriers on copies of the database send through the stack's proxy and keep their records in the copies" },
  });
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

test("a copy taken while the node's named error is the answer on record, the chain having taken the request: the take on the restored database leaves the Cross unknown with the error's fixed words; under the restore's hold its courier settles it confirmed from the chain by the hash the copy kept, with the hand-offs and the answer the copy kept, and signs and hands off nothing; the hold stands", async () => {
  await backToTheOriginal();
  await quote(await fresh(), url());
  // The final block held and the receipt not given, so the original records the answer and cannot settle.
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string));
  stack.proxy.rule('eth_getTransactionReceipt', { kind: 'answer', result: () => null });
  const named = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText('nonce too low') });
  let b!: { status: number; hash: string; body: Record<string, unknown> };
  try {
    b = await bet(await fresh(), url());
    assert.equal(b.status, 202, JSON.stringify(b.body));
    await until(() => crossState(original, b.hash), (s) => s !== null && !['intent', 'signed', 'handing off'].includes(s), 30_000, 'the answer recorded');
    assert.equal(named.forwarded.length, 1, 'the chain had the request');
  } finally {
    named.stop();
  }
  try {
    const copy = await copyDatabase('restored_named');
    const kept = (await copy.pool.query<{ state: string; tx_hash: string | null; hand_offs: number; node_answer: unknown }>('SELECT state, tx_hash, hand_offs, node_answer FROM crosses WHERE bet_hash = $1', [b.hash.toLowerCase()])).rows[0];
    assert.deepEqual([kept?.state, kept?.hand_offs, kept?.node_answer], ['unknown', 1, { kind: 'unknown', words: 'nonce too low' }], JSON.stringify(kept));
    await stopAll();
    const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
    assert.equal(shut.status, 0, shut.out);
    const sends = stack.proxy.count('eth_sendRawTransaction');
    const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: copy.url });
    extra.push(courier);
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(await crossState(copy.pool, b.hash), 'unknown', 'the take leaves it unknown');
    stack.proxy.rule('eth_getTransactionReceipt', null);
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
    await until(() => crossState(copy.pool, b.hash), (s) => s === 'confirmed', 90_000, 'settled from the chain by its hash');
    const row = (await copy.pool.query<{ tx_hash: string | null; hand_offs: number; node_answer: unknown }>('SELECT tx_hash, hand_offs, node_answer FROM crosses WHERE bet_hash = $1', [b.hash.toLowerCase()])).rows[0];
    assert.deepEqual(row, { tx_hash: kept?.tx_hash, hand_offs: kept?.hand_offs, node_answer: kept?.node_answer }, 'the hash, the hand-offs and the answer the copy kept');
    assert.deepEqual({ signed: courier.hooks.signed.length, sends: stack.proxy.count('eth_sendRawTransaction') - sends }, { signed: 0, sends: 0 }, 'nothing signed or handed off under the hold');
    assert.equal(await zeroReservations(copy.pool), '0', 'the hold stands');
  } finally {
    stack.proxy.rule('eth_getTransactionReceipt', null);
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
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

/** A transaction of `who`, signed here and sent to the chain's pool at this tip, not waited for. */
async function sendFrom(who: HDAccount, to: Hex, data: Hex, tip: bigint): Promise<Hex> {
  const nonce = Number(BigInt((await stack.rig.rpc('eth_getTransactionCount', [who.address, 'pending'])) as string));
  const block = (await stack.rig.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
  const raw = await who.signTransaction({ type: 'eip1559', chainId: 31337, to, data, value: 0n, nonce, gas: 200_000n, maxFeePerGas: BigInt(block.baseFeePerGas) * 3n + tip, maxPriorityFeePerGas: tip });
  return (await stack.rig.rpc('eth_sendRawTransaction', [raw])) as Hex;
}

interface Found {
  bet: string;
  B: HDAccount;
  quote: string;
  copy: { url: string; pool: pg.Pool };
  /** The Cross as the database that went on settled it, by the ordinary path. */
  settled: { state: string; txHash: string; recorded: Record<string, unknown> };
  /** Each listed quote's mark on the database that went on, after the ordinary path's outcome. */
  marks: Array<{ hash: string; ended: string | null; ended_final: boolean }>;
}

/**
 * A found intent's set-up: the copy taken while B's Cross is at its intent on the database that goes on; that courier
 * then sends B, which fills, or, with `revert`, reverts by B's own allowance taken back in the Cross's block and before
 * it; every courier stopped, and the operator's shut on the copy. The copy's courier is the case's to start.
 */
async function foundIntent(prefix: string, revert = false): Promise<Found> {
  await backToTheOriginal();
  const hooks = stack.courier.hooks as HookControl;
  const listed = await quote(await fresh(), url());
  await hooks.arm('after-intent', 1);
  if (revert) {
    await hooks.arm('after-gate', 1);
    await hooks.arm('after-hand-off', 1);
  }
  const B = await fresh();
  const b = await bet(B, url());
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const atIntent = await hooks.reached('after-intent');
  const copy = await copyDatabase(prefix);
  assert.equal(await crossState(copy.pool, b.hash), 'intent');
  await hooks.go(atIntent);
  if (revert) {
    const gate = await hooks.reached('after-gate');
    await stack.rig.rpc('evm_setIntervalMining', [0]);
    await hooks.go(gate);
    const handed = await hooks.reached('after-hand-off');
    try {
      await sendFrom(B, stack.rig.addresses.coin, encodeFunctionData({ abi: stack.rig.abis.TestCoin as Abi, functionName: 'approve', args: [stack.rig.addresses.positions, 0n] }), 50_000_000_000n);
      await stack.rig.rpc('anvil_mine', ['0x1']);
    } finally {
      await stack.rig.rpc('evm_setIntervalMining', [2]);
      await hooks.go(handed);
    }
  }
  const state = await until(() => crossState(original, b.hash), (s) => s === (revert ? 'reverted' : 'confirmed'), 90_000, 'B settled on the database that went on');
  const row = (await original.query<{ tx_hash: string; recorded: Record<string, unknown> }>('SELECT tx_hash, recorded FROM crosses WHERE bet_hash = $1', [b.hash.toLowerCase()])).rows[0] as { tx_hash: string; recorded: Record<string, unknown> };
  const marks = (await original.query<{ hash: string; ended: string | null; ended_final: boolean }>('SELECT o.hash, o.ended, o.ended_final FROM legs l JOIN orders o ON o.hash = l.order_hash WHERE l.bet_hash = $1 ORDER BY l.position', [b.hash.toLowerCase()])).rows;
  await stopAll();
  const shut = await operator(copy.url, ['shut', '--copy-time', new Date().toISOString()]);
  assert.equal(shut.status, 0, shut.out);
  return { bet: b.hash, B, quote: listed, copy, settled: { state: String(state), txHash: row.tx_hash, recorded: row.recorded }, marks };
}

/** One listed quote's mark on the copy, by hash. */
const copyMarks = async (f: Found) =>
  (await f.copy.pool.query<{ hash: string; ended: string | null; ended_final: boolean }>('SELECT o.hash, o.ended, o.ended_final FROM legs l JOIN orders o ON o.hash = l.order_hash WHERE l.bet_hash = $1 ORDER BY l.position', [f.bet.toLowerCase()])).rows;
const conflicts = async (f: Found) => (await f.copy.pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'incident' AND reason = 'CHAIN_CONTRADICTS_RECORDS' AND bet_hash = $1`, [f.bet.toLowerCase()])).rows;
const outcomeLines = async (f: Found) => (await f.copy.pool.query(`SELECT 1 FROM events WHERE kind IN ('cross confirmed', 'cross reverted') AND bet_hash = $1`, [f.bet.toLowerCase()])).rows.length;

/** The copy's lanes as they stand: what each holds and under which reservation. */
const lanesOf = async (pool: pg.Pool) => (await pool.query<{ sender: string; reservation: string | null; held_bet: string | null }>('SELECT sender, reservation::text AS reservation, held_bet FROM lanes ORDER BY sender')).rows;

/**
 * While the found intent is unresolved on the copy: no outcome, no mark, no line, the hand-offs the copy kept, and
 * nothing reserved, signed or handed off: the lanes hold only what the copy held when its courier started, the
 * retained intent's reservation among it.
 */
async function unresolvedAndHeld(f: Found, before: { s: number; h: number; lanes: Awaited<ReturnType<typeof lanesOf>> }): Promise<void> {
  const row = (await f.copy.pool.query<{ state: string; hand_offs: number; tx_hash: string | null }>('SELECT state, hand_offs, tx_hash FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0];
  assert.deepEqual(row, { state: 'intent', hand_offs: 0, tx_hash: null }, 'unresolved, with nothing associated');
  assert.ok((await copyMarks(f)).every((m) => m.ended === null), `no mark: ${JSON.stringify(await copyMarks(f))}`);
  assert.equal(await outcomeLines(f), 0, 'no outcome line');
  assert.deepEqual(await lanesOf(f.copy.pool), before.lanes, 'no new reservation: the lanes hold what the copy held');
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 }, 'nothing signed or handed off');
}

/** The found intent settled on the copy as the database that went on settled it: the record, the marks, the served amount and cash. */
async function settledAsTheOriginal(f: Found, courier: CourierProcess): Promise<void> {
  const row = (await f.copy.pool.query<{ state: string; recorded: Record<string, unknown>; hand_offs: number; tx_hash: string | null }>('SELECT state, recorded, hand_offs, tx_hash FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0];
  const recorded = row?.recorded as Record<string, unknown>;
  assert.equal(row?.state, f.settled.state);
  assert.equal(row?.tx_hash, f.settled.txHash, 'the found transaction associated');
  assert.equal(row?.hand_offs, 0, 'the hand-offs the copy kept');
  for (const k of ['totals', 'pulls', 'paysBack', 'paysBackRefused', 'skipped', 'marketCreated']) assert.deepEqual(recorded[k], f.settled.recorded[k], `the record's ${k}`);
  assert.deepEqual(await copyMarks(f), f.marks, "the listed quotes' marks, as the ordinary path made them");
  const served = await get(courier.url, `/v1/orders/${f.bet}`);
  const cross = served.body.cross as Record<string, unknown>;
  const filled = coinAmount(BigInt((f.settled.recorded.totals as { taker: string }).taker), 6);
  assert.ok(String(cross.message).includes(`It filled ${filled} USDC of this bet's`), String(cross.message));
  assert.deepEqual(cross.recordedPulls, f.settled.recorded.pulls, 'the cash the receipt moved, served');
  assert.equal(await zeroReservations(f.copy.pool), '0', 'the hold stands');
}

/** The copy's courier started, with the signatures and hand-offs counted from its start; through `relay` where one is given, so its commands are counted. */
async function startOnCopy(f: Found, relay?: TcpRelay): Promise<{ courier: CourierProcess & { hooks: HookControl }; before: { s: number; h: number; lanes: Awaited<ReturnType<typeof lanesOf>> } }> {
  const before = { s: signed(), h: handOffs(), lanes: await lanesOf(f.copy.pool) };
  const through = new URL(f.copy.url);
  if (relay !== undefined) {
    through.hostname = '127.0.0.1';
    through.port = String(relay.port);
  }
  const courier = await startHookedCourier({ ...stack.env, DATABASE_URL: through.toString() });
  extra.push(courier);
  return { courier, before };
}

test("a copy taken at the bet's intent, its transaction then sent and filled by the courier that went on: found by the search, the restored Cross is settled as any Cross is, with the receipt's totals, pulls and pay-backs, its quotes marked at the final block as the ordinary path marked them, and the bet told what this transaction filled; the hand-offs the copy kept, and the hold stands", async () => {
  const f = await foundIntent('restored_found');
  // The copy reached through a relay of its own, so the first start's commands are counted as the stack's are.
  const relay = await startTcpRelay(Number(new URL(f.copy.url).port === '' ? 5432 : new URL(f.copy.url).port));
  try {
    // The first start after a restore, and the search across the gap from the intent's block, measured: the requests
    // to the node at the proxy, by method, and the commands at the relay; no other courier runs meanwhile.
    const at = { requests: stack.proxy.counted.length, commands: relay.commands() };
    const { courier, before } = await startOnCopy(f, relay);
    const started = { requests: stack.proxy.counted.length, commands: relay.commands() };
    await until(() => crossState(f.copy.pool, f.bet), (s) => s === 'confirmed', 90_000, 'the found intent settled');
    const settled = { requests: stack.proxy.counted.length, commands: relay.commands() };
    await settledAsTheOriginal(f, courier);
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 }, 'nothing signed or handed off');
    const byMethod = (from: number, to: number) => {
      const out: Record<string, number> = {};
      for (const r of stack.proxy.counted.slice(from, to)) out[r.method] = (out[r.method] ?? 0) + 1;
      return out;
    };
    const window = stack.proxy.counted.slice(at.requests, settled.requests);
    const numbered = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{1,16}$/i.test(v);
    const kept = (await f.copy.pool.query<{ block_number: string; recorded: { final?: { number?: string } } }>('SELECT block_number::text AS block_number, recorded FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0];
    // The search's steps: a header read by its height, then the key's count at that header's hash; then the block found, in full.
    const search = {
      gapInBlocks: Number(BigInt(String(kept?.recorded.final?.number ?? '0')) - BigInt(kept?.block_number ?? '0')),
      headersByHeight: window.filter((r) => r.method === 'eth_getBlockByNumber' && numbered(r.params?.[0]) && r.params?.[1] !== true).length,
      countsAtABlocksHash: window.filter((r) => r.method === 'eth_getTransactionCount' && typeof r.params?.[1] === 'object' && r.params?.[1] !== null).length,
      blocksReadInFull: window.filter((r) => r.method === 'eth_getBlockByNumber' && r.params?.[1] === true).length,
    };
    console.log(`# the first start after a restore, measured: ${JSON.stringify({ start: { requests: started.requests - at.requests, byMethod: byMethod(at.requests, started.requests), commands: started.commands - at.commands }, toSettled: { requests: settled.requests - started.requests, byMethod: byMethod(started.requests, settled.requests), commands: settled.commands - started.commands } })}`);
    console.log(`# the search across a gap, measured: ${JSON.stringify(search)}`);
    assert.ok(search.headersByHeight > 0 && search.blocksReadInFull > 0, `the search ran in the window: ${JSON.stringify(search)}`);
  } finally {
    await stopAll();
    await relay.close();
    await stack.restartCourier({ hooked: true });
  }
});

test("a copy taken at the bet's intent, its transaction then sent by the courier that went on and reverted by the bettor's own allowance taken back in the same block: found by the search, the restored Cross is reverted with the reason one trace gives, pinned on the bettor, with the gas it paid on its line, and no quote marked; the hand-offs the copy kept, and the hold stands", async () => {
  const f = await foundIntent('restored_found_reverted', true);
  try {
    const { before } = await startOnCopy(f);
    await until(() => crossState(f.copy.pool, f.bet), (s) => s === 'reverted', 90_000, 'the found intent settled');
    const row = (await f.copy.pool.query<{ revert_reason: string | null; revert_evidence: string | null; hand_offs: number }>('SELECT revert_reason, revert_evidence, hand_offs FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0];
    assert.deepEqual([row?.revert_reason, row?.revert_evidence], ['TakerPullRefused', 'trace'], JSON.stringify(row));
    const line = (await f.copy.pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'cross reverted' AND bet_hash = $1`, [f.bet.toLowerCase()])).rows[0]?.facts;
    assert.deepEqual(line?.pinnedOn, [{ account: f.B.address, role: 'bettor', act: 'its approval to the positions contract was too low' }], JSON.stringify(line));
    assert.equal(typeof line?.gasUsed, 'string', 'the gas paid, on its line');
    assert.equal(row?.hand_offs, 0, 'the hand-offs the copy kept');
    assert.ok((await copyMarks(f)).every((m) => m.ended === null), 'no quote marked for a reverted Cross');
    assert.equal(await zeroReservations(f.copy.pool), '0', 'the hold stands');
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 }, 'nothing signed or handed off');
  } finally {
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

for (const wrong of ['transaction hash', 'block number'] as const) {
  test(`a found intent whose receipt the node answers with the wrong ${wrong}, every other field whole: the evidence conflicts with what the search found; an incident line, once, and the intent stays unresolved, with no mark, no outcome and nothing sent; answered as asked at a later look, it is settled as the database that went on settled it`, async () => {
    const f = await foundIntent(`restored_found_${wrong === 'transaction hash' ? 'hash' : 'block'}`);
    const other = `0x${'cd'.repeat(32)}`;
    stack.proxy.rule('eth_getTransactionReceipt', {
      kind: 'rewriteResult',
      result: (p, result) => {
        if (String(p[0]).toLowerCase() !== f.settled.txHash.toLowerCase() || result === null) return result;
        const r = result as { blockNumber: Hex; logs: Array<Record<string, unknown>> };
        if (wrong === 'transaction hash') return { ...r, transactionHash: other, logs: r.logs.map((l) => ({ ...l, transactionHash: other })) };
        return { ...r, blockNumber: `0x${(BigInt(r.blockNumber) + 1n).toString(16)}`, logs: r.logs.map((l) => ({ ...l, blockNumber: `0x${(BigInt(r.blockNumber) + 1n).toString(16)}` })) };
      },
    });
    try {
      const { courier, before } = await startOnCopy(f);
      await until(async () => (await conflicts(f)).length > 0 || (await crossState(f.copy.pool, f.bet)) !== 'intent', (v) => v, 90_000, 'the conflict recorded, or an outcome');
      assert.equal(await crossState(f.copy.pool, f.bet), 'intent', 'no outcome from evidence that conflicts with the search');
      const found = await conflicts(f);
      assert.match(String(found[0]?.facts.why), wrong === 'transaction hash' ? /of another transaction/ : /not the block the search found/);
      await unresolvedAndHeld(f, before);
      stack.proxy.rule('eth_getTransactionReceipt', null);
      await until(() => crossState(f.copy.pool, f.bet), (s) => s === 'confirmed', 90_000, 'settled once the node answers as asked');
      await settledAsTheOriginal(f, courier);
      assert.equal((await conflicts(f)).length, 1, 'the incident once');
    } finally {
      stack.proxy.rule('eth_getTransactionReceipt', null);
      await stopAll();
      await stack.restartCourier({ hooked: true });
    }
  });
}

test("a found intent whose bet's total at the final block the node cannot give, twice: the intent stays unresolved, with no mark, no outcome and nothing sent; given at a later look, it is settled whole; and a listed quote the copy holds stopped is left stopped", async () => {
  const f = await foundIntent('restored_found_total');
  const totalOf = encodeFunctionData({ abi: stack.rig.abis.OspexMatching as Abi, functionName: 's_filledRisk', args: [f.bet as Hex] }).slice(2).toLowerCase();
  // The case's own quote, stopped on the copy: a mark the ordinary rules leave alone.
  await f.copy.pool.query(`UPDATE orders SET ended = 'stopped', ended_at = now() WHERE hash = $1`, [f.quote.toLowerCase()]);
  let refused = 0;
  stack.proxy.rule('eth_call', { kind: 'refuseIf', refuse: (p) => JSON.stringify(p).toLowerCase().includes(totalOf) && (refused++, true), code: -32000, message: 'the node could not answer' });
  try {
    const { courier, before } = await startOnCopy(f);
    await until(async () => refused, (n) => n >= 2, 90_000, "the bet's total refused twice");
    await until(async () => courier.lines.some((l) => /not yet reconciled: .*failed twice/.test(l)), (v) => v, 60_000, 'the recovery says what it lacks');
    const row = (await f.copy.pool.query<{ state: string; hand_offs: number }>('SELECT state, hand_offs FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0];
    assert.deepEqual(row, { state: 'intent', hand_offs: 0 });
    assert.ok((await copyMarks(f)).every((m) => m.ended === null || m.hash === f.quote.toLowerCase()), 'no mark while the total is missing');
    assert.equal(await outcomeLines(f), 0, 'no outcome line');
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 }, 'nothing signed or handed off');
    stack.proxy.rule('eth_call', null);
    await until(() => crossState(f.copy.pool, f.bet), (s) => s === 'confirmed', 90_000, 'settled once the total is given');
    const recorded = (await f.copy.pool.query<{ recorded: Record<string, unknown> }>('SELECT recorded FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0]?.recorded as Record<string, unknown>;
    assert.deepEqual(recorded.totals, f.settled.recorded.totals, 'the record whole');
    const stopped = (await f.copy.pool.query<{ ended: string | null }>('SELECT ended FROM orders WHERE hash = $1', [f.quote.toLowerCase()])).rows[0];
    assert.equal(stopped?.ended, 'stopped', 'the quote held stopped is left stopped');
    assert.equal(await zeroReservations(f.copy.pool), '0', 'the hold stands');
  } finally {
    stack.proxy.rule('eth_call', null);
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a found intent whose bet's total at the final block falls short of what its receipt filled: the chain's own state contradicts the receipt; an incident line, once, and the intent stays unresolved, with no mark, no outcome and nothing sent", async () => {
  const f = await foundIntent('restored_found_short');
  const totalOf = encodeFunctionData({ abi: stack.rig.abis.OspexMatching as Abi, functionName: 's_filledRisk', args: [f.bet as Hex] }).toLowerCase();
  stack.proxy.rule('eth_call', {
    kind: 'rewriteResult',
    result: (p, result) => {
      const data = String((p[0] as { data?: string }).data ?? '').toLowerCase();
      if (!data.includes(totalOf.slice(2)) || typeof result !== 'string') return result;
      try {
        const calls = (decodeFunctionData({ abi: MULTICALL_ABI, data: data as Hex }).args[0] ?? []) as ReadonlyArray<{ callData: Hex }>;
        const at = calls.findIndex((c) => c.callData.toLowerCase() === totalOf);
        if (at < 0) return result;
        const answers = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result as Hex }) as ReadonlyArray<{ success: boolean; returnData: Hex }>;
        return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', result: answers.map((a, i) => (i === at ? { success: a.success, returnData: `0x${'0'.repeat(64)}` } : a)) } as never);
      } catch {
        return result;
      }
    },
  });
  try {
    const { before } = await startOnCopy(f);
    await until(async () => (await conflicts(f)).length > 0 || (await crossState(f.copy.pool, f.bet)) !== 'intent', (v) => v, 90_000, 'the contradiction recorded, or an outcome');
    assert.equal(await crossState(f.copy.pool, f.bet), 'intent', 'no outcome from a receipt the chain contradicts');
    const found = await conflicts(f);
    assert.match(String(found[0]?.facts.why), /filled amount at the final block is below/);
    await unresolvedAndHeld(f, before);
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal((await conflicts(f)).length, 1, 'the incident once, look after look');
  } finally {
    stack.proxy.rule('eth_call', null);
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a found intent recovered by two processes on the copy, the first of them overtaken by the second's start while it reads the receipt: the stale owner writes nothing, and the Cross is settled once, with one outcome line and the hand-offs the copy kept", async () => {
  const f = await foundIntent('restored_found_two');
  const held = stack.proxy.hold('eth_getTransactionReceipt', (p) => String(p[0]).toLowerCase() === f.settled.txHash.toLowerCase());
  try {
    const { courier: first } = await startOnCopy(f);
    await held.arrived;
    // The second process's start raises every lane's epoch: the first, held at its read of the receipt, is overtaken.
    const { courier: second } = await startOnCopy(f);
    held.release();
    await until(() => crossState(f.copy.pool, f.bet), (s) => s === 'confirmed', 90_000, 'settled once');
    await until(async () => first.lines.some((l) => /not written by this process: the lane is not this process's now/.test(l)), (v) => v, 60_000, 'the stale owner wrote nothing');
    assert.equal(await outcomeLines(f), 1, 'one outcome line');
    await settledAsTheOriginal(f, second);
  } finally {
    held.release();
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});

test("a copy taken at the bet's intent, its transaction then sent and filled by the courier that went on, and 300 blocks mined before the restored courier starts: the watermark's anchor, the search's lower anchor and the block it finds lie more than 256 blocks below F, each read by number, with F's own height read again before recovery writes; the restored Cross is settled confirmed as any Cross is, nothing signed or handed off, and the hold stands", async () => {
  const f = await foundIntent('restored_found_deep');
  try {
    const anchor = BigInt(String((await f.copy.pool.query<{ n: string }>('SELECT verified_block_number::text AS n FROM lanes WHERE sender = $1', [stack.rig.accounts.sender.address.toLowerCase()])).rows[0]?.n));
    const found = BigInt(((await stack.rig.rpc('eth_getTransactionReceipt', [f.settled.txHash])) as { blockNumber: Hex }).blockNumber);
    await stack.rig.rpc('evm_setIntervalMining', [0]);
    await stack.rig.rpc('anvil_mine', ['0x12c', '0x2']);
    await stack.rig.rpc('evm_setIntervalMining', [2]);
    const from = stack.proxy.counted.length;
    const { before } = await startOnCopy(f);
    await until(() => crossState(f.copy.pool, f.bet), (s) => s === 'confirmed', 120_000, 'the found intent settled');
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 }, 'nothing signed or handed off');
    const F = BigInt(String((await f.copy.pool.query<{ n: string }>('SELECT final_block_number::text AS n FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0]?.n));
    assert.ok(F - anchor > 256n && F - found > 256n, `the anchor and the found block more than 256 below F: ${JSON.stringify({ anchor: String(anchor), found: String(found), F: String(F) })}`);
    const read = stack.proxy.counted
      .slice(from)
      .filter((r) => r.method === 'eth_getBlockByNumber' && typeof r.params?.[0] === 'string' && /^0x[0-9a-fA-F]+$/.test(r.params[0] as string) && r.params?.[1] !== true)
      .map((r) => BigInt(r.params?.[0] as string));
    assert.ok(read.includes(anchor), "the watermark's anchor, the search's lower anchor, read by number");
    assert.ok(read.includes(found), 'the block the search found read by number');
    assert.ok(read.includes(F), "F's own height read again");
    // The reconciliation shows the watermark's anchor on F's chain before it reads the key's count at F, as its first
    // read at F after F itself; the search, which reads the same anchor in the same decision, comes after the count.
    const window = stack.proxy.counted.slice(from);
    const Fhash = String((await f.copy.pool.query<{ h: string }>('SELECT final_block_hash AS h FROM crosses WHERE bet_hash = $1', [f.bet.toLowerCase()])).rows[0]?.h).toLowerCase();
    const anchorAt = window.findIndex((r) => r.method === 'eth_getBlockByNumber' && typeof r.params?.[0] === 'string' && /^0x[0-9a-fA-F]+$/.test(r.params[0] as string) && BigInt(r.params[0] as string) === anchor);
    const countAt = window.findIndex((r) => r.method === 'eth_getTransactionCount' && String((r.params?.[1] as { blockHash?: string } | undefined)?.blockHash).toLowerCase() === Fhash);
    assert.ok(anchorAt >= 0 && countAt >= 0 && anchorAt < countAt, `the anchor read before the count at F: ${JSON.stringify({ anchorAt, countAt })}`);
    const hold = await f.copy.pool.query(`SELECT 1 FROM events WHERE kind = 'incident' AND reason = 'RESTORE_SHUT'`);
    assert.equal(hold.rowCount, 1, 'the hold stands');
  } finally {
    await stopAll();
    await stack.restartCourier({ hooked: true });
  }
});
