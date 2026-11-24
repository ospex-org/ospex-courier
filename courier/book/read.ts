import { getAddress, type Address, type Hex } from 'viem';
import { readPositions, readQuotes, type PositionRead } from '../chain/reads';
import { NO_RECORDS, payable } from '../check/pull';
import type { BettingSet } from '../chain/set';
import type { ChainReader } from '../chain/snapshot';
import { BOUNDS } from '../http/limits';
import { marketKey as keyOf } from '../orders/order';
import { quoteEnd } from '../orders/standing';
import type { Cursor, EndSeen, MarketCursor, ScannedQuote } from '../records/orders';
import type { Store } from '../records/store';

// The book, read. Public and bounded: no read is returned more than the bound
// of rows from the book's index for one side of one market, the quotes the
// courier has not marked ended, in the index's order; where that bound and
// not the book ended a page or a count, the answer says so. The order is the
// fill-priority order: the lowest tick first, then the record number. One
// block's answer, and it says which; and the final block beside it, which is
// what the request marked expired quotes against. A market's page asks the
// chain about the quotes it lists and marks the ones shown cancelled; the
// game's list asks the chain nothing, so its counts are the courier's records
// as they stand, right once any request has asked the chain about the quotes.
//
// A read scans one side of one market at a time, and each scan is one
// statement that commits on its own: no transaction encloses two of them. A
// scan holds the rows of the expired quotes it marks only until its own
// statement ends, so a read has let them go before its next scan begins, and
// before the mark of quotes the chain showed ended. A read that kept one
// scan's rows into the next could wait on a stop that was waiting on it. So a
// read is its statements' observations of the records, one after another, and
// not one snapshot across a market's sides or a game's markets; and a mark a
// finished scan made stays where a later scan, or a later stage of the same
// read, fails.

export interface BookDeps {
  store: Store;
  chain: ChainReader;
  set: BettingSet;
}

export interface BlockNamed {
  number: string;
  hash: Hex;
  time: string;
}

export interface SideCount {
  live: number;
  /** Whether the bound of rows, and not the book, ended the count. */
  boundReached: boolean;
  /** Rows this request marked expired. */
  marked: number;
}

export interface GameBook {
  gameId: string;
  block: BlockNamed;
  final: BlockNamed;
  markets: Array<{ scorer: Address; lineTicks: number; marketKey: Hex; live: { A: SideCount; B: SideCount } }>;
  bound: number;
  more: boolean;
  /** Where the next page of markets starts: the last market of this page, as `after=scorer:lineTicks`. Null where this page ends the list. */
  next: { scorer: Address; lineTicks: number } | null;
  limit: number;
}

export type { MarketCursor };

export interface Quote {
  orderHash: Hex;
  account: Address;
  positionType: 0 | 1;
  oddsTick: number;
  /** Per lot: what a bettor stakes against this quote, and what the quote stakes. */
  perLot: { bettor: number; maker: number };
  /** The bettor's decimal price, rounded down to two places. */
  bettorPrice: string;
  /** The signed stake less what the chain shows filled at the block. */
  remaining: string;
  /**
   * How much of `remaining` one bet could fill against this quote alone at that block, whole lots, with the account's
   * wallet covering the leg's netted pull: what the positions contract would take, after what the account already
   * holds on the market. A maker that holds the other side can be payable for more than its wallet holds.
   */
  payable: string;
  minFill: string;
  expiry: string;
  recordNumber: number;
}

export interface SidePage {
  side: 'A' | 'B';
  quotes: Quote[];
  /** Rows the index returned to this request; rows it marked expired; rows live at the block among them. */
  scanned: number;
  marked: number;
  live: number;
  /** Quotes the chain showed ended at the block (cancelled, at a version left, under a floor, under a grant that is gone, filled, or the relay dropped), among those examined. */
  endedOnChain: number;
  /** Of those, the quotes the chain showed cancelled, at a version their account has left, under their floor at their version, or under a grant that is gone, which this request marked cancelled in the records at the block: they are asked about no more. */
  markedCancelled: number;
  /** Of those, the quotes the chain showed with less than a lot of their stake left, which this request marked filled in the records at the block. */
  markedFilled: number;
  /** What ended the page: the book (no more rows), the bound (the scan returned its bound), or nothing yet (more live rows than the page). */
  endedBy: 'book' | 'bound' | null;
  /** Where the next page starts: the last row this scan returned. Null where the book ended. */
  next: Cursor | null;
  limit: number;
}

export interface MarketBook {
  gameId: string;
  market: { scorer: Address; lineTicks: number; marketKey: Hex };
  block: BlockNamed;
  final: BlockNamed;
  sides: Partial<Record<'A' | 'B', SidePage>>;
  /** Once for each account on the page: its balance and its allowance to the positions contract at the block. */
  accounts: Record<string, { balance: string; allowance: string; registered: boolean }>;
  bound: number;
}

