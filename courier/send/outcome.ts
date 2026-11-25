import type { Address, Hex } from 'viem';
import { blockWithTransactions, byHash, headerByNumber, receiptOf, transactionCountAt, type Header, type JsonRpc, type Receipt } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import type { CrossRow } from '../records/crosses';
import { filledAtF, onFinalChain, readCrossReceipt, type CrossReceipt, type Named } from './chain';

// The outcome of a Cross, from the chain and from nothing else. Each look
// reads, in this order: the final block F by the tag, and from then on by its
// hash; the key's count at F; the receipt for the Cross's hash. Then the table:
// a receipt above F is pending; one at or under F, shown on F's chain, is
// confirmed or reverted once the second reads agree; one not on F's chain is
// an orphan's, set aside; no receipt with the nonce unused at F is expired
// unmined once F's time is at or past the bet's expiry, and nothing yet
// before; no receipt with the nonce used at F is the search for what used it.
// Nothing here is written; the lane writes what a look decides. A read that
// fails twice is a transient: the look says what it could not read, at which F.

export interface OutcomeDeps {
  chain: ChainReader;
  rpc: JsonRpc;
  set: BettingSet;
  /** The lane's key: the Cross's sender. */
  key: Address;
}

/** What the lane knows of the Cross's bet and its legs, from its records: the bet's hash, expiry and account; the listed occurrences in order. */
export interface Expected {
  betHash: Hex;
  account: Address;
  expiry: bigint;
  /** The listed occurrences, in list order: each quote's hash, a hash listed twice as two. */
  legs: ReadonlyArray<{ orderHash: Hex }>;
  /** The bet's filled amount at H, and H: added to the comparison only where H is shown on F's chain. */
  atH: { block: Named; betFilled: bigint } | null;
}

const s = (n: bigint) => n.toString();
const blockFacts = (b: Named) => ({ number: s(b.number), hash: b.hash });
const finalFacts = (F: Header) => ({ number: s(F.number), hash: F.hash, time: s(F.timestamp) });

/** The ran outcome's record, from the receipt's module events and the reads at F. */
export interface Ran {
  status: 'confirmed' | 'reverted';
  receipt: Receipt;
  record: CrossReceipt | null;
  betFilled: bigint;
  quotesFilled: Map<string, bigint>;
}

export type Look =
  /** F is lower than one this process has already read: the reads wait for a later one. */
  | { kind: 'not comparable'; F: Header; facts: Record<string, unknown> }
  /** A receipt in a block above F's height. */
  | { kind: 'pending'; F: Header; receipt: Receipt }
  /** A receipt in a block that is not on F's chain: set aside, and read again. */
  | { kind: 'orphan'; F: Header; receipt: Receipt }
  /** No receipt, the nonce unused at F, F's time before the expiry: nothing concluded. */
  | { kind: 'nothing yet'; F: Header }
  /** No receipt, the nonce unused at F, F's time at or past the expiry. */
  | { kind: 'expired unmined'; F: Header; betFilled: bigint }
  /** A receipt at or under F, on its chain, and the second reads agree. */
  | ({ kind: 'ran'; F: Header } & Ran)
  /** The nonce used at F by another transaction, shown there from this key at this nonce: the courier's own Cross (ours) or none. */
  | { kind: 'replaced'; F: Header; by: { hash: Hex; block: Named }; ours: Hex | null; betFilled: bigint; reads: number }
  /** The search found this Cross's own transaction, whose receipt was missing: it is read again by its block. */
  | { kind: 'missing receipt'; F: Header; block: Named; reads: number }
  /** The search could not answer, or a read at F failed: what is missing, at F. */
  | { kind: 'unavailable'; F: Header; missing: string; facts: Record<string, unknown> }
  /** The second reads disagree with the receipt: a contradiction, never a transient. */
  | { kind: 'contradiction'; F: Header; facts: Record<string, unknown> };

/** The bet's filled amount at F alone, or with each quote's: one multicall at F by its hash. */
async function filled(deps: OutcomeDeps, F: Header, bet: Hex, quotes: readonly Hex[]): Promise<{ bet: bigint; quotes: Map<string, bigint> }> {
  const m = await filledAtF(deps.chain, deps.set, F, [bet, ...quotes]);
  return { bet: m.get(bet.toLowerCase()) as bigint, quotes: m };
}

/**
 * The search for what used a nonce at F, where no receipt is found: the block where the key's count passed the
 * nonce, by halving the gap from the recorded height at which the nonce was unused; that block in full, for the one
 * transaction from this key at this nonce; and that block shown on F's chain. About log₂ of the gap in reads, and a
 * hold where a historical read is unavailable: no replacement is guessed.
 */
