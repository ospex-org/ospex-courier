import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { readGameBook, readMarketBook } from '../book/read';
import { ChainUnreachable } from '../chain/snapshot';
import { betOutcome, orderRecord, postOrder } from '../orders/door';
import { postStop } from '../orders/stops';
import { failureCode, POOL_WAIT_EXHAUSTED, POOL_WAIT_MS } from '../records/store';
import { DatabaseUnreadable, status, type StatusDeps } from '../status/status';
import { BOUNDS } from './limits';

// The routes, each answering with a status and a body. A refusal is {error,
// code}: a plain sentence and an UPPER_SNAKE code. A refusal before admission
// is counted by code and logged by route and code, never with the caller's
// address; a database that cannot be read is 503, and no answer claims a record
// that was not written.

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

/** A refusal before admission: answered, counted and logged, and nothing written. */
function before(deps: RouteDeps, route: string, status: number, code: string, error: string): HttpAnswer {
  deps.counters.count(code);
  deps.log(`refused before admission: ${route} ${code}`);
  return refusal(status, code, error);
}

/**
 * What a read of the book says where the database fails under it. It does not say that nothing was written: a read's
 * scans each commit on their own, so a quote a finished scan marked expired stays marked where a later scan fails.
 */
const BOOK_NOT_SERVED = 'The database could not be read, so the book was not served. Expired quotes a scan had already marked stay marked.';

/**
 * The driver's connection failures that carry no code: a socket closed under
 * it ("Connection terminated unexpectedly"), its connection time-out, a client
 * no longer queryable, the pool's wait for a connection run out. On one
 * platform the same cut gives ECONNRESET with a code, on another this sentence
 * with none; both are the database's failure.
 */
const CODELESS_DATABASE_FAILURES = /connection terminated|connection timeout|timeout expired|timeout exceeded when trying to connect|not queryable|connection ended|terminating connection|connection refused/i;

/** Whether a failure is the database's (a driver or server code, or the driver's codeless connection message), and not a fault of the courier's own. */
const isDatabaseFailure = (err: unknown) =>
  !(err instanceof ChainUnreachable) && (failureCode(err) !== undefined || (err instanceof Error && CODELESS_DATABASE_FAILURES.test(err.message)));

/** Whether the failure is the pool's wait for a connection run out: every connection held by other requests for the whole wait. */
const isPoolWaitExhausted = (err: unknown) => err instanceof Error && POOL_WAIT_EXHAUSTED.test(err.message);

/**
 * The answer for a database that could not be read on a route, logged by the
 * route and the failure's code, never with a value. A pool wait run out is
 * said as that, with a retry time: the connections were all held for the
 * whole wait, and one frees as soon as a request ends.
 */
function databaseUnreadable(deps: RouteDeps, route: string, err: unknown, sentence: string): HttpAnswer {
  if (isPoolWaitExhausted(err)) {
    deps.log(`database: no connection free within its wait of ${POOL_WAIT_MS / 1000} s (${route})`);
    return { status: 503, body: { error: `${sentence} The courier waited ${POOL_WAIT_MS / 1000} seconds for a connection to it and none came free; try again shortly.`, code: 'DATABASE_UNREADABLE', retryAfterSeconds: 1 } };
  }
  deps.log(`database: could not be read (${route})${failureCode(err) === undefined ? '' : ` (${failureCode(err)})`}`);
  return refusal(503, 'DATABASE_UNREADABLE', sentence);
}

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
  if (after === null) return before(deps, 'GET /v1/runs', 400, 'INVALID_PARAM', 'after must be a run number.');
  if (limit === null || limit < 1n || limit > BigInt(BOUNDS.page)) return before(deps, 'GET /v1/runs', 400, 'INVALID_PARAM', `limit must be a whole number from 1 to ${BOUNDS.page}.`);
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
  } catch (err) {
    return databaseUnreadable(deps, 'GET /v1/runs', err, 'The database could not be read.');
  }
}

const CHAIN_UNREACHABLE = refusal(503, 'CHAIN_UNREACHABLE', "The chain could not be read, twice; the book is one block's answer and there is no block to answer at.");

/**
 * GET /v1/book?gameId=            the markets of a game that hold a live quote
 * GET /v1/book?gameId=&scorer=&lineTicks=[&side=A|B&after=tick:record&limit=]   one market's quotes, a page a side
 */
