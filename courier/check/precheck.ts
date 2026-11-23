import type pg from 'pg';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { COIN_ABI, MATCHING_ABI, POSITIONS_ABI, RELAY_ABI, MULTICALL_ADDRESS, RELAY_SENDER_SLOT } from '../chain/abi';
import { readForBet, readPositions, readQuotes, floorKey, grantKey, type BetRead, type PositionRead, type QuotesRead } from '../chain/reads';
import { callAt, describeNodeFailure, estimateGasAt, ExecutionReverted, multicallAt, OutOfGas, transactionCountAt, byHash, type Header, type JsonRpc, type MulticallResult, type StateOverride } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import { BOUNDS, CHAIN_LIMITS } from '../http/limits';
import { grantGoneWhy } from '../orders/door';
import { coinAmount, ORDER_RULES, orderHash, orderSigner, splitNonce, type OrderFields } from '../orders/order';
import { isPublishedList } from '../orders/published';
import { grantGone, orderGone, quoteEnd } from '../orders/standing';
import { candidates as candidateQuery, type CandidatesResult, type MarkEnded, type OrderRow, type Orders } from '../records/orders';
import { decodeRevert, reasonText, type Decoded } from './decode';
import type { LaneHooks } from './hooks';
import { NO_RECORDS, PullModel, pulls as predict, type AccountRead, type Leg, type Pulls, type Side } from './pull';
import { VERDICT } from './sentences';
import { meetsMinimum, shortestMeetingMinimum, walk, type Candidate, type CandidateState, type ListedLeg, type WalkBet, type WalkResult } from './walk';

// One bet's check, at one block named by its hash: H, the latest block's
// header, read first; every request for a value names H by its hash, and none
// falls back to a number or a tag. The steps, in order: the lapse; read A,
// judged at once in the door's order; F, the final header; the candidate query;
// read B; read C; the walk with the netted pull; the marks; the bettor's pull;
// the simulation of the exact call, the model's comparison where the node takes
// an override, the probe and the one re-walk; the gas, and the search for a
// shorter fill over a ceiling; the key's count; and H read again by number.
//
// A read that fails, or answers for another block, throws the round away: each
// read is tried twice, then one more round is made from a new latest block with
// nothing kept, and then the bet is refused CHAIN_UNREACHABLE. A refusal the
// contract decodes is a verdict on the Cross, never the node's failure.
//
// The check writes nothing but its two statements of the book (the candidate
// query and the marks), each one statement on the lane's connection: what it
// returns is the outcome, which the lane writes in one transaction with its
// line.

export interface CheckDeps {
  chain: ChainReader;
  rpc: JsonRpc;
  set: BettingSet;
  published: readonly Address[];
  /** COURIER_ADDRESS: the key's address, which the exact call is made from. */
  courier: Address;
  /** Whether the node took the override at start: the comparison runs only then. */
  overrideTaken: boolean;
  /** The lane's own connection: the candidate query and the marks, each one statement. */
  lane: pg.Pool;
  orders: Orders;
  hooks: LaneHooks;
}

/** A header as a record names it. */
export interface BlockNamed {
  number: string;
  hash: Hex;
  time: string;
}

export const named = (h: Header): BlockNamed => ({ number: h.number.toString(), hash: h.hash, time: h.timestamp.toString() });

/** A verdict: the code, its sentence and its own fields; the block that decided it, or null where no check finished; the last header read where none decided it. */
export interface Verdict {
  code: string;
  error: string;
  fields: Record<string, unknown>;
  block: BlockNamed | null;
  lastObservedBlock?: BlockNamed;
}

/** A fault of the courier's own seen in the check: an incident line, written with the outcome. */
export interface Incident {
  reason: string;
  orderHash?: Hex;
  facts: Record<string, unknown>;
}

export interface ReadyCross {
  block: Header;
  legs: Array<{ orderHash: Hex; account: Address; oddsTick: number; makerRisk: bigint; takerRisk: bigint }>;
  takerRisk: bigint;
  unfilled: bigint;
  pulls: Record<string, string>;
  paysBack: Record<string, string>;
  paysBackRefused: Record<string, string>;
  gas: { estimate: bigint; limit: bigint };
  nonce: bigint;
  checked: Record<string, unknown>;
}

export type CheckOutcome =
  | { kind: 'lapsed'; verdict: Verdict; incidents: Incident[] }
  | { kind: 'refused'; verdict: Verdict; incidents: Incident[] }
  | { kind: 'ready'; cross: ReadyCross; incidents: Incident[] };

/** The check starts again: H at its height is no longer H. */
class RoundAgain extends Error {
  constructor(readonly failure: { kind: string; code: number | string | null; method: string | null }) {
    super('the block the check was made at is no longer canonical at its height');
    this.name = 'RoundAgain';
  }
}

const usdc = (deps: CheckDeps, units: bigint) => coinAmount(units, deps.set.coinDecimals);

/**
 * The check of one bet, in at most two rounds. The bet's row is the one the reservation took. `observe` is told of
 * every H a round reads, so the outcome of two failed rounds can name the last one, labelled as an observation.
 */
export async function checkBet(deps: CheckDeps, bet: OrderRow): Promise<CheckOutcome> {
  let lastObserved: Header | null = null;
  let failure: { kind: string; code: number | string | null; method: string | null } | null = null;
  for (let round = 1; round <= 2; round++) {
    try {
      return await oneRound(deps, bet, (h) => (lastObserved = h));
    } catch (err) {
      if (err instanceof ChainUnreachable) {
        failure = err.failure;
        continue;
      }
      if (err instanceof RoundAgain) {
        failure = err.failure;
        continue;
      }
      throw err;
    }
  }
  const observed = lastObserved as Header | null;
  return {
    kind: 'refused',
    verdict: {
      code: 'CHAIN_UNREACHABLE',
      error: VERDICT.CHAIN_UNREACHABLE,
      fields: { operation: failure?.method ?? null, failureKind: failure?.kind ?? null, failureCode: failure?.code ?? null },
      block: null,
      ...(observed === null ? {} : { lastObservedBlock: named(observed) }),
    },
    incidents: [],
  };
}

