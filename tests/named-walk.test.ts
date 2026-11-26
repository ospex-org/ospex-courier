import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { Hex } from 'viem';
import type { NamedError } from '../courier/chain/rpc';
import { closeEach } from './support/close';
import { carries, namedWitnesses, nodeText, type Bet } from './support/named';
import { startStack, type Stack } from './support/stack';

// The final block's reads while a Cross the node answered with a named error is held, each failing and then recovered
// (tests/support/named.ts): the final block's own read refused twice; and the walk of the final block's parents, when
// the Cross's own block lies further below it than the chain's own hash of a height reaches, with a parent missing
// once, a parent missing on both of the reader's attempts, and a parent at the wrong height or with the wrong hash.
// None writes anything final while it lasts; a contradiction stops the process sending; the Cross ends confirmed.

let stack: Stack;
let pool: pg.Pool;
let w: ReturnType<typeof namedWitnesses>;

before(async () => {
  stack = await startStack('named_walk', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  w = namedWitnesses(stack, pool, { firstAccount: 40, firstLine: 3_000 });
  await w.prepare();
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];
const STOPPED_LINE = /takes no more bets until it restarts|sends nothing more until it restarts/;
const stops = () => stack.courier.lines.filter((l) => STOPPED_LINE.test(l)).length;
const unavailableLooks = () => stack.courier.lines.filter((l) => /could not be read whole/.test(l)).length;

/**
 * A Cross the node answered with a named error after the chain took it, held unknown with its receipt not given while
 * the final block is held at the head; then 300 blocks, so that its block lies further below the final block than the
 * chain's own hash of a height reaches. The receipt is given again here; the final block is let go by the case.
 */
async function deepNamed(words: NamedError): Promise<{ bet: Bet; head: bigint; receiptBlock: bigint }> {
  const market = w.market();
  await w.quoteIn(market);
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  await w.holdFinal();
  stack.proxy.rule('eth_getTransactionReceipt', { kind: 'answer', result: () => null });
  const passed = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText(words) }, carries(made.signature));
  let bet: Bet;
  let c: Awaited<ReturnType<typeof w.heldUnknown>>;
  try {
    bet = await w.post(B, made);
    c = await w.heldUnknown(bet, words);
    const mined = await w.until(() => stack.rig.rpc('eth_getTransactionReceipt', [c.tx_hash]) as Promise<{ blockNumber: Hex } | null>, (r) => r !== null, 30_000, 'mined');
    await stack.rig.rpc('anvil_mine', ['0x12c']);
    const head = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
    assert.equal((await w.cross(bet.hash))?.state, 'unknown', 'still unknown, its receipt not given');
    return { bet, head, receiptBlock: BigInt((mined as { blockNumber: Hex }).blockNumber) };
  } finally {
    passed.stop();
    stack.proxy.rule('eth_getTransactionReceipt', null);
  }
}

/** A parent the walk asks for: well past the window below the head, and above the receipt's own block. */
const deepParent = (d: { head: bigint; receiptBlock: bigint }, result: unknown): bigint | null => {
  const at = result === null ? null : BigInt((result as { number: Hex }).number);
  return at !== null && at + 260n < d.head && at > d.receiptBlock + 5n ? at : null;
};

test("the final block's own read refused twice while the Cross the node answered with a named error is held: it stays open and is looked at again, the process does not stop, and it ends confirmed at a final block of the chain", async () => {
  const before = stops();
  const market = w.market();
  await w.quoteIn(market);
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  await w.holdFinal();
  stack.proxy.rule('eth_getTransactionReceipt', { kind: 'answer', result: () => null });
  const passed = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText('oversized data') }, carries(made.signature));
  let bet!: Bet;
  let refused = 0;
  try {
    bet = await w.post(B, made);
    await w.heldUnknown(bet, 'oversized data');
    passed.stop();
    stack.proxy.rule('eth_getTransactionReceipt', null);
    w.followFinal();
    stack.proxy.rule('eth_getBlockByNumber', { kind: 'refuseIf', refuse: (p) => p[0] === 'finalized' && (refused++, true), code: -32000, message: 'the node is busy' });
    await w.until(async () => refused, (n) => n >= 2, 30_000, 'the final block refused twice');
    assert.ok(!FINAL.includes(String((await w.cross(bet.hash))?.state)), 'nothing final while the final block cannot be read');
  } finally {
    passed.stop();
    stack.proxy.rule('eth_getTransactionReceipt', null);
    stack.proxy.rule('eth_getBlockByNumber', null);
    w.followFinal();
  }
  const end = await w.final(bet.hash);
  assert.equal(end.state, 'confirmed', JSON.stringify(end));
  assert.equal(stops(), before, 'the process did not stop');
});

