import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { COIN_ABI, GAMES_ABI, MARKETS_ABI, MATCHING_ABI, MULTICALL_ABI, MULTICALL_ADDRESS, POSITIONS_ABI, RELAY_ABI } from './abi';
import { splitNonce, type OrderFields } from '../orders/order';
import { decoded, NodeFailure, type Header, type MulticallResult } from './rpc';
import type { BettingSet } from './set';
import type { ChainReader } from './snapshot';

// The reads of state the door, the book and the stop make, each one call to
// the multicall contract at a block named by its hash (snapshot.ts): what the
// door asks about one order, what the book asks about a page of quotes, and
// what a stop asks about its account and the grants it names. Each is
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
  const calls = doorCalls(set, order, hash, marketKey);
  return chain.read(header, calls, (answered) => decodeDoor(header, order, exactly(answered, calls.length)));
}

/** The door's calls for one order, in the door's order; the bet's check makes the same ones first. */
function doorCalls(set: BettingSet, order: OrderFields, hash: Hex, marketKey: Hex) {
  const nonce = splitNonce(order.nonce);
  const underGrant = nonce.grantNumber !== 0;
  return [
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
}

/** The door's read decoded from its calls' results, in the order `doorCalls` makes them. */
function decodeDoor(header: Header, order: OrderFields, results: MulticallResult[]): DoorRead {
  const underGrant = splitNonce(order.nonce).grantNumber !== 0;
  {
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
  }
}

/** What the bet's check reads at H, beyond the door's read: read A. */
export interface BetRead extends DoorRead {
  /** The relay's sender, and the matching contract it passes to. */
  relaySender: Address;
  relayMatching: Address;
  /** The market's id, 0 where no market is drawn on the three fields; and the count of markets drawn. */
  marketId: bigint;
  marketCount: bigint;
  /** The bettor's balance, and its allowance to the positions contract. */
  balance: bigint;
  allowance: bigint;
  /** The key's POL, and the coin held by the key and by the relay: recorded with the result, deciding nothing. */
  keyPol: bigint;
  keyCoin: bigint;
  relayCoin: bigint;
}

const mk = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi: MARKETS_ABI, functionName, args } as never);
const mc = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi: MULTICALL_ABI, functionName, args } as never);
const rl = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi: RELAY_ABI, functionName, args } as never);
const pc = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi: POSITIONS_ABI, functionName, args } as never);
const dmk = <T>(functionName: string, data: Hex) => decoded(functionName, () => decodeFunctionResult({ abi: MARKETS_ABI, functionName, data } as never) as T);
const dmc = <T>(functionName: string, data: Hex) => decoded(functionName, () => decodeFunctionResult({ abi: MULTICALL_ABI, functionName, data } as never) as T);
const drl = <T>(functionName: string, data: Hex) => decoded(functionName, () => decodeFunctionResult({ abi: RELAY_ABI, functionName, data } as never) as T);
const dp = <T>(functionName: string, data: Hex) => decoded(functionName, () => decodeFunctionResult({ abi: POSITIONS_ABI, functionName, data } as never) as T);

/**
 * Read A: one call at H, every argument known from the bet. The door's read (the cap and its switch; the bet's hash
 * as the contract computes it, its cancel and its fill; its account's registration, version and floor; its grant's
 * record and line; the game's four reads), then the relay's sender and the matching contract it passes to; the
 * market's id on the bet's three fields, and the count of markets; the bettor's balance and allowance; the key's
 * POL and coin, and the relay's coin.
 */
