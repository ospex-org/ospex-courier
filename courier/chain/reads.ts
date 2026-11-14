import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { COIN_ABI, GAMES_ABI, MATCHING_ABI } from './abi';
import type { OrderFields } from '../orders/order';
import { decoded, NodeFailure, type Header, type MulticallResult } from './rpc';
import type { BettingSet } from './set';
import type { ChainReader } from './snapshot';

// The reads of state the door and the book make, each one call to the
// multicall contract at a block named by its hash (snapshot.ts): what the door
// asks about one order, and what the book asks about a page of quotes. Each is
// decoded inside the read: a required value whose bytes do not decode is an
// answer the read cannot use, the node's `malformed` failure, tried once more
// and then the chain unreachable; a call that allowed failure and failed is an
// intelligible negative (a game the set does not know), kept as such and never
// fed to the decoder of a success.

export interface GameRead {
  /** False where the games set refuses the id: not a game. */
  known: boolean;
  status: number | null;
  /** The start, where it is written; null where the games set refuses the read. */
  start: bigint | null;
  window: bigint | null;
  reporters: Address[] | null;
}

export interface DoorRead {
  header: Header;
  registered: boolean;
  /** The contract's own hash of the ten values. */
  contractHash: Hex;
  cancelled: boolean;
  floor: bigint;
  filled: bigint;
  cap: bigint;
  capLifted: boolean;
  game: GameRead;
}

const m = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi: MATCHING_ABI, functionName, args } as never);
const g = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi: GAMES_ABI, functionName, args } as never);
const c = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi: COIN_ABI, functionName, args } as never);
const dm = <T>(functionName: string, data: Hex) => decoded(functionName, () => decodeFunctionResult({ abi: MATCHING_ABI, functionName, data } as never) as T);
const dg = <T>(functionName: string, data: Hex) => decoded(functionName, () => decodeFunctionResult({ abi: GAMES_ABI, functionName, data } as never) as T);
const dc = <T>(functionName: string, data: Hex) => decoded(functionName, () => decodeFunctionResult({ abi: COIN_ABI, functionName, data } as never) as T);

/** The results of a read, exactly as many as the calls asked; fewer or more is an answer the read cannot use. */
function exactly(results: MulticallResult[], count: number): MulticallResult[] {
  if (results.length !== count) throw new NodeFailure('malformed', 'eth_call', null, `the read asked ${count} values and was answered ${results.length}`);
  return results;
}

/** What the door asks about one order, in one call at the header. */
export async function readForDoor(chain: ChainReader, set: BettingSet, header: Header, order: OrderFields, hash: Hex, marketKey: Hex): Promise<DoorRead> {
  const calls = [
    { target: set.matching, callData: m('isCourier', [order.account, set.relay]) },
    { target: set.matching, callData: m('getOrderHash', [order]) },
    { target: set.matching, callData: m('s_cancelledOrders', [hash]) },
    { target: set.matching, callData: m('s_minNonces', [order.account, marketKey]) },
    { target: set.matching, callData: m('s_filledRisk', [hash]) },
    { target: set.matching, callData: m('TAKING_STAKE_CAP') },
    { target: set.matching, callData: m('s_takingStakeCapLifted') },
    { target: set.games, callData: g('getGameStatus', [order.gameId]), allowFailure: true },
    { target: set.games, callData: g('getGameStart', [order.gameId]), allowFailure: true },
    { target: set.games, callData: g('getGameWindow', [order.gameId]), allowFailure: true },
    { target: set.games, callData: g('getGameReporters', [order.gameId]), allowFailure: true },
  ];
  return chain.read(header, calls, (answered) => {
    const [registered, contractHash, cancelled, floor, filled, cap, lifted, status, start, window, reporters] = exactly(answered, calls.length) as [
      MulticallResult, MulticallResult, MulticallResult, MulticallResult, MulticallResult, MulticallResult, MulticallResult,
      MulticallResult, MulticallResult, MulticallResult, MulticallResult,
    ];
    // The games set's refusal of the id is an intelligible negative: not a game. Its bytes are a revert's, not a
    // value's, and are decoded as nothing.
    const known = status.success;
    return {
      header,
      registered: dm<boolean>('isCourier', registered.returnData),
      contractHash: dm<Hex>('getOrderHash', contractHash.returnData),
      cancelled: dm<boolean>('s_cancelledOrders', cancelled.returnData),
      floor: dm<bigint>('s_minNonces', floor.returnData),
      filled: dm<bigint>('s_filledRisk', filled.returnData),
      cap: dm<bigint>('TAKING_STAKE_CAP', cap.returnData),
      capLifted: dm<boolean>('s_takingStakeCapLifted', lifted.returnData),
      game: {
        known,
        status: known ? Number(dg<number>('getGameStatus', status.returnData)) : null,
        start: known && start.success ? BigInt(dg<bigint>('getGameStart', start.returnData)) : null,
        window: known && window.success ? BigInt(dg<bigint>('getGameWindow', window.returnData)) : null,
        reporters: known && reporters.success ? dg<readonly [readonly Address[], readonly number[]]>('getGameReporters', reporters.returnData)[0].map((a) => getAddress(a)) : null,
      },
    };
  });
}