test("a parent of the final block missing once in a look's walk past the window, the Cross the node answered with a named error held: read again within the reader's attempt, the look is whole, and the Cross is confirmed; the process does not stop", async () => {
  const before = { stops: stops(), unavailable: unavailableLooks() };
  const d = await deepNamed('address already reserved');
  let missing = 0;
  stack.proxy.rule('eth_getBlockByHash', {
    kind: 'rewriteResult',
    result: (_p, result) => {
      if (missing === 0 && deepParent(d, result) !== null) {
        missing++;
        return null;
      }
      return result;
    },
  });
  try {
    w.followFinal();
    await w.until(async () => missing, (n) => n === 1, 60_000, 'a parent missing once');
    const end = await w.final(d.bet.hash);
    assert.equal(end.state, 'confirmed', JSON.stringify(end));
  } finally {
    stack.proxy.rule('eth_getBlockByHash', null);
    w.followFinal();
  }
  assert.equal(stops(), before.stops, 'the process did not stop');
});

test("a parent of the final block missing on both of the reader's attempts, in a look's walk past the window, the Cross the node answered with a named error held: the look is unavailable and writes nothing final; at a later look the node returns it, and the Cross is confirmed; the process does not stop", async () => {
  const before = { stops: stops(), unavailable: unavailableLooks() };
  const d = await deepNamed('account limit exceeded');
  let missing = 0;
  let asked: string | null = null;
  stack.proxy.rule('eth_getBlockByHash', {
    kind: 'rewriteResult',
    result: (p, result) => {
      const hash = String(p[0]).toLowerCase();
      if (missing < 2 && deepParent(d, result) !== null && (asked === null || asked === hash)) {
        asked = hash;
        missing++;
        return null;
      }
      return result;
    },
  });
  try {
    w.followFinal();
    await w.until(async () => missing, (n) => n >= 2, 60_000, 'a parent missing on both attempts');
    await w.until(async () => stops() > before.stops || unavailableLooks() > before.unavailable, (v) => v, 30_000, "the look's answer to the missing parent");
    assert.equal(stops(), before.stops, 'the process did not stop');
    assert.ok(!FINAL.includes(String((await w.cross(d.bet.hash))?.state)), 'nothing final is written while the walk is incomplete');
  } finally {
    stack.proxy.rule('eth_getBlockByHash', null);
    w.followFinal();
  }
  const end = await w.final(d.bet.hash);
  assert.equal(end.state, 'confirmed', JSON.stringify(end));
  assert.equal(stops(), before.stops, 'the process did not stop');
});

for (const wrong of ['height', 'hash'] as const) {
  test(`a parent of the final block returned with the wrong ${wrong} in a look's walk past the window, the Cross the node answered with a named error held: a contradiction, never read again as if it were missing and never followed; nothing final is written, and the process stops sending; started again with the node answering as asked, the Cross is confirmed`, async () => {
    const before = stops();
    const d = await deepNamed(wrong === 'height' ? 'exceeds block gas limit' : 'intrinsic gas too low');
    let served = 0;
    stack.proxy.rule('eth_getBlockByHash', {
      kind: 'rewriteResult',
      result: (_p, result) => {
        const at = deepParent(d, result);
        if (served > 0 || at === null) return result;
        served++;
        return wrong === 'height' ? { ...(result as Record<string, unknown>), number: `0x${(at - 1n).toString(16)}` } : { ...(result as Record<string, unknown>), hash: `0x${'ab'.repeat(32)}` };
      },
    });
    try {
      w.followFinal();
      await w.until(async () => served, (n) => n === 1, 60_000, `the parent with the wrong ${wrong} served`);
      await w.until(async () => stops() > before || FINAL.includes(String((await w.cross(d.bet.hash))?.state)), (v) => v, 60_000, `the lane's answer to the wrong ${wrong}`);
      assert.ok(!FINAL.includes(String((await w.cross(d.bet.hash))?.state)), `no outcome from a walk that met a parent with the wrong ${wrong}`);
      assert.equal(stops(), before + 1, 'the process stops sending');
    } finally {
      stack.proxy.rule('eth_getBlockByHash', null);
      w.followFinal();
      await stack.restartCourier({ hooked: true });
    }
    const end = await w.final(d.bet.hash);
    assert.equal(end.state, 'confirmed', JSON.stringify(end));
    assert.equal(w.requestsOf(end.tx_hash as string), 1, 'handed once, across both lives');
  });
}