export async function readForBet(chain: ChainReader, set: BettingSet, header: Header, order: OrderFields, hash: Hex, marketKey: Hex, courier: Address): Promise<BetRead> {
  const door = doorCalls(set, order, hash, marketKey);
  const calls = [
    ...door,
    { target: set.relay, callData: rl('s_sender') },
    { target: set.relay, callData: rl('i_matching') },
    { target: set.markets, callData: mk('getMarketId', [order.gameId, order.scorer, order.lineTicks]) },
    { target: set.markets, callData: mk('s_marketCount') },
    { target: set.coin, callData: c('balanceOf', [order.account]) },
    { target: set.coin, callData: c('allowance', [order.account, set.positions]) },
    { target: MULTICALL_ADDRESS, callData: mc('getEthBalance', [courier]) },
    { target: set.coin, callData: c('balanceOf', [courier]) },
    { target: set.coin, callData: c('balanceOf', [set.relay]) },
  ];
  return chain.read(header, calls, (answered) => {
    const results = exactly(answered, calls.length);
    const at = (i: number) => (results[door.length + i] as MulticallResult).returnData;
    return {
      ...decodeDoor(header, order, results.slice(0, door.length)),
      relaySender: getAddress(drl<Address>('s_sender', at(0))),
      relayMatching: getAddress(drl<Address>('i_matching', at(1))),
      marketId: BigInt(dmk<bigint>('getMarketId', at(2))),
      marketCount: BigInt(dmk<bigint>('s_marketCount', at(3))),
      balance: dc<bigint>('balanceOf', at(4)),
      allowance: dc<bigint>('allowance', at(5)),
      keyPol: dmc<bigint>('getEthBalance', at(6)),
      keyCoin: dc<bigint>('balanceOf', at(7)),
      relayCoin: dc<bigint>('balanceOf', at(8)),
    };
  });
}

/** One account's two records on a market and what is held for it. */
export interface PositionRead {
  riskA: bigint;
  profitA: bigint;
  riskB: bigint;
  profitB: bigint;
  held: bigint;
}

