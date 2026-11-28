import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { CROSS_EVENTS_ABI, MATCHING_ABI, MULTICALL_ABI, MULTICALL_ADDRESS } from '../chain/abi';
import { headerByNumber, NodeFailure, type Header, type JsonRpc, type Receipt } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import type { ChainReader } from '../chain/snapshot';
import { SKIP_REASONS, type SkipReason } from '../check/decode';

// What the sender reads of the chain at the final block F, from F's hash on,
// and how it reads a receipt. "On F's chain" is checked, never assumed, under
// the node's trust boundary: at F's own height a block is F; up to 256 blocks
// below, the chain's own hash of that height is read at F by F's hash; further
// back, the header at the block's own height is read by number, and its number
// and its hash must both be the block's. A height alone shows nothing: an
// orphaned block has a height too. A decision that read a header by number is
// accepted only once F's own height, read again by number after every other
// read of the chain the decision rests on, still holds F. This trusts every
// machine behind the provider to answer from one finalized history: the read
// again is a check of consistency, not a proof of it. No parent of F is walked.

/** A block named by its number and hash. */
export interface Named {
  number: bigint;
  hash: Hex;
}

/** Whether a block is on F's chain: true or false, or not comparable where F is below it. */
export type OnChain = true | false | 'not comparable';

/** How far back the chain's own hash of a height can be read at a block: the EVM's `blockhash` window. */
export const BLOCKHASH_WINDOW = 256n;

/**
 * One decision at one final block F, and the headers it read by number below the window: each height read once, kept
 * by height. Made fresh for each decision and kept no longer: a header read for one decision is no evidence in another,
 * at another F, in another life of the process or on another database.
 */
export interface Decision {
  readonly F: Header;
  readonly deep: Map<bigint, Header>;
}

/** A new decision at F, with nothing read yet. */
export function decisionAt(F: Header): Decision {
  return { F, deep: new Map() };
}

/**
 * The header at a height, by number, under the reader's rule for a read: a header the node does not return is tried
 * again, and twice is unavailable. One it returns at another height contradicts the request: it is never read again as
 * if it were missing.
 */
async function headerAtHeight(chain: ChainReader, rpc: JsonRpc, F: Header, number: bigint): Promise<Header> {
  const h = await chain.ask(F, async () => {
    const got = await headerByNumber(rpc, number);
    if (got === null) throw new NodeFailure('malformed', 'eth_getBlockByNumber', null, 'no block at a height the decision needs');
    return got;
  });
  if (h.number !== number) throw new NodeFailure('malformed', 'eth_getBlockByNumber', null, 'a block read by number is at another height than the one asked for');
  return h;
}

