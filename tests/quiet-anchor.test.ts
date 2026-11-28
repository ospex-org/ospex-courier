import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { HookControl } from './support/courier';
import { closeEach } from './support/close';
import { orderOn, postOrder, type Order } from './support/orders';
import { balance, clockFrom, crossOf, earlierOf, filledOnce, finalOf, funded, instant, numbered, oneCent, quote } from './support/quiet';
import { startStack, type Stack } from './support/stack';

// The anchor alone below the window: a real earlier Cross, then the final block held 257 blocks above the watermark's
// anchor, which puts the anchor one block past the window and that Cross's own receipt, a few blocks above the
// anchor, still inside it. The next bet's send checks read one header by number, the anchor's, and the final block's
// own height once more: two, and none by hash. The count is held here, for docs/COST.md.

let stack: Stack;
let pool: pg.Pool;

before(async () => {
  stack = await startStack('quiet_anchor', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

test("the watermark's anchor one block past the window below the final block and the last receipt inside it: the next bet's send checks read two headers by number, the anchor's and the final block's own, none of them twice and none by hash; the bet fills once", async () => {
  const hooks = stack.courier.hooks as HookControl;
  await instant(stack);
  const game = await stack.rig.createGame();
  const first = await funded(stack, 40);
  const before0 = await balance(stack, first.M.address);
  await quote(stack, first.M, game);
  await clockFrom(stack);
  const earlierBet = await oneCent(stack, pool, first.B, game);
  filledOnce(earlierBet, (await balance(stack, first.M.address)) - before0);
  const earlier = await earlierOf(stack, pool, earlierBet.bet);
  assert.ok(earlier.receipt.number - earlier.anchor.number < 200n, 'the receipt a few blocks above the anchor');
  // F held where the anchor is 257 below it and the receipt fewer than 256.
  const F = earlier.anchor.number + 257n;
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await stack.rig.rpc('anvil_mine', ['0x12c', '0x2']);
  await instant(stack);
  const next = await funded(stack, 42);
  const game2 = await stack.rig.createGame();
  await quote(stack, next.M, game2);
  stack.proxy.finalFollows(null);
  stack.proxy.setFinal(F);
  await clockFrom(stack);
  await hooks.arm('before-result', 1);
  await hooks.arm('after-intent', 1);
  const T = await stack.rig.time();
  const b: Order = { ...orderOn(stack.rig, next.B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, gameId: game2 }), positionType: 1 };
  const posted = await postOrder(stack.courier.url, stack.rig, next.B, 'take', b, { 'x-forwarded-for': '198.18.244.1' });
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const bet = String(posted.body.orderHash).toLowerCase();
  const atResult = await hooks.reached('before-result');
  const from = stack.proxy.counted.length;
  await hooks.go(atResult);
  const atIntent = await hooks.reached('after-intent');
  const seen = stack.proxy.counted.slice(from);
  await hooks.go(atIntent);
  stack.proxy.setFinal(null);
  stack.proxy.finalFollows(1n);
  const c = await finalOf(stack, pool, bet);
  assert.equal(c.state, 'confirmed', JSON.stringify(c));
  assert.equal(c.proofF, String(F), 'the check at the held final block');
  const heights = seen.map(numbered).filter((n): n is bigint => n !== null);
  assert.deepEqual(
    { numbered: heights.map(String), byHash: seen.filter((x) => x.method === 'eth_getBlockByHash').length },
    { numbered: [String(earlier.anchor.number), String(F)], byHash: 0 },
    `the send checks: the anchor ${earlier.anchor.number}, the receipt ${earlier.receipt.number}, F ${F}`,
  );
  assert.equal((await crossOf(pool, bet))?.hand_offs, 1, 'one hand-off');
  console.log(`# the anchor alone below the window, measured: the anchor at ${earlier.anchor.number}, the last receipt at ${earlier.receipt.number}, F held at ${F}; the next bet's send checks read ${heights.length} headers by number (${heights.map(String).join(', ')}) and none by hash`);
});
