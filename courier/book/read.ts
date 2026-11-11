import { getAddress, type Address, type Hex } from 'viem';
import { readQuotes } from '../chain/reads';
import type { BettingSet } from '../chain/set';
import type { ChainReader } from '../chain/snapshot';
import { BOUNDS } from '../http/limits';
import { marketKey as keyOf, ORDER_RULES } from '../orders/order';
import type { Cursor, ScannedQuote } from '../records/orders';
import type { Store } from '../records/store';

// The book, read. Public and bounded: no read is returned more than the bound
// of rows from the book's index for one side of one market, the quotes the
// courier has not marked ended, in the index's order; where that bound and
// not the book ended a page or a count, the answer says so. The order is the
// fill-priority order: the lowest tick first, then the record number. One
// block's answer, and it says which; and the final block beside it, which is
// what the request marked expired quotes against.

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
}

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
  /** How much of `remaining` the account could be pulled for at that block, this quote alone: what its balance and its allowance cover. */
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
  /** Quotes the chain showed ended at the block (cancelled, under a floor, filled, or the relay dropped), among those examined. */
  endedOnChain: number;
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

/** The markets of a game that hold a live quote, each side's count within the bound. */
export async function readGameBook(deps: BookDeps, gameId: bigint): Promise<GameBook> {
  const { header, final } = await blocks(deps);
  const client = await deps.store.pool.connect();
  try {
    await client.query('BEGIN');
    const pairs = await deps.store.orders.marketsOfGame(client, gameId);
    const byMarket = new Map<string, GameBook['markets'][number]>();
    for (const pair of pairs) {
      const result = await deps.store.orders.scan(client, { marketKey: pair.marketKey, side: pair.side, after: null, blockTime: header.timestamp, finalTime: final.timestamp, page: 0 });
      const count: SideCount = { live: result.live, boundReached: result.scanned >= BOUNDS.scanRows, marked: result.marked };
      const entry = byMarket.get(pair.marketKey) ?? { scorer: getAddress(pair.scorer), lineTicks: pair.lineTicks, marketKey: pair.marketKey, live: { A: { live: 0, boundReached: false, marked: 0 }, B: { live: 0, boundReached: false, marked: 0 } } };
      if (pair.side === 0) entry.live.A = count;
      else entry.live.B = count;
      byMarket.set(pair.marketKey, entry);
    }
    await client.query('COMMIT');
    const all = [...byMarket.values()].filter((m) => m.live.A.live > 0 || m.live.B.live > 0 || m.live.A.boundReached || m.live.B.boundReached);
    return { gameId: gameId.toString(), block: named(header), final: named(final), markets: all.slice(0, BOUNDS.page), bound: BOUNDS.scanRows, more: all.length > BOUNDS.page };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
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
    await client.query('BEGIN');
    for (const side of sides) {
      scans[side] = await deps.store.orders.scan(client, { marketKey: key, side: side === 'A' ? 0 : 1, after: q.after, blockTime: header.timestamp, finalTime: final.timestamp, page: q.limit });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // What only the chain knows about the page's quotes, in one call at the block.
  const examined: ScannedQuote[] = sides.flatMap((s) => scans[s]?.rows ?? []);
  const state = await readQuotes(deps.chain, deps.set, header, key, examined.map((e) => ({ hash: e.hash, account: e.account })));

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
    for (const row of scan.rows) {
      const s = state.quotes.get(row.hash.toLowerCase());
      const a = state.accounts.get(row.account.toLowerCase());
      if (s === undefined || a === undefined) continue;
      const remaining = row.riskAmount - s.filled;
      if (s.cancelled || row.nonce < a.floor || remaining < ORDER_RULES.lot || !a.registered) {
        endedOnChain++;
        continue;
      }
      const cover = a.balance < a.allowance ? a.balance : a.allowance;
      quotes.push({
        orderHash: row.hash,
        account: getAddress(row.account),
        positionType: row.positionType,
        oddsTick: row.oddsTick,
        perLot: { bettor: row.oddsTick - 100, maker: 100 },
        bettorPrice: bettorPrice(row.oddsTick),
        remaining: remaining.toString(),
        payable: (remaining < cover ? remaining : cover).toString(),
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
      endedBy: pageFull ? null : boundEnded ? 'bound' : 'book',
      next: pageFull ? (scan.rows[scan.rows.length - 1] ? { oddsTick: (scan.rows[scan.rows.length - 1] as ScannedQuote).oddsTick, recordNumber: (scan.rows[scan.rows.length - 1] as ScannedQuote).recordNumber } : scan.last) : boundEnded ? scan.last : null,
      limit: q.limit,
    };
  }
  return out;
}
