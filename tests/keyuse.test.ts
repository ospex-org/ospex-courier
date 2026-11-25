import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type Abi, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { RELAY_ABI } from '../courier/chain/abi';
import { orderHash, type OrderFields } from '../courier/orders/order';
import { CROSS_SELECTOR } from '../courier/send/signer';
import { get as getFrom, type CourierProcess, type HookControl } from './support/courier';
import { testAccountKey, testKeystoreFor } from './support/keystore';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { startStack, type Stack } from './support/stack';

// What the key signs, on the stack: only one Cross, to the relay read at
// start, with the Cross's selector, no value, on the set's chain, built from
// the orders the pre-check verified, at the nonce, gas and fees the send chose.
// A look-alike, an earlier reservation's result, orders that no longer hash to
// their hashes, a target or a value changed inside the signing path: each is
// refused, and no signature is counted. A snapshot changed after the check is
// signed as sealed or refused. A Cross's row written into the database signs
// nothing. And the key appears nowhere, in any form, nor its password, nor the
// keystore, nor any transaction it signed. No needle is ever printed.

let stack: Stack;
let pool: pg.Pool;
const url = () => stack.courier.url;
const lives = new Set<CourierProcess & { hooks?: HookControl }>();
const allSigned = (): Hex[] => {
  lives.add(stack.courier);
  return [...lives].flatMap((c) => c.hooks?.signed ?? []);
};
const handOffs = () => stack.proxy.count('eth_sendRawTransaction');
const answers: string[] = [];

