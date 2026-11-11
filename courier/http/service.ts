import type { IncomingMessage, ServerResponse } from 'node:http';
import { describeNodeFailure } from '../chain/rpc';
import { failureCode } from '../records/store';
import { BOUNDS, createAddressLimiter, type AddressLimiter, type Counters } from './limits';
import { getBook, getOrder, getReady, getRuns, getStatus, postOrders, type HttpAnswer, type RouteDeps } from './routes';

// The courier's HTTP service: node:http and routes by hand. JSON under /v1;
// no sign-in and no shared secret, since a signed order is its own permission
// and the book is public. https only, behind Heroku's router; plain http only
// from this machine, which is how the tests reach it.
//
//   GET  /healthz              the process answers; nothing more
//   GET  /readyz               the database answers
//   GET  /v1/status            what stands now
//   GET  /v1/runs              the runs, paged
//   GET  /v1/book?gameId=      the markets of a game that hold a live quote, at one block
//   GET  /v1/book?gameId=&scorer=&lineTicks=   one market's quotes, a page a side, at one block
//   POST /v1/orders            the door: a signed order, under a role
//   GET  /v1/orders/{hash}     the courier's record of one order

export interface ServiceDeps extends RouteDeps {
  counters: Counters;
  limiter?: AddressLimiter;
}

const THIS_MACHINE = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * How a request reached the courier, for the https rule. Behind Heroku's
 * router TLS ends at the router, which says how the request arrived in
 * X-Forwarded-Proto; the dyno's own socket is plain either way. A request
 * with no such header did not come through the router: it is served only
 * from this machine.
 */
function transport(req: IncomingMessage): 'https' | 'this-machine' | 'not-https' | 'no-header-from-elsewhere' {
  const proto = req.headers['x-forwarded-proto'];
  if (proto !== undefined) return (Array.isArray(proto) ? proto.join(',') : proto).trim().toLowerCase() === 'https' ? 'https' : 'not-https';
  return THIS_MACHINE.has(req.socket.remoteAddress ?? '') ? 'this-machine' : 'no-header-from-elsewhere';
}

/** The caller's network address, as the router reports it or as the socket has it. Used for the limit and never kept. */
function callerAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim() !== '') return forwarded.split(',').pop()?.trim() ?? '';
  return req.socket.remoteAddress ?? '';
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(res: ServerResponse, answer: HttpAnswer, extra: Record<string, string> = {}): void {
  res.writeHead(answer.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
    ...extra,
  });
  res.end(JSON.stringify(answer.body));
}

const refusal = (status: number, code: string, error: string): HttpAnswer => ({ status, body: { error, code } });

/**
 * The body of a POST, read up to its bound and no further: a body over the
 * bound is refused before it is read whole, and before anything is parsed.
 */
function readBody(req: IncomingMessage, bound: number): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: { ok: true; text: string } | { ok: false }) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > bound) {
        req.removeAllListeners('data');
        req.resume();
        return finish({ ok: false });
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false }));
  });
}

export function createRequestHandler(deps: ServiceDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const limiter = deps.limiter ?? createAddressLimiter(BOUNDS.requestsPerAddressPerMinute);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://courier');
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method === 'GET' && path === '/healthz') return send(res, { status: 200, body: { ok: true } });

    // The door's first two checks for every other route: https, then the caller's minute. A request that fails
    // either is answered at once, counted, and nothing else happens: no database and no chain.
    const how = transport(req);
    if (how === 'not-https' || how === 'no-header-from-elsewhere') {
      deps.counters.count('HTTPS_REQUIRED');
      return send(res, refusal(403, 'HTTPS_REQUIRED', 'This service answers only over https.'), { connection: 'close' });
    }
    const minute = limiter.take(callerAddress(req));
    if (!minute.allowed) {
      deps.counters.count('RATE_LIMIT_EXCEEDED');
      return send(res, refusal(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests from this address in the last minute.'), { 'retry-after': String(minute.retryAfterSeconds) });
    }

    if (req.method === 'GET' && path === '/readyz') return send(res, await getReady(deps));
    if (req.method === 'GET' && path === '/v1/status') return send(res, await getStatus(deps));
    if (req.method === 'GET' && path === '/v1/runs') return send(res, await getRuns(deps, url.searchParams));
    if (req.method === 'GET' && path === '/v1/book') return send(res, await getBook(deps, url.searchParams));
    if (req.method === 'POST' && path === '/v1/orders') {
      const body = await readBody(req, BOUNDS.orderBodyBytes);
      if (!body.ok) {
        deps.counters.count('BODY_TOO_LARGE');
        return send(res, refusal(413, 'BODY_TOO_LARGE', `An order's body is at most ${BOUNDS.orderBodyBytes} bytes.`), { connection: 'close' });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        deps.counters.count('INVALID_PARAM');
        return send(res, refusal(400, 'INVALID_PARAM', 'The body is not JSON.'));
      }
      const answer = await postOrders(deps, parsed);
      const retry = answer.body.retryAfterSeconds;
      return send(res, answer, typeof retry === 'number' ? { 'retry-after': String(retry) } : {});
    }
    const order = /^\/v1\/orders\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && order !== null) return send(res, await getOrder(deps, order[1] ?? ''));
    deps.counters.count('NOT_FOUND');
    return send(res, refusal(404, 'NOT_FOUND', 'Not found.'));
  }

  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      const node = describeNodeFailure(err);
      const code = failureCode(err);
      // Logged by class and code; nothing is recorded, and the answer does not say otherwise. The one failure the
      // courier records as its own fault is the door's hash mismatch, which the door writes itself.
      deps.log(`request ${req.method ?? ''} ${(req.url ?? '').split('?')[0] ?? ''} failed: ${node.kind}${code === undefined ? '' : ` (${code})`}`);
      if (!res.headersSent) send(res, refusal(500, 'INTERNAL_ERROR', 'The courier failed on this request.'));
      else res.destroy();
    });
  };
}
