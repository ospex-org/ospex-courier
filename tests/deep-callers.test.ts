import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { HDAccount } from 'viem/accounts';
import { closeEach } from './support/close';
import { orderOn, postOrder, type Order } from './support/orders';
import { clockFrom, crossOf, finalOf, funded, instant, laneOf, numbered, oneCent, quote, until } from './support/quiet';
import { startStack, type Stack } from './support/stack';

// The other readers of a block's place on the final block's chain, each with its block more than 256 below F, through
// the whole courier on the rig: the read again of an expired unmined Cross that the chain mined later, at the next
// bet's check; the search for what used a nonce, which finds the key's own transaction the records do not hold; and
// the operator's clear of that hold, which shows the found transaction on F's chain again. Each reads the deep block's
// header by number, F's own height once more before it writes, and nothing by a walk of parents.

let stack: Stack;
let pool: pg.Pool;
let next = 40;

before(async () => {
  stack = await startStack('deep_callers', { hooked: true, blockTime: 2, sending: true, sendsApart: { unsent: 'a Cross kept from the chain by the proxy and never sent on: the key\'s own transaction took its nonce' } });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

const headNow = async () => BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);

async function market(): Promise<{ game: bigint; B: HDAccount }> {
  await instant(stack);
  const game = await stack.rig.createGame();
  const { M, B } = await funded(stack, next);
  next += 2;
  await quote(stack, M, game);
  await clockFrom(stack);
  return { game, B };
}

async function betOn(B: HDAccount, game: bigint, life = 30n): Promise<string> {
  const T = await stack.rig.time();
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + life, oddsTick: 196, riskAmount: 10_000n, gameId: game }), positionType: 1 };
  const posted = await postOrder(stack.courier.url, stack.rig, B, 'take', b, { 'x-forwarded-for': `198.18.245.${next}` });
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  return String(posted.body.orderHash).toLowerCase();
}

function operator(args: string[]): Promise<{ out: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/operator.ts', ...args],
      { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...stack.env, DATABASE_URL: stack.databaseUrl }, encoding: 'utf8', timeout: 120_000 },
      (err, stdout, stderr) => resolve({ out: `${stdout}${stderr}`.trim(), status: err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null }),
    );
  });
}

/** The heights the requests since `from` named by number. */
const readByNumber = (from: number) => stack.proxy.counted.slice(from).map(numbered).filter((n): n is bigint => n !== null);

test("an expired unmined Cross the chain mined later, its receipt more than 256 blocks below F when the next bet's check finds its nonce used: its receipt read by its hash, the receipt's header by number and F's own height once more; written reverted, as expired unmined before; and the next bet fills once", async () => {
  const kept = stack.proxy.withhold();
  let first = '';
  try {
    const m = await market();
    first = await betOn(m.B, m.game);
    await until(stack, () => crossOf(pool, first), (c) => c?.state === 'sent', 30_000, 'the Cross sent, kept from the chain');
    const e = await finalOf(stack, pool, first, 120_000);
    assert.equal(e.state, 'expired unmined', JSON.stringify(e));
  } finally {
    kept.stop();
  }
  // F held at the head; the kept bytes let through, mined and reverted; then 300 blocks; then F one behind the head again.
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(await headNow());
  const tx = (await stack.rig.rpc('eth_sendRawTransaction', [kept.kept[0]])) as string;
  const mined = (await until(stack, async () => (await stack.rig.rpc('eth_getTransactionReceipt', [tx])) as { blockNumber: string; status: string } | null, (r) => r !== null, 30_000, 'the late bytes mined')) as { blockNumber: string; status: string };
  assert.equal(mined.status, '0x0', 'reverted: past its expiry');
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await stack.rig.rpc('anvil_mine', ['0x12c', '0x2']);
  await clockFrom(stack);
  const from = stack.proxy.counted.length;
  stack.proxy.setFinal(null);
  stack.proxy.finalFollows(1n);
  const m2 = await market();
  const second = await oneCent(stack, pool, m2.B, m2.game);
  assert.equal(second.cross.state, 'confirmed', JSON.stringify(second.cross));
  assert.deepEqual({ signed: second.signed, handOffs: second.handOffs }, { signed: 1, handOffs: 1 });
  const again = await crossOf(pool, first);
  assert.equal(again?.state, 'reverted', JSON.stringify(again));
  const recorded = (await pool.query<{ recorded: Record<string, unknown> }>('SELECT recorded FROM crosses WHERE bet_hash = $1', [first])).rows[0]?.recorded;
  assert.equal(recorded?.wasExpiredUnmined, true, 'written reverted, as expired unmined before');
  const receiptAt = BigInt(mined.blockNumber);
  assert.ok(BigInt(String(second.cross.proofF)) - receiptAt > 256n, 'its receipt more than 256 below F');
  assert.ok(readByNumber(from).includes(receiptAt), "its receipt's header read by number");
  assert.equal(stack.proxy.counted.slice(from).filter((c) => c.method === 'eth_getBlockByHash' && String(c.params?.[0]).toLowerCase() !== String(again?.receipt_block_hash).toLowerCase() && String(c.params?.[0]).toLowerCase() !== String(second.cross.receipt_block_hash).toLowerCase()).length, 0, 'by hash, only the receipts\' own blocks');
});

