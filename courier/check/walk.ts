import type { Address, Hex } from 'viem';
import type { OrderFields } from '../orders/order';
import { ORDER_RULES, splitNonce } from '../orders/order';
import { PullModel, type Side } from './pull';

// The walk: the matching contract's leg (OspexMatching `_leg`), in the
// contract's order of tests, over the candidates in the published order, with
// the filled amounts carried from leg to leg as the contract carries them in
// storage, and the netted pull at each leg (pull.ts). It lists only what the
// bet can use, and at most the bound of quotes a Cross lists.
//
// First, each candidate under a grant is judged as the contract judges every
// listed order before the first leg: its signer is the grant's agent at the
// block, its stake is within the grant's cap, and its line is on the grant's
// list or the list is empty. One that fails is not listed (the contract would
// refuse the whole Cross) and is not marked: its grant reads otherwise at the
// block, which is not an end of the quote.
//
// Then, for each candidate in order, while fewer than the bound are listed, not
// listed when (the contract's reason): its account has not registered the
// relay (NoCourier); it is cancelled, at a version that is not its account's,
// or under its floor (Cancelled); under a grant that is not its account's
// current one or ends at or under T + 1 (GrantGone); its expiry is at or under
// T + 1 (Expired); it has no room (NoRoom); no whole lot fits (NothingFits), and
// then the walk ends where no later quote can fit; its leg is under its own
// minimum with a lot or more of its room left (UnderMinFill); its account
// cannot pay the leg's netted pull (PullRefused). T + 1, and not T, for every
// signed time: the Cross lands in a block whose time is at least T + 1.

export const LOT = ORDER_RULES.lot;

/** What the reads at the block show of one candidate and its account. */
export interface CandidateState {
  /** The account has registered the relay. */
  registered: boolean;
  cancelled: boolean;
  /** The account's current version. */
  version: bigint;
  /** The floor of the market's line for the account at the version the candidate's nonce names. */
  floorAtVersion: bigint;
  /** The account's current grant, 0 for none. */
  currentGrant: number;
  /** For a candidate under a grant: the record of the grant its nonce names, and whether that grant's list names the bet's line. Null for one its account signs. */
  grant: { agent: Address; endsAt: bigint; stakeCap: bigint; lineCount: number; lineNamed: boolean } | null;
  /** What the chain shows filled of the candidate. */
  filled: bigint;
}

export interface Candidate {
  hash: Hex;
  order: OrderFields;
  signature: Hex;
  recordNumber: number;
  /** The signer the stored signature recovers to, or null where it recovers to none. */
  signer: Address | null;
  state: CandidateState;
}

/** Why a candidate was not listed: the contract's skip reasons, and the courier's own two before the walk. */
export type NotListed = 'GrantReadsOtherwise' | 'NoCourier' | 'Cancelled' | 'GrantGone' | 'Expired' | 'NoRoom' | 'NothingFits' | 'UnderMinFill' | 'PullRefused' | 'Skipped';

export interface ListedLeg {
  candidate: Candidate;
  makerRisk: bigint;
  takerRisk: bigint;
  /** The model's pull of the resting account at this leg. */
  pull: bigint;
}

export interface WalkBet {
  account: Address;
  side: Side;
  oddsTick: number;
  riskAmount: bigint;
  minFill: bigint;
  /** What the chain shows filled of the bet at the block. */
  filled: bigint;
}

export interface WalkResult {
  listed: ListedLeg[];
  /** Each candidate examined and not listed, with why. */
  notListed: Array<{ hash: Hex; why: NotListed }>;
  /** What this walk fills of the bet: the taking stakes of the listed legs. */
  filled: bigint;
  /** Why the walk ended: the bet used up (no later quote can fit), the bound of quotes listed, or the candidates ran out. */
  endedBy: 'betUsedUp' | 'quotesListed' | 'candidates';
  model: PullModel;
}

/** Whether a candidate under a grant passes the contract's up-front checks of its grant: the signer is the grant's agent, the stake within its cap, the line on its list or the list empty. True for one its account signs, which the integrity check holds to its account. */
export function grantUpFront(c: Candidate): boolean {
  const nonce = splitNonce(c.order.nonce);
  if (nonce.grantNumber === 0) return true;
  const g = c.state.grant;
  if (g === null) throw new Error(`the read holds no grant for the candidate ${c.hash} under grant ${nonce.grantNumber}`);
  if (g.agent.toLowerCase() === '0x0000000000000000000000000000000000000000') return false;
  if (c.signer === null || c.signer.toLowerCase() !== g.agent.toLowerCase()) return false;
  if (c.order.riskAmount > g.stakeCap) return false;
  if (g.lineCount !== 0 && !g.lineNamed) return false;
  return true;
}

