import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { readGameBook, readMarketBook } from '../book/read';
import { ChainUnreachable } from '../chain/snapshot';
import { orderRecord, postOrder } from '../orders/door';
import { DatabaseUnreadable, status, type StatusDeps } from '../status/status';
import { BOUNDS } from './limits';

// The routes, each answering with a status and a body. A refusal is {error,
// code}: a plain sentence and an UPPER_SNAKE code.

export interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface RouteDeps extends StatusDeps {
  /** The published list of reporters, read at start. */
  published: readonly Address[];
  log(line: string): void;
}

const refusal = (status: number, code: string, error: string): HttpAnswer => ({ status, body: { error, code } });

/** A whole number from a query string, or null where it is not one. */
function wholeNumber(text: string | null, max = 18): bigint | null {
  if (text === null || !new RegExp(`^[0-9]{1,${max}}$`).test(text)) return null;
  return BigInt(text);
}

export async function getStatus(deps: RouteDeps): Promise<HttpAnswer> {
  try {
    return { status: 200, body: await status(deps) };
  } catch (err) {
    if (err instanceof DatabaseUnreadable) return refusal(503, 'DATABASE_UNREADABLE', 'The database could not be read, so nothing is said about what stands now.');
    throw err;
  }
}

/** Whether the process can serve: the database answers. The set was read at start, or the process would not be running. */
export async function getReady(deps: RouteDeps): Promise<HttpAnswer> {
  try {
    await deps.store.pool.query('SELECT 1');
    return { status: 200, body: { ok: true } };
  } catch {
    return refusal(503, 'NOT_READY', 'The database did not answer.');
  }
}

export async function getRuns(deps: RouteDeps, query: URLSearchParams): Promise<HttpAnswer> {
  const after = query.get('after') === null ? 0n : wholeNumber(query.get('after'));
  const limit = query.get('limit') === null ? BigInt(BOUNDS.page) : wholeNumber(query.get('limit'), 4);
  if (after === null) return refusal(400, 'INVALID_PARAM', 'after must be a run number.');
  if (limit === null || limit < 1n || limit > BigInt(BOUNDS.page)) return refusal(400, 'INVALID_PARAM', `limit must be a whole number from 1 to ${BOUNDS.page}.`);
  try {
    const runs = await deps.store.runs.page(Number(after), Number(limit) + 1);
    const page = runs.slice(0, Number(limit));
    return {
      status: 200,
      body: {
        runs: page.map((r) => ({ id: r.id, startedAt: r.startedAt.toISOString(), stoppedAt: r.stoppedAt?.toISOString() ?? null, stopReason: r.stopReason })),
        more: runs.length > page.length,
        limit: Number(limit),
      },
    };
  } catch {
    return refusal(503, 'DATABASE_UNREADABLE', 'The database could not be read.');
  }
}

const CHAIN_UNREACHABLE = refusal(503, 'CHAIN_UNREACHABLE', "The chain could not be read, twice; the book is one block's answer and there is no block to answer at.");

/**
 * GET /v1/book?gameId=            the markets of a game that hold a live quote
 * GET /v1/book?gameId=&scorer=&lineTicks=[&side=A|B&after=tick:record&limit=]   one market's quotes, a page a side
 */
export async function getBook(deps: RouteDeps, query: URLSearchParams): Promise<HttpAnswer> {
  const gameId = wholeNumber(query.get('gameId'), 78);
  if (gameId === null) return refusal(400, 'INVALID_PARAM', 'gameId must be a game number.');
  const scorer = query.get('scorer');
  const lineText = query.get('lineTicks');
  if (scorer === null && lineText === null) {
    if (query.get('side') !== null || query.get('after') !== null || query.get('limit') !== null) return refusal(400, 'INVALID_PARAM', 'side, after and limit go with scorer and lineTicks: one market\'s quotes.');
    try {
      return { status: 200, body: { ...(await readGameBook(deps, gameId)) } };
    } catch (err) {
      if (err instanceof ChainUnreachable) return CHAIN_UNREACHABLE;
      throw err;
    }
  }
  if (scorer === null || !isAddress(scorer, { strict: false })) return refusal(400, 'INVALID_PARAM', 'scorer must be the market contract\'s address.');
  if (lineText === null || !/^-?[0-9]{1,7}$/.test(lineText) || Math.abs(Number(lineText)) > 1_000_000) return refusal(400, 'INVALID_PARAM', 'lineTicks must be a whole number within 1,000,000 either side of zero.');
  const sideText = query.get('side');
  if (sideText !== null && sideText !== 'A' && sideText !== 'B') return refusal(400, 'INVALID_PARAM', 'side must be A or B.');
  const afterText = query.get('after');
  let after = null;
  if (afterText !== null) {
    const m = /^([0-9]{1,5}):([0-9]{1,18})$/.exec(afterText);
    if (m === null || sideText === null) return refusal(400, 'INVALID_PARAM', 'after must be the last quote\'s tick and record number, tick:record, and goes with side.');
    after = { oddsTick: Number(m[1]), recordNumber: Number(m[2]) };
  }
  const limit = query.get('limit') === null ? BigInt(BOUNDS.pageQuotesPerSide) : wholeNumber(query.get('limit'), 3);
  if (limit === null || limit < 1n || limit > BigInt(BOUNDS.pageQuotesPerSide)) return refusal(400, 'INVALID_PARAM', `limit must be a whole number from 1 to ${BOUNDS.pageQuotesPerSide}.`);
  try {
    return { status: 200, body: { ...(await readMarketBook(deps, { gameId, scorer: getAddress(scorer), lineTicks: Number(lineText), side: sideText, after, limit: Number(limit) })) } };
  } catch (err) {
    if (err instanceof ChainUnreachable) return CHAIN_UNREACHABLE;
    throw err;
  }
}

/** POST /v1/orders: the door. */
export async function postOrders(deps: RouteDeps, body: unknown): Promise<HttpAnswer> {
  return postOrder({ store: deps.store, chain: deps.chain, set: deps.set, run: deps.run, counters: deps.counters, published: deps.published, coinDecimals: deps.set.coinDecimals, log: deps.log }, body);
}

/** GET /v1/orders/{hash}: the courier's record of one order. */
export async function getOrder(deps: RouteDeps, hash: string): Promise<HttpAnswer> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return refusal(400, 'INVALID_PARAM', 'An order is read by its hash: 0x and 64 hex characters.');
  try {
    const row = await deps.store.orders.get(hash.toLowerCase() as Hex);
    if (row === null) return refusal(404, 'UNKNOWN_ORDER', 'The courier holds no order of this hash.');
    return { status: 200, body: orderRecord(row) };
  } catch {
    return refusal(503, 'DATABASE_UNREADABLE', 'The database could not be read.');
  }
}