/** A refusal decided at H. */
const refusedAt = (H: Header, code: string, error: string, fields: Record<string, unknown> = {}, incidents: Incident[] = []): CheckOutcome => ({
  kind: 'refused',
  verdict: { code, error, fields, block: named(H) },
  incidents,
});

async function oneRound(deps: CheckDeps, bet: OrderRow, observe: (h: Header) => void): Promise<CheckOutcome> {
  const order = bet.order;
  // 1. H, with its gas limit.
  const H = await deps.chain.latestHeader();
  observe(H);
  const T = H.timestamp;
  const n = H.number.toString();
  // 2. The lapse: the bet's expiry at or under T + 1 can fill in no later block. Nothing more is read.
  if (order.expiry <= T + 1n) {
    return {
      kind: 'lapsed',
      verdict: { code: 'BET_LAPSED', error: VERDICT.BET_LAPSED(order.expiry.toString(), n, (T + 1n).toString()), fields: { expiry: order.expiry.toString(), neededAbove: (T + 1n).toString() }, block: named(H) },
      incidents: [],
    };
  }
  // 3. Read A, judged at once in the door's order.
  const A = await readForBet(deps.chain, deps.set, H, order, bet.hash, bet.marketKey, deps.courier);
  await deps.hooks.at('after-read-a', bet.hash);
  const judged = await judgeBet(deps, bet, A, H);
  if (judged !== null) return judged;

  // 4. F, the final header: the candidate query's mark needs its time.
  const F = await deps.chain.finalHeader();
  // 5. The candidate query, one statement, alone, on the lane's connection.
  const betSide = order.positionType;
  const quoteSide = (1 - betSide) as Side;
  const cand = await candidateQuery(deps.lane, { marketKey: bet.marketKey, side: quoteSide, betTick: order.oddsTick, bettor: order.account, blockTime: T, finalTime: F.timestamp });
  deps.hooks.observe?.('candidates', cand.rows.map((r) => r.hash));

  // 6. Read B, the candidates' standing: in calls of at most 100 quotes, each at H. None where the query returned none.
  const readB: QuotesRead = { quotes: new Map(), accounts: new Map(), floors: new Map(), grants: new Map(), grantLines: new Map() };
  const line = { gameId: order.gameId, scorer: order.scorer, lineTicks: order.lineTicks };
  for (let i = 0; i < cand.rows.length; i += 100) {
    const batch = cand.rows.slice(i, i + 100).map((r) => ({ hash: r.hash, account: r.order.account, nonce: r.order.nonce }));
    const part = await readQuotes(deps.chain, deps.set, H, bet.marketKey, batch, line);
    for (const k of ['quotes', 'accounts', 'floors', 'grants', 'grantLines'] as const) for (const [key, value] of part[k] ?? new Map()) (readB[k] as Map<string, unknown>).set(key, value);
  }

  // 7. Read C, the positions, only where the market is drawn and the query returned a quote.
  const accounts = [order.account, ...cand.rows.map((r) => r.order.account)];
  let positions = new Map<string, PositionRead>();
  let marketOpen: boolean | null = null;
  if (A.marketId !== 0n && cand.rows.length > 0) {
    const unique = [...new Map(accounts.map((a) => [a.toLowerCase(), getAddress(a)])).values()];
    const c = await readPositions(deps.chain, deps.set, H, A.marketId, unique);
    positions = c.positions;
    marketOpen = c.open;
  }
  await deps.hooks.at('after-read-c', bet.hash);

  // The candidates as the walk takes them: each row hashed again and its signature recovered; one that no longer
  // hashes to its key, or whose signature fails under its own key, is not listed, with an incident line.
  const incidents: Incident[] = [];
  const walkInput: Candidate[] = [];
  for (const row of cand.rows) {
    const rehashed = orderHash(row.order, deps.set.chainId, deps.set.matching);
    const signer = await orderSigner(row.order, row.signature, deps.set.chainId, deps.set.matching);
    const nonce = splitNonce(row.order.nonce);
    if (rehashed.toLowerCase() !== row.hash.toLowerCase() || signer === null || (nonce.grantNumber === 0 && signer.toLowerCase() !== row.order.account.toLowerCase())) {
      incidents.push({ reason: 'STORED_ORDER_CHANGED', orderHash: row.hash, facts: { role: 'rest', block: n, rehashed, signer } });
      continue;
    }
    const a = readB.accounts.get(row.order.account.toLowerCase());
    const q = readB.quotes.get(row.hash.toLowerCase());
    const floor = readB.floors.get(floorKey(row.order.account, nonce.version));
    if (a === undefined || q === undefined || floor === undefined) throw new Error(`read B holds no answer for the candidate ${row.hash}`);
    const g = nonce.grantNumber === 0 ? null : readB.grants.get(grantKey(row.order.account, nonce.grantNumber));
    const state: CandidateState = {
      registered: a.registered,
      cancelled: q.cancelled,
      version: a.version,
      floorAtVersion: floor,
      currentGrant: a.currentGrant,
      grant: g === null || g === undefined ? null : { ...g, lineNamed: readB.grantLines?.get(grantKey(row.order.account, nonce.grantNumber)) ?? false },
      filled: q.filled,
    };
    if (nonce.grantNumber !== 0 && state.grant === null) throw new Error(`read B holds no grant for the candidate ${row.hash}`);
    const live = deps.hooks.listAsLive?.(row.hash) === true;
    walkInput.push({
      hash: row.hash,
      order: row.order,
      signature: row.signature,
      recordNumber: row.recordNumber,
      signer,
      state: live ? { ...state, registered: true, cancelled: false, version: nonce.version, floorAtVersion: 0n, currentGrant: nonce.grantNumber, filled: 0n } : state,
    });
  }
  deps.hooks.observe?.('walk input', walkInput.map((c) => c.hash));

  // The model's reads: each account's records and held amount (read C, zero where the market is not drawn), its
  // balance and its allowance (read A for the bettor, read B for the others).
  const modelState = new Map<string, AccountRead>();
  const recordsOf = (a: Address) => {
    const p = positions.get(a.toLowerCase());
    return p === undefined ? { records: NO_RECORDS, held: 0n } : { records: { riskA: p.riskA, profitA: p.profitA, riskB: p.riskB, profitB: p.profitB }, held: p.held };
  };
  modelState.set(order.account.toLowerCase(), { ...recordsOf(order.account), balance: A.balance, allowance: A.allowance });
  for (const c of walkInput) {
    const a = readB.accounts.get(c.order.account.toLowerCase());
    if (a === undefined || c.order.account.toLowerCase() === order.account.toLowerCase()) continue;
    modelState.set(c.order.account.toLowerCase(), { ...recordsOf(c.order.account), balance: a.balance, allowance: a.allowance });
  }

  const walkBet: WalkBet = { account: order.account, side: betSide, oddsTick: order.oddsTick, riskAmount: order.riskAmount, minFill: order.minFill, filled: A.filled };
  const ctx: RoundContext = { deps, bet, A, H, F, T, n, cand, walkInput, modelState, walkBet, incidents, readB, positions, marketOpen };

  // 8. The walk.
  const first = walk(walkBet, walkInput, new PullModel(modelState, order.account, betSide), T, BOUNDS.quotesListed);

  // 9. The marks: the quotes the reads showed ended at H, in one statement, alone, by the book's own predicate. Not
  // a quote whose account dropped the relay, nor one whose grant reads otherwise at H, nor one taken as live by a
  // test's fault.
  const marks: MarkEnded[] = [];
  for (const c of walkInput) {
    if (deps.hooks.listAsLive?.(c.hash) === true) continue;
    if (first.notListed.some((x) => x.hash === c.hash && x.why === 'GrantReadsOtherwise')) continue;
    const how = quoteEnd({ hash: c.hash, account: c.order.account, nonce: c.order.nonce, riskAmount: c.order.riskAmount }, readB, T);
    if (how !== null) marks.push({ hash: c.hash, how });
  }
  if (marks.length > 0) await deps.orders.markEnded(deps.lane, marks, { number: H.number, hash: H.hash });

  return afterWalk(ctx, first, new Set(), null);
}

