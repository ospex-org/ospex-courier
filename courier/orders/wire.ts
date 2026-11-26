import type { Hex } from 'viem';
import type { CrossRow } from '../records/crosses';
import { coinAmount } from './order';

// A bet's Cross as its record serves it: the state on the wire, the fields the
// record can fill and no others, and the sentence of the Cross's current state
// with its one next step, each word for word as docs/API.md states it. The
// descriptive sentence comes first; one next step is then chosen by what the
// record itself shows: the state, the reason, the final block's time against the
// bet's expiry, and the bet's total filled at that block against its stake.

/** The next steps, as docs/API.md states them. `{…}` is filled in here. */
export const NEXT = {
  N1: (expiry: string) =>
    `Next: do not sign another bet for this wager yet. Read this record again every few seconds. A compatible final block at or past this bet's expiry, ${expiry}, proves it cannot newly fill; this clock does not. If the record is still unresolved then, read this bet's total filled at that same block. If the wager can still be placed, read the quotes again and sign only for what remains unfilled. Without those chain facts, keep waiting. The courier records an unresolved case for its operator; you need not report it.`,
  N2: 'Next: before signing another bet for this wager, establish at a compatible final block that the original signed order cannot fill again, by its expiry or an on-chain cancellation, and read its total filled at that block. Then, if the wager can still be placed, read the quotes again and sign only for the amount still unfilled.',
  N3: 'The filled part stands. Next: before signing another bet for this wager, establish at a compatible final block that the original signed order cannot fill again, by its expiry or an on-chain cancellation, and read its total filled at that block. Then, if the wager can still be placed, read the quotes again and sign only for the amount still unfilled.',
  N4: "Next: this bet's expiry has passed at a final block, so it cannot fill. If the wager can still be placed, read the quotes again and sign a new bet.",
  N5: (rest: string) => `Next: the filled part stands. This bet's expiry has passed at a final block, so the rest cannot fill. If the wager can still be placed, read the quotes again and sign a new bet for up to ${rest} USDC.`,
  N6: 'Next: this game takes no more bets, so choose another game to bet on.',
  N7: "Next: read the courier's status again; its key must cover the gas requirement before it can send. Before signing another bet for this wager, establish at a compatible final block that the original signed order cannot fill again, by its expiry or an on-chain cancellation, and read its total filled at that block. Then, if the wager can still be placed, read the quotes again and sign only for the amount still unfilled.",
  N8: (reason: string) => `the courier could not establish an account action that caused this refusal; the recorded reason is ${reason}, and the courier has put it before its operator`,
  N8_SUFFIX: 'If the new bet is refused the same way, do not sign another: the cause is not established, and there is nothing to report.',
} as const;

