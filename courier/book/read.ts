import type { ChainReader } from '../chain/snapshot';
import { BOUNDS } from '../http/limits';
import type { Store } from '../records/store';

// The book, read: for a game, the markets that hold a live quote. One block's
// answer, and it says which. This build carries no orders, so the answer is
// an empty book at a named block; the quotes themselves, their order and the
// page of one market are the orders build's.

export interface BookDeps {
  store: Store;
  chain: ChainReader;
}

export interface GameBook {
  gameId: string;
  block: { number: string; hash: string; time: string };
  markets: Array<{ scorer: string; lineTicks: number; live: { A: number; B: number } }>;
  /** Whether the bound of rows read, and not the book, ended the count. */
  boundReached: boolean;
  /** How many rows one read takes from the book at most. */
  bound: number;
  more: boolean;
}

export async function readGameBook(deps: BookDeps, gameId: bigint): Promise<GameBook> {
  const header = await deps.chain.latestHeader();
  const { markets, boundReached } = await deps.store.liveMarkets(gameId, header.timestamp, BOUNDS.scanRows);
  const byMarket = new Map<string, { scorer: string; lineTicks: number; live: { A: number; B: number } }>();
  for (const row of markets) {
    const key = `${row.scorer}:${row.lineTicks}`;
    const market = byMarket.get(key) ?? { scorer: row.scorer, lineTicks: row.lineTicks, live: { A: 0, B: 0 } };
    if (row.side === 0) market.live.A += row.live;
    else market.live.B += row.live;
    byMarket.set(key, market);
  }
  const all = [...byMarket.values()];
  return {
    gameId: gameId.toString(),
    block: { number: header.number.toString(), hash: header.hash, time: header.timestamp.toString() },
    markets: all.slice(0, BOUNDS.page),
    boundReached,
    bound: BOUNDS.scanRows,
    more: all.length > BOUNDS.page,
  };
}