interface RoundContext {
  deps: CheckDeps;
  bet: OrderRow;
  A: BetRead;
  H: Header;
  F: Header;
  T: bigint;
  n: string;
  cand: CandidatesResult;
  walkInput: Candidate[];
  modelState: Map<string, AccountRead>;
  walkBet: WalkBet;
  incidents: Incident[];
  readB: QuotesRead;
  positions: Map<string, PositionRead>;
  marketOpen: boolean | null;
}

/** Read A judged in the door's order: the relay's sender, the bet's own row, its grant, its registration, the game, its standing, the cap. Null where the bet passes. */
async function judgeBet(deps: CheckDeps, bet: OrderRow, A: BetRead, H: Header): Promise<CheckOutcome | null> {
  const order = bet.order;
  const n = H.number.toString();
  const T = H.timestamp;
  if (A.relaySender.toLowerCase() !== deps.courier.toLowerCase()) {
    return refusedAt(H, 'COURIER_CANNOT_SEND', VERDICT.COURIER_CANNOT_SEND(n), { relaySender: A.relaySender, key: deps.courier });
  }
  // The bet's stored row: it hashes to its key, the contract's hash is the same, and its signature recovers to the
  // signer it must have (its account's own for grant 0; any signer for a grant, which its grant judges next).
  const nonce = splitNonce(order.nonce);
  const rehashed = orderHash(order, deps.set.chainId, deps.set.matching);
  const signer = await orderSigner(order, bet.signature, deps.set.chainId, deps.set.matching);
  if (rehashed.toLowerCase() !== bet.hash.toLowerCase() || A.contractHash.toLowerCase() !== bet.hash.toLowerCase() || signer === null || (nonce.grantNumber === 0 && signer.toLowerCase() !== order.account.toLowerCase())) {
    return refusedAt(H, 'COURIER_FAULT', VERDICT.COURIER_FAULT, {}, [{ reason: 'STORED_ORDER_CHANGED', orderHash: bet.hash, facts: { role: 'take', block: n, rehashed, contractHash: A.contractHash, signer } }]);
  }
  if (nonce.grantNumber !== 0) {
    const g = A.grant;
    const g_ = String(nonce.grantNumber);
    if (g === null || A.currentGrant === null) throw new Error(`read A holds no grant for a bet under grant ${nonce.grantNumber}`);
    if (g.agent.toLowerCase() === '0x0000000000000000000000000000000000000000') return refusedAt(H, 'BAD_SIGNATURE', VERDICT.BAD_SIGNATURE_NO_GRANT(n, g_), { grantNumber: nonce.grantNumber });
    if (g.agent.toLowerCase() !== signer.toLowerCase()) return refusedAt(H, 'BAD_SIGNATURE', VERDICT.BAD_SIGNATURE_NOT_AGENT(n, g_), { grantNumber: nonce.grantNumber });
    if (order.riskAmount > g.stakeCap) return refusedAt(H, 'AGENT_STAKE_ABOVE_CAP', VERDICT.AGENT_STAKE_ABOVE_CAP(n, g_, usdc(deps, g.stakeCap), usdc(deps, order.riskAmount)), { grantNumber: nonce.grantNumber, stakeCap: g.stakeCap.toString() });
    if (g.lineCount !== 0 && !g.lineNamed) return refusedAt(H, 'LINE_NOT_IN_GRANT', VERDICT.LINE_NOT_IN_GRANT(n, g_), { grantNumber: nonce.grantNumber });
    if (grantGone(nonce, { currentGrant: A.currentGrant, endsAt: g.endsAt }, T)) {
      return refusedAt(H, 'GRANT_GONE', VERDICT.GRANT_GONE(n, grantGoneWhy(nonce.grantNumber, A.currentGrant, g.endsAt, T)), { grantNumber: nonce.grantNumber, currentGrant: A.currentGrant, endsAt: g.endsAt.toString(), chainTime: T.toString() });
    }
  }
  if (!A.registered) return refusedAt(H, 'NOT_REGISTERED', VERDICT.NOT_REGISTERED(n, deps.set.relay));
  const game = A.game;
  const gameId = order.gameId.toString();
  if (!game.known) return refusedAt(H, 'UNKNOWN_GAME', VERDICT.UNKNOWN_GAME(n, gameId));
  if (game.start === null) return refusedAt(H, 'NO_WRITTEN_START', VERDICT.NO_WRITTEN_START(n, gameId));
  if (game.reporters === null || !isPublishedList(game.reporters, deps.published)) return refusedAt(H, 'REPORTERS_NOT_THE_PUBLISHED_LIST', VERDICT.REPORTERS_NOT_THE_PUBLISHED_LIST(n, gameId), { published: deps.published });
  if (game.status !== null && game.status >= 4) return refusedAt(H, 'GAME_ENDED', VERDICT.GAME_ENDED(n, gameId, String(game.status)), { status: game.status });
  const closesAt = game.start + (game.window ?? 0n);
  if (closesAt <= T + 1n) return refusedAt(H, 'BETS_CLOSED', VERDICT.BETS_CLOSED(n, gameId, closesAt.toString(), T.toString()), { closesAt: closesAt.toString(), chainTime: T.toString() });
  if (orderGone(nonce, A)) return refusedAt(H, 'CANCELLED', VERDICT.CANCELLED(n));
  if (order.riskAmount - A.filled < ORDER_RULES.lot) return refusedAt(H, 'FILLED', VERDICT.FILLED(n));
  if (order.riskAmount > A.cap && !A.capLifted) return refusedAt(H, 'ABOVE_CAP', VERDICT.ABOVE_CAP(n, usdc(deps, A.cap), usdc(deps, order.riskAmount)), { cap: A.cap.toString() });
  return null;
}

