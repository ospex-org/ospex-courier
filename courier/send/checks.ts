import type { Hex } from 'viem';
import type { Header } from '../chain/rpc';
import type { CrossRow } from '../records/crosses';
import type { Named, OnChain } from './chain';

// The send's own checks, each a decision from reads already made: the nonce
// and the key's count held against the records, the fees, and the wallet.
// None reads the chain or the database itself; the lane gathers the reads and
// writes what these decide.

/** The lane's watermark: every nonce below `to` explained at the anchor, a final block; no anchor before the first proof. */
export interface Watermark {
  to: bigint;
  anchor: Named | null;
}

/**
 * The block that explains a Cross's nonce, where its record holds one: the receipt's block, for a Cross the chain ran
 * (`confirmed` or `reverted`); for one `replaced` by a transaction the records do not hold, the block the search found
 * that transaction in and recorded. A Cross `not sent` or `expired unmined`, and one replaced by another of the
 * courier's own (which explains it itself), explain none.
 */
export function explainingBlock(c: CrossRow): Named | null {
  if ((c.state === 'confirmed' || c.state === 'reverted') && c.receipt !== null) return c.receipt;
  if (c.state === 'replaced' && c.replacedByOurs === false) {
    const b = (c.recorded as { replacedByBlock?: { number?: string; hash?: string } } | null)?.replacedByBlock;
    if (b !== undefined && typeof b.number === 'string' && typeof b.hash === 'string') return { number: BigInt(b.number), hash: b.hash as Hex };
  }
  return null;
}

/** The blocks the nonce proof needs shown on F's chain: the watermark's anchor, and each explaining block at or under F. */
export function blocksToShow(F: Header, watermark: Watermark, crosses: readonly CrossRow[]): Named[] {
  const out = new Map<string, Named>();
  if (watermark.anchor !== null && watermark.anchor.number <= F.number) out.set(watermark.anchor.hash.toLowerCase(), watermark.anchor);
  for (const c of crosses) {
    const b = explainingBlock(c);
    if (b !== null && b.number <= F.number) out.set(b.hash.toLowerCase(), b);
  }
  return [...out.values()];
}

const s = (n: bigint) => n.toString();
const blockFacts = (b: Named) => ({ number: s(b.number), hash: b.hash });

export type NonceProof =
  /** Every nonce below the count at F explained: the nonce chosen, and the watermark as it stands after the proof. */
  | { kind: 'proved'; nonce: bigint; watermark: Watermark; raised: boolean; facts: Record<string, unknown> }
  /** F cannot be compared with the records: the lane holds, and reads again at a later F. Nothing is called a fault. */
  | { kind: 'not comparable'; facts: Record<string, unknown> }
  /** A nonce used at F at which the records hold an `expired unmined` Cross: that Cross's receipt is read by its hash first. */
  | { kind: 'read again'; nonce: bigint; cross: CrossRow; facts: Record<string, unknown> }
  /** A nonce used at F that nothing the records hold explains: the lane shuts, nothing is signed, and the search runs. */
  | { kind: 'unexplained'; nonce: bigint; facts: Record<string, unknown> }
  /** The records and the chain disagree at the same compatible anchor: this process stops sending. */
  | { kind: 'contradiction'; facts: Record<string, unknown> };

/**
 * The nonce, and the key's count held against the records, at each pre-check before anything is signed. The rule: the
 * larger of the key's count at H and one past the highest nonce the records explain. Every Cross of the key is final
 * by then, so every nonce below the count at F must be explained; those below the watermark were explained at an
 * earlier F and are not read again. The watermark's anchor must be on F's chain, and F at or past it; a receipt the
 * records hold must be at or under F and on its chain to explain anything; otherwise F is not comparable.
 */
