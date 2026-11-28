import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { Hex } from 'viem';
import { closeEach } from './support/close';
import { get as getFrom, type HookControl } from './support/courier';
import { carries, namedWitnesses, nodeText, type Bet } from './support/named';
import { startStack, type Stack } from './support/stack';
import { outcomes, postStop, resultsOf, stopMessage } from './support/stops';

// A Cross the node answered with a named error, as the courier's status and the maker read it
// (tests/support/named.ts): the status's open Cross until the outcome; and a listed quote stopped after that answer,
// and stopped again as its Cross is pending on a receipt, set back by an orphan, and ended. A recorded taken answer's
// orphan goes back to sent: that control is in tests/receipts.test.ts.

let stack: Stack;
let pool: pg.Pool;
let w: ReturnType<typeof namedWitnesses>;

before(async () => {
  stack = await startStack('named_sides', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  w = namedWitnesses(stack, pool, { firstAccount: 40, firstLine: 3_000 });
  await w.prepare();
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

const hooks = () => stack.courier.hooks as HookControl;
let nextAddress = 0;
const from = () => {
  const n = nextAddress++;
  return { 'x-forwarded-for': `198.19.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
};

/** The status's lanes, as the courier serves them. */
async function lanes(): Promise<Array<{ sender: string; openCross: Record<string, unknown> | null; shut: unknown }>> {
  return (await statusBody()).lanes;
}

/** The status's sender part, and the whole body as text. */
async function statusBody(): Promise<{ lanes: Array<{ sender: string; openCross: Record<string, unknown> | null; shut: unknown }>; text: string }> {
  const status = await getFrom(stack.courier.url, '/v1/status', from());
  assert.equal(status.status, 200, JSON.stringify(status.body));
  return { lanes: (status.body.sender as { lanes: Array<{ sender: string; openCross: Record<string, unknown> | null; shut: unknown }> }).lanes, text: JSON.stringify(status.body).toLowerCase() };
}

test("the status while a Cross the node answered with a named error is held: the lane's open Cross reads unknown, with its transaction and nonce and no bet's hash, and the lane is not shut; at the outcome, the lane's open Cross is null", async () => {
  const market = w.market();
  await w.quoteIn(market);
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  await w.holdFinal();
  stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuseIf', refuse: carries(made.signature), code: -32000, message: nodeText('max fee per gas less than block base fee') });
  let bet!: Bet;
  try {
    bet = await w.post(B, made);
    const c = await w.heldUnknown(bet, 'max fee per gas less than block base fee');
    const seen = await statusBody();
    const lane = seen.lanes.find((l) => l.sender === stack.rig.accounts.sender.address.toLowerCase());
    assert.ok(lane !== undefined && lane.openCross !== null, 'the lane is on the status, with its open Cross');
    assert.deepEqual([lane.openCross.state, lane.openCross.txHash, lane.openCross.nonce], ['unknown', c.tx_hash, c.nonce], JSON.stringify(lane));
    assert.equal('bet' in lane.openCross, false, "no bet on the open Cross: the property is absent");
    assert.ok(!seen.text.includes(bet.hash.slice(2)), "the bet's hash is nowhere on the status");
    assert.equal(lane.shut, null, 'the lane is not shut');
  } finally {
    stack.proxy.rule('eth_sendRawTransaction', null);
  }
  try {
    await w.finalAt(bet.expiry);
    assert.equal((await w.final(bet.hash)).state, 'expired unmined');
  } finally {
    w.followFinal();
  }
  const lane = (await lanes()).find((l) => l.sender === stack.rig.accounts.sender.address.toLowerCase());
  assert.equal(lane?.openCross, null, 'no open Cross after its outcome');
});

test("the maker's stops of a quote a Cross lists, after the node answered its hand-off with a named error: uncertain, and the same again; pending and its block once its receipt is seen above the final block; uncertain again when that receipt is an orphan's, its words kept; and none once the Cross is confirmed in the block that wins", async () => {
  const market = w.market();
  const quoteHash = (await w.quoteIn(market)) as Hex;
  const M = w.people().maker;
  const B = w.people().bettor;
  const made = await w.betOf(B, market);
  const stop = () => postStop(stack.courier.url, stack.rig, M, stopMessage(M.address, [quoteHash]), undefined, from());
  const handOffOf = (answer: Awaited<ReturnType<typeof stop>>) => (resultsOf(answer)[0] as unknown as { handOff?: Record<string, unknown> }).handOff;
  // The final block held where it stands, so the Cross's first block lies above it while the chain takes it back.
  await w.holdFinal();
  stack.proxy.rule('eth_getTransactionReceipt', { kind: 'answer', result: () => null });
  const passed = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText('future transaction tries to replace pending') }, carries(made.signature));
  await hooks().arm('after-gate', 1);
  await hooks().arm('after-hand-off', 1);
  let serving = false;
  let orphan: { blockNumber: Hex; blockHash: Hex } | null = null;
  try {
    const bet = await w.post(B, made);
    const gate = await hooks().reached('after-gate');
    await stack.rig.rpc('evm_setIntervalMining', [0]);
    await hooks().go(gate);
    const handed = await hooks().reached('after-hand-off');
    const raw = hooks().signed[hooks().signed.length - 1] as Hex;
    const kept = (await stack.rig.rpc('evm_snapshot', [])) as Hex;
    await stack.rig.rpc('anvil_mine', ['0x1']);
    await hooks().go(handed);
    const c = await w.heldUnknown(bet, 'future transaction tries to replace pending');
    const txHash = c.tx_hash as Hex;
    orphan = (await stack.rig.rpc('eth_getTransactionReceipt', [txHash])) as { blockNumber: Hex; blockHash: Hex };
    assert.ok(orphan !== null, 'mined in the first block');
    const orphanTime = BigInt(((await stack.rig.rpc('eth_getBlockByHash', [orphan.blockHash, false])) as { timestamp: Hex }).timestamp);
    // Stopped after the named error's answer, and stopped again: uncertain both times, the same.
    const first = await stop();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(outcomes(first), ['stopped']);
    assert.deepEqual(handOffOf(first), { txHash, state: 'uncertain', bet: bet.hash }, 'uncertain, with no block');
    const again = await stop();
    assert.deepEqual(outcomes(again), ['already stopped']);
    assert.deepEqual(handOffOf(again), handOffOf(first), 'the same handOff');
    // Its receipt seen above the final block: pending, and its block named.
    stack.proxy.rule('eth_getTransactionReceipt', { kind: 'rewriteResult', result: (p, r) => (serving && String(p[0]).toLowerCase() === txHash.toLowerCase() ? orphan : r) });
    const pending = await w.until(() => w.cross(bet.hash), (r) => r?.state === 'pending', 60_000, 'pending on the first receipt');
    assert.deepEqual(pending?.node_answer, { kind: 'unknown', words: 'future transaction tries to replace pending' });
    const third = await stop();
    assert.deepEqual(handOffOf(third), { txHash, state: 'pending', bet: bet.hash, block: { number: BigInt(orphan.blockNumber).toString(), hash: orphan.blockHash.toLowerCase() } });
    // From here the proxy answers the orphan's receipt for this transaction; the block taken back, and the same
    // transaction mined again at the same height in a block of another time.
    serving = true;
    assert.equal(await stack.rig.rpc('evm_revert', [kept]), true);
    try {
      await stack.rig.rpc('eth_sendRawTransaction', [raw]);
    } catch {
      // Still in the pool after the revert: mined from there.
    }
    await stack.rig.setNextBlockTime(orphanTime + 1n);
    await stack.rig.rpc('anvil_mine', ['0x1']);
    const winning = (await stack.rig.rpc('eth_getTransactionReceipt', [txHash])) as { blockNumber: Hex; blockHash: Hex };
    assert.equal(BigInt(winning.blockNumber), BigInt(orphan.blockNumber), 'mined again at the same height');
    assert.notEqual(winning.blockHash.toLowerCase(), orphan.blockHash.toLowerCase(), 'in another block');
    await stack.rig.rpc('anvil_mine', ['0x2']);
    stack.proxy.setFinal(BigInt(winning.blockNumber) + 2n);
    // The orphan set aside: back to unknown, not sent, since the answer on record is not a taken one; its words kept.
    const back = await w.until(() => w.cross(bet.hash), (r) => r !== null && r.state !== 'pending', 90_000, 'the orphan set aside');
    assert.deepEqual([back?.state, back?.node_answer], ['unknown', { kind: 'unknown', words: 'future transaction tries to replace pending' }], JSON.stringify(back));
    const fourth = await stop();
    assert.deepEqual(handOffOf(fourth), { txHash, state: 'uncertain', bet: bet.hash }, 'uncertain again');
    // The winning block's receipt: confirmed, and a stop now names no hand-off.
    serving = false;
    const end = await w.final(bet.hash);
    assert.equal(end.state, 'confirmed', JSON.stringify(end));
    const fifth = await stop();
    assert.deepEqual(outcomes(fifth), ['already stopped']);
    assert.equal('handOff' in (resultsOf(fifth)[0] as object), false, 'no handOff after the Cross is final: the property is absent');
    assert.equal(w.requestsOf(txHash), 1, 'handed once');
  } finally {
    serving = false;
    passed.stop();
    stack.proxy.rule('eth_getTransactionReceipt', null);
    w.followFinal();
    await stack.rig.rpc('evm_setIntervalMining', [2]);
  }
});