export async function getBook(deps: RouteDeps, query: URLSearchParams): Promise<HttpAnswer> {
  const route = 'GET /v1/book';
  const gameId = wholeNumber(query.get('gameId'), 78);
  if (gameId === null) return before(deps, route, 400, 'INVALID_PARAM', 'gameId must be a game number.');
  const scorer = query.get('scorer');
  const lineText = query.get('lineTicks');
  if (scorer === null && lineText === null) {
    if (query.get('side') !== null) return before(deps, route, 400, 'INVALID_PARAM', "side goes with scorer and lineTicks: one market's quotes.");
    // The game's markets, a page at a time: after is the last market of the page before, as scorer:lineTicks.
    const afterText = query.get('after');
    let after = null;
    if (afterText !== null) {
      const m = /^(0x[0-9a-fA-F]{40}):(-?[0-9]{1,7})$/.exec(afterText);
      if (m === null || !isAddress(m[1] as string, { strict: false })) return before(deps, route, 400, 'INVALID_PARAM', "after must be the last market of the page before, scorer:lineTicks.");
      after = { scorer: getAddress(m[1] as string), lineTicks: Number(m[2]) };
    }
    const limit = query.get('limit') === null ? BigInt(BOUNDS.page) : wholeNumber(query.get('limit'), 4);
    if (limit === null || limit < 1n || limit > BigInt(BOUNDS.page)) return before(deps, route, 400, 'INVALID_PARAM', `limit must be a whole number from 1 to ${BOUNDS.page}.`);
    try {
      return { status: 200, body: { ...(await readGameBook(deps, gameId, after, Number(limit))) } };
    } catch (err) {
      if (err instanceof ChainUnreachable) return CHAIN_UNREACHABLE;
      if (isDatabaseFailure(err)) return databaseUnreadable(deps, route, err, BOOK_NOT_SERVED);
      throw err;
    }
  }
  if (scorer === null || !isAddress(scorer, { strict: false })) return before(deps, route, 400, 'INVALID_PARAM', 'scorer must be the market contract\'s address.');
  if (lineText === null || !/^-?[0-9]{1,7}$/.test(lineText) || Math.abs(Number(lineText)) > 1_000_000) return before(deps, route, 400, 'INVALID_PARAM', 'lineTicks must be a whole number within 1,000,000 either side of zero.');
  const sideText = query.get('side');
  if (sideText !== null && sideText !== 'A' && sideText !== 'B') return before(deps, route, 400, 'INVALID_PARAM', 'side must be A or B.');
  const afterText = query.get('after');
  let after = null;
  if (afterText !== null) {
    const m = /^([0-9]{1,5}):([0-9]{1,18})$/.exec(afterText);
    if (m === null || sideText === null) return before(deps, route, 400, 'INVALID_PARAM', 'after must be the last quote\'s tick and record number, tick:record, and goes with side.');
    after = { oddsTick: Number(m[1]), recordNumber: Number(m[2]) };
  }
  const limit = query.get('limit') === null ? BigInt(BOUNDS.pageQuotesPerSide) : wholeNumber(query.get('limit'), 3);
  if (limit === null || limit < 1n || limit > BigInt(BOUNDS.pageQuotesPerSide)) return before(deps, route, 400, 'INVALID_PARAM', `limit must be a whole number from 1 to ${BOUNDS.pageQuotesPerSide}.`);
  try {
    return { status: 200, body: { ...(await readMarketBook(deps, { gameId, scorer: getAddress(scorer), lineTicks: Number(lineText), side: sideText, after, limit: Number(limit) })) } };
  } catch (err) {
    if (err instanceof ChainUnreachable) return CHAIN_UNREACHABLE;
    if (isDatabaseFailure(err)) return databaseUnreadable(deps, route, err, BOOK_NOT_SERVED);
    throw err;
  }
}

/**
 * A database or connection failure under the door can leave the order recorded or not: the sentence the order route
 * answers it with, as docs/API.md states it, so the two agree.
 */
export const ORDER_ACCEPTANCE_UNCERTAIN =
  'A database or connection failure means this order may or may not have been recorded. Next: read the order by its hash, or post the same signed order again. Do not sign a new bet because an answer failed.';

/**
 * POST /v1/orders: the door. A database or connection failure under it is 503 with that sentence: the order may have
 * been recorded, as a commit can land and its acknowledgement be lost, so the answer does not say it was not.
 */
export async function postOrders(deps: RouteDeps, body: unknown): Promise<HttpAnswer> {
  try {
    return await postOrder({ store: deps.store, chain: deps.chain, set: deps.set, node: deps.node, lane: deps.lane, run: deps.run, counters: deps.counters, published: deps.published, coinDecimals: deps.set.coinDecimals, log: deps.log }, body);
  } catch (err) {
    if (isDatabaseFailure(err)) return databaseUnreadable(deps, 'POST /v1/orders', err, ORDER_ACCEPTANCE_UNCERTAIN);
    throw err;
  }
}

/**
 * POST /v1/stops: the stop. A database that fails under it is 503, and the stop's transaction was rolled back whole;
 * the one failure not known to have recorded nothing is a connection lost as the transaction was committing, and
 * the sentence says how to learn which.
 */
export async function postStops(deps: RouteDeps, body: unknown): Promise<HttpAnswer> {
  try {
    return await postStop({ store: deps.store, chain: deps.chain, set: deps.set, run: deps.run, counters: deps.counters, coinDecimals: deps.set.coinDecimals, log: deps.log }, body);
  } catch (err) {
    if (isDatabaseFailure(err)) {
      return databaseUnreadable(
        deps,
        'POST /v1/stops',
        err,
        'The database could not be read or written for this stop. A stop is recorded whole or not at all; where the connection was lost as it was being recorded, read one of its orders by hash, or send the same message again, to learn which.',
      );
    }
    throw err;
  }
}

/**
 * GET /v1/orders/{hash}: the courier's record of one order. A hash stopped ahead of its order holds no order here:
 * the stop is said, and when, and nothing of the order, since the signed original it was recorded with is served on
 * no route.
 */
export async function getOrder(deps: RouteDeps, hash: string): Promise<HttpAnswer> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return before(deps, 'GET /v1/orders/{hash}', 400, 'INVALID_PARAM', 'An order is read by its hash: 0x and 64 hex characters.');
  try {
    const row = await deps.store.orders.get(hash.toLowerCase() as Hex);
    if (row === null) {
      const stoppedAt = await deps.store.stops.aheadOf(hash.toLowerCase() as Hex);
      if (stoppedAt !== null) return { status: 200, body: { orderHash: hash.toLowerCase(), state: 'stopped ahead', stoppedAt: stoppedAt.toISOString() } };
      return refusal(404, 'UNKNOWN_ORDER', 'The courier holds no order of this hash.');
    }
    return { status: 200, body: orderRecord(row, await betOutcome(deps.store, row, { decimals: deps.set.coinDecimals, relay: deps.set.relay })) };
  } catch (err) {
    return databaseUnreadable(deps, 'GET /v1/orders/{hash}', err, 'The database could not be read.');
  }
}
