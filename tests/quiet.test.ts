import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { closeEach } from './support/close';
import { ancestryOf, at1912, balance, clockFrom, earlierOf, filledOnce, funded, heldAfterQuiet, instant, laneOf, oneCent, quietStep, quote, said, type Earlier } from './support/quiet';
import { startStack, type Stack } from './support/stack';

// The first bet after a quiet hour, on the rig, with its controls (the chain's schedule and the clock are declared in
// tests/support/quiet.ts): the first bet of a key whose lane has no anchor yet; a bet after a short gap; then a real
// earlier Cross, a quiet hour of the chain, 1,800 empty blocks two seconds apart, and one cent at 7:12:00 PM Central
// time on the chain's clock, good until 7:12:30; then the bet after it. Each bet's reads of a block's header are
// counted at the proxy, by what they are for.

let stack: Stack;
let pool: pg.Pool;
let earlier: Earlier | null = null;

before(async () => {
  stack = await startStack('quiet', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

test("the first bet of a key whose lane has no anchor yet, nothing of it yet explained: no header is read by number below the window, and none of the final block's own height; it fills once, to the unit, and the lane's watermark is anchored at its check's final block", async () => {
  await instant(stack);
  const { M, B } = await funded(stack, 40);
  assert.equal((await laneOf(stack, pool)).anchor, null, 'no anchor before the first bet');
  const makerBefore = await balance(stack, M.address);
  await quote(stack, M, stack.rig.gameId);
  await clockFrom(stack);
  const sent = await oneCent(stack, pool, B, stack.rig.gameId);
  filledOnce(sent, (await balance(stack, M.address)) - makerBefore);
  const a = ancestryOf(sent);
  assert.deepEqual({ deep: a.deep.length, atF: a.atF }, { deep: 0, atF: 0 }, JSON.stringify({ deep: a.deep.map(String), other: a.other.map(String) }));
  const lane = await laneOf(stack, pool);
  assert.equal(String(lane.anchor?.number), sent.cross.proofF, "the watermark anchored at the bet's check's final block");
  console.log(said("the first bet of a key, its lane's watermark not yet anchored", { sent, target: sent.chain.expiry - 30n, ancestry: a }));
});

test("a short gap: ten blocks after the last bet, its anchor and its receipt inside the window below the final block: no header is read by number below the window, and none of the final block's own height; the bet fills once, to the unit", async () => {
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await stack.rig.rpc('anvil_mine', ['0xa', '0x2']);
  await instant(stack);
  // A game of its own, so that the bet meets this case's quote and no earlier one.
  const game = await stack.rig.createGame();
  const { M, B } = await funded(stack, 42);
  const makerBefore = await balance(stack, M.address);
  await quote(stack, M, game);
  await clockFrom(stack);
  const sent = await oneCent(stack, pool, B, game);
  filledOnce(sent, (await balance(stack, M.address)) - makerBefore);
  const a = ancestryOf(sent);
  assert.deepEqual({ deep: a.deep.length, atF: a.atF }, { deep: 0, atF: 0 }, JSON.stringify({ deep: a.deep.map(String), other: a.other.map(String) }));
  earlier = await earlierOf(stack, pool, sent.bet);
  console.log(said('a bet after a short gap of ten blocks', { sent, target: sent.chain.expiry - 30n, ancestry: a }));
});

test("the first bet after a quiet hour: a real earlier Cross, then 1,800 empty blocks two seconds apart in which the courier asks the chain nothing and writes nothing; then one cent at 7:12:00 PM on the chain's clock, good until 7:12:30, handed off and filled before 7:12:30 with one signature and one hand-off, the coins to the unit; its send checks read the earlier anchor's and the earlier receipt's headers by number, once each, and the final block's own height once more, and no header by hash but the new receipt's own", async () => {
  assert.ok(earlier !== null, 'the earlier Cross, the case before');
  const step = await quietStep(stack, pool, 1_800);
  assert.deepEqual({ requests: step.requests, recordsUnchanged: step.recordsUnchanged }, { requests: {}, recordsUnchanged: true }, 'a quiet hour: nothing asked of the chain, nothing written');
  const r = await at1912(stack, pool, 44);
  assert.ok(r.sent.cross.proofF !== null && BigInt(r.sent.cross.proofF) - earlier.anchor.number > 256n, 'the anchor more than 256 blocks below the final block of the check');
  assert.ok(BigInt(r.sent.cross.proofF as string) - earlier.receipt.number > 256n, 'the earlier receipt too');
  heldAfterQuiet(r, earlier);
  console.log(`# the quiet hour, measured: ${JSON.stringify({ blocks: step.blocks, minedMs: step.ms, from: String(step.from.number), to: String(step.to.number), chainSeconds: String(step.to.time - step.from.time) })}`);
  console.log(said('the first bet after a quiet hour', r, { earlier: { anchor: String(earlier.anchor.number), receipt: String(earlier.receipt.number) } }));
  earlier = await earlierOf(stack, pool, r.sent.bet);
});

test("the bet after it: its lane's watermark raised by the bet before at its check's final block: no header is read by number below the window, and none of the final block's own height; it fills once, to the unit", async () => {
  await instant(stack);
  const { M, B } = await funded(stack, 46);
  const game = await stack.rig.createGame();
  const makerBefore = await balance(stack, M.address);
  await quote(stack, M, game);
  await clockFrom(stack);
  const sent = await oneCent(stack, pool, B, game);
  filledOnce(sent, (await balance(stack, M.address)) - makerBefore);
  const a = ancestryOf(sent);
  assert.deepEqual({ deep: a.deep.length, atF: a.atF }, { deep: 0, atF: 0 }, JSON.stringify({ deep: a.deep.map(String), other: a.other.map(String) }));
  console.log(said('the bet after the first bet after a quiet hour', { sent, target: sent.chain.expiry - 30n, ancestry: a }));
});
