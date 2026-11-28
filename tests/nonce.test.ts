import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hex } from 'viem';
import type { Header } from '../courier/chain/rpc';
import type { CrossRow, CrossState } from '../courier/records/crosses';
import { blocksToShow, chooseFees, proveNonce, walletCovers, type Watermark } from '../courier/send/checks';

// The key's count held against the records, with no chain: the watermark and
// its anchor, each kind of record a nonce can or cannot be explained by, and a
// final block that cannot be compared. Each decision is the proof's own; the
// lane writes what it decides, and signs nothing unless it says proved.

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const header = (n: bigint, hash = h(Number(n))): Header => ({ number: n, hash, parentHash: h(Number(n) - 1), timestamp: 1_000n + n * 2n });

function cross(nonce: bigint, state: CrossState, receipt: { number: bigint; hash: Hex } | null, over: Partial<CrossRow> = {}): CrossRow {
  return {
    betHash: h(10_000 + Number(nonce) * 7 + state.length),
    lane: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
    epoch: 1n,
    reservation: 1n,
    block: { number: 1n, hash: h(1), time: 1n },
    sender: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
    nonce,
    gasLimit: 500_000n,
    maxFeePerGas: 100n,
    maxPriorityFee: 10n,
    txHash: h(20_000 + Number(nonce) * 7 + state.length),
    state,
    handOffs: 1,
    nodeAnswer: null,
    receipt,
    final: receipt === null ? null : { number: receipt.number, hash: receipt.hash },
    replacedBy: null,
    replacedByOurs: null,
    revertReason: null,
    revertEvidence: null,
    revertData: null,
    // The reserved reason, on a retained row the schema allows: this build never writes it.
    notSentReason: state === 'not sent' ? 'NODE_REFUSED' : null,
    gasUsed: null,
    effectiveGasPrice: null,
    checked: {},
    recorded: null,
    times: { intentAt: null, signedAt: null, gateAt: null, answeredAt: null, receiptSeenAt: null, outcomeAt: null },
    ...over,
  };
}

/** Every block the proof asks for shown on F's chain, but those named. */
const shownAll = (F: Header, wm: Watermark, crosses: CrossRow[], notShown: Hex[] = []) => new Map(blocksToShow(F, wm, crosses).map((b) => [b.hash.toLowerCase(), !notShown.includes(b.hash)] as const));

// A covered prefix: nonces 0 to 2 explained at final block 100.
const WM: Watermark = { to: 3n, anchor: { number: 100n, hash: h(100) } };

test('the count check: a compatible new nonce. With nonces 0 to 2 covered at block 100 and nonce 3 confirmed at block 104, F at 110 with a count of 4 proves nonce 4, and the watermark rises to 4 anchored at F', () => {
  const F = header(110n);
  const crosses = [cross(3n, 'confirmed', { number: 104n, hash: h(104) })];
  const p = proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses, onF: shownAll(F, WM, crosses) });
  assert.equal(p.kind, 'proved');
  if (p.kind !== 'proved') return;
  assert.equal(p.nonce, 4n);
  assert.deepEqual(p.watermark, { to: 4n, anchor: { number: 110n, hash: h(110) } });
  assert.equal(p.raised, true);
});

test('the count check: the count at F not past the watermark keeps the watermark and its anchor as they are, and proves the count', () => {
  const F = header(110n);
  const p = proveNonce({ F, countAtFinal: 3n, countAtH: 3n, watermark: WM, crosses: [], onF: shownAll(F, WM, []) });
  assert.equal(p.kind, 'proved');
  if (p.kind !== 'proved') return;
  assert.equal(p.nonce, 3n);
  assert.deepEqual(p.watermark, WM);
  assert.equal(p.raised, false);
});

test('the count check: an unexplained nonce. Nonce 3 used at F and nothing the records hold explains it: unexplained at 3, nothing proved, the watermark not moved', () => {
  const F = header(110n);
  const p = proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses: [], onF: shownAll(F, WM, []) });
  assert.deepEqual([p.kind, p.kind === 'unexplained' ? p.nonce : null], ['unexplained', 3n]);
});

test('the count check: a not-sent and an expired-unmined row consume no nonce. Nonce 3 held by a retained, schema-valid reserved NODE_REFUSED row is unexplained; one closed expired unmined is read again by its hash first; with the nonce unused at F, neither stands in the way', () => {
  const F = header(110n);
  const refused = [cross(3n, 'not sent', null)];
  const p1 = proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses: refused, onF: shownAll(F, WM, refused) });
  assert.deepEqual([p1.kind, p1.kind === 'unexplained' ? p1.nonce : null], ['unexplained', 3n]);
  const expired = [cross(3n, 'expired unmined', null)];
  const p2 = proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses: expired, onF: shownAll(F, WM, expired) });
  assert.equal(p2.kind, 'read again');
  // Neither used at F: the count is the watermark, nonce 3 is chosen again.
  for (const crosses of [refused, expired]) {
    const p = proveNonce({ F, countAtFinal: 3n, countAtH: 3n, watermark: WM, crosses, onF: shownAll(F, WM, crosses) });
    assert.deepEqual([p.kind, p.kind === 'proved' ? p.nonce : null], ['proved', 3n]);
  }
});