/** The answers after the walk, then the bettor's pull, then the exact call and its gas: for the walk given, made once more at most (`rewalked`). */
async function afterWalk(ctx: RoundContext, w: WalkResult, skipped: Set<string>, rewalked: { left: Hex[] } | null): Promise<CheckOutcome> {
  const { deps, bet, H, n, cand, walkBet, incidents } = ctx;
  const listed = w.listed;
  const pageFull = cand.rows.length >= BOUNDS.quotesExamined;
  const scanBound = cand.scanned >= BOUNDS.scanRows;
  const byBound = w.endedBy === 'candidates';
  if (listed.length === 0) {
    if (byBound && pageFull) return refusedAt(H, 'DEPTH_BEYOND_BOUND', VERDICT.DEPTH_EXAMINED_NONE(String(BOUNDS.quotesExamined), n), { bound: 'quotesExamined' }, incidents);
    if (byBound && scanBound) return refusedAt(H, 'DEPTH_BEYOND_BOUND', VERDICT.DEPTH_SCAN_NONE(BOUNDS.scanRows.toLocaleString('en-US'), n), { bound: 'scanRows' }, incidents);
    if (byBound && cand.others === 0 && cand.own > 0) return refusedAt(H, 'ONLY_YOUR_OWN_QUOTES', VERDICT.ONLY_YOUR_OWN_QUOTES(n), {}, incidents);
    return refusedAt(H, 'NO_DEPTH', VERDICT.NO_DEPTH(n), {}, incidents);
  }
  if (!meetsMinimum(walkBet, w.filled)) {
    const filled = usdc(deps, w.filled);
    const minFill = usdc(deps, walkBet.minFill);
    const f = { filled: w.filled.toString(), minFill: walkBet.minFill.toString() };
    if (w.endedBy === 'quotesListed') return refusedAt(H, 'DEPTH_BEYOND_BOUND', VERDICT.DEPTH_LISTED(String(BOUNDS.quotesListed), n, filled, minFill), { bound: 'quotesListed', ...f }, incidents);
    if (byBound && pageFull) return refusedAt(H, 'DEPTH_BEYOND_BOUND', VERDICT.DEPTH_EXAMINED_SOME(String(BOUNDS.quotesExamined), n, filled, minFill), { bound: 'quotesExamined', ...f }, incidents);
    if (byBound && scanBound) return refusedAt(H, 'DEPTH_BEYOND_BOUND', VERDICT.DEPTH_SCAN_SOME(BOUNDS.scanRows.toLocaleString('en-US'), n, filled, minFill), { bound: 'scanRows', ...f }, incidents);
    return refusedAt(H, 'NOT_ENOUGH_DEPTH', VERDICT.NOT_ENOUGH_DEPTH(n, filled, minFill), f, incidents);
  }
  const taker = w.model.takerPull();
  if (!taker.canPay) {
    return refusedAt(H, 'CANNOT_PAY', VERDICT.CANNOT_PAY(usdc(deps, taker.pull), n, usdc(deps, taker.balance), usdc(deps, taker.allowance)), { pull: taker.pull.toString(), balance: taker.balance.toString(), allowance: taker.allowance.toString() }, incidents);
  }
  return exactCall(ctx, listed, skipped, rewalked);
}

const crossData = (bet: OrderRow, legs: readonly ListedLeg[]): Hex =>
  encodeFunctionData({
    abi: RELAY_ABI,
    functionName: 'cross',
    args: [{ order: bet.order, signature: bet.signature }, legs.map((l) => ({ order: l.candidate.order, signature: l.candidate.signature }))],
  } as never);

type CallAnswer = { ok: true; out: Hex } | { ok: false; data: Hex } | { ok: false; outOfGas: true };

