import type { Address } from 'viem';

// The netted pull: what the positions contract takes from an account's wallet
// for a fill, after what the account already holds on that market. It is the
// contract's own rule (OspexPositions: the fill's records, `_pull`, `_worst`
// and `finishFills`), in whole numbers held as bigints: nothing divides, so
// nothing rounds.
//
// An account's worst loss over its two records on a market is the larger of
// what it loses if side A wins (its risk on B less its profit on A) and if side
// B wins (the mirror), each difference taken only where its first term is the
// larger, and zero at least. At a leg the resting account's record on its side
// grows by (its stake, the taking stake), and the taking account's on the other
// side by (the taking stake, the resting stake). The resting account is pulled,
// at its leg, what lifts its held amount to its worst loss, and nothing where
// it holds that already; it can pay when that is within what is left of its
// balance and of its allowance after this Cross's earlier pulls of it. The
// taking account is pulled once, after every leg, the same way. Then every
// account of the Cross is paid back what it holds above its worst loss: the
// taking account first, then each resting account in list order, one listed
// twice visited twice. A pay-back is never spent ahead, and the coin may refuse
// it: then the amount stays held, and the Cross completes. So a pay-back has two
// outcomes, and both are the contract's.

export type Side = 0 | 1;

/** An account's two records on one market: what it risks and stands to win on each side. */
export interface Records {
  riskA: bigint;
  profitA: bigint;
  riskB: bigint;
  profitB: bigint;
}

export const NO_RECORDS: Records = { riskA: 0n, profitA: 0n, riskB: 0n, profitB: 0n };

/** What the model needs of one account, read at the block: its records and what is held for it (zero on a market not drawn), its balance, and its allowance to the positions contract. */
export interface AccountRead {
  records: Records;
  held: bigint;
  balance: bigint;
  allowance: bigint;
}

/** The contract's `_worst`: each term compared before it is subtracted, zero at least. */
export function worstLoss(r: Records): bigint {
  const ifAWins = r.riskB > r.profitA ? r.riskB - r.profitA : 0n;
  const ifBWins = r.riskA > r.profitB ? r.riskA - r.profitB : 0n;
  return ifAWins > ifBWins ? ifAWins : ifBWins;
}

/** The records after a stake of `risk` for a profit of `profit` on `side`. */
export function grown(r: Records, side: Side, risk: bigint, profit: bigint): Records {
  return side === 0 ? { ...r, riskA: r.riskA + risk, profitA: r.profitA + profit } : { ...r, riskB: r.riskB + risk, profitB: r.profitB + profit };
}

/** A self-leg: the courier's own fault, never computed. The candidate query leaves the bettor's quotes out, so it cannot arise unless the courier erred. */
export class SelfLeg extends Error {
  constructor(readonly account: Address) {
    super(`a leg whose resting account is the taking account, ${account}: the courier lists no such leg`);
    this.name = 'SelfLeg';
  }
}

/** A leg of the walk, as the model applies it. */
export interface Leg {
  maker: Address;
  makerSide: Side;
  makerRisk: bigint;
  takerRisk: bigint;
}

/** One pay-back visit, in the contract's order, with the amount the model predicts: held above the worst loss after every pull. */
export interface PayBack {
  account: Address;
  amount: bigint;
}

/** What the model predicts of a whole Cross. */
export interface Pulls {
  /** Each listed leg's pull of its resting account, in list order. */
  legPulls: bigint[];
  /** The taking account's one pull, after every leg. */
  takerPull: bigint;
  /** Each account's total pulled in this Cross, lowercase address to amount. */
  pulled: Map<string, bigint>;
  /** The pay-back visits, the taking account first, then each leg's resting account in list order; a zero visit is left out. */
  paysBack: PayBack[];
  /** Each account's held amount after the pulls and before any pay-back. */
  heldAfterPulls: Map<string, bigint>;
  /** Each account's worst loss over its records as the Cross leaves them. */
  worstAfter: Map<string, bigint>;
}

const key = (a: Address) => a.toLowerCase();