/** The sentence of each state, as docs/API.md states it. */
export const SENTENCE = {
  SENDING: (n: string) => `This bet was checked at block ${n} and is being signed and handed to the chain. Next: read this record again in a few seconds.`,
  UNKNOWN: (txHash: string, expiry: string) =>
    `The courier may have handed this bet's fill to the chain as transaction ${txHash}, and cannot yet say whether the chain has it. It may still fill before its expiry; a final block at or past that expiry proves it cannot fill later. This record changes when the chain shows what became of it. ${NEXT.N1(expiry)}`,
  RESTORED: (expiry: string) => `The restored record does not establish what became of this bet before recovery. Nothing new is being signed for it. ${NEXT.N1(expiry)}`,
  SENT: (txHash: string, time: string, expiry: string) =>
    `The courier handed this bet's fill to the chain as transaction ${txHash} at ${time}. The courier has not seen it in a final block yet. It may still fill, or the chain may refuse it. ${NEXT.N1(expiry)}`,
  PENDING: (txHash: string, n: string, expiry: string) => `The courier has seen transaction ${txHash} in block ${n}, which is not final yet; that block can still be dropped. ${NEXT.N1(expiry)}`,
  CONFIRMED: (txHash: string, n: string, filled: string, stake: string) => `Transaction ${txHash} is in final block ${n}. It filled ${filled} USDC of this bet's ${stake} USDC, at the prices of the quotes listed.`,
  CONFIRMED_PART: (unfilled: string) => `${unfilled} USDC of it did not fill in this transaction, and this courier does not carry the rest.`,
  SKIPPED: (k: string, reasons: string) => `The chain skipped ${k} of the quotes listed: ${reasons}.`,
  REVERTED: (txHash: string, n: string, reason: string) => `Transaction ${txHash} is in final block ${n}, and the chain refused it: ${reason}. It filled nothing of this bet and moved no USDC; the courier paid its network fee.`,
  REVERTED_UNAVAILABLE: (txHash: string, n: string) =>
    `Transaction ${txHash} is in final block ${n}, and the chain refused it. The courier could not read why. It filled nothing of this bet and moved no USDC; the courier paid its network fee. Before you bet again, check this account's USDC balance and its approval to the positions contract.`,
  REVERTED_EXPIRY: (txHash: string, n: string, blockTime: string, expiry: string) =>
    `Transaction ${txHash} reached the chain in block ${n}, at ${blockTime}, at or after this bet's expiry, ${expiry}, so it could not fill. It moved no USDC; the courier paid its network fee.`,
  CHAIN_REASON: (reason: string) => `The chain's reason: ${reason}.`,
  EXPIRED_UNMINED: (txHash: string, n: string, time: string, expiry: string) => `Transaction ${txHash} was in no block up to final block ${n}, whose time, ${time}, is at or past this bet's expiry, ${expiry}. It can no longer fill this bet.`,
  EXPIRED_UNMINED_RESTORED: (n: string, time: string, expiry: string) => `No transaction of the courier's for this bet is in a block up to final block ${n}, whose time, ${time}, is at or past its expiry, ${expiry}. None can fill it now.`,
  REPLACED: (txHash: string, replacedBy: string, n: string) => `Transaction ${txHash} can never be mined: transaction ${replacedBy}, which took its place in the courier's line, is in final block ${n}.`,
  STOPPED_AT_GATE: `A stop for a quote listed for this bet was recorded before the courier handed the fill to the chain, so this courier sent nothing for it. ${NEXT.N2}`,
  COURIER_RESTARTED: `This attempt ended before the courier handed this bet's fill to the chain, so this courier sent nothing for it. ${NEXT.N2}`,
  // The bet's line.
  NOTHING_FILLED: (n: string) => `Nothing of this bet has filled on the chain as of final block ${n}.`,
  PART_FILLED: (betFilled: string, stake: string, n: string) => `The chain shows ${betFilled} USDC of this bet's ${stake} USDC filled in total as of final block ${n}.`,
  FULL_FILLED: (stake: string, n: string) => `The chain shows this bet's ${stake} USDC filled in full as of final block ${n}.`,
} as const;

/** The chain's reason, in words: the {reason} of a traced revert, as docs/API.md states each. */
export const REASON = {
  PULL_BETTOR: (pull: string, what: string) => `the coin would not move ${pull} USDC from this bet's account: its ${what} was too low. Raise it to at least ${pull} USDC before you bet again`,
  PULL_UNKNOWN: (pull: string) => `the coin would not move ${pull} USDC from this bet's account, and the courier cannot tell why. Check its USDC balance and its approval to the positions contract; the coin can also refuse by a rule of its own`,
  GRANT_REVOKED: (grant: string) => `this bet's grant, ${grant}, was revoked or replaced before the fill landed. To sign as an agent again, use a suitable current, unexpired grant; if none exists, the account must grant one. The account may instead sign for itself`,
  GRANT_ENDED: (grant: string, endsAt: string) => `this bet's grant, ${grant}, ended at ${endsAt}, before the fill landed. To sign as an agent again, use a suitable current, unexpired grant; if none exists, the account must grant one. The account may instead sign for itself`,
  RELAY_DROPPED: (relay: string) => `this bet's account took the courier's relay, ${relay}, off its couriers before the fill landed. Register the relay again before you bet again`,
  NO_COURIER: "this quote's account had not registered the courier's relay at execution",
  CANCELLED: "this bet was cancelled on chain before the fill landed: by its own cancel, by its account moving to a new version, or by a floor raised above its order number on this line. A new bet uses a new hash, the account's current version, and an order number at or above this line's floor",
  FILLED: 'this bet had already filled on the chain',
  EXPIRED: "this bet's expiry had come when the fill landed",
  TOO_LONG: "this bet's expiry was further past the block's time than the contract allows",
  NOTHING_FILLED: (skips: string) => `none of the quotes listed could fill when the fill landed: ${skips}`,
  UNDER_MIN_FILL: (minFill: string) => `the quotes left when the fill landed could not fill this bet's minimum, ${minFill} USDC`,
  BETS_CLOSED: (gameId: string) => `bets on game ${gameId} had closed when the fill landed`,
  GAME_ENDED: (gameId: string) => `game ${gameId} had ended when the fill landed`,
  MARKET_SETTLED: 'its market had settled when the fill landed',
  COURIERS_OWN: (kind: string) => `the courier's own transaction failed: ${kind}. Nothing this account did caused it`,
} as const;