/** The exact call at H, from the key to the relay, no value, at an optional gas limit: its answer, or its refusal as an answer. */
async function exact(deps: CheckDeps, H: Header, data: Hex, gas?: bigint): Promise<CallAnswer> {
  return deps.chain.ask(H, async () => {
    try {
      return { ok: true, out: await callAt(deps.rpc, { from: deps.courier, to: deps.set.relay, data, value: 0n, ...(gas === undefined ? {} : { gas }) }, byHash(H.hash)) } as CallAnswer;
    } catch (err) {
      if (err instanceof ExecutionReverted) return { ok: false, data: err.data } as CallAnswer;
      if (err instanceof OutOfGas) return { ok: false, outOfGas: true } as CallAnswer;
      throw err;
    }
  });
}

type EstimateAnswer = { ok: true; gas: bigint } | { ok: false; data: Hex } | { ok: false; outOfGas: true };

async function estimate(deps: CheckDeps, H: Header, data: Hex): Promise<EstimateAnswer> {
  return deps.chain.ask(H, async () => {
    try {
      return { ok: true, gas: await estimateGasAt(deps.rpc, { from: deps.courier, to: deps.set.relay, data, value: 0n }, byHash(H.hash)) } as EstimateAnswer;
    } catch (err) {
      if (err instanceof ExecutionReverted) return { ok: false, data: err.data } as EstimateAnswer;
      if (err instanceof OutOfGas) return { ok: false, outOfGas: true } as EstimateAnswer;
      throw err;
    }
  });
}

const fault = (ctx: RoundContext, reason: string, facts: Record<string, unknown>): CheckOutcome =>
  refusedAt(ctx.H, 'COURIER_FAULT', VERDICT.COURIER_FAULT, {}, [...ctx.incidents, { reason, orderHash: ctx.bet.hash, facts: { block: ctx.n, ...facts } }]);

const jsonDecoded = (d: Decoded) => (d.kind === 'named' ? { name: d.name, args: d.args } : d);

/** The model's prediction for these legs, on the round's reads, with a test's skew applied where one is planted. */
function prediction(ctx: RoundContext, legs: readonly ListedLeg[]): Pulls {
  const p = predict(
    legs.map((l): Leg => ({ maker: l.candidate.order.account, makerSide: l.candidate.order.positionType, makerRisk: l.makerRisk, takerRisk: l.takerRisk })),
    ctx.modelState,
    ctx.bet.order.account,
    ctx.bet.order.positionType,
  );
  const skew = ctx.deps.hooks.skewPull;
  if (skew !== undefined) {
    legs.forEach((l, i) => {
      const d = skew(l.candidate.hash);
      if (d === null || d === 0n) return;
      p.legPulls[i] = (p.legPulls[i] as bigint) + d;
      const a = l.candidate.order.account.toLowerCase();
      p.pulled.set(a, (p.pulled.get(a) ?? 0n) + d);
    });
  }
  return p;
}

