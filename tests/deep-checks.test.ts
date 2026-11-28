import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { Hex } from 'viem';
import type { HookControl } from './support/courier';
import { closeEach } from './support/close';
import { orderOn, postOrder, type Order } from './support/orders';
import { balance, clockFrom, crossOf, filledOnce, finalOf, funded, instant, laneOf, numbered, oneCent, quote, until } from './support/quiet';
import { startStack, type Stack } from './support/stack';

// The last check of F and a deep block's identity, through the whole courier, on the rig: a final block whose own
// height answers another block when it is read again, after the nonce proof's deep reads and after a ran Cross's trace
// and block time; a watermark anchored more than 256 blocks down under a hash that is not the chain's; and a count
// below a deep anchor that is the chain's. Each case's earlier Cross is real, and its quiet spell is 300 empty blocks.

let stack: Stack;
let pool: pg.Pool;
let next = 40;

before(async () => {
  stack = await startStack('deep_checks', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

const hooks = () => stack.courier.hooks as HookControl;
const STOPPED_LINE = /takes no more bets until it restarts|sends nothing more until it restarts/;
const stops = () => stack.courier.lines.filter((l) => STOPPED_LINE.test(l)).length;
const headNow = async () => BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);

/** A real Cross of one cent, sent and filled once, on a game of its own; then a quiet spell of 300 empty blocks. */
async function earlierThenQuiet(): Promise<void> {
  await instant(stack);
  const game = await stack.rig.createGame();
  const { M, B } = await funded(stack, next);
  next += 2;
  const before = await balance(stack, M.address);
  await quote(stack, M, game);
  await clockFrom(stack);
  const sent = await oneCent(stack, pool, B, game);
  filledOnce(sent, (await balance(stack, M.address)) - before);
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await stack.rig.rpc('anvil_mine', ['0x12c', '0x2']);
  await clockFrom(stack);
}

/** A new game with the maker's quote on it, and a bettor funded: what a bet of the case needs. */
async function market(): Promise<{ game: bigint; M: Awaited<ReturnType<typeof funded>>['M']; B: Awaited<ReturnType<typeof funded>>['B'] }> {
  await instant(stack);
  const game = await stack.rig.createGame();
  const { M, B } = await funded(stack, next);
  next += 2;
  await quote(stack, M, game);
  await clockFrom(stack);
  return { game, M, B };
}

/**
 * A rule for the final block's own height read again after a decision's deep reads: once a header more than 260
 * blocks below the head has been read by number, the next header read by number within ten blocks of the head is
 * answered under another hash, once. The heights it changed are kept.
 */
function changeTheLastCheck(head: bigint): { changed: bigint[] } {
  const changed: bigint[] = [];
  let deepSeen = false;
  stack.proxy.rule('eth_getBlockByNumber', {
    kind: 'rewriteResult',
    result: (p, result) => {
      const n = typeof p[0] === 'string' && /^0x[0-9a-fA-F]+$/.test(p[0]) ? BigInt(p[0]) : null;
      if (n === null || result === null) return result;
      if (n + 260n < head) deepSeen = true;
      else if (deepSeen && changed.length === 0 && n + 10n > head) {
        changed.push(n);
        return { ...(result as Record<string, unknown>), hash: `0x${'cd'.repeat(32)}` };
      }
      return result;
    },
  });
  return { changed };
}

test("the nonce proof's last check of F fails: after its deep reads, F's own height answers another block; the proof is set aside, with no intent, no signature and no watermark raised from it; the lane reads again at the next check, and the bet fills once inside its life", async () => {
  await earlierThenQuiet();
  const { game, M, B } = await market();
  const laneBefore = await laneOf(stack, pool);
  const head = await headNow();
  const rule = changeTheLastCheck(head);
  await hooks().arm('before-result', 2);
  const makerBefore = await balance(stack, M.address);
  const signedBefore = hooks().signed.length;
  let bet = '';
  try {
    const T = await stack.rig.time();
    const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, gameId: game }), positionType: 1 };
    const posted = await postOrder(stack.courier.url, stack.rig, B, 'take', b, { 'x-forwarded-for': '198.18.246.1' });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    bet = String(posted.body.orderHash).toLowerCase();
    await hooks().go(await hooks().reached('before-result'));
    // The second check's result: the first proof has run and been set aside by then.
    const second = await hooks().reached('before-result');
    assert.equal(rule.changed.length, 1, "F's own height answered another block, once");
    assert.ok(stack.courier.lines.some((l) => /cannot be compared with the records yet \(the final block's own height, read again, holds another block\)/.test(l)), stack.courier.lines.slice(-6).join(' | '));
    assert.equal(await crossOf(pool, bet).then((c) => c?.state ?? null), null, 'no intent from the set-aside proof');
    assert.equal(hooks().signed.length, signedBefore, 'no signature');
    assert.deepEqual(await laneOf(stack, pool), laneBefore, 'the watermark as it was');
    await hooks().go(second);
  } finally {
    stack.proxy.rule('eth_getBlockByNumber', null);
  }
  const c = await finalOf(stack, pool, bet);
  assert.equal(c.state, 'confirmed', JSON.stringify(c));
  assert.equal(c.hand_offs, 1);
  assert.equal(hooks().signed.length - signedBefore, 1, 'one signature');
  assert.equal((await balance(stack, M.address)) - makerBefore, -9_600n, "the maker's coin, down 9,600");
  const after = await laneOf(stack, pool);
  assert.equal(String(after.anchor?.number), c.proofF, "the watermark raised once, at the accepted proof's final block");
});

test("a ran Cross's last check of F fails: its receipt more than 256 blocks below F, its look's reads made and its trace and block time read, F's own height answers another block when it is read again; nothing final is written, and at the next look the Cross is confirmed, one hand-off", async () => {
  const { game, B } = await market();
  // F held at the head while the Cross is sent and mined, then 300 blocks, then F one behind the head again.
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(await headNow());
  const T = await stack.rig.time();
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, gameId: game }), positionType: 1 };
  const posted = await postOrder(stack.courier.url, stack.rig, B, 'take', b, { 'x-forwarded-for': '198.18.246.2' });
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const bet = String(posted.body.orderHash).toLowerCase();
  await until(stack, () => crossOf(pool, bet), (c) => c?.state === 'pending', 60_000, 'pending above the held final block');
  const receipt = BigInt(((await crossOf(pool, bet))?.receipt_block_number ?? '0') as string);
  await stack.rig.rpc('anvil_mine', ['0x12c']);
  const head = await headNow();
  const from = stack.proxy.counted.length;
  const rule = changeTheLastCheck(head);
  let held: { arrived: Promise<void>; release(): void } | null = null;
  try {
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
    await until(stack, async () => rule.changed.length, (n) => n === 1, 60_000, "F's own height answered another block");
    // The next look's final block held as it arrives: the look whose check failed has ended by then.
    const ruleNow = stack.proxy;
    held = ruleNow.hold('eth_getBlockByNumber', (p) => p[0] === 'finalized');
    await held.arrived;
    const c = await crossOf(pool, bet);
    assert.ok(!['confirmed', 'reverted'].includes(String(c?.state)), `nothing final from the look whose check failed: ${JSON.stringify(c)}`);
    assert.ok(stack.courier.lines.some((l) => /is set aside before anything it found is written \(the final block's own height, read again, holds another block\)/.test(l)), stack.courier.lines.slice(-6).join(' | '));
    // The last check came after the look's every read of the chain: its receipt's header by number, and the receipt's block by hash.
    const seen = stack.proxy.counted.slice(from);
    const checkAt = seen.findIndex((x) => numbered(x) === rule.changed[0] && seen.slice(0, seen.indexOf(x)).some((y) => numbered(y) === receipt));
    const blockTime = seen.findIndex((x) => x.method === 'eth_getBlockByHash');
    assert.ok(seen.some((x) => numbered(x) === receipt), "the receipt's header read by number");
    assert.ok(blockTime >= 0 && checkAt > blockTime, `the last check after the receipt's block time was read: ${JSON.stringify(seen.map((x) => `${x.method} ${String(x.params?.[0]).slice(0, 12)}`))}`);
  } finally {
    held?.release();
    stack.proxy.rule('eth_getBlockByNumber', null);
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
  }
  const end = await finalOf(stack, pool, bet);
  assert.equal(end.state, 'confirmed', JSON.stringify(end));
  assert.equal(end.hand_offs, 1, 'one hand-off');
});

test("a watermark anchored more than 256 blocks down under a hash that is not the chain's at that height: the next bet's proof is not comparable, so nothing is signed or handed off, and the bet lapses at its turn; the anchor's true hash put back, the next bet fills once", async () => {
  await earlierThenQuiet();
  const key = stack.rig.accounts.sender.address.toLowerCase();
  const lane = await laneOf(stack, pool);
  assert.ok(lane.anchor !== null && (await headNow()) - lane.anchor.number > 256n, 'the anchor deep');
  // A row the chain does not bear out: the anchor's hash.
  await pool.query('UPDATE lanes SET verified_block_hash = $2 WHERE sender = $1', [key, `0x${'ef'.repeat(32)}`]);
  const signedBefore = hooks().signed.length;
  const handOffsBefore = stack.proxy.count('eth_sendRawTransaction');
  try {
    const { game, B } = await market();
    const T = await stack.rig.time();
    const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 20n, oddsTick: 196, riskAmount: 10_000n, gameId: game }), positionType: 1 };
    const posted = await postOrder(stack.courier.url, stack.rig, B, 'take', b, { 'x-forwarded-for': '198.18.246.3' });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const bet = String(posted.body.orderHash).toLowerCase();
    const state = await until(stack, async () => (await pool.query<{ bet_state: string }>('SELECT bet_state FROM orders WHERE hash = $1', [bet])).rows[0]?.bet_state, (s) => s === 'lapsed' || s === 'refused', 90_000, 'the bet at its end');
    assert.equal(state, 'lapsed', 'lapsed at its turn');
    assert.ok(stack.courier.lines.some((l) => /the watermark's anchor is not shown on the final block's chain/.test(l)), 'not comparable, for the anchor');
    assert.equal(await crossOf(pool, bet).then((c) => c?.state ?? null), null, 'no Cross');
    assert.deepEqual({ signed: hooks().signed.length - signedBefore, handOffs: stack.proxy.count('eth_sendRawTransaction') - handOffsBefore }, { signed: 0, handOffs: 0 });
  } finally {
    await pool.query('UPDATE lanes SET verified_block_hash = $2 WHERE sender = $1', [key, (lane.anchor as { hash: Hex }).hash]);
  }
  const { game, B } = await market();
  const sent = await oneCent(stack, pool, B, game);
  assert.equal(sent.cross.state, 'confirmed', JSON.stringify(sent.cross));
  assert.deepEqual({ signed: sent.signed, handOffs: sent.handOffs }, { signed: 1, handOffs: 1 });
});