/** The game's reasons: a zero or partial total takes N6 in place of the other next steps. */
const GAME_REASONS = new Set(['BetsClosed', 'GameEnded', 'MarketSettled']);

/** What the record knows of the bet itself: its expiry, its stake and its minimum, raw, and the coin's decimals. */
export interface BetTerms {
  expiry: bigint;
  riskAmount: bigint;
  minFill: bigint;
  gameId: bigint;
  relay: string;
  decimals: number;
}

export interface LegForRecord {
  position: number;
  orderHash: Hex;
  account: string;
  oddsTick: number;
  makerRisk: string;
  takerRisk: string;
  recordedMakerRisk: string | null;
  recordedTakerRisk: string | null;
  skip: string | null;
}

/** The record's state for a bet whose stage is sent, by its Cross's state; `restored` where the database is under a restore's hold. */
export function wireState(cross: CrossRow | null, restored: boolean): { state: string; turn?: 'sending' } {
  if (cross === null) return { state: 'not sent' };
  if (cross.state === 'intent' || cross.state === 'signed') return restored ? { state: 'unknown' } : { state: 'queued', turn: 'sending' };
  if (cross.state === 'handing off' || cross.state === 'unknown') return { state: 'unknown' };
  return { state: cross.state };
}

const rec = (c: CrossRow) => (c.recorded ?? {}) as Record<string, unknown>;

/** The reason in words, the {reason} of a traced revert. */
function reasonInWords(c: CrossRow, terms: BetTerms, legs: readonly LegForRecord[]): { words: string; needsLook: boolean; game: boolean } {
  const r = rec(c).reason as { reason?: string; args?: unknown[]; pinnedOn?: unknown; affected?: Array<{ pull: string; coin: string }>; evidence?: string } | undefined;
  const name = c.revertReason ?? r?.reason ?? 'unavailable';
  const usdc = (units: bigint) => coinAmount(units, terms.decimals);
  const args = r?.args ?? [];
  switch (name) {
    case 'TakerPullRefused': {
      const pull = usdc(BigInt(String(args[1] ?? r?.affected?.[0]?.pull ?? '0')));
      if (Array.isArray(r?.pinnedOn) && r.pinnedOn.length > 0) {
        const what = r?.affected?.[0]?.coin === 'balance' ? 'USDC balance' : 'approval to the positions contract';
        return { words: REASON.PULL_BETTOR(pull, what), needsLook: false, game: false };
      }
      return { words: REASON.PULL_UNKNOWN(pull), needsLook: false, game: false };
    }
    case 'TakingOrderGrantGone': {
      const [, grant, current, endsAt] = args as [unknown, unknown, unknown, unknown];
      if (String(grant) !== String(current)) return { words: REASON.GRANT_REVOKED(String(grant)), needsLook: false, game: false };
      return { words: REASON.GRANT_ENDED(String(grant), String(endsAt)), needsLook: false, game: false };
    }
    case 'SenderNotCourier': {
      const account = String(args[0] ?? '').toLowerCase();
      const isBettor = legs.every((l) => l.account.toLowerCase() !== account);
      return isBettor ? { words: REASON.RELAY_DROPPED(terms.relay), needsLook: false, game: false } : { words: REASON.NO_COURIER, needsLook: false, game: false };
    }
    case 'TakingOrderCancelled':
      return { words: REASON.CANCELLED, needsLook: false, game: false };
    case 'TakingOrderFilled':
      return { words: REASON.FILLED, needsLook: false, game: false };
    case 'TakingOrderExpired':
      return { words: REASON.EXPIRED, needsLook: false, game: false };
    case 'TakingOrderTooLong':
      return { words: REASON.TOO_LONG, needsLook: false, game: false };
    case 'NothingFilled': {
      const reasons = (args[0] as unknown[] | undefined) ?? [];
      return { words: REASON.NOTHING_FILLED(reasons.map(String).join(', ')), needsLook: false, game: false };
    }
    case 'TakingOrderUnderMinFill':
      return { words: REASON.UNDER_MIN_FILL(usdc(terms.minFill)), needsLook: false, game: false };
    case 'BetsClosed':
      return { words: REASON.BETS_CLOSED(terms.gameId.toString()), needsLook: false, game: true };
    case 'GameEnded':
      return { words: REASON.GAME_ENDED(terms.gameId.toString()), needsLook: false, game: true };
    case 'MarketSettled':
      return { words: REASON.MARKET_SETTLED, needsLook: false, game: true };
    case 'NotTheSender':
      return { words: REASON.COURIERS_OWN('NotTheSender'), needsLook: false, game: false };
    case 'out of gas':
      return { words: REASON.COURIERS_OWN('out of gas'), needsLook: false, game: false };
    default:
      return { words: NEXT.N8(name), needsLook: true, game: false };
  }
}