const named = (h: { number: bigint; hash: Hex; timestamp: bigint }): BlockNamed => ({ number: h.number.toString(), hash: h.hash, time: h.timestamp.toString() });

/** The bettor's decimal price against a tick R, R ÷ (R − 100), rounded down to two places. */
export function bettorPrice(oddsTick: number): string {
  const hundredths = Math.floor((oddsTick * 100) / (oddsTick - 100));
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

/** The two headers every read starts from: the latest block, T, and the final block, F. */
async function blocks(deps: BookDeps) {
  const header = await deps.chain.latestHeader();
  const final = await deps.chain.finalHeader();
  return { header, final };
}

/**
 * The markets of a game that hold a quote the courier has not marked ended,
 * each side's live count within the bound, a page at a time: the markets in
 * order of the market contract's address and then the line, from after the
 * cursor, at most the page. The game's (market, side) pairs are walked along
 * the game's own index from the cursor, one probe a pair, at most two a market
 * of the page plus one, so the page's work is the page's and not the book's;
 * only the page's markets are scanned, and a market whose sides hold no live
 * quote and reached no bound is left out of the page.
 */
export async function readGameBook(deps: BookDeps, gameId: bigint, after: MarketCursor | null = null, limit: number = BOUNDS.page): Promise<GameBook> {
  const { header, final } = await blocks(deps);
  const client = await deps.store.pool.connect();
  try {
    // The pairs past the cursor, in the list's order: two a market at most, and one market more than the page, to
    // know whether markets follow.
    const pairs = await deps.store.orders.marketsOfGame(client, gameId, after, 2 * (limit + 1));
    const markets: Array<{ scorer: Address; lineTicks: number; marketKey: Hex; sides: Array<0 | 1> }> = [];
    for (const pair of pairs) {
      const last = markets[markets.length - 1];
      if (last !== undefined && last.scorer.toLowerCase() === pair.scorer.toLowerCase() && last.lineTicks === pair.lineTicks) last.sides.push(pair.side);
      else markets.push({ scorer: getAddress(pair.scorer), lineTicks: pair.lineTicks, marketKey: pair.marketKey, sides: [pair.side] });
    }
    const more = markets.length > limit;
    const taken = markets.slice(0, limit);
    const page: GameBook['markets'] = [];
    for (const m of taken) {
      const entry: GameBook['markets'][number] = { scorer: m.scorer, lineTicks: m.lineTicks, marketKey: m.marketKey, live: { A: { live: 0, boundReached: false, marked: 0 }, B: { live: 0, boundReached: false, marked: 0 } } };
      for (const side of m.sides) {
        const result = await deps.store.orders.scan(client, { marketKey: m.marketKey, side, after: null, blockTime: header.timestamp, finalTime: final.timestamp, page: 0 });
        const count: SideCount = { live: result.live, boundReached: result.scanned >= BOUNDS.scanRows, marked: result.marked };
        if (side === 0) entry.live.A = count;
        else entry.live.B = count;
      }
      if (entry.live.A.live > 0 || entry.live.B.live > 0 || entry.live.A.boundReached || entry.live.B.boundReached) page.push(entry);
    }
    const lastTaken = taken[taken.length - 1];
    return {
      gameId: gameId.toString(),
      block: named(header),
      final: named(final),
      markets: page,
      bound: BOUNDS.scanRows,
      more,
      next: more && lastTaken !== undefined ? { scorer: lastTaken.scorer, lineTicks: lastTaken.lineTicks } : null,
      limit,
    };
  } finally {
    client.release();
  }
}

export interface MarketQuery {
  gameId: bigint;
  scorer: Address;
  lineTicks: number;
  side: 'A' | 'B' | null;
  after: Cursor | null;
  limit: number;
}

/** One market's quotes, a page a side. */
export async function readMarketBook(deps: BookDeps, q: MarketQuery): Promise<MarketBook> {
  const { header, final } = await blocks(deps);
  const key = keyOf(q.gameId, q.scorer, q.lineTicks);
  const sides: Array<'A' | 'B'> = q.side === null ? ['A', 'B'] : [q.side];
  const client = await deps.store.pool.connect();
  const scans: Partial<Record<'A' | 'B', Awaited<ReturnType<Store['orders']['scan']>>>> = {};
  try {
    for (const side of sides) {
      scans[side] = await deps.store.orders.scan(client, { marketKey: key, side: side === 'A' ? 0 : 1, after: q.after, blockTime: header.timestamp, finalTime: final.timestamp, page: q.limit });
    }
  } finally {
    client.release();
  }

  // What only the chain knows about the page's quotes, in one call at the block. A quote it shows ended is marked in
  // the records here, at this block, in this same request, so the courier carries it no further and no request asks
  // about it again: cancelled, at a version its account has left, under its floor at its version, or under a grant
  // that is gone (the account's own acts, or its grant's own end), as `cancelled`; with less than a lot of its stake
  // left (a fill through another courier), as `filled`. The predicate is the door's (orders/standing.ts), each quote
  // judged at the version and under the grant its own nonce names. A quote whose account dropped the relay is not
  // listed and not marked: not an end of the quote, and undone by the account itself.
  const examined: ScannedQuote[] = sides.flatMap((s) => scans[s]?.rows ?? []);
  const market = { gameId: q.gameId, scorer: q.scorer, lineTicks: q.lineTicks };
  const state = await readQuotes(deps.chain, deps.set, header, key, examined.map((e) => ({ hash: e.hash, account: e.account, nonce: e.nonce })), undefined, market);
  // The positions, where the market is drawn: one read more, after the page's read, whose answer it needs. A market not
  // drawn holds no position and nothing held, so each account's netted pull is its whole stake there.
  let positions = new Map<string, PositionRead>();
  if (state.marketId !== undefined && state.marketId !== 0n && state.accounts.size > 0) {
    positions = (await readPositions(deps.chain, deps.set, header, state.marketId, [...state.accounts.keys()].map((a) => getAddress(a)))).positions;
  }
  const endOf = (row: ScannedQuote): EndSeen | null => quoteEnd(row, state, header.timestamp);
  const marks = examined.flatMap((e) => {
    const how = endOf(e);
    return how === null ? [] : [{ hash: e.hash, how }];
  });
  const marked = new Map<string, EndSeen>((await deps.store.orders.markEnded(deps.store.pool, marks, header)).map((m) => [m.hash.toLowerCase(), m.how]));

  const out: MarketBook = {
    gameId: q.gameId.toString(),
    market: { scorer: getAddress(q.scorer), lineTicks: q.lineTicks, marketKey: key },
    block: named(header),
    final: named(final),
    sides: {},
    accounts: {},
    bound: BOUNDS.scanRows,
  };
  for (const [address, a] of state.accounts) out.accounts[address] = { balance: a.balance.toString(), allowance: a.allowance.toString(), registered: a.registered };

  for (const side of sides) {
    const scan = scans[side];
    if (scan === undefined) continue;
    const quotes: Quote[] = [];
    let endedOnChain = 0;
    let markedCancelled = 0;
    let markedFilled = 0;
    for (const row of scan.rows) {
      const s = state.quotes.get(row.hash.toLowerCase());
      const a = state.accounts.get(row.account.toLowerCase());
      if (s === undefined || a === undefined) continue;
      const remaining = row.riskAmount - s.filled;
      const mark = marked.get(row.hash.toLowerCase());
      if (mark === 'cancelled') markedCancelled++;
      else if (mark === 'filled') markedFilled++;
      // Listed: a quote the read shows standing, by the same predicate that marks, whose account still has the relay.
      if (endOf(row) !== null || !a.registered) {
        endedOnChain++;
        continue;
      }
      const p = positions.get(row.account.toLowerCase());
      const coverable = payable(
        { side: row.positionType, oddsTick: row.oddsTick, remaining },
        { records: p === undefined ? NO_RECORDS : { riskA: p.riskA, profitA: p.profitA, riskB: p.riskB, profitB: p.profitB }, held: p?.held ?? 0n, balance: a.balance, allowance: a.allowance },
      );
      quotes.push({
        orderHash: row.hash,
        account: getAddress(row.account),
        positionType: row.positionType,
        oddsTick: row.oddsTick,
        perLot: { bettor: row.oddsTick - 100, maker: 100 },
        bettorPrice: bettorPrice(row.oddsTick),
        remaining: remaining.toString(),
        payable: coverable.toString(),
        minFill: row.minFill.toString(),
        expiry: row.expiry.toString(),
        recordNumber: row.recordNumber,
      });
    }
    const boundEnded = scan.scanned >= BOUNDS.scanRows;
    const pageFull = scan.live > scan.rows.length;
    out.sides[side] = {
      side,
      quotes,
      scanned: scan.scanned,
      marked: scan.marked,
      live: scan.live,
      endedOnChain,
      markedCancelled,
      markedFilled,
      endedBy: pageFull ? null : boundEnded ? 'bound' : 'book',
      next: pageFull ? (scan.rows[scan.rows.length - 1] ? { oddsTick: (scan.rows[scan.rows.length - 1] as ScannedQuote).oddsTick, recordNumber: (scan.rows[scan.rows.length - 1] as ScannedQuote).recordNumber } : scan.last) : boundEnded ? scan.last : null,
      limit: q.limit,
    };
  }
  return out;
}