export function proveNonce(input: {
  F: Header;
  countAtFinal: bigint;
  countAtH: bigint;
  watermark: Watermark;
  crosses: readonly CrossRow[];
  /** Each block of `blocksToShow`, by its hash in lower case: whether it is on F's chain. */
  onF: ReadonlyMap<string, OnChain>;
}): NonceProof {
  const { F, countAtFinal, countAtH, watermark, crosses, onF } = input;
  const base = {
    final: blockFacts(F),
    countAtFinal: s(countAtFinal),
    countAtH: s(countAtH),
    watermark: { to: s(watermark.to), anchor: watermark.anchor === null ? null : blockFacts(watermark.anchor) },
  };

  // The watermark's anchor: F at or past it, and the anchor on F's chain.
  if (watermark.anchor !== null) {
    if (F.number < watermark.anchor.number) return { kind: 'not comparable', facts: { ...base, why: "the final block is below the watermark's anchor" } };
    if (onF.get(watermark.anchor.hash.toLowerCase()) !== true) return { kind: 'not comparable', facts: { ...base, why: "the watermark's anchor is not shown on the final block's chain" } };
    if (countAtFinal < watermark.to) return { kind: 'contradiction', facts: { ...base, why: "the key's count at the final block is below the watermark proved on its chain" } };
  }

  // Every Cross of the key is final at a pre-check, and none was proved at a final block above this F.
  const explained = new Map<bigint, { betHash: Hex; block: Named }>();
  for (const c of crosses) {
    if (c.nonce === null) continue;
    if (!['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'].includes(c.state)) {
      return { kind: 'not comparable', facts: { ...base, why: 'a Cross of the key is not final', betHash: c.betHash, state: c.state } };
    }
    if (c.final !== null && c.final.number > F.number) {
      return { kind: 'not comparable', facts: { ...base, why: 'a Cross of the key was settled at a final block above this one', betHash: c.betHash, settledAt: blockFacts(c.final) } };
    }
    const b = explainingBlock(c);
    if (b === null) continue;
    if (b.number > F.number) return { kind: 'not comparable', facts: { ...base, why: 'a receipt the records hold is above the final block', betHash: c.betHash, block: blockFacts(b) } };
    const shown = onF.get(b.hash.toLowerCase());
    if (shown !== true) return { kind: 'not comparable', facts: { ...base, why: "a receipt the records hold is not shown on the final block's chain", betHash: c.betHash, block: blockFacts(b) } };
    if (c.nonce >= countAtFinal) {
      return { kind: 'contradiction', facts: { ...base, why: "a receipt the records hold, on the final block's chain, is at a nonce at or above the key's count there", betHash: c.betHash, nonce: s(c.nonce), block: blockFacts(b) } };
    }
    if (!explained.has(c.nonce)) explained.set(c.nonce, { betHash: c.betHash, block: b });
  }

  // Every nonce from the watermark up to the count at F.
  for (let n = watermark.to; n < countAtFinal; n++) {
    if (explained.has(n)) continue;
    const expired = crosses.find((c) => c.nonce === n && c.state === 'expired unmined' && c.txHash !== null);
    if (expired !== undefined) return { kind: 'read again', nonce: n, cross: expired, facts: { ...base, nonce: s(n), betHash: expired.betHash, txHash: expired.txHash } };
    return { kind: 'unexplained', nonce: n, facts: { ...base, nonce: s(n) } };
  }

  let floor = watermark.to;
  for (const n of explained.keys()) if (n + 1n > floor) floor = n + 1n;
  const nonce = countAtH > floor ? countAtH : floor;
  const raised = watermark.anchor === null || countAtFinal > watermark.to;
  const after: Watermark = raised ? { to: countAtFinal, anchor: { number: F.number, hash: F.hash } } : watermark;
  return {
    kind: 'proved',
    nonce,
    watermark: after,
    raised,
    facts: { ...base, floor: s(floor), nonce: s(nonce), watermarkAfter: { to: s(after.to), anchor: after.anchor === null ? null : blockFacts(after.anchor) } },
  };
}

/** How far a replacement's fees rise over the highest of the Crosses it takes the place of: a quarter. Bor's pool asks a tenth. */
export const REPLACEMENT_RISE_PERCENT = 25n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * The fees: the tip the node suggests, and a cap of twice H's base fee plus that tip. Where the records hold earlier
 * Crosses at the same nonce that were never mined, each fee is at least a quarter above the highest of theirs: the
 * highest cap and the highest tip among all of them. The tip is never above the cap.
 */
export function chooseFees(tip: bigint, baseFee: bigint, earlier: readonly CrossRow[]): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; facts: Record<string, unknown> } {
  let cap = 2n * baseFee + tip;
  let t = tip;
  let rise: Record<string, unknown> | null = null;
  const priced = earlier.filter((c) => c.maxFeePerGas !== null && c.maxPriorityFee !== null);
  if (priced.length > 0) {
    const highestCap = priced.reduce((m, c) => ((c.maxFeePerGas as bigint) > m ? (c.maxFeePerGas as bigint) : m), 0n);
    const highestTip = priced.reduce((m, c) => ((c.maxPriorityFee as bigint) > m ? (c.maxPriorityFee as bigint) : m), 0n);
    const minCap = ceilDiv(highestCap * (100n + REPLACEMENT_RISE_PERCENT), 100n);
    const minTip = ceilDiv(highestTip * (100n + REPLACEMENT_RISE_PERCENT), 100n);
    if (cap < minCap) cap = minCap;
    if (t < minTip) t = minTip;
    rise = { replaces: priced.map((c) => c.txHash), highestCap: s(highestCap), highestTip: s(highestTip), minCap: s(minCap), minTip: s(minTip) };
  }
  if (t > cap) cap = t;
  return { maxFeePerGas: cap, maxPriorityFeePerGas: t, facts: { suggestedTip: s(tip), baseFee: s(baseFee), maxFeePerGas: s(cap), maxPriorityFeePerGas: s(t), rise } };
}

/** The wallet: the key's POL at H must cover the gas limit times the fee cap, what the node itself asks before it takes a transaction. */
export function walletCovers(keyPol: bigint, gasLimit: bigint, maxFeePerGas: bigint): { ok: boolean; required: bigint } {
  const required = gasLimit * maxFeePerGas;
  return { ok: keyPol >= required, required };
}