/** The blocks of `named` on the decision's F's chain, each judged as above: one multicall at F for those in the window, and one header by number for each other height further back. */
export async function onFinalChain(chain: ChainReader, rpc: JsonRpc, decision: Decision, named: readonly Named[]): Promise<OnChain[]> {
  const F = decision.F;
  const out: OnChain[] = named.map(() => 'not comparable');
  const windowed: number[] = [];
  const deep: number[] = [];
  named.forEach((b, i) => {
    if (b.number > F.number) out[i] = 'not comparable';
    else if (b.number === F.number) out[i] = b.hash.toLowerCase() === F.hash.toLowerCase();
    else if (F.number - b.number <= BLOCKHASH_WINDOW) windowed.push(i);
    else deep.push(i);
  });
  if (windowed.length > 0) {
    const calls = windowed.map((i) => ({ target: MULTICALL_ADDRESS as Address, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getBlockHash', args: [(named[i] as Named).number] }) }));
    const hashes = await chain.read(F, calls, (results) =>
      results.map((r) => {
        try {
          return (decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getBlockHash', data: r.returnData }) as Hex).toLowerCase();
        } catch {
          throw new NodeFailure('malformed', 'eth_call', null, "a block's hash did not decode");
        }
      }),
    );
    windowed.forEach((i, k) => {
      out[i] = hashes[k] === (named[i] as Named).hash.toLowerCase();
    });
  }
  // Further back: the header at each height, by number, read once in this decision, and its hash held to the block's. A
  // header there under another hash says the block is not on F's chain: an orphan's, never a contradiction.
  for (const i of deep) {
    const b = named[i] as Named;
    let h = decision.deep.get(b.number);
    if (h === undefined) {
      h = await headerAtHeight(chain, rpc, F, b.number);
      decision.deep.set(b.number, h);
    }
    out[i] = h.hash.toLowerCase() === b.hash.toLowerCase();
  }
  return out;
}

/**
 * The last check of a decision that read a header by number: F's own height read again by number, after every other
 * read of the chain the decision rests on, and held to F. True where that height still holds F, and where the
 * decision read no header by number and so needs no check; false where another block stands there now, and the
 * decision is discarded. It reads again at each call: no earlier check, of this decision or of another, stands for it.
 */
export async function stillFinal(chain: ChainReader, rpc: JsonRpc, decision: Decision): Promise<boolean> {
  if (decision.deep.size === 0) return true;
  const F = decision.F;
  const h = await headerAtHeight(chain, rpc, F, F.number);
  return h.hash.toLowerCase() === F.hash.toLowerCase();
}

/** The bet's and each quote's filled amount at F, in one multicall at F by its hash: the chain's own totals across every Cross. */
export async function filledAtF(chain: ChainReader, set: BettingSet, F: Header, hashes: readonly Hex[]): Promise<Map<string, bigint>> {
  const unique = [...new Set(hashes.map((h) => h.toLowerCase()))] as Hex[];
  const calls = unique.map((h) => ({ target: set.matching, callData: encodeFunctionData({ abi: MATCHING_ABI, functionName: 's_filledRisk', args: [h] }) }));
  const values = await chain.read(F, calls, (results) =>
    results.map((r) => {
      try {
        return decodeFunctionResult({ abi: MATCHING_ABI, functionName: 's_filledRisk', data: r.returnData }) as bigint;
      } catch {
        throw new NodeFailure('malformed', 'eth_call', null, 'a filled amount did not decode');
      }
    }),
  );
  return new Map(unique.map((h, i) => [h, values[i] as bigint]));
}

/** One listed occurrence, as the receipt records it: filled with its two stakes, or skipped with the contract's reason. In list order. */
export type LegEvent = { kind: 'filled'; orderHash: Hex; maker: Address; makerRisk: bigint; takerRisk: bigint; logIndex: number } | { kind: 'skipped'; orderHash: Hex; account: Address; reason: SkipReason; logIndex: number };

/** What a receipt of one Cross recorded, from the modules' own events, each read once and in the order of the logs. */
export interface CrossReceipt {
  legs: LegEvent[];
  crossed: { courier: Address; takingOrderHash: Hex; taker: Address; marketId: bigint; totalMakerRisk: bigint; totalTakerRisk: bigint } | null;
  /** Each account's pulls and pay-backs, summed, and the amount held after the last change. */
  pulls: Map<string, bigint>;
  paysBack: Map<string, bigint>;
  /** Each pay-back the coin refused, in order: the account, the amount, and what stays held for it. */
  paysBackRefused: Array<{ account: Address; amount: bigint; held: bigint; logIndex: number }>;
  marketCreated: bigint | null;
}

/**
 * The receipt's logs read as the Cross's record, module by module: the matching contract's, the positions
 * contract's and the markets contract's own events, never the core's hub copy. Each log must carry the receipt's
 * block hash and this transaction's hash. One direct Cross: its leg events, filled or skipped, are one for each
 * listed occurrence, in list order, a hash listed twice as two; any other count is a contradiction the caller judges.
 */
export function readCrossReceipt(set: BettingSet, receipt: Receipt, betHash: Hex): CrossReceipt {
  const bet = betHash.toLowerCase();
  return readCrossesOfReceipt(set, receipt).find((c) => c.crossed !== null && c.crossed.takingOrderHash.toLowerCase() === bet) ?? emptyCross();
}

const emptyCross = (): CrossReceipt => ({ legs: [], crossed: null, pulls: new Map(), paysBack: new Map(), paysBackRefused: [], marketCreated: null });

/**
 * Every Cross a receipt recorded, Cross by Cross, in the order of the logs. A receipt can hold more than one Cross, as
 * a batch of calls through a relay can make; each Cross's events end at its own Crossed, so the receipt is read in
 * those pieces and no Cross's legs, pulls or pay-backs are counted in another's. Events after the last Crossed, which
 * a successful Cross does not leave, are a last piece with no Crossed.
 */
export function readCrossesOfReceipt(set: BettingSet, receipt: Receipt): CrossReceipt[] {
  const pieces: CrossReceipt[] = [];
  let out: CrossReceipt = emptyCross();
  let touched = false;
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  const matching = set.matching.toLowerCase();
  const positions = set.positions.toLowerCase();
  const markets = set.markets.toLowerCase();
  const logs = [...receipt.logs].sort((a, b) => a.logIndex - b.logIndex);
  for (const log of logs) {
    if (log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() || log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase()) {
      throw new NodeFailure('malformed', 'eth_getTransactionReceipt', null, 'a log of the receipt names another block or transaction');
    }
    const at = log.address.toLowerCase();
    if (at !== matching && at !== positions && at !== markets) continue;
    let e: { eventName: string; args: Record<string, unknown> };
    try {
      e = decodeEventLog({ abi: CROSS_EVENTS_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
    } catch {
      continue;
    }
    const a = e.args;
    touched = true;
    if (at === matching && e.eventName === 'OrderMatched') {
      out.legs.push({ kind: 'filled', orderHash: (a.orderHash as Hex).toLowerCase() as Hex, maker: getAddress(a.maker as string), makerRisk: a.makerRisk as bigint, takerRisk: a.takerRisk as bigint, logIndex: log.logIndex });
    } else if (at === matching && e.eventName === 'OrderSkipped') {
      const reason = SKIP_REASONS[Number(a.reason)];
      if (reason === undefined) throw new NodeFailure('malformed', 'eth_getTransactionReceipt', null, 'a skip reason the contract does not have');
      out.legs.push({ kind: 'skipped', orderHash: (a.orderHash as Hex).toLowerCase() as Hex, account: getAddress(a.account as string), reason, logIndex: log.logIndex });
    } else if (at === matching && e.eventName === 'Crossed') {
      out.crossed = { courier: getAddress(a.courier as string), takingOrderHash: (a.takingOrderHash as Hex).toLowerCase() as Hex, taker: getAddress(a.taker as string), marketId: a.marketId as bigint, totalMakerRisk: a.totalMakerRisk as bigint, totalTakerRisk: a.totalTakerRisk as bigint };
      // This Cross's events end here: the next ones are another Cross's.
      pieces.push(out);
      out = emptyCross();
      touched = false;
    } else if (at === positions && e.eventName === 'HeldChanged') {
      const account = getAddress(a.account as string);
      if ((a.pulled as bigint) > 0n) add(out.pulls, account, a.pulled as bigint);
      if ((a.paidBack as bigint) > 0n) add(out.paysBack, account, a.paidBack as bigint);
    } else if (at === positions && e.eventName === 'PayBackRefused') {
      out.paysBackRefused.push({ account: getAddress(a.account as string), amount: a.amount as bigint, held: a.held as bigint, logIndex: log.logIndex });
    } else if (at === markets && e.eventName === 'MarketCreated') {
      out.marketCreated = a.marketId as bigint;
    }
  }
  if (touched) pieces.push(out);
  return pieces;
}