/** The simulation of the exact call, the comparison, the probe and the one re-walk, the gas and its search: for the listed legs. */
async function exactCall(ctx: RoundContext, listed: ListedLeg[], skipped: Set<string>, rewalked: { left: Hex[] } | null): Promise<CheckOutcome> {
  const { deps, bet, H, n } = ctx;
  const data = crossData(bet, listed);
  const predicted = prediction(ctx, listed);

  // The simulation.
  const sim = await exact(deps, H, data);
  if (!sim.ok) {
    if ('outOfGas' in sim) return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, reasonText({ kind: 'empty' })), { reason: 'none' }, ctx.incidents);
    const d = decodeRevert(sim.data);
    if (d.kind === 'unknown') return fault(ctx, 'UNKNOWN_REVERT', { selector: d.selector, at: 'simulation' });
    // A coin's refusal of a listed maker the model said could pay: the quotes the contract names PullRefused.
    const refusedQuotes = coinRefused(d, listed);
    if (refusedQuotes.length > 0) {
      if (refusedQuotes.some((i) => (predicted.legPulls[i] as bigint) === 0n)) return fault(ctx, 'MODEL_AND_CONTRACT_DIFFER', { at: 'simulation', revert: jsonDecoded(d), note: 'a maker pulled nothing by the model was refused its pull' });
      const left = refusedQuotes.map((i) => (listed[i] as ListedLeg).candidate.hash);
      if (rewalked !== null) {
        const maker = (listed[refusedQuotes[0] as number] as ListedLeg).candidate.order.account;
        return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, `PullRefused of ${maker}`), { reason: 'PullRefused', maker, left }, ctx.incidents);
      }
      return rewalk(ctx, skipped, left);
    }
    return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, reasonText(d)), { reason: d.kind === 'named' ? d.name : 'none', ...(d.kind === 'named' ? { args: d.args } : {}) }, ctx.incidents);
  }

  // The model's comparison, where the node takes an override.
  let comparison: Record<string, unknown> = { made: false, why: 'the node took no override at start' };
  let paysBackRefused: Record<string, string> = {};
  if (deps.overrideTaken) {
    const compared = await compare(ctx, listed, data, predicted);
    if ('outcome' in compared) return compared.outcome;
    if ('unfilled' in compared) {
      // A listed leg left unfilled: the coin's refusal of that maker's pull only on a positive predicted pull and a
      // one-quote probe that names PullRefused; then one re-walk at the same H without it.
      const left: Hex[] = [];
      for (const i of compared.unfilled) {
        const leg = listed[i] as ListedLeg;
        if ((predicted.legPulls[i] as bigint) === 0n) return fault(ctx, 'MODEL_AND_CONTRACT_DIFFER', { at: 'comparison', unfilled: leg.candidate.hash, note: 'a leg the model pulled nothing for was left unfilled' });
        const probe = await exact(deps, H, crossData(bet, [leg]));
        const probed = !probe.ok && 'data' in probe ? decodeRevert(probe.data) : null;
        const isRefusal = probed !== null && probed.kind === 'named' && probed.name === 'OspexMatching__NothingFilled' && probed.reasons?.length === 1 && probed.reasons[0] === 'PullRefused';
        if (!isRefusal) return fault(ctx, 'MODEL_AND_CONTRACT_DIFFER', { at: 'comparison', unfilled: leg.candidate.hash, probe: probe.ok ? 'filled' : 'data' in probe ? jsonDecoded(decodeRevert(probe.data)) : 'out of gas' });
        left.push(leg.candidate.hash);
      }
      if (rewalked !== null) {
        const maker = (listed[compared.unfilled[0] as number] as ListedLeg).candidate.order.account;
        return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, `PullRefused of ${maker}`), { reason: 'PullRefused', maker, left }, ctx.incidents);
      }
      return rewalk(ctx, skipped, left);
    }
    comparison = { made: true, agreed: true };
    paysBackRefused = compared.paysBackRefused;
  }

  // The gas: the estimate of the exact call at H; the limit, the estimate and a fifth of it; the two ceilings.
  const cap = deps.hooks.transactionGasCap ?? BigInt(CHAIN_LIMITS.transactionGasCap);
  const blockLimit = H.gasLimit;
  if (blockLimit === undefined) throw new Error('the header of the bet\'s block holds no gas limit');
  const within = (limit: bigint) => limit <= blockLimit && limit <= cap;
  const est = await estimate(deps, H, data);
  if (!est.ok) {
    if ('outOfGas' in est) return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, reasonText({ kind: 'empty' })), { reason: 'none', at: 'estimate' }, ctx.incidents);
    const d = decodeRevert(est.data);
    if (d.kind === 'unknown') return fault(ctx, 'UNKNOWN_REVERT', { selector: d.selector, at: 'estimate' });
    return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, reasonText(d)), { reason: d.kind === 'named' ? d.name : 'none', at: 'estimate' }, ctx.incidents);
  }
  const ceilings = { blockGasLimit: blockLimit.toString(), transactionGasCap: cap.toString() };
  let chosen = listed;
  let g = est.gas;
  let limit = g + g / 5n;
  let trim: Record<string, unknown> | null = null;
  if (!within(limit)) {
    const searched = await search(ctx, listed, within, { whole: { estimate: g.toString(), limit: limit.toString() }, ceilings });
    if ('outcome' in searched) return searched.outcome;
    chosen = searched.prefix;
    g = searched.gas;
    limit = g + g / 5n;
    trim = searched.trim;
    // The chosen prefix is run exactly, as a whole list is: its simulation, its comparison, and its call at the limit.
    // Its simulation's refusal is the plain one: the search found it to fit, and the exact run refuses it.
    const prefixData = crossData(bet, chosen);
    const prefixPredicted = prediction(ctx, chosen);
    const sim2 = await exact(deps, H, prefixData);
    if (!sim2.ok) {
      if ('outOfGas' in sim2) return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, reasonText({ kind: 'empty' })), { reason: 'none' }, ctx.incidents);
      const d = decodeRevert(sim2.data);
      if (d.kind === 'unknown') return fault(ctx, 'UNKNOWN_REVERT', { selector: d.selector, at: 'simulation of the chosen prefix' });
      return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT(n, reasonText(d)), { reason: d.kind === 'named' ? d.name : 'none', ...(d.kind === 'named' ? { args: d.args } : {}) }, ctx.incidents);
    }
    if (deps.overrideTaken) {
      const compared = await compare(ctx, chosen, prefixData, prefixPredicted);
      if ('outcome' in compared) return compared.outcome;
      if ('unfilled' in compared) return fault(ctx, 'MODEL_AND_CONTRACT_DIFFER', { at: 'comparison of the chosen prefix', unfilled: compared.unfilled.map((i) => (chosen[i] as ListedLeg).candidate.hash) });
      paysBackRefused = compared.paysBackRefused;
      comparison = { made: true, agreed: true };
    }
    return finishReady(ctx, chosen, prefixPredicted, prefixData, g, limit, comparison, paysBackRefused, { ...ceilings, trim }, skipped);
  }
  return finishReady(ctx, chosen, predicted, data, g, limit, comparison, paysBackRefused, { ...ceilings, trim }, skipped);
}

