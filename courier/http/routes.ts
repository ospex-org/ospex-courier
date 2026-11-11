import { readGameBook } from '../book/read';
import { ChainUnreachable } from '../chain/snapshot';
import { DatabaseUnreadable, status, type StatusDeps } from '../status/status';
import { BOUNDS } from './limits';

// The routes of this build, each answering with a status and a body. A
// refusal is {error, code}: a plain sentence and an UPPER_SNAKE code.

export interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

export type RouteDeps = StatusDeps;

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

export async function getBook(deps: RouteDeps, query: URLSearchParams): Promise<HttpAnswer> {
  const gameId = wholeNumber(query.get('gameId'), 78);
  if (gameId === null) return refusal(400, 'INVALID_PARAM', 'gameId must be a game number.');
  if (query.get('scorer') !== null || query.get('lineTicks') !== null) {
    return refusal(400, 'INVALID_PARAM', "One market's quotes are not served by this build; the markets of a game are.");
  }
  try {
    return { status: 200, body: { ...(await readGameBook(deps, gameId)) } };
  } catch (err) {
    if (err instanceof ChainUnreachable) return refusal(503, 'CHAIN_UNREACHABLE', 'The chain could not be read, twice; the book is one block\'s answer and there is no block to answer at.');
    throw err;
  }
}