let from: Record<string, string> = {};
let nextAddress = 0;
beforeEach(() => {
  const n = nextAddress++;
  from = { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
});
const postOrder = async (...a: Parameters<typeof postOrderFrom>) => {
  const r = await postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
  answers.push(JSON.stringify(r.body));
  return r;
};

before(async () => {
  stack = await startStack('keyuse', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(async () => {
  await pool?.end();
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
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function quoteAndBet(quotes = 1): Promise<string> {
  const B = await fresh();
  const T = await stack.rig.time();
  // One quote that the bet fills whole, or two of half its size each, so the Cross lists two.
  for (let i = 0; i < quotes; i++) {
    const M = await fresh();
    const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: quotes === 1 ? 9_600n : 4_800n }), positionType: 0 };
    assert.equal((await postOrder(url(), stack.rig, M, 'rest', q)).status, 201);
  }
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
  const taken = await postOrder(url(), stack.rig, B, 'take', b);
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  return taken.body.orderHash as string;
}

const state = async (bet: string) => (await pool.query<{ state: string }>('SELECT state FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()])).rows[0]?.state ?? null;
const incidents = async (reason: string) => (await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'incident' AND reason = $1`, [reason])).rows[0]?.n;

/** A new process for the next case, through the tests' start file, after one that refused to sign and so stopped sending. */
async function fresh_process(): Promise<void> {
  lives.add(stack.courier);
  await stack.restartCourier({ hooked: true });
}

for (const fault of [
  { name: 'a look-alike of the pre-check\'s result, which the pre-check did not make', set: { signer: { substitute: 'look-alike' as const } } },
  { name: 'orders that no longer hash to the hashes the result carries', set: { unhashBeforeSeal: true } },
  { name: 'a target that is not the relay, changed inside the signing path', set: { signer: { envelope: { to: '0x000000000000000000000000000000000000dEaD' } } } },
  { name: 'a value above zero, changed inside the signing path', set: { signer: { envelope: { value: 1n } } } },
]) {
  test(`the signer refuses ${fault.name}: nothing is signed, nothing is handed off, and the courier's own fault is an incident line`, async () => {
    const before = { s: allSigned().length, h: handOffs(), refused: Number(await incidents('SIGNATURE_REFUSED')) };
    await stack.courier.hooks?.fault(fault.set);
    const bet = await quoteAndBet();
    await until(() => incidents('SIGNATURE_REFUSED'), (n) => Number(n) > before.refused, 60_000, 'the refusal');
    assert.equal(allSigned().length, before.s, 'no signature counted');
    assert.equal(handOffs(), before.h, 'no hand-off');
    assert.notEqual(await state(bet), 'signed');
    await fresh_process();
  });
}

test('a result from an earlier reservation, after the lane moved on, is refused; the control, the same path with no fault, signs once and fills', async () => {
  const control = await quoteAndBet();
  await until(() => state(control), (s) => s === 'confirmed', 60_000, 'the control');
  const before = { s: allSigned().length, h: handOffs(), refused: Number(await incidents('SIGNATURE_REFUSED')) };
  await stack.courier.hooks?.fault({ signer: { substitute: 'earlier' } });
  await quoteAndBet();
  await until(() => incidents('SIGNATURE_REFUSED'), (n) => Number(n) > before.refused, 60_000, 'the refusal');
  assert.deepEqual({ s: allSigned().length - before.s, h: handOffs() - before.h }, { s: 0, h: 0 });
  await fresh_process();
});

for (const how of ['reorder', 'swap', 'gas'] as const) {
  test(`the snapshot is sealed: after the check and before the signature, a try to ${how === 'reorder' ? 'reorder the quotes' : how === 'swap' ? 'swap an order with its hash and signature for another' : 'change the gas'} changes nothing; the bytes signed are the sealed ones`, async () => {
    const before = allSigned().length;
    await stack.courier.hooks?.fault({ signer: { tamper: how } });
    const bet = await quoteAndBet(2);
    await until(() => state(bet), (s) => s === 'confirmed', 60_000, 'the Cross');
    await stack.courier.hooks?.fault({ signer: { tamper: null } });
    const tries = stack.courier.hooks?.tampered.filter((t) => t.how === how) ?? [];
    assert.ok(tries.length >= 1 && tries.every((t) => t.result !== 'changed'), JSON.stringify(tries));
    const raw = allSigned()[before] as Hex;
    const tx = parseTransaction(raw);
    const legs = await pool.query<{ order_hash: string }>('SELECT order_hash FROM legs WHERE bet_hash = $1 ORDER BY position', [bet.toLowerCase()]);
    const { args } = decodeFunctionData({ abi: RELAY_ABI, data: tx.data as Hex });
    const [taking, resting] = args as unknown as [{ order: OrderFields }, Array<{ order: OrderFields }>];
    assert.equal(orderHash(taking.order, 31337n, stack.rig.addresses.matching).toLowerCase(), bet.toLowerCase());
    assert.deepEqual(resting.map((r) => orderHash(r.order, 31337n, stack.rig.addresses.matching).toLowerCase()), legs.rows.map((l) => l.order_hash));
  });
}

test("a Cross's row written straight into the database, as intent and as signed, for a bet the lane holds: the next start closes it not sent, nothing is signed and nothing is handed off", async () => {
  const before = { s: allSigned().length, h: handOffs() };
  const lane = stack.rig.accounts.sender.address.toLowerCase();
  for (const as of ['intent', 'signed'] as const) {
    await stack.courier.hooks?.arm('after-reservation', 1);
    const bet = await quoteAndBet();
    await stack.courier.hooks?.reached('after-reservation');
    lives.add(stack.courier);
    await stack.courier.stop();
    const l = (await pool.query<{ epoch: string; reservation: string }>('SELECT epoch::text AS epoch, reservation::text AS reservation FROM lanes WHERE sender = $1', [lane])).rows[0] as { epoch: string; reservation: string };
    await pool.query(
      `INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, state, hand_offs, sender, nonce, gas_limit, max_fee_per_gas, max_priority_fee, tx_hash)
       VALUES ($1, $2, $3, $4, 1, $5, 1, $6, 0, $7, $8, $9, $10, $11, $12)`,
      as === 'intent'
        ? [bet.toLowerCase(), lane, l.epoch, l.reservation, `0x${'ab'.repeat(32)}`, 'intent', null, null, null, null, null, null]
        : [bet.toLowerCase(), lane, l.epoch, l.reservation, `0x${'ab'.repeat(32)}`, 'signed', lane, '999', '500000', '1', '1', `0x${'cd'.repeat(32)}`],
    );
    await pool.query('UPDATE lanes SET open_cross = $2 WHERE sender = $1', [lane, bet.toLowerCase()]);
    await pool.query(`UPDATE orders SET bet_state = 'sent' WHERE hash = $1`, [bet.toLowerCase()]);
    await stack.restartCourier({ hooked: true });
    await until(() => state(bet), (s) => s === 'not sent', 30_000, `the hand-written ${as} row`);
  }
  assert.deepEqual({ s: allSigned().length - before.s, h: handOffs() - before.h }, { s: 0, h: 0 });
});

test('after every other case: every signed attempt, refused and unmined ones included, and every transaction the key sent on the chain, is to the relay with the Cross\'s selector and no value, on the set\'s chain, at the recorded nonce, gas and fees, and decodes to a bet and quotes the records hold', async () => {
  const relay = stack.rig.addresses.relay.toLowerCase();
  const key = stack.rig.accounts.sender.address.toLowerCase();
  for (const raw of allSigned()) {
    const tx = parseTransaction(raw);
    assert.equal(tx.to?.toLowerCase(), relay);
    assert.equal(tx.value ?? 0n, 0n);
    assert.equal(tx.chainId, 31337);
    assert.ok((tx.data as Hex).startsWith(CROSS_SELECTOR));
    assert.equal((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase(), key);
    const row = (await pool.query<{ nonce: string; gas_limit: string; max_fee_per_gas: string; max_priority_fee: string }>('SELECT nonce::text AS nonce, gas_limit::text AS gas_limit, max_fee_per_gas::text AS max_fee_per_gas, max_priority_fee::text AS max_priority_fee FROM crosses WHERE tx_hash = $1', [keccak256(raw).toLowerCase()])).rows[0];
    if (row !== undefined) assert.deepEqual([BigInt(row.nonce), BigInt(row.gas_limit), BigInt(row.max_fee_per_gas), BigInt(row.max_priority_fee)], [BigInt(tx.nonce ?? -1), tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas]);
  }
  const head = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
  let found = 0;
  for (let n = 0n; n <= head; n++) {
    const block = (await stack.rig.rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, true])) as { transactions: Array<{ from: string; to: string | null; input: Hex; value: Hex; hash: string }> };
    for (const t of block.transactions) {
      if (t.from.toLowerCase() !== key) continue;
      found++;
      assert.equal(t.to?.toLowerCase(), relay);
      assert.equal(BigInt(t.value), 0n);
      assert.ok(t.input.startsWith(CROSS_SELECTOR));
      const held = await pool.query('SELECT 1 FROM crosses WHERE tx_hash = $1', [t.hash.toLowerCase()]);
      assert.equal(held.rowCount, 1, 'a transaction of the key the records hold');
    }
  }
  assert.ok(found > 0);
});

test('the key appears nowhere, in any form: nor its password, nor the whole keystore, nor the bytes of any transaction it signed; searched in the courier\'s whole output across its lives, every text column of its database, its status and every answer it gave', async () => {
  const keystore = testKeystoreFor(stack.rig.accounts.sender.address);
  assert.ok(keystore !== null);
  const key = testAccountKey(4).toLowerCase();
  const needles = [key, key.slice(2), key.slice(2).toUpperCase(), keystore.password, keystore.json, JSON.parse(keystore.json).crypto.ciphertext as string, ...allSigned().map((r) => r.toLowerCase()), ...allSigned().map((r) => r.slice(2).toLowerCase())];
  lives.add(stack.courier);
  const output = [...lives].flatMap((c) => c.lines).join('\n').toLowerCase();
  const status = JSON.stringify((await getFrom(url(), '/v1/status', from)).body).toLowerCase();
  const tables = (await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name);
  let database = '';
  for (const t of tables) database += ((await pool.query<{ j: string }>(`SELECT coalesce(json_agg(x), '[]')::text AS j FROM ${t} x`)).rows[0] as { j: string }).j.toLowerCase();
  const said = answers.join('\n').toLowerCase();
  const where: string[] = [];
  needles.forEach((needle, i) => {
    const n = needle.toLowerCase();
    if (n.length < 16) return;
    for (const [name, hay] of [['output', output], ['status', status], ['database', database], ['answers', said]] as const) if (hay.includes(n)) where.push(`needle ${i} in ${name}`);
  });
  assert.deepEqual(where, [], 'found, by index only');
});