/**
 * The bet's line, after a terminal outcome: the total the chain shows at the outcome's final block, and one next step
 * chosen by that total against the stake and the final block's time against the expiry. `game` takes N6; `n8` appends
 * N8's suffix after the step. A full total has no next step.
 */
function betLine(c: CrossRow, terms: BetTerms, opts: { game: boolean; n8: boolean }): string {
  const r = rec(c);
  const final = r.final as { number: string; time: string } | undefined;
  const filledRaw = r.betFilled;
  if (final === undefined || typeof filledRaw !== 'string') return '';
  const n = final.number;
  const filled = BigInt(filledRaw);
  const usdc = (units: bigint) => coinAmount(units, terms.decimals);
  const stake = usdc(terms.riskAmount);
  if (filled >= terms.riskAmount) return SENTENCE.FULL_FILLED(stake, n);
  const past = BigInt(final.time) >= terms.expiry;
  const first = filled === 0n ? SENTENCE.NOTHING_FILLED(n) : SENTENCE.PART_FILLED(usdc(filled), stake, n);
  if (opts.game) return filled === 0n ? `${first} ${NEXT.N6}` : `${first} The filled part stands. ${NEXT.N6}`;
  const step = filled === 0n ? (past ? NEXT.N4 : NEXT.N2) : past ? NEXT.N5(usdc(terms.riskAmount - filled)) : NEXT.N3;
  return opts.n8 ? `${first} ${step} ${NEXT.N8_SUFFIX}` : `${first} ${step}`;
}

/** The sentence of the Cross's current state, made from its row: what `cross.message` serves. */
export function crossMessage(c: CrossRow, terms: BetTerms, legs: readonly LegForRecord[], restored: boolean): string {
  const expiry = terms.expiry.toString();
  const r = rec(c);
  const tx = c.txHash ?? '';
  const usdc = (units: bigint) => coinAmount(units, terms.decimals);
  const join = (...parts: string[]) => parts.filter((p) => p !== '').join(' ');
  switch (c.state) {
    case 'intent':
    case 'signed':
      return restored ? SENTENCE.RESTORED(expiry) : SENTENCE.SENDING(c.block.number.toString());
    case 'handing off':
    case 'unknown':
      return restored && c.txHash === null ? SENTENCE.RESTORED(expiry) : SENTENCE.UNKNOWN(tx, expiry);
    case 'sent':
      return SENTENCE.SENT(tx, (c.times.answeredAt ?? c.times.gateAt ?? new Date(0)).toISOString(), expiry);
    case 'pending':
      return SENTENCE.PENDING(tx, c.receipt?.number.toString() ?? '', expiry);
    case 'confirmed': {
      const totals = r.totals as { taker?: string } | undefined;
      const filled = BigInt(totals?.taker ?? '0');
      const skipped = legs.filter((l) => l.skip !== null);
      return join(
        SENTENCE.CONFIRMED(tx, c.receipt?.number.toString() ?? '', usdc(filled), usdc(terms.riskAmount)),
        filled < terms.riskAmount ? SENTENCE.CONFIRMED_PART(usdc(terms.riskAmount - filled)) : '',
        skipped.length > 0 ? SENTENCE.SKIPPED(String(skipped.length), skipped.map((l) => l.skip as string).join(', ')) : '',
        betLine(c, terms, { game: false, n8: false }),
      );
    }
    case 'reverted': {
      const n = c.receipt?.number.toString() ?? '';
      const facts = (r.reason ?? {}) as { expired?: { expiry: string; blockTime: string }; evidence?: string };
      const words = c.revertEvidence === 'trace' ? reasonInWords(c, terms, legs) : null;
      if (facts.expired !== undefined) {
        return join(SENTENCE.REVERTED_EXPIRY(tx, n, facts.expired.blockTime, facts.expired.expiry), words === null ? '' : SENTENCE.CHAIN_REASON(words.words), betLine(c, terms, { game: words?.game ?? false, n8: words?.needsLook ?? false }));
      }
      if (words === null) return join(SENTENCE.REVERTED_UNAVAILABLE(tx, n), betLine(c, terms, { game: false, n8: false }));
      return join(SENTENCE.REVERTED(tx, n, words.words), betLine(c, terms, { game: words.game, n8: words.needsLook }));
    }
    case 'expired unmined': {
      const final = r.final as { number: string; time: string } | undefined;
      const head = c.txHash === null ? SENTENCE.EXPIRED_UNMINED_RESTORED(final?.number ?? '', final?.time ?? '', expiry) : SENTENCE.EXPIRED_UNMINED(tx, final?.number ?? '', final?.time ?? '', expiry);
      return join(head, betLine(c, terms, { game: false, n8: false }));
    }
    case 'replaced': {
      const by = r.replacedByBlock as { number: string } | undefined;
      return join(SENTENCE.REPLACED(tx, c.replacedBy ?? '', by?.number ?? ''), betLine(c, terms, { game: false, n8: false }));
    }
    case 'not sent': {
      if (c.notSentReason === 'STOPPED_AT_GATE') return SENTENCE.STOPPED_AT_GATE;
      if (c.notSentReason === 'COURIER_RESTARTED') return SENTENCE.COURIER_RESTARTED;
      // The reserved reason, which this build never writes: a hand-off with no proven end, read as not known.
      return SENTENCE.UNKNOWN(tx, expiry);
    }
  }
}