/** The call at the limit, the key's count, H again; then the ready outcome. */
async function finishReady(
  ctx: RoundContext,
  legs: ListedLeg[],
  predicted: Pulls,
  data: Hex,
  g: bigint,
  limit: bigint,
  comparison: Record<string, unknown>,
  paysBackRefused: Record<string, string>,
  gasFacts: Record<string, unknown>,
  skipped: Set<string>,
): Promise<CheckOutcome> {
  const { deps, bet, H, n, A, F, cand } = ctx;
  const atLimit = await exact(deps, H, data, limit);
  if (!atLimit.ok) {
    const d: Decoded = 'outOfGas' in atLimit ? { kind: 'empty' } : decodeRevert(atLimit.data);
    if (d.kind === 'unknown') return fault(ctx, 'UNKNOWN_REVERT', { selector: d.selector, at: 'call at the limit' });
    return refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT_AT_LIMIT(n, reasonText(d)), { reason: d.kind === 'named' ? d.name : 'none', atGasLimit: limit.toString() }, ctx.incidents);
  }
  // The key's count at H, as the node check asks for it.
  const nonce = await deps.chain.ask(H, () => transactionCountAt(deps.rpc, deps.courier, byHash(H.hash)));
  // H again, by number: a changed hash starts the check again.
  const again = await deps.chain.headerAt(H.number);
  if (again === null || again.hash.toLowerCase() !== H.hash.toLowerCase()) throw new RoundAgain({ kind: 'reorg', code: null, method: 'eth_getBlockByNumber' });

  const takerRisk = legs.reduce((s, l) => s + l.takerRisk, 0n);
  const unfilled = bet.order.riskAmount - A.filled - takerRisk;
  const pullsOut: Record<string, string> = {};
  for (const [a, v] of predicted.pulled) pullsOut[getAddress(a)] = v.toString();
  const paysBackOut: Record<string, string> = {};
  for (const p of predicted.paysBack) paysBackOut[getAddress(p.account)] = ((BigInt(paysBackOut[getAddress(p.account)] ?? '0')) + p.amount).toString();
  return {
    kind: 'ready',
    incidents: ctx.incidents,
    cross: {
      block: H,
      legs: legs.map((l) => ({ orderHash: l.candidate.hash, account: getAddress(l.candidate.order.account), oddsTick: l.candidate.order.oddsTick, makerRisk: l.makerRisk, takerRisk: l.takerRisk })),
      takerRisk,
      unfilled,
      pulls: pullsOut,
      paysBack: paysBackOut,
      paysBackRefused,
      gas: { estimate: g, limit },
      nonce,
      checked: {
        final: named(F),
        candidateStatementAt: cand.ranAt.toISOString(),
        candidates: { scanned: cand.scanned, marked: cand.marked, own: cand.own, examined: cand.rows.length },
        estimate: g.toString(),
        limit: limit.toString(),
        gas: gasFacts,
        nonce: nonce.toString(),
        keyPol: A.keyPol.toString(),
        keyCoin: A.keyCoin.toString(),
        relayCoin: A.relayCoin.toString(),
        comparison,
        predicted: { legPulls: predicted.legPulls.map(String), takerPull: predicted.takerPull.toString(), paysBack: predicted.paysBack.map((p) => ({ account: getAddress(p.account), amount: p.amount.toString() })) },
        paysBackRefused,
        leftOutAfterCoinRefusal: [...skipped],
        unfilled: unfilled.toString(),
      },
    },
  };
}

/** The listed legs a revert names PullRefused for, by their place in the list: a NothingFilled's reasons, or a TakingOrderUnderMinFill's legs. */
function coinRefused(d: Decoded, listed: readonly ListedLeg[]): number[] {
  if (d.kind !== 'named') return [];
  if (d.name === 'OspexMatching__NothingFilled' && d.reasons !== undefined && d.reasons.length === listed.length) return d.reasons.flatMap((r, i) => (r === 'PullRefused' ? [i] : []));
  if (d.name === 'OspexMatching__TakingOrderUnderMinFill' && d.legs !== undefined && d.legs.length === listed.length) return d.legs.flatMap((l, i) => (!l.filled && l.reason === 'PullRefused' ? [i] : []));
  return [];
}

/** The one re-walk at the same H, without the quotes the coin refused: its own answers, simulation, comparison and gas. */
async function rewalk(ctx: RoundContext, skipped: Set<string>, left: Hex[]): Promise<CheckOutcome> {
  const skip = new Set([...skipped, ...left.map((h) => h.toLowerCase())]);
  const w = walk(ctx.walkBet, ctx.walkInput, new PullModel(ctx.modelState, ctx.bet.order.account, ctx.bet.order.positionType), ctx.T, BOUNDS.quotesListed, skip);
  return afterWalk(ctx, w, skip, { left });
}

type Compared = { outcome: CheckOutcome } | { unfilled: number[] } | { paysBackRefused: Record<string, string> };

const slotWord = (address: Address): Hex => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

/**
 * The model's comparison: the same Cross at H run from inside the multicall contract, the relay's sender slot
 * overridden to it for this call alone, and in the same call, after the Cross, the bet's and each listed quote's
 * filled amount, each account's coin, and what is held for it on the market. Held to the walk: each fill the walk's;
 * each pay-back one of its two outcomes, paid or refused and kept held. A leg left unfilled is the caller's to probe;
 * any other difference is the courier's fault.
 */