export interface QuoteState {
  cancelled: boolean;
  filled: bigint;
}

export interface AccountState {
  registered: boolean;
  /** The account's nonce floor on the market. */
  floor: bigint;
  balance: bigint;
  /** The allowance to the positions contract. */
  allowance: bigint;
}

export interface QuotesRead {
  quotes: Map<string, QuoteState>;
  accounts: Map<string, AccountState>;
}

/**
 * What the book asks about a page of quotes on one market, in one call at the
 * header: for each quote whether it is cancelled and what it has filled; for
 * each account once, whether it still has the relay registered, its floor on
 * the market, its balance and its allowance.
 */
export async function readQuotes(chain: ChainReader, set: BettingSet, header: Header, marketKey: Hex, quotes: ReadonlyArray<{ hash: Hex; account: Address }>): Promise<QuotesRead> {
  const accounts = [...new Set(quotes.map((q) => getAddress(q.account)))];
  const calls = [
    ...quotes.flatMap((q) => [
      { target: set.matching, callData: m('s_cancelledOrders', [q.hash]) },
      { target: set.matching, callData: m('s_filledRisk', [q.hash]) },
    ]),
    ...accounts.flatMap((a) => [
      { target: set.matching, callData: m('isCourier', [a, set.relay]) },
      { target: set.matching, callData: m('s_minNonces', [a, marketKey]) },
      { target: set.coin, callData: c('balanceOf', [a]) },
      { target: set.coin, callData: c('allowance', [a, set.positions]) },
    ]),
  ];
  if (calls.length === 0) return { quotes: new Map(), accounts: new Map() };
  return chain.read(header, calls, (answered) => {
    const results = exactly(answered, calls.length);
    const out: QuotesRead = { quotes: new Map(), accounts: new Map() };
    quotes.forEach((q, i) => {
      out.quotes.set(q.hash.toLowerCase(), {
        cancelled: dm<boolean>('s_cancelledOrders', (results[2 * i] as MulticallResult).returnData),
        filled: dm<bigint>('s_filledRisk', (results[2 * i + 1] as MulticallResult).returnData),
      });
    });
    const base = 2 * quotes.length;
    accounts.forEach((a, i) => {
      out.accounts.set(a.toLowerCase(), {
        registered: dm<boolean>('isCourier', (results[base + 4 * i] as MulticallResult).returnData),
        floor: dm<bigint>('s_minNonces', (results[base + 4 * i + 1] as MulticallResult).returnData),
        balance: dc<bigint>('balanceOf', (results[base + 4 * i + 2] as MulticallResult).returnData),
        allowance: dc<bigint>('allowance', (results[base + 4 * i + 3] as MulticallResult).returnData),
      });
    });
    return out;
  });
}