test('the count check: duplicate rows at one nonce explain it once. Two Crosses at nonce 3, one replaced and one confirmed at 104: nonce 3 is explained once and nonce 4 is proved', () => {
  const F = header(110n);
  const crosses = [cross(3n, 'replaced', null, { replacedByOurs: true }), cross(3n, 'confirmed', { number: 104n, hash: h(104) })];
  const p = proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses, onF: shownAll(F, WM, crosses) });
  assert.deepEqual([p.kind, p.kind === 'proved' ? p.nonce : null], ['proved', 4n]);
});

test('the count check: a receipt above F explains nothing yet. Nonce 3 confirmed at 112 while F is 110: not comparable, nothing proved, nothing called a fault', () => {
  const F = header(110n);
  const crosses = [cross(3n, 'confirmed', { number: 112n, hash: h(112) })];
  const p = proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses, onF: shownAll(F, WM, crosses) });
  assert.equal(p.kind, 'not comparable');
});

test('the count check: a regressing F and an incompatible one. F at 95, below the anchor at 100, and F at 110 whose chain does not hold the anchor: each not comparable, the watermark not moved', () => {
  const low = header(95n);
  assert.equal(proveNonce({ F: low, countAtFinal: 3n, countAtH: 3n, watermark: WM, crosses: [], onF: shownAll(low, WM, []) }).kind, 'not comparable');
  const F = header(110n);
  assert.equal(proveNonce({ F, countAtFinal: 3n, countAtH: 3n, watermark: WM, crosses: [], onF: shownAll(F, WM, [], [h(100)]) }).kind, 'not comparable');
  // A receipt the records hold that is not on F's chain: not comparable either.
  const crosses = [cross(3n, 'confirmed', { number: 104n, hash: h(104) })];
  assert.equal(proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses, onF: shownAll(F, WM, crosses, [h(104)]) }).kind, 'not comparable');
});

test('the count check: contradictions at the same compatible anchor. A count at F below the watermark proved on its chain, and a receipt on F\'s chain at a nonce at or above the count there', () => {
  const F = header(110n);
  assert.equal(proveNonce({ F, countAtFinal: 2n, countAtH: 2n, watermark: WM, crosses: [], onF: shownAll(F, WM, []) }).kind, 'contradiction');
  const crosses = [cross(4n, 'confirmed', { number: 104n, hash: h(104) })];
  assert.equal(proveNonce({ F, countAtFinal: 4n, countAtH: 4n, watermark: WM, crosses, onF: shownAll(F, WM, crosses) }).kind, 'contradiction');
});

test('the count check: a fresh lane with no anchor proves its first count, anchored at F, and the records\' floor wins over a stale count at H', () => {
  const F = header(50n);
  const none: Watermark = { to: 0n, anchor: null };
  const p = proveNonce({ F, countAtFinal: 0n, countAtH: 0n, watermark: none, crosses: [], onF: shownAll(F, none, []) });
  assert.deepEqual(p.kind === 'proved' ? [p.nonce, p.watermark] : p.kind, [0n, { to: 0n, anchor: { number: 50n, hash: h(50) } }]);
  const crosses = [cross(3n, 'confirmed', { number: 104n, hash: h(104) })];
  const G = header(110n);
  const stale = proveNonce({ F: G, countAtFinal: 4n, countAtH: 2n, watermark: WM, crosses, onF: shownAll(G, WM, crosses) });
  assert.deepEqual(stale.kind === 'proved' ? stale.nonce : stale.kind, 4n);
});

test('the fees: a cap of twice the base fee plus the tip; a replacement a quarter above the highest cap and the highest tip among the unmined Crosses at the nonce, rounded up; the tip never above the cap. The wallet covers the gas limit times the cap, to the unit', () => {
  assert.deepEqual([chooseFees(30n, 100n, []).maxFeePerGas, chooseFees(30n, 100n, []).maxPriorityFeePerGas], [230n, 30n]);
  const earlier = [cross(3n, 'expired unmined', null, { maxFeePerGas: 300n, maxPriorityFee: 41n }), cross(3n, 'expired unmined', null, { maxFeePerGas: 250n, maxPriorityFee: 50n })];
  const r = chooseFees(30n, 100n, earlier);
  assert.deepEqual([r.maxFeePerGas, r.maxPriorityFeePerGas], [375n, 63n]);
  const high = chooseFees(500n, 1n, [cross(3n, 'expired unmined', null, { maxFeePerGas: 10n, maxPriorityFee: 9n })]);
  assert.ok(high.maxPriorityFeePerGas <= high.maxFeePerGas);
  assert.deepEqual(walletCovers(230n * 500_000n, 500_000n, 230n), { ok: true, required: 115_000_000n });
  assert.deepEqual(walletCovers(230n * 500_000n - 1n, 500_000n, 230n), { ok: false, required: 115_000_000n });
});