/** Read C: the market's record, and for each account its two records and what is held for it, at H. Only where the market is drawn. */
export async function readPositions(chain: ChainReader, set: BettingSet, header: Header, marketId: bigint, accounts: readonly Address[]): Promise<{ open: boolean; positions: Map<string, PositionRead> }> {
  const calls = [
    { target: set.markets, callData: mk('getMarket', [marketId]) },
    ...accounts.flatMap((a) => [
      { target: set.positions, callData: pc('getPosition', [marketId, a, 0]) },
      { target: set.positions, callData: pc('getPosition', [marketId, a, 1]) },
      { target: set.positions, callData: pc('s_held', [marketId, a]) },
    ]),
  ];
  return chain.read(header, calls, (answered) => {
    const results = exactly(answered, calls.length);
    const at = (i: number) => (results[i] as MulticallResult).returnData;
    const market = dmk<{ status: number }>('getMarket', at(0));
    const positions = new Map<string, PositionRead>();
    accounts.forEach((a, i) => {
      const A = dp<{ risk: bigint; profit: bigint }>('getPosition', at(1 + 3 * i));
      const B = dp<{ risk: bigint; profit: bigint }>('getPosition', at(2 + 3 * i));
      positions.set(a.toLowerCase(), { riskA: A.risk, profitA: A.profit, riskB: B.risk, profitB: B.profit, held: dp<bigint>('s_held', at(3 + 3 * i)) });
    });
    return { open: Number(market.status) === 0, positions };
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
  /** Where the read was asked about a line (the bet's check): whether each grant above names that line; keyed by `grantKey`. Empty otherwise. */
  grantLines?: Map<string, boolean>;
  /** Where the read was asked for the market's id (a market's page): the id on its three fields, 0 where no market is drawn. */
  marketId?: bigint;
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
export async function readQuotes(
  chain: ChainReader,
  set: BettingSet,
  header: Header,
  marketKey: Hex,
  quotes: ReadonlyArray<{ hash: Hex; account: Address; nonce: bigint }>,
  /** The bet's line, for the bet's check (read B): each grant above is also asked whether its list names it. */
  line?: { gameId: bigint; scorer: Address; lineTicks: number },
  /** A market's page: the market's id on its three fields is asked in the same call, so the page knows whether to read the positions. */
  market?: { gameId: bigint; scorer: Address; lineTicks: number },
): Promise<QuotesRead> {
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
    ...(line === undefined ? [] : [...grantsAsked.values()].map((gr) => ({ target: set.matching, callData: m('isGrantLine', [gr.account, gr.grantNumber, line.gameId, line.scorer, line.lineTicks]) }))),
    ...(market === undefined || quotes.length === 0 ? [] : [{ target: set.markets, callData: encodeFunctionData({ abi: MARKETS_ABI, functionName: 'getMarketId', args: [market.gameId, market.scorer, market.lineTicks] }) }]),
  ];
  if (calls.length === 0) return { quotes: new Map(), accounts: new Map(), floors: new Map(), grants: new Map(), grantLines: new Map() };
  return chain.read(header, calls, (answered) => {
    const results = exactly(answered, calls.length);
    const out: QuotesRead = { quotes: new Map(), accounts: new Map(), floors: new Map(), grants: new Map(), grantLines: new Map() };
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
    const linesAt = grantsAt + grantsAsked.size;
    if (line !== undefined) {
      [...grantsAsked.keys()].forEach((key, i) => out.grantLines?.set(key, dm<boolean>('isGrantLine', at(linesAt + i))));
    }
    if (market !== undefined && quotes.length > 0) {
      const marketAt = linesAt + (line === undefined ? 0 : grantsAsked.size);
      out.marketId = BigInt(decoded('getMarketId', () => decodeFunctionResult({ abi: MARKETS_ABI, functionName: 'getMarketId', data: at(marketAt) }) as bigint));
    }
    return out;
  });
}

/** What a stop asks of the chain about its account, in one call at the header. */
export interface StopAsk {
  account: Address;
  /** The message's signer where it is not the account: asked whether it is the account's live agent. Null for a message the account's own key signed. */
  signer: Address | null;
  /** The grant numbers above zero the message's carried orders and its originals name in their nonces. */
  grantNumbers: readonly number[];
  /** The originals signed under a grant: each asked whether its grant's list names its line. */
  originals: ReadonlyArray<{ hash: Hex; order: OrderFields }>;
  /** Whether the account's registration of the relay is asked: for a message under the budgets. */
  registration: boolean;
}

export interface StopRead {
  header: Header;
  /** Whether the signer is the account's live agent at the block, as the contract's own rule has it: the agent of the account's current grant, the block's time before the grant's end. Null where no signer was asked about. */
  liveAgent: boolean | null;
  /** The number of the account's current grant, 0 for none. */
  currentGrant: number;
  /** The record of each grant asked about, by its number. */
  grants: Map<number, GrantRead>;
  /** For each original under a grant, by its hash, whether that grant's list names its line. */
  lineNamed: Map<string, boolean>;
  /** Whether the account has the relay registered. Null where it was not asked. */
  registered: boolean | null;
}

/**
 * What a stop asks, in one call at the header, in the shape of the door's read: every call is encoded first, from
 * the message alone, and no call's argument is another call's answer. Whether the signer is the account's live
 * agent, where the account's own key did not sign; the account's current grant; the record of each grant the
 * message's carried orders and originals name; for each original under a grant, whether that grant's list names
 * its line (asked whether or not the list is empty, and used only where it is not); and the account's registration
 * of the relay, for a message under the budgets.
 */
export async function readForStop(chain: ChainReader, set: BettingSet, header: Header, ask: StopAsk): Promise<StopRead> {
  const account = getAddress(ask.account);
  const grantNumbers = [...new Set(ask.grantNumbers.filter((n) => n !== 0))].sort((a, b) => a - b);
  const underGrant = ask.originals.filter((o) => splitNonce(o.order.nonce).grantNumber !== 0);
  const calls = [
    { target: set.matching, callData: m('s_currentGrant', [account]) },
    ...(ask.signer === null ? [] : [{ target: set.matching, callData: m('isLiveAgent', [account, getAddress(ask.signer)]) }]),
    ...(ask.registration ? [{ target: set.matching, callData: m('isCourier', [account, set.relay]) }] : []),
    ...grantNumbers.map((n) => ({ target: set.matching, callData: m('getGrant', [account, n]) })),
    ...underGrant.map((o) => ({ target: set.matching, callData: m('isGrantLine', [account, splitNonce(o.order.nonce).grantNumber, o.order.gameId, o.order.scorer, o.order.lineTicks]) })),
  ];
  return chain.read(header, calls, (answered) => {
    const results = exactly(answered, calls.length);
    const at = (i: number) => (results[i] as MulticallResult).returnData;
    let next = 0;
    const currentGrant = Number(dm<number>('s_currentGrant', at(next++)));
    const liveAgent = ask.signer === null ? null : dm<boolean>('isLiveAgent', at(next++));
    const registered = ask.registration ? dm<boolean>('isCourier', at(next++)) : null;
    const grants = new Map<number, GrantRead>();
    for (const n of grantNumbers) grants.set(n, grantOf(at(next++)));
    const lineNamed = new Map<string, boolean>();
    for (const o of underGrant) lineNamed.set(o.hash.toLowerCase(), dm<boolean>('isGrantLine', at(next++)));
    return { header, liveAgent, currentGrant, grants, lineNamed, registered };
  });
}