test("the search after a quiet spell: the key's own transaction the records do not hold takes the withheld Cross's nonce, and 300 blocks pass before F reaches it; the search's lower anchor and the block it finds are each read by number, F's own height once more; the Cross is replaced and not the courier's own, and the lane shuts; then the operator's clear, its found block more than 256 below F, read by number again, opens the lane, and the next bet fills once", async () => {
  const key = stack.rig.accounts.sender;
  const m = await market();
  const withheld = stack.proxy.withhold();
  let bet = '';
  let ownTx = '';
  try {
    bet = await betOn(m.B, m.game);
    const sent = await until(stack, () => crossOf(pool, bet), (c) => c?.state === 'sent', 30_000, 'the Cross sent, kept from the chain');
    // F held at the head; the key's own transaction at that nonce, at a higher fee, outside the courier: it mines.
    stack.proxy.finalFollows(null);
    stack.proxy.setFinal(await headNow());
    ownTx = (await stack.rig.rpc('eth_sendTransaction', [{ from: key.address, to: key.address, value: '0x0', nonce: `0x${BigInt(sent?.nonce as string).toString(16)}`, maxFeePerGas: '0x174876e800', maxPriorityFeePerGas: '0x174876e800' }])) as string;
    await until(stack, async () => stack.rig.rpc('eth_getTransactionReceipt', [ownTx]), (r) => r !== null, 30_000, "the key's own transaction mined");
  } finally {
    withheld.stop();
  }
  const own = (await stack.rig.rpc('eth_getTransactionReceipt', [ownTx])) as { blockNumber: string };
  const unusedAt = BigInt(String((await pool.query<{ f: string }>(`SELECT checked->'send'->'nonce'->'final'->>'number' AS f FROM crosses WHERE bet_hash = $1`, [bet])).rows[0]?.f));
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await stack.rig.rpc('anvil_mine', ['0x12c', '0x2']);
  await clockFrom(stack);
  const from = stack.proxy.counted.length;
  stack.proxy.setFinal(null);
  stack.proxy.finalFollows(1n);
  const replaced = await finalOf(stack, pool, bet, 120_000);
  assert.equal(replaced.state, 'replaced', JSON.stringify(replaced));
  const row = (await pool.query<{ replaced_by: string; replaced_by_ours: boolean }>('SELECT replaced_by, replaced_by_ours FROM crosses WHERE bet_hash = $1', [bet])).rows[0];
  assert.deepEqual(row, { replaced_by: ownTx.toLowerCase(), replaced_by_ours: false });
  const searched = readByNumber(from);
  const F = BigInt(String(replaced.final_block_number));
  assert.ok(F - unusedAt > 256n && F - BigInt(own.blockNumber) > 256n, 'the anchor and the found block both more than 256 below F');
  assert.ok(searched.includes(unusedAt), "the search's lower anchor read by number");
  assert.ok(searched.includes(BigInt(own.blockNumber)), 'the block it found read by number');
  assert.ok(searched.includes(F), "F's own height read again");
  assert.equal(stack.proxy.counted.slice(from).filter((c) => c.method === 'eth_getBlockByHash').length, 0, 'nothing by hash');
  const shut = await until(stack, async () => (await pool.query<{ shut_line: string | null }>('SELECT shut_line::text AS shut_line FROM lanes WHERE sender = $1', [key.address.toLowerCase()])).rows[0]?.shut_line ?? null, (v) => v !== null, 30_000, 'the lane shut');
  assert.ok(shut !== null);
  // The operator's clear, with the courier stopped: the found transaction shown on F's chain again, by number.
  await stack.courier.stop();
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await stack.rig.rpc('anvil_mine', ['0x12c', '0x2']);
  await clockFrom(stack);
  const clearFrom = stack.proxy.counted.length;
  const clear = await operator(['clear', '--lane', key.address, '--found', "the key's own transaction at the Cross's nonce, sent outside the courier by the test"]);
  assert.equal(clear.status, 0, clear.out);
  const cleared = readByNumber(clearFrom);
  assert.ok(cleared.includes(BigInt(own.blockNumber)), `the clear read the found block by number: ${cleared.map(String).join(', ')}`);
  assert.equal(stack.proxy.counted.slice(clearFrom).filter((c) => c.method === 'eth_getBlockByHash').length, 0, 'the clear read nothing by hash');
  const lane = await laneOf(stack, pool);
  assert.ok(lane.anchor !== null && cleared.includes(lane.anchor.number), "the clear's final block, its own height read again, is the watermark's new anchor");
  await stack.restartCourier({ hooked: true });
  const m2 = await market();
  const sent = await oneCent(stack, pool, m2.B, m2.game);
  assert.equal(sent.cross.state, 'confirmed', JSON.stringify(sent.cross));
});