test("a count below a watermark whose deep anchor the chain does bear out: the anchor is shown on F's chain by its header and F's own height read again, so the count is a contradiction, and this process stops sending, with nothing signed; started again with the row put right, the next bet fills once", async () => {
  await earlierThenQuiet();
  const key = stack.rig.accounts.sender.address.toLowerCase();
  const lane = await laneOf(stack, pool);
  const before = stops();
  const signedBefore = hooks().signed.length;
  await pool.query('UPDATE lanes SET verified_nonce_to = $2 WHERE sender = $1', [key, (lane.to + 5n).toString()]);
  try {
    const { game, B } = await market();
    const T = await stack.rig.time();
    const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, gameId: game }), positionType: 1 };
    const posted = await postOrder(stack.courier.url, stack.rig, B, 'take', b, { 'x-forwarded-for': '198.18.246.4' });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    await until(stack, async () => stops(), (n) => n > before, 60_000, 'the process stops sending');
    const incident = await pool.query<{ facts: Record<string, unknown> }>(`SELECT facts FROM events WHERE kind = 'incident' AND reason = 'CHAIN_CONTRADICTS_RECORDS' ORDER BY number DESC LIMIT 1`);
    assert.match(String(incident.rows[0]?.facts.why), /below the watermark proved on its chain/);
    assert.equal(hooks().signed.length, signedBefore, 'nothing signed');
  } finally {
    await pool.query('UPDATE lanes SET verified_nonce_to = $2 WHERE sender = $1', [key, lane.to.toString()]);
    await stack.restartCourier({ hooked: true });
  }
  const { game, B } = await market();
  const sent = await oneCent(stack, pool, B, game);
  assert.equal(sent.cross.state, 'confirmed', JSON.stringify(sent.cross));
});