/**
 * The walk over the candidates, in the order given (the published order), on the model's state. `skip` names
 * candidates left out whatever they are (the one re-walk after a coin's refusal). The model is the caller's, built
 * from the reads; the walk applies the listed legs to it.
 */
export function walk(bet: WalkBet, candidates: readonly Candidate[], model: PullModel, T: bigint, maxListed: number, skip: ReadonlySet<string> = new Set()): WalkResult {
  const listed: ListedLeg[] = [];
  const notListed: WalkResult['notListed'] = [];
  const filled = new Map<string, bigint>();
  let betFilled = bet.filled;
  let endedBy: WalkResult['endedBy'] = 'candidates';
  for (const c of candidates) {
    if (listed.length >= maxListed) {
      endedBy = 'quotesListed';
      break;
    }
    const hash = c.hash.toLowerCase();
    if (skip.has(hash)) {
      notListed.push({ hash: c.hash, why: 'Skipped' });
      continue;
    }
    if (!grantUpFront(c)) {
      notListed.push({ hash: c.hash, why: 'GrantReadsOtherwise' });
      continue;
    }
    const s = c.state;
    const nonce = splitNonce(c.order.nonce);
    if (!s.registered) {
      notListed.push({ hash: c.hash, why: 'NoCourier' });
      continue;
    }
    if (s.cancelled || nonce.version !== s.version || nonce.orderNumber < s.floorAtVersion) {
      notListed.push({ hash: c.hash, why: 'Cancelled' });
      continue;
    }
    if (nonce.grantNumber !== 0 && (nonce.grantNumber !== s.currentGrant || (s.grant as NonNullable<CandidateState['grant']>).endsAt <= T + 1n)) {
      notListed.push({ hash: c.hash, why: 'GrantGone' });
      continue;
    }
    if (c.order.expiry <= T + 1n) {
      notListed.push({ hash: c.hash, why: 'Expired' });
      continue;
    }
    const quoteFilled = filled.get(hash) ?? s.filled;
    if (quoteFilled >= c.order.riskAmount) {
      notListed.push({ hash: c.hash, why: 'NoRoom' });
      continue;
    }
    const left = betFilled >= bet.riskAmount ? 0n : bet.riskAmount - betFilled;
    const p = BigInt(c.order.oddsTick) - 100n;
    let lots = (c.order.riskAmount - quoteFilled) / LOT;
    if (left / p < lots) lots = left / p;
    if (lots * p < LOT) {
      notListed.push({ hash: c.hash, why: 'NothingFits' });
      // No later quote can fit: each later one's p is at least this one's, so the bet's room is under a lot or under p for them too.
      if (left < LOT || left < p) {
        endedBy = 'betUsedUp';
        break;
      }
      continue;
    }
    const makerRisk = lots * LOT;
    const takerRisk = lots * p;
    if (makerRisk < c.order.minFill && c.order.riskAmount - quoteFilled - makerRisk >= LOT) {
      notListed.push({ hash: c.hash, why: 'UnderMinFill' });
      continue;
    }
    const leg = { maker: c.order.account, makerSide: c.order.positionType, makerRisk, takerRisk };
    const tried = model.try(leg);
    if (!tried.canPay) {
      notListed.push({ hash: c.hash, why: 'PullRefused' });
      continue;
    }
    const pull = model.apply(leg);
    filled.set(hash, quoteFilled + makerRisk);
    betFilled += takerRisk;
    listed.push({ candidate: c, makerRisk, takerRisk, pull });
  }
  return { listed, notListed, filled: betFilled - bet.filled, endedBy, model };
}

/**
 * The bet's own minimum, as the contract tests it after the legs: what this Cross fills of it is at least its minimum,
 * or less than a lot of its room is left.
 */
export function meetsMinimum(bet: WalkBet, filledThisCross: bigint): boolean {
  const room = bet.riskAmount - bet.filled - filledThisCross;
  return !(filledThisCross < bet.minFill && room >= LOT);
}

/**
 * The shortest prefix of the listed legs that meets the bet's minimum, by the contract's own test, in memory: every
 * shorter prefix misses it and every longer one meets it, since each leg adds to what is filled and takes from what
 * is left. The whole list's length where only the whole list meets it.
 */
export function shortestMeetingMinimum(bet: WalkBet, legs: readonly ListedLeg[]): number {
  let filled = 0n;
  for (let k = 1; k <= legs.length; k++) {
    filled += (legs[k - 1] as ListedLeg).takerRisk;
    if (meetsMinimum(bet, filled)) return k;
  }
  return legs.length;
}
