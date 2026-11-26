import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { encodeFunctionData, type Abi, type Hex } from 'viem';
import { NEXT, SENTENCE } from '../courier/orders/wire';
import { closeEach } from './support/close';
import { carries, namedWitnesses, nodeText } from './support/named';
import { crossFromTheTest, orderOn, sign, type Order } from './support/orders';
import { startStack, type Stack } from './support/stack';

// The ends of a Cross whose hand-off the node answered with a named error, each from that unknown answer
// (tests/support/named.ts): filled by another courier's transaction and then expired unmined, with that total at the
// same final block; the final block past the expiry by the chain's clock alone, and at the expiry without the bet's
// total there; its own receipt not given though the final block is past it; a different transaction at its nonce,
// recorded as the courier's own; and one the records do not hold, last, as the key's hold it leaves stays.

let stack: Stack;
let pool: pg.Pool;
let w: ReturnType<typeof namedWitnesses>;

before(async () => {
  stack = await startStack('named_ends', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  w = namedWitnesses(stack, pool, { firstAccount: 40, firstLine: 3_000 });
  await w.prepare();
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];

test('filled in full by another courier while its own Cross is unknown: the node refuses the hand-off by a named error before the chain has it, another relay fills the bet in full, and at a final block at its expiry the Cross ends expired unmined with that total at the same block: the chain shows the bet filled in full', async () => {
  const market = w.market();
  await w.quoteIn(market);
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  await w.holdFinal();
  stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuseIf', refuse: carries(made.signature), code: -32000, message: nodeText('txpool is full') });
  let bet!: Awaited<ReturnType<typeof w.post>>;
  try {
    bet = await w.post(B, made);
    await w.heldUnknown(bet, 'txpool is full');
  } finally {
    stack.proxy.rule('eth_sendRawTransaction', null);
  }
  // Another courier fills the bet in full, with a quote of its own the courier never saw: 10,000 at tick 200.
  const M2 = await w.fresh();
  const other: Order = { ...orderOn(stack.rig, M2, { expiry: bet.expiry + 600n, oddsTick: 200, riskAmount: 10_000n, minFill: 0n, ...market }), positionType: 0 };
  const filled = await crossFromTheTest(stack.rig, { order: bet.order, signature: bet.signature }, [{ order: other, signature: await sign(M2, other, 31337, stack.rig.addresses.matching) }]);
  assert.equal(filled.filled, true, JSON.stringify(filled));
  assert.equal((await w.cross(bet.hash))?.state, 'unknown', 'still unknown: the final block is held');
  try {
    const at = await w.finalAt(bet.expiry);
    const end = await w.final(bet.hash);
    assert.equal(end.state, 'expired unmined', JSON.stringify(end));
    const fin = (end.recorded ?? {}).final as { number: string; time: string };
    assert.deepEqual([fin.number, (end.recorded ?? {}).betFilled], [at.toString(), '10000'], 'the total at the same final block, filled in full by the other');
    const record = await w.record(bet.hash);
    const cross = record.cross as { message: string; answer: unknown };
    assert.equal(cross.message, `${SENTENCE.EXPIRED_UNMINED(end.tx_hash as string, fin.number, fin.time, bet.expiry.toString())} ${SENTENCE.FULL_FILLED('0.01', fin.number)}`);
    assert.equal('reason' in cross, false);
    assert.deepEqual(cross.answer, { kind: 'unknown', words: 'txpool is full' });
    assert.equal(w.requestsOf(end.tx_hash as string), 1, 'handed once');
    assert.equal((await w.lane()).shut_line, null, 'no hold of the key');
  } finally {
    w.followFinal();
  }
});

test("the final block before the expiry while the chain's clock is past it, and then a final block at the expiry without the bet's total there: neither ends the Cross the node answered with a named error; once the total is read at that block, it ends expired unmined and the next bet is sent and fills", async () => {
  const market = w.market();
  await w.quoteIn(market);
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  await w.holdFinal();
  stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuseIf', refuse: carries(made.signature), code: -32000, message: nodeText('nonce too low') });
  let bet!: Awaited<ReturnType<typeof w.post>>;
  try {
    bet = await w.post(B, made);
    await w.heldUnknown(bet, 'nonce too low');
  } finally {
    stack.proxy.rule('eth_sendRawTransaction', null);
  }
  const filledOfBet = encodeFunctionData({ abi: stack.rig.abis.OspexMatching as Abi, functionName: 's_filledRisk', args: [bet.hash as Hex] }).slice(2).toLowerCase();
  let refused = 0;
  try {
    // The chain's clock past the expiry, the final block still before it: looks come and go, and nothing ends.
    await stack.rig.setNextBlockTime(bet.expiry + 5n);
    await stack.rig.rpc('anvil_mine', ['0x1']);
    await sleep(8_000);
    assert.equal((await w.cross(bet.hash))?.state, 'unknown', 'a clock past the expiry, with the final block before it, ends nothing');
    // A final block at the expiry, the bet's total there refused: nothing ends while it cannot be read.
    stack.proxy.rule('eth_call', { kind: 'refuseIf', refuse: (p) => JSON.stringify(p).toLowerCase().includes(filledOfBet) && (refused++, true), code: -32000, message: 'the node is busy' });
    const atOrPast = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
    stack.proxy.setFinal(atOrPast);
    await w.until(async () => refused, (n) => n >= 3, 90_000, "the bet's total at the final block refused three times");
    assert.ok(!FINAL.includes(String((await w.cross(bet.hash))?.state)), 'no outcome without the total at the same block');
    assert.equal((await w.lane()).held_bet, bet.hash, 'the lane still held');
  } finally {
    stack.proxy.rule('eth_call', null);
  }
  // The total given: the look has its whole proof, and the Cross ends.
  const end = await w.final(bet.hash, 120_000);
  assert.equal(end.state, 'expired unmined', JSON.stringify(end));
  assert.equal((end.recorded ?? {}).betFilled, '0');
  w.followFinal();
  // The lane goes on.
  const next = w.market();
  await w.quoteIn(next);
  const bet2 = await w.post(w.people().next, await w.betOf(w.people().next, next));
  assert.equal((await w.final(bet2.hash)).state, 'confirmed', 'the next bet is sent and fills');
});

test('its own receipt not given though the final block is past its block: the Cross the node answered with a named error after the chain took it is not ended by the missing receipt, look after look; given, it is confirmed from that receipt', async () => {
  const market = w.market();
  await w.quoteIn(market);
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  await w.holdFinal();
  stack.proxy.rule('eth_getTransactionReceipt', { kind: 'answer', result: () => null });
  const passed = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText('invalid sender') }, carries(made.signature));
  let bet!: Awaited<ReturnType<typeof w.post>>;
  try {
    bet = await w.post(B, made);
    await w.heldUnknown(bet, 'invalid sender');
    passed.stop();
    // The final block past the Cross's own block, its receipt still not given: no end is invented.
    w.followFinal();
    await sleep(12_000);
    const c = await w.cross(bet.hash);
    assert.ok(c !== null && !FINAL.includes(c.state), `no outcome without its receipt: ${JSON.stringify(c)}`);
    assert.equal((await w.lane()).shut_line, null, 'and no hold of the key');
  } finally {
    passed.stop();
    stack.proxy.rule('eth_getTransactionReceipt', null);
    w.followFinal();
  }
  const end = await w.final(bet.hash);
  assert.equal(end.state, 'confirmed', JSON.stringify(end));
  assert.equal(((end.recorded ?? {}).totals as { taker?: string } | undefined)?.taker, '9984');
});