export async function searchNonce(deps: OutcomeDeps, F: Header, nonce: bigint, unusedAt: Named | null): Promise<{ found: { hash: Hex; block: Named }; reads: number } | { missing: string; reads: number }> {
  let reads = 0;
  if (unusedAt === null) return { missing: 'no recorded height at which the nonce was unused', reads };
  if (unusedAt.number >= F.number) return { missing: 'the recorded height at which the nonce was unused is not below the final block', reads };
  try {
    const [anchorShown] = await onFinalChain(deps.chain, deps.rpc, F, [unusedAt]);
    reads++;
    if (anchorShown !== true) return { missing: "the recorded height at which the nonce was unused is not on the final block's chain", reads };
    let lo = unusedAt.number;
    let hi = F.number;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      const h = await deps.chain.ask(F, () => headerByNumber(deps.rpc, mid));
      reads++;
      if (h === null) return { missing: `the block at height ${mid} could not be read`, reads };
      const c = await deps.chain.ask(F, () => transactionCountAt(deps.rpc, deps.key, byHash(h.hash)));
      reads++;
      if (c > nonce) hi = mid;
      else lo = mid;
    }
    const block = await deps.chain.ask(F, () => blockWithTransactions(deps.rpc, hi));
    reads++;
    if (block === null) return { missing: `the block at height ${hi}, where the key's count passed the nonce, could not be read`, reads };
    const tx = block.transactions.find((t) => t.from.toLowerCase() === deps.key.toLowerCase() && t.nonce === nonce);
    if (tx === undefined) return { missing: `the block at height ${hi} holds no transaction from the key at nonce ${nonce}`, reads };
    const named = { number: block.header.number, hash: block.header.hash };
    const [shown] = await onFinalChain(deps.chain, deps.rpc, F, [named]);
    reads++;
    if (shown !== true) return { missing: `the block at height ${hi} is not shown on the final block's chain`, reads };
    return { found: { hash: tx.hash, block: named }, reads };
  } catch (err) {
    if (err instanceof ChainUnreachable) return { missing: `a read of the search failed twice (${err.failure.method ?? 'a read'})`, reads };
    throw err;
  }
}

/** The recorded height at which a Cross's nonce was unused: the final block its pre-check read, where the key's count was at or under the nonce. */
export function unusedAtOf(cross: CrossRow): Named | null {
  const proof = (cross.checked as { send?: { nonce?: { final?: { number?: string; hash?: string }; countAtFinal?: string } } }).send?.nonce;
  if (proof?.final?.number === undefined || proof.final.hash === undefined || proof.countAtFinal === undefined || cross.nonce === null) return null;
  if (BigInt(proof.countAtFinal) > cross.nonce) return null;
  return { number: BigInt(proof.final.number), hash: proof.final.hash as Hex };
}

/**
 * One look at a Cross the courier handed to the node, or may have: the reads at F and the table above, with the second
 * reads of a ran Cross. `lastF` is the highest F this process has read for it. `ours` names the courier's own
 * transactions the records hold at this nonce, by hash, for the search.
 */
export async function look(deps: OutcomeDeps, cross: CrossRow, expected: Expected, lastF: Header | null, ours: ReadonlyMap<string, Hex>): Promise<Look> {
  if (cross.txHash === null || cross.nonce === null) throw new Error('a Cross is looked at only from its signed record on');
  const F = await deps.chain.finalHeader();
  if (lastF !== null && F.number < lastF.number) return { kind: 'not comparable', F, facts: { why: 'the final block is lower than one already read', final: finalFacts(F), last: finalFacts(lastF) } };
  try {
    const count = await deps.chain.ask(F, () => transactionCountAt(deps.rpc, deps.key, byHash(F.hash)));
    const receipt = await deps.chain.ask(F, () => receiptOf(deps.rpc, cross.txHash as Hex));
    if (receipt !== null) {
      if (receipt.transactionHash.toLowerCase() !== cross.txHash.toLowerCase()) return { kind: 'contradiction', F, facts: { why: 'the receipt is of another transaction', final: finalFacts(F), asked: cross.txHash, got: receipt.transactionHash } };
      if (receipt.blockNumber > F.number) return { kind: 'pending', F, receipt };
      const [shown] = await onFinalChain(deps.chain, deps.rpc, F, [{ number: receipt.blockNumber, hash: receipt.blockHash }]);
      if (shown !== true) return { kind: 'orphan', F, receipt };
      return ran(deps, F, cross, expected, receipt, count);
    }
    if (count <= cross.nonce) {
      if (F.timestamp < expected.expiry) return { kind: 'nothing yet', F };
      const f = await filled(deps, F, expected.betHash, []);
      return { kind: 'expired unmined', F, betFilled: f.bet };
    }
    // The nonce used at F, and no receipt: the search.
    const found = await searchNonce(deps, F, cross.nonce, unusedAtOf(cross));
    if ('missing' in found) return { kind: 'unavailable', F, missing: found.missing, facts: { search: 'unanswered', reads: found.reads, nonce: s(cross.nonce), countAtFinal: s(count) } };
    if (found.found.hash.toLowerCase() === cross.txHash.toLowerCase()) return { kind: 'missing receipt', F, block: found.found.block, reads: found.reads };
    const f = await filled(deps, F, expected.betHash, []);
    return { kind: 'replaced', F, by: found.found, ours: ours.get(found.found.hash.toLowerCase()) ?? null, betFilled: f.bet, reads: found.reads };
  } catch (err) {
    if (err instanceof ChainUnreachable) return { kind: 'unavailable', F, missing: `a read at the final block failed twice (${err.failure.method ?? 'a read'})`, facts: { failureKind: err.failure.kind, failureCode: err.failure.code } };
    throw err;
  }
}