async function compare(ctx: RoundContext, legs: readonly ListedLeg[], data: Hex, predicted: Pulls): Promise<Compared> {
  const { deps, bet, A, H, readB, positions } = ctx;
  const marketId = A.marketId !== 0n ? A.marketId : A.marketCount + 1n;
  const accounts = [...new Map([bet.order.account, ...legs.map((l) => l.candidate.order.account)].map((a) => [a.toLowerCase(), getAddress(a)])).values()];
  const m = (fn: string, args: readonly unknown[]) => encodeFunctionData({ abi: MATCHING_ABI, functionName: fn, args } as never);
  const calls = [
    { target: deps.set.relay, callData: data, allowFailure: true },
    { target: deps.set.matching, callData: m('s_filledRisk', [bet.hash]) },
    ...legs.map((l) => ({ target: deps.set.matching, callData: m('s_filledRisk', [l.candidate.hash]) })),
    ...accounts.map((a) => ({ target: deps.set.coin, callData: encodeFunctionData({ abi: COIN_ABI, functionName: 'balanceOf', args: [a] }) })),
    ...accounts.map((a) => ({ target: deps.set.positions, callData: encodeFunctionData({ abi: POSITIONS_ABI, functionName: 's_held', args: [marketId, a] }) })),
  ];
  const override: StateOverride = { [deps.set.relay]: { stateDiff: { [`0x${RELAY_SENDER_SLOT.toString(16).padStart(64, '0')}`]: slotWord(MULTICALL_ADDRESS) } } };
  const results = await deps.chain.ask(H, () => multicallAt(deps.rpc, H, calls, override));
  const word = (r: MulticallResult | undefined) => BigInt((r as MulticallResult).returnData);
  if ((results[0] as MulticallResult).success !== true) {
    return { outcome: fault(ctx, 'MODEL_AND_CONTRACT_DIFFER', { at: 'comparison', note: 'the Cross the simulation ran reverted inside the comparison', data: (results[0] as MulticallResult).returnData }) };
  }
  const differences: string[] = [];
  // The fills.
  const betAfter = word(results[1]);
  const unfilled: number[] = [];
  legs.forEach((l, i) => {
    const before = readB.quotes.get(l.candidate.hash.toLowerCase())?.filled ?? 0n;
    const after = word(results[2 + i]);
    if (after === before) unfilled.push(i);
    else if (after - before !== l.makerRisk) differences.push(`quote ${l.candidate.hash} filled ${after - before}, the walk ${l.makerRisk}`);
  });
  if (unfilled.length > 0 && differences.length === 0) return { unfilled };
  const takerRisk = legs.reduce((s, l) => s + l.takerRisk, 0n);
  if (betAfter - A.filled !== takerRisk) differences.push(`the bet filled ${betAfter - A.filled}, the walk ${takerRisk}`);
  // Each account's coin and held, against the model's two outcomes of its pay-back.
  const coinAt = 2 + legs.length;
  const heldAt = coinAt + accounts.length;
  const paysBackRefused: Record<string, string> = {};
  accounts.forEach((a, i) => {
    const k = a.toLowerCase();
    const coinBefore = k === bet.order.account.toLowerCase() ? A.balance : (readB.accounts.get(k)?.balance ?? 0n);
    const pulled = predicted.pulled.get(k) ?? 0n;
    const paid = predicted.paysBack.filter((p) => p.account.toLowerCase() === k).reduce((s, p) => s + p.amount, 0n);
    const heldPulls = predicted.heldAfterPulls.get(k) ?? positions.get(k)?.held ?? 0n;
    const worst = predicted.worstAfter.get(k) ?? 0n;
    const coinAfter = word(results[coinAt + i]);
    const heldAfter = word(results[heldAt + i]);
    const asPaid = coinAfter === coinBefore - pulled + paid && heldAfter === (paid > 0n ? worst : heldPulls);
    const asRefused = paid > 0n && coinAfter === coinBefore - pulled && heldAfter === heldPulls;
    if (asPaid) return;
    if (asRefused) {
      paysBackRefused[a] = paid.toString();
      return;
    }
    differences.push(`account ${a}: coin ${coinBefore} to ${coinAfter}, held to ${heldAfter}; the model: pulled ${pulled}, paid back ${paid}, held ${paid > 0n ? worst : heldPulls}`);
  });
  if (differences.length > 0) return { outcome: fault(ctx, 'MODEL_AND_CONTRACT_DIFFER', { at: 'comparison', differences }) };
  return { paysBackRefused };
}

/**
 * The search for a shorter fill, over a ceiling: first, with no request, the shortest prefix that meets the bet's
 * minimum; then the prefixes from it to one short of the whole list, at most six estimates, each step by its answer:
 * a fit goes above, a limit over a ceiling or an answer with no reason goes below, a named refusal ends the search,
 * and the node's failure throws the round away. The longest prefix found to fit is the Cross; it is not always the
 * longest that would, since gas is not proved to grow with legs.
 */
async function search(
  ctx: RoundContext,
  listed: ListedLeg[],
  within: (limit: bigint) => boolean,
  facts: { whole: Record<string, string>; ceilings: Record<string, string> },
): Promise<{ outcome: CheckOutcome } | { prefix: ListedLeg[]; gas: bigint; trim: Record<string, unknown> }> {
  const { deps, bet, H, n } = ctx;
  const ks = shortestMeetingMinimum(ctx.walkBet, listed);
  const steps: Array<Record<string, unknown>> = [];
  let lo = ks;
  let hi = listed.length - 1;
  let best: { k: number; gas: bigint } | null = null;
  let oneOver = listed.length === 1;
  let estimates = 0;
  while (lo <= hi && estimates < 6) {
    const k = Math.floor((lo + hi + 1) / 2);
    const answer = await estimate(deps, H, crossData(bet, listed.slice(0, k)));
    estimates++;
    if (answer.ok) {
      const limit = answer.gas + answer.gas / 5n;
      if (within(limit)) {
        steps.push({ k, estimate: answer.gas.toString(), limit: limit.toString(), fits: true });
        best = { k, gas: answer.gas };
        lo = k + 1;
      } else {
        steps.push({ k, estimate: answer.gas.toString(), limit: limit.toString(), fits: false });
        if (k === 1) oneOver = true;
        hi = k - 1;
      }
      continue;
    }
    const d: Decoded = 'outOfGas' in answer ? { kind: 'empty' } : decodeRevert(answer.data);
    if (d.kind === 'empty') {
      steps.push({ k, answer: 'no reason came back' });
      hi = k - 1;
      continue;
    }
    if (d.kind === 'unknown') return { outcome: fault(ctx, 'UNKNOWN_REVERT', { selector: d.selector, at: `the search's estimate of the first ${k}` }) };
    steps.push({ k, answer: d.name });
    if (deps.overrideTaken) return { outcome: fault(ctx, 'MODEL_AND_CONTRACT_DIFFER', { at: `the search's estimate of the first ${k}`, refused: jsonDecoded(d), note: 'the comparison agreed on the whole list, and the contract refuses a prefix the model accepted' }) };
    return {
      outcome: refusedAt(H, 'CROSS_WOULD_REVERT', VERDICT.CROSS_WOULD_REVERT_TRIMMED(n, String(k), reasonText(d)), { reason: d.name, trimmedTo: k, steps }, ctx.incidents),
    };
  }
  const trim = { listed: listed.length, shortestMeetingMinimum: ks, estimates, steps, ...facts };
  if (best !== null) return { prefix: listed.slice(0, best.k), gas: best.gas, trim };
  if (oneOver) return { outcome: refusedAt(H, 'CROSS_TOO_LARGE', VERDICT.CROSS_TOO_LARGE_ONE(n), { trim }, ctx.incidents) };
  return {
    outcome: refusedAt(H, 'CROSS_TOO_LARGE', VERDICT.CROSS_TOO_LARGE_SEARCHED(n, String(listed.length)), { listed: listed.length, shortestMeetingMinimum: ks, estimates, trim }, ctx.incidents),
  };
}

export { describeNodeFailure };