/**
 * The model of one Cross on one market: the accounts' reads at the block, then each leg applied as the contract
 * applies it. Legs are tried before they are applied, so the walk can leave out a leg whose resting account cannot
 * pay, and keep none of that leg's writes, as the contract undoes them.
 */
export class PullModel {
  private readonly state = new Map<string, { records: Records; held: bigint; balance: bigint; allowance: bigint }>();
  private readonly legs: Leg[] = [];
  private readonly legPulls: bigint[] = [];

  constructor(
    accounts: ReadonlyMap<string, AccountRead>,
    readonly taker: Address,
    readonly takerSide: Side,
  ) {
    for (const [account, read] of accounts) state(this.state, account, read);
    if (!this.state.has(key(taker))) throw new Error(`the model holds no read for the taking account ${taker}`);
  }

  private account(a: Address) {
    const s = this.state.get(key(a));
    if (s === undefined) throw new Error(`the model holds no read for the account ${a}`);
    return s;
  }

  /** What the resting account would be pulled at this leg, and whether what is left of its balance and its allowance covers it. Changes nothing. */
  try(leg: Leg): { pull: bigint; canPay: boolean } {
    if (key(leg.maker) === key(this.taker)) throw new SelfLeg(leg.maker);
    const s = this.account(leg.maker);
    const worst = worstLoss(grown(s.records, leg.makerSide, leg.makerRisk, leg.takerRisk));
    const pull = worst > s.held ? worst - s.held : 0n;
    return { pull, canPay: pull <= s.balance && pull <= s.allowance };
  }

  /** Applies the leg: both records grow, the resting account is pulled, its held amount rises to its worst loss, and its balance and allowance fall by the pull. Returns the pull. The caller has tried it and found it can pay. */
  apply(leg: Leg): bigint {
    const { pull, canPay } = this.try(leg);
    if (!canPay) throw new Error(`a leg applied whose resting account cannot pay its pull of ${pull}`);
    const m = this.account(leg.maker);
    m.records = grown(m.records, leg.makerSide, leg.makerRisk, leg.takerRisk);
    const worst = worstLoss(m.records);
    if (worst > m.held) m.held = worst;
    m.balance -= pull;
    m.allowance -= pull;
    const t = this.account(this.taker);
    t.records = grown(t.records, this.takerSide, leg.takerRisk, leg.makerRisk);
    this.legs.push(leg);
    this.legPulls.push(pull);
    return pull;
  }

  /** The taking account's one pull over its records as the legs left them, and whether its balance and its allowance cover it. */
  takerPull(): { pull: bigint; balance: bigint; allowance: bigint; canPay: boolean } {
    const t = this.account(this.taker);
    const worst = worstLoss(t.records);
    const pull = worst > t.held ? worst - t.held : 0n;
    return { pull, balance: t.balance, allowance: t.allowance, canPay: pull <= t.balance && pull <= t.allowance };
  }

  /** The legs applied so far, in list order. */
  applied(): readonly Leg[] {
    return this.legs;
  }

  /**
   * The whole Cross: the taking account's pull, then the pay-backs in the contract's order, each the amount held
   * above the worst loss after every pull. A pay-back is never spent ahead. Changes nothing.
   */
  finish(): Pulls {
    const held = new Map<string, bigint>();
    const worst = new Map<string, bigint>();
    const pulled = new Map<string, bigint>();
    for (const [a, s] of this.state) {
      held.set(a, s.held);
      worst.set(a, worstLoss(s.records));
    }
    this.legs.forEach((leg, i) => pulled.set(key(leg.maker), (pulled.get(key(leg.maker)) ?? 0n) + (this.legPulls[i] as bigint)));
    const t = this.takerPull();
    if (t.pull > 0n) {
      held.set(key(this.taker), (held.get(key(this.taker)) ?? 0n) + t.pull);
      pulled.set(key(this.taker), (pulled.get(key(this.taker)) ?? 0n) + t.pull);
    }
    const heldAfterPulls = new Map(held);
    const paysBack: PayBack[] = [];
    // The contract's order: the taking account, then each filled leg's resting account in list order. A visit pays
    // what is held above the worst loss and lowers the held amount to it, so a second visit to an account finds
    // nothing more where the first paid. The model predicts every pay-back paid; the coin's refusal is the
    // contract's other outcome, which the comparison accepts beside this one.
    for (const account of [this.taker, ...this.legs.map((l) => l.maker)]) {
      const a = key(account);
      const h = held.get(a) ?? 0n;
      const w = worst.get(a) ?? 0n;
      if (h > w) {
        paysBack.push({ account, amount: h - w });
        held.set(a, w);
      }
    }
    return { legPulls: [...this.legPulls], takerPull: t.pull, pulled, paysBack, heldAfterPulls, worstAfter: worst };
  }
}