test("a different transaction at its nonce, the courier's own: Cross 1 kept from the chain until it is expired unmined; Cross 2, the next bet, at the same nonce, refused by the node with a named error before the chain has it; then Cross 1 let through: Cross 1 reverted and Cross 2 replaced, by the courier's own transaction, with its total at that block and no hold of the key", async () => {
  const kept = stack.proxy.withhold();
  let first!: Awaited<ReturnType<typeof w.post>>;
  try {
    const m1 = w.market();
    await w.quoteIn(m1);
    const B1 = await w.fresh();
    first = await w.post(B1, await w.betOf(B1, m1));
    const c1 = await w.until(() => w.cross(first.hash), (c) => c?.state === 'sent', 30_000, 'Cross 1 sent, kept from the chain');
    assert.equal((await w.final(first.hash)).state, 'expired unmined');
    kept.stop();
    const m2 = w.market();
    await w.quoteIn(m2);
    const B2 = await w.fresh();
    const made = await w.betOf(B2, m2);
    stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuseIf', refuse: carries(made.signature), code: -32000, message: nodeText('replacement transaction underpriced') });
    let second!: Awaited<ReturnType<typeof w.post>>;
    try {
      second = await w.post(B2, made);
      const c2 = await w.heldUnknown(second, 'replacement transaction underpriced');
      assert.equal(c2.nonce, c1?.nonce, 'the same nonce');
    } finally {
      stack.proxy.rule('eth_sendRawTransaction', null);
    }
    // Cross 1 let through: it mines at that nonce, a transaction the records hold.
    await stack.rig.rpc('eth_sendRawTransaction', [kept.kept[0]]);
    const r1 = await w.until(() => w.cross(first.hash), (c) => c?.state === 'reverted', 90_000, 'Cross 1 reverted');
    assert.equal(r1?.state, 'reverted');
    const r2 = await w.final(second.hash);
    assert.deepEqual([r2.state, r2.replaced_by, r2.replaced_by_ours], ['replaced', c1?.tx_hash, true], JSON.stringify(r2));
    assert.equal((r2.recorded ?? {}).betFilled, '0', 'its total at that block');
    assert.equal(w.requestsOf(r2.tx_hash as string), 1, 'Cross 2 handed once');
    assert.equal((await w.lane()).shut_line, null, "the courier's own transaction leaves no hold of the key");
    assert.ok(!(await w.openConditions()).includes('cross-unreconciled'));
  } finally {
    kept.stop();
  }
});

