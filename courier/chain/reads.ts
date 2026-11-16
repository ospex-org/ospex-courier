import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { COIN_ABI, GAMES_ABI, MATCHING_ABI } from './abi';
import { splitNonce, type OrderFields } from '../orders/order';
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

/** A grant's record, as the contract keeps it under the account and the grant's number: written once, never edited. */
export interface GrantRead {
  /** The grant's agent; the zero address for a number the account never made. */
  agent: Address;
  /** The second the grant ends at. */
  endsAt: bigint;
  /** The most one order the agent signs may stake. */
  stakeCap: bigint;
  /** How many lines the grant's list names; 0 passes every market. */
  lineCount: number;
}

export interface DoorRead {
  header: Header;
  registered: boolean;
  /** The contract's own hash of the ten values. */
  contractHash: Hex;
  cancelled: boolean;
  /** The account's current version. */
  version: bigint;
  /** The floor of the order's line at the version the order's own nonce names. */
  floorAtVersion: bigint;
  filled: bigint;
  cap: bigint;
  capLifted: boolean;
  /** For an order under a grant, the number of the account's current grant, 0 for none; null for an order its account signs. */
  currentGrant: number | null;
  /** For an order under a grant, the record of the grant its nonce names and whether that grant's list names the order's line; null for an order its account signs. */
  grant: (GrantRead & { lineNamed: boolean }) | null;
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

/** A grant's record, decoded from getGrant's four values. */
function grantOf(data: Hex): GrantRead {
  const [agent, endsAt, stakeCap, lineCount] = dm<readonly [Address, bigint, bigint, number]>('getGrant', data);
  return { agent: getAddress(agent), endsAt: BigInt(endsAt), stakeCap: BigInt(stakeCap), lineCount: Number(lineCount) };
}

/**
 * What the door asks about one order, in one call at the header. The order's nonce is split here as the contract
 * splits it, and its standing is asked as the contract judges it: the account's version, and the floor of the
 * order's line at the version the nonce names. For an order under a grant the same call asks the account's current
 * grant, the record of the grant the nonce names, and whether that grant's list names the order's line (asked
 * whether or not the list is empty, and used only where it is not). Every argument is known from the order: no
 * call's argument is another call's answer.
 */
export async function readForDoor(chain: ChainReader, set: BettingSet, header: Header, order: OrderFields, hash: Hex, marketKey: Hex): Promise<DoorRead> {
  const nonce = splitNonce(order.nonce);
  const underGrant = nonce.grantNumber !== 0;
  const calls = [
    { target: set.matching, callData: m('isCourier', [order.account, set.relay]) },
    { target: set.matching, callData: m('getOrderHash', [order]) },
    { target: set.matching, callData: m('s_cancelledOrders', [hash]) },
    { target: set.matching, callData: m('s_version', [order.account]) },
    { target: set.matching, callData: m('s_floors', [order.account, nonce.version, marketKey]) },
    { target: set.matching, callData: m('s_filledRisk', [hash]) },
    { target: set.matching, callData: m('TAKING_STAKE_CAP') },
    { target: set.matching, callData: m('s_takingStakeCapLifted') },
    { target: set.games, callData: g('getGameStatus', [order.gameId]), allowFailure: true },
    { target: set.games, callData: g('getGameStart', [order.gameId]), allowFailure: true },
    { target: set.games, callData: g('getGameWindow', [order.gameId]), allowFailure: true },
    { target: set.games, callData: g('getGameReporters', [order.gameId]), allowFailure: true },
    ...(underGrant
      ? [
          { target: set.matching, callData: m('s_currentGrant', [order.account]) },
          { target: set.matching, callData: m('getGrant', [order.account, nonce.grantNumber]) },
          { target: set.matching, callData: m('isGrantLine', [order.account, nonce.grantNumber, order.gameId, order.scorer, order.lineTicks]) },
        ]
      : []),
  ];
  return chain.read(header, calls, (answered) => {
    const results = exactly(answered, calls.length);
    const [registered, contractHash, cancelled, version, floor, filled, cap, lifted, status, start, window, reporters] = results as [
      MulticallResult, MulticallResult, MulticallResult, MulticallResult, MulticallResult, MulticallResult, MulticallResult, MulticallResult,
      MulticallResult, MulticallResult, MulticallResult, MulticallResult,
    ];
    const [currentGrant, grant, lineNamed] = results.slice(12) as [MulticallResult, MulticallResult, MulticallResult];
    // The games set's refusal of the id is an intelligible negative: not a game. Its bytes are a revert's, not a
    // value's, and are decoded as nothing.
    const known = status.success;
    return {
      header,
      registered: dm<boolean>('isCourier', registered.returnData),
      contractHash: dm<Hex>('getOrderHash', contractHash.returnData),
      cancelled: dm<boolean>('s_cancelledOrders', cancelled.returnData),
      version: BigInt(dm<bigint>('s_version', version.returnData)),
      floorAtVersion: BigInt(dm<bigint>('s_floors', floor.returnData)),
      filled: dm<bigint>('s_filledRisk', filled.returnData),
      cap: dm<bigint>('TAKING_STAKE_CAP', cap.returnData),
      capLifted: dm<boolean>('s_takingStakeCapLifted', lifted.returnData),
      currentGrant: underGrant ? Number(dm<number>('s_currentGrant', currentGrant.returnData)) : null,
      grant: underGrant ? { ...grantOf(grant.returnData), lineNamed: dm<boolean>('isGrantLine', lineNamed.returnData) } : null,
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
  /** The account's current version. */
  version: bigint;
  /** The number of the account's current grant, 0 for none. */
  currentGrant: number;
  balance: bigint;
  /** The allowance to the positions contract. */
  allowance: bigint;
}

export interface QuotesRead {
  quotes: Map<string, QuoteState>;
  accounts: Map<string, AccountState>;
  /** The floor of the market's line for an account at a version, for each (account, version) the quotes' nonces name; keyed by `floorKey`. */
  floors: Map<string, bigint>;
  /** The record of each grant the quotes' nonces name, for each (account, grant number) above zero; keyed by `grantKey`. */
  grants: Map<string, GrantRead>;
}

/** The key a floor is held under in a read of quotes: the account and the version. */
export const floorKey = (account: Address, version: bigint): string => `${account.toLowerCase()}:${version}`;
/** The key a grant's record is held under in a read of quotes: the account and the grant's number. */
export const grantKey = (account: Address, grantNumber: number): string => `${account.toLowerCase()}:${grantNumber}`;

/**
 * What the book asks about a page of quotes on one market, in one call at the
 * header: for each quote whether it is cancelled and what it has filled; for
 * each account once, whether it still has the relay registered, its current
 * version, its current grant, its balance and its allowance; for each account
 * and version the quotes' nonces name, the floor of the market's line at that
 * version; and for each account and grant they name, the grant's record. So
 * the one read answers the standing of every quote of the page, each at the
 * version and under the grant its own nonce names. The calls are at most four
 * a quote and five an account, whatever the records hold: a page's, not the
 * book's.
 */
export async function readQuotes(chain: ChainReader, set: BettingSet, header: Header, marketKey: Hex, quotes: ReadonlyArray<{ hash: Hex; account: Address; nonce: bigint }>): Promise<QuotesRead> {
  const accounts = [...new Set(quotes.map((q) => getAddress(q.account)))];
  const floorsAsked = new Map<string, { account: Address; version: bigint }>();
  const grantsAsked = new Map<string, { account: Address; grantNumber: number }>();
  for (const q of quotes) {
    const nonce = splitNonce(q.nonce);
    floorsAsked.set(floorKey(q.account, nonce.version), { account: getAddress(q.account), version: nonce.version });
    if (nonce.grantNumber !== 0) grantsAsked.set(grantKey(q.account, nonce.grantNumber), { account: getAddress(q.account), grantNumber: nonce.grantNumber });
  }
  const calls = [
    ...quotes.flatMap((q) => [
      { target: set.matching, callData: m('s_cancelledOrders', [q.hash]) },
      { target: set.matching, callData: m('s_filledRisk', [q.hash]) },
    ]),
    ...accounts.flatMap((a) => [
      { target: set.matching, callData: m('isCourier', [a, set.relay]) },
      { target: set.matching, callData: m('s_version', [a]) },
      { target: set.matching, callData: m('s_currentGrant', [a]) },
      { target: set.coin, callData: c('balanceOf', [a]) },
      { target: set.coin, callData: c('allowance', [a, set.positions]) },
    ]),
    ...[...floorsAsked.values()].map((f) => ({ target: set.matching, callData: m('s_floors', [f.account, f.version, marketKey]) })),
    ...[...grantsAsked.values()].map((gr) => ({ target: set.matching, callData: m('getGrant', [gr.account, gr.grantNumber]) })),
  ];
  if (calls.length === 0) return { quotes: new Map(), accounts: new Map(), floors: new Map(), grants: new Map() };
  return chain.read(header, calls, (answered) => {
    const results = exactly(answered, calls.length);
    const out: QuotesRead = { quotes: new Map(), accounts: new Map(), floors: new Map(), grants: new Map() };
    const at = (i: number) => (results[i] as MulticallResult).returnData;
    quotes.forEach((q, i) => {
      out.quotes.set(q.hash.toLowerCase(), {
        cancelled: dm<boolean>('s_cancelledOrders', at(2 * i)),
        filled: dm<bigint>('s_filledRisk', at(2 * i + 1)),
      });
    });
    const accountsAt = 2 * quotes.length;
    accounts.forEach((a, i) => {
      out.accounts.set(a.toLowerCase(), {
        registered: dm<boolean>('isCourier', at(accountsAt + 5 * i)),
        version: BigInt(dm<bigint>('s_version', at(accountsAt + 5 * i + 1))),
        currentGrant: Number(dm<number>('s_currentGrant', at(accountsAt + 5 * i + 2))),
        balance: dc<bigint>('balanceOf', at(accountsAt + 5 * i + 3)),
        allowance: dc<bigint>('allowance', at(accountsAt + 5 * i + 4)),
      });
    });
    const floorsAt = accountsAt + 5 * accounts.length;
    [...floorsAsked.keys()].forEach((key, i) => out.floors.set(key, BigInt(dm<bigint>('s_floors', at(floorsAt + i)))));
    const grantsAt = floorsAt + floorsAsked.size;
    [...grantsAsked.keys()].forEach((key, i) => out.grants.set(key, grantOf(at(grantsAt + i))));
    return out;
  });
}