function state(map: Map<string, { records: Records; held: bigint; balance: bigint; allowance: bigint }>, account: string, read: AccountRead): void {
  map.set(account.toLowerCase(), { records: { ...read.records }, held: read.held, balance: read.balance, allowance: read.allowance });
}

/**
 * What the model reads at the block, for the accounts of one Cross on one market: for each, its two records and what
 * is held for it (read C, only where the market is drawn; all zero where it is not), and its balance and its
 * allowance to the positions contract (reads A and B). Every argument is known before the read: the market's id is
 * read A's answer.
 */
export function reads(accounts: readonly Address[], marketId: bigint): { marketId: bigint; accounts: Address[]; positions: boolean } {
  const seen = new Set<string>();
  const unique = accounts.filter((a) => (seen.has(key(a)) ? false : (seen.add(key(a)), true)));
  return { marketId, accounts: unique, positions: marketId !== 0n };
}

/** The model's prediction for a whole walk on a state: every leg applied in order, then the taking pull and the pay-backs. */
export function pulls(walk: readonly Leg[], state_: ReadonlyMap<string, AccountRead>, taker: Address, takerSide: Side): Pulls {
  const model = new PullModel(state_, taker, takerSide);
  for (const leg of walk) model.apply(leg);
  return model.finish();
}

/** Signed whole-number division rounded toward minus infinity, and toward plus infinity. */
const floorDiv = (a: bigint, b: bigint): bigint => (a >= 0n ? a / b : -((-a + b - 1n) / b));
const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b);

/**
 * The book's `payable` for one quote alone, against the reads at the page's block: the largest number of whole lots
 * of its `remaining` whose leg's netted pull its wallet covers, times 100. For a maker on side A (side B mirrored)
 * with c = min(balance, allowance) + held and p = tick − 100, the worst loss after a leg of L lots is
 * max(0, (riskB − profitA) − pL, (riskA − profitB) + 100L): the first term falls as L grows and the second rises, so
 * the lots it can pay are one interval, from max(0, ⌈((riskB − profitA) − c) ÷ p⌉) to
 * min(remaining ÷ 100, ⌊(c − (riskA − profitB)) ÷ 100⌋). `payable` is 100 times its top, or 0 where it is empty.
 */
export function payable(q: { side: Side; oddsTick: number; remaining: bigint }, a: AccountRead): bigint {
  const LOT = 100n;
  const p = BigInt(q.oddsTick) - 100n;
  if (p <= 0n || q.remaining < LOT) return 0n;
  const c = (a.balance < a.allowance ? a.balance : a.allowance) + a.held;
  // On side A the falling term is (riskB − profitA) and the rising one (riskA − profitB); on side B, the mirror.
  const falling = q.side === 0 ? a.records.riskB - a.records.profitA : a.records.riskA - a.records.profitB;
  const rising = q.side === 0 ? a.records.riskA - a.records.profitB : a.records.riskB - a.records.profitA;
  let low = ceilDiv(falling - c, p);
  if (low < 0n) low = 0n;
  let high = floorDiv(c - rising, LOT);
  const room = q.remaining / LOT;
  if (high > room) high = room;
  if (high < low || high < 1n) return 0n;
  return high * LOT;
}