test("a different transaction at its nonce, one the records do not hold: the node refuses the hand-off by a named error before the chain has it; the key's own transaction outside the courier waits in the pool, then mines above the held final block, and neither ends the Cross; the final block past it: replaced, not the courier's own, and the lane shut by its own hold, which stays", async () => {
  const market = w.market();
  await w.quoteIn(market);
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  await w.holdFinal();
  stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuseIf', refuse: carries(made.signature), code: -32000, message: nodeText('nonce too high') });
  let bet!: Awaited<ReturnType<typeof w.post>>;
  let c!: Awaited<ReturnType<typeof w.heldUnknown>>;
  try {
    bet = await w.post(B, made);
    c = await w.heldUnknown(bet, 'nonce too high');
  } finally {
    stack.proxy.rule('eth_sendRawTransaction', null);
  }
  const key = stack.rig.accounts.sender;
  let outside: Hex;
  try {
    // The clock stopped: the key's own transaction at that nonce, outside the courier, waits in the pool.
    await stack.rig.rpc('evm_setIntervalMining', [0]);
    outside = (await stack.rig.rpc('eth_sendTransaction', [{ from: key.address, to: key.address, value: '0x0', nonce: `0x${BigInt(c.nonce as string).toString(16)}`, maxFeePerGas: '0x174876e800', maxPriorityFeePerGas: '0x174876e800' }])) as Hex;
    await sleep(6_000);
    assert.equal((await w.cross(bet.hash))?.state, 'unknown', 'a transaction in the pool at its nonce ends nothing');
    // Mined above the held final block: the key's count at the head moves, and that alone ends nothing.
    await stack.rig.rpc('anvil_mine', ['0x1']);
    assert.notEqual(await stack.rig.rpc('eth_getTransactionReceipt', [outside]), null, 'mined');
    await sleep(6_000);
    assert.equal((await w.cross(bet.hash))?.state, 'unknown', 'a count moved above the final block ends nothing');
    assert.equal((await w.lane()).shut_line, null);
  } finally {
    await stack.rig.rpc('evm_setIntervalMining', [2]);
  }
  w.followFinal();
  const end = await w.final(bet.hash);
  assert.deepEqual([end.state, end.replaced_by, end.replaced_by_ours], ['replaced', outside.toLowerCase(), false], JSON.stringify(end));
  assert.ok(typeof (end.recorded ?? {}).betFilled === 'string', 'its total at that block');
  const line = await w.until(async () => (await w.lane()).shut_line, (v) => v !== null, 30_000, 'the lane shut');
  assert.ok((await w.openConditions()).includes('cross-unreconciled'), "the key's hold, apart from the Cross");
  await sleep(6_000);
  assert.equal((await w.lane()).shut_line, line, 'and it stays');
  await w.noneReserved();
});