/** The second reads of a ran Cross, held against the chain's own state at the same F, and the record from the receipt's module events. */
async function ran(deps: OutcomeDeps, F: Header, cross: CrossRow, expected: Expected, receipt: Receipt, count: bigint): Promise<Look> {
  const base = { final: finalFacts(F), receipt: { number: s(receipt.blockNumber), hash: receipt.blockHash }, txHash: receipt.transactionHash };
  if (count <= (cross.nonce as bigint)) return { kind: 'contradiction', F, facts: { ...base, why: "the key's count at the final block is not above the Cross's nonce", countAtFinal: s(count), nonce: s(cross.nonce as bigint) } };
  if (receipt.from.toLowerCase() !== deps.key.toLowerCase() || receipt.to === null || receipt.to.toLowerCase() !== deps.set.relay.toLowerCase()) {
    return { kind: 'contradiction', F, facts: { ...base, why: "the receipt's sender is not the key, or its target not the relay", from: receipt.from, to: receipt.to } };
  }
  if (receipt.status === 'reverted') {
    const f = await filled(deps, F, expected.betHash, []);
    return { kind: 'ran', F, status: 'reverted', receipt, record: null, betFilled: f.bet, quotesFilled: f.quotes };
  }
  const record = readCrossReceipt(deps.set, receipt);
  if (record.legs.length !== expected.legs.length || record.legs.some((l, i) => l.orderHash.toLowerCase() !== (expected.legs[i] as { orderHash: Hex }).orderHash.toLowerCase())) {
    return { kind: 'contradiction', F, facts: { ...base, why: 'the receipt does not hold one leg event for each listed occurrence, in order', events: record.legs.map((l) => l.orderHash), listed: expected.legs.map((l) => l.orderHash) } };
  }
  if (record.crossed === null || record.crossed.takingOrderHash.toLowerCase() !== expected.betHash.toLowerCase() || record.crossed.courier.toLowerCase() !== deps.set.relay.toLowerCase() || record.crossed.taker.toLowerCase() !== expected.account.toLowerCase()) {
    return { kind: 'contradiction', F, facts: { ...base, why: "the receipt's Crossed is not this bet's, by the relay", crossed: record.crossed === null ? null : { takingOrderHash: record.crossed.takingOrderHash, courier: record.crossed.courier, taker: record.crossed.taker } } };
  }
  const quoteHashes = [...new Set(record.legs.filter((l) => l.kind === 'filled').map((l) => l.orderHash.toLowerCase() as Hex))];
  const f = await filled(deps, F, expected.betHash, quoteHashes);
  // The bet's filled amount at F: at least the receipt's total taking stake, plus the amount at H where H is an ancestor of F.
  let baseline = 0n;
  // Nothing filled at H adds nothing, wherever H stands: its place on F's chain is read only where there is an amount to add.
  if (expected.atH !== null && expected.atH.betFilled > 0n) {
    const [hShown] = await onFinalChain(deps.chain, deps.rpc, F, [expected.atH.block]);
    if (hShown === true) baseline = expected.atH.betFilled;
  }
  if (f.bet < record.crossed.totalTakerRisk + baseline) {
    return { kind: 'contradiction', F, facts: { ...base, why: "the bet's filled amount at the final block is below the receipt's total taking stake", betFilled: s(f.bet), totalTakerRisk: s(record.crossed.totalTakerRisk), baselineAtH: s(baseline) } };
  }
  // Each quote's filled amount at F: at least what the receipt's legs for that hash took, a hash listed twice summed once.
  for (const q of quoteHashes) {
    const took = record.legs.reduce((sum, l) => (l.kind === 'filled' && l.orderHash.toLowerCase() === q ? sum + l.makerRisk : sum), 0n);
    const at = f.quotes.get(q) ?? 0n;
    if (at < took) return { kind: 'contradiction', F, facts: { ...base, why: "a quote's filled amount at the final block is below what the receipt's legs took", quote: q, filled: s(at), took: s(took) } };
  }
  return { kind: 'ran', F, status: 'confirmed', receipt, record, betFilled: f.bet, quotesFilled: f.quotes };
}

/** The look's facts for a line or an ACTION: F, and what it found, never an amount the look did not read. */
export function lookFacts(l: Look): Record<string, unknown> {
  const out: Record<string, unknown> = { look: l.kind, final: finalFacts(l.F) };
  if (l.kind === 'pending' || l.kind === 'orphan') out.receipt = { number: s(l.receipt.blockNumber), hash: l.receipt.blockHash };
  if (l.kind === 'missing receipt') out.block = blockFacts(l.block);
  if (l.kind === 'replaced') out.by = { hash: l.by.hash, block: blockFacts(l.by.block), ours: l.ours };
  if (l.kind === 'unavailable') Object.assign(out, { missing: l.missing }, l.facts);
  if (l.kind === 'contradiction' || l.kind === 'not comparable') Object.assign(out, l.facts);
  return out;
}