/** The fields of a Cross the record can fill, and no others: a field the record cannot fill yet is absent. */
export function crossFields(c: CrossRow, legs: readonly LegForRecord[], reconciled: boolean): Record<string, unknown> {
  const r = rec(c);
  const checked = c.checked;
  const gas = (checked.gas ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (c.txHash !== null) out.txHash = c.txHash;
  if (c.nonce !== null) out.nonce = c.nonce.toString();
  out.gas = { estimate: gas.estimate ?? checked.estimate ?? null, limit: gas.limit ?? checked.limit ?? null, ...(c.gasUsed === null ? {} : { used: c.gasUsed.toString() }) };
  if (c.maxFeePerGas !== null && c.maxPriorityFee !== null) out.fees = { cap: c.maxFeePerGas.toString(), tip: c.maxPriorityFee.toString(), ...(c.effectiveGasPrice === null ? {} : { paid: c.effectiveGasPrice.toString() }) };
  if (c.gasUsed !== null && c.effectiveGasPrice !== null) out.cost = coinAmount(c.gasUsed * c.effectiveGasPrice, 18);
  if (c.nodeAnswer !== null) out.answer = c.nodeAnswer;
  if (c.receipt !== null) out.receipt = { block: { number: c.receipt.number.toString(), hash: c.receipt.hash, ...(typeof r.receiptBlockTime === 'string' ? { time: r.receiptBlockTime } : {}) } };
  if (c.final !== null) out.final = { number: c.final.number.toString(), hash: c.final.hash, ...(typeof (r.final as { time?: string } | undefined)?.time === 'string' ? { time: (r.final as { time: string }).time } : {}) };
  if (typeof r.betFilled === 'string') out.betFilled = r.betFilled;
  if (c.state === 'reverted') {
    out.reason = c.revertReason ?? 'unavailable';
    out.evidence = c.revertEvidence ?? 'unavailable';
    const reason = (r.reason ?? {}) as { args?: unknown; expired?: unknown; pinnedOn?: unknown; affected?: unknown };
    if (reason.args !== undefined) out.values = reason.args;
    if (reason.expired !== undefined) out.expiry = reason.expired;
    if (reason.pinnedOn !== undefined) out.pinnedOn = reason.pinnedOn;
    if (reason.affected !== undefined) out.affected = reason.affected;
  }
  if (c.replacedBy !== null) {
    out.replacedBy = c.replacedBy;
    out.replacedByOurs = c.replacedByOurs;
  }
  if (r.pulls !== undefined) out.recordedPulls = r.pulls;
  if (r.paysBack !== undefined) out.recordedPaysBack = r.paysBack;
  if (r.paysBackRefused !== undefined) out.recordedPaysBackRefused = r.paysBackRefused;
  out.reconciled = reconciled;
  const t = c.times;
  for (const [k, v] of Object.entries({ intentAt: t.intentAt, signedAt: t.signedAt, gateAt: t.gateAt, answeredAt: t.answeredAt, receiptSeenAt: t.receiptSeenAt, outcomeAt: t.outcomeAt })) if (v !== null) out[k] = v.toISOString();
  out.legs = legs.map((l) => ({
    position: l.position,
    orderHash: l.orderHash,
    account: l.account,
    oddsTick: l.oddsTick,
    makerRisk: l.makerRisk,
    takerRisk: l.takerRisk,
    ...(l.recordedMakerRisk !== null ? { recorded: { makerRisk: l.recordedMakerRisk, takerRisk: l.recordedTakerRisk } } : {}),
    ...(l.skip !== null ? { skipped: l.skip } : {}),
  }));
  return out;
}
