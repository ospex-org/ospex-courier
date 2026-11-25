import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { CROSS_EVENTS_ABI, MATCHING_ABI, MULTICALL_ABI, MULTICALL_ADDRESS } from '../chain/abi';
import { headerByHash, NodeFailure, type Header, type JsonRpc, type Receipt } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import type { ChainReader } from '../chain/snapshot';
import { SKIP_REASONS, type SkipReason } from '../check/decode';

// What the sender reads of the chain at the final block F, from F's hash on,
// and how it reads a receipt. "On F's chain" is shown, never assumed: at F's own
// height a block is F; up to 256 blocks below, the chain's own hash of that
// height is read at F by F's hash; further back, F's parents are walked by
// hash. A height alone shows nothing: an orphaned block has a height too.

/** A block named by its number and hash. */
export interface Named {
  number: bigint;
  hash: Hex;
}

/** Whether a block is on F's chain: true or false, or not comparable where F is below it. */
export type OnChain = true | false | 'not comparable';

/** How far back the chain's own hash of a height can be read at a block: the EVM's `blockhash` window. */
export const BLOCKHASH_WINDOW = 256n;

/** The blocks of `named` on F's chain, each judged as above. The reads are one multicall at F for those in the window, and a walk of parents for any further back. */
export async function onFinalChain(chain: ChainReader, rpc: JsonRpc, F: Header, named: readonly Named[]): Promise<OnChain[]> {
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
  if (deep.length > 0) {
    // The walk: F's parents by hash, down to the lowest height asked about. Its cost grows with the gap, not with history.
    const lowest = deep.reduce((m, i) => ((named[i] as Named).number < m ? (named[i] as Named).number : m), F.number);
    const byHeight = new Map<bigint, Hex>();
    let at: Header = F;
    byHeight.set(at.number, at.hash.toLowerCase() as Hex);
    while (at.number > lowest) {
      const below = at.parentHash;
      const height = at.number - 1n;
      // Judged inside the read: a parent the node does not return, or not at the height below, is a read that is tried
      // again, and twice is unavailable, as any read of the chain is; never a stop.
      const parent = await chain.ask(F, async () => {
        const h = await headerByHash(rpc, below);
        if (h === null || h.number !== height) throw new NodeFailure('malformed', 'eth_getBlockByHash', null, "a parent of the final block is not the block below it");
        return h;
      });
      at = parent;
      byHeight.set(at.number, at.hash.toLowerCase() as Hex);
    }
    for (const i of deep) out[i] = byHeight.get((named[i] as Named).number) === (named[i] as Named).hash.toLowerCase();
  }
  return out;
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
