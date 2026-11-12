import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';

// A small proxy between the courier and the chain, which the tests control.
// It counts requests and their bytes, by method; it can refuse one, answer
// one itself, hold one, or pass it on. It answers the `finalized` tag itself,
// so the test decides which block is final.

export interface Counted {
  method: string;
  requestBytes: number;
  answerBytes: number;
  /** How the proxy dealt with it. */
  how: 'passed' | 'refused' | 'answered' | 'held';
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: unknown[];
}

export type Rule =
  | { kind: 'refuse'; code: number; message: string }
  | { kind: 'answer'; result: (params: unknown[]) => unknown }
  | { kind: 'rewrite'; params: (params: unknown[]) => unknown[] }
  /** Pass the request on, and answer with the node's result changed: the chain made to say something else. */
  | { kind: 'rewriteResult'; result: (params: unknown[], result: unknown) => unknown }
  | { kind: 'hold'; released: Promise<void> };

export interface ChainProxy {
  url: string;
  counted: Counted[];
  count(method?: string): number;
  /** Apply a rule to every request of the method until the rule is lifted. */
  rule(method: string, rule: Rule | null): void;
  /** Lift every rule. */
  clear(): void;
  /** The block the proxy answers for the `finalized` tag: by number, read from the node on each request. Null: pass the tag on. */
  setFinal(number: bigint | null): void;
  /** Hold every request of the method until `release` is called; resolves when the first such request has arrived. */
  hold(method: string): { arrived: Promise<void>; release(): void };
  close(): Promise<void>;
}

export async function startProxy(upstreamUrl: string): Promise<ChainProxy> {
  const rules = new Map<string, Rule>();
  const counted: Counted[] = [];
  let finalNumber: bigint | null = null;

  async function upstream(body: string): Promise<string> {
    const target = new URL(upstreamUrl);
    return new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  async function answerOne(req: JsonRpcRequest, raw: string): Promise<{ text: string; how: Counted['how'] }> {
    const params = req.params ?? [];
    const rule = rules.get(req.method);
    if (rule?.kind === 'refuse') {
      return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: rule.code, message: rule.message } }), how: 'refused' };
    }
    if (rule?.kind === 'answer') {
      return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: rule.result(params) }), how: 'answered' };
    }
    if (rule?.kind === 'rewrite') {
      const text = await upstream(JSON.stringify({ ...req, params: rule.params(params) }));
      return { text, how: 'passed' };
    }
    if (rule?.kind === 'rewriteResult') {
      const text = await upstream(raw);
      const answer = JSON.parse(text) as Record<string, unknown>;
      if (!('result' in answer)) return { text, how: 'passed' };
      return { text: JSON.stringify({ ...answer, result: rule.result(params, answer.result) }), how: 'answered' };
    }
    if (rule?.kind === 'hold') {
      await rule.released;
      const text = await upstream(raw);
      return { text, how: 'held' };
    }
    // The finalized tag, answered here: the block the test named, read from the node by number.
    if (req.method === 'eth_getBlockByNumber' && params[0] === 'finalized' && finalNumber !== null) {
      const text = await upstream(JSON.stringify({ jsonrpc: '2.0', id: req.id, method: 'eth_getBlockByNumber', params: [`0x${finalNumber.toString(16)}`, params[1] ?? false] }));
      return { text, how: 'answered' };
    }
    return { text: await upstream(raw), how: 'passed' };
  }

  const server: Server = createServer((incoming, res) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (c: Buffer) => chunks.push(c));
    incoming.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: JsonRpcRequest | JsonRpcRequest[];
      try {
        parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
      } catch {
        res.writeHead(400);
        return res.end();
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      Promise.all(list.map((r) => answerOne(r, JSON.stringify(r)))).then(
        (answers) => {
          const text = Array.isArray(parsed) ? `[${answers.map((a) => a.text).join(',')}]` : (answers[0]?.text ?? '');
          list.forEach((r, i) => counted.push({ method: r.method, requestBytes: Buffer.byteLength(raw), answerBytes: Buffer.byteLength(text), how: answers[i]?.how ?? 'passed' }));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(text);
        },
        () => {
          res.writeHead(502);
          res.end();
        },
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    counted,
    count(method) {
      return method === undefined ? counted.length : counted.filter((c) => c.method === method).length;
    },
    rule(method, rule) {
      if (rule === null) rules.delete(method);
      else rules.set(method, rule);
    },
    clear() {
      rules.clear();
    },
    setFinal(number) {
      finalNumber = number;
    },
    hold(method) {
      let release = () => undefined as void;
      let arrivedResolve = () => undefined as void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const arrived = new Promise<void>((resolve) => (arrivedResolve = resolve));
      rules.set(method, {
        kind: 'hold',
        released: released.then(() => undefined),
      });
      // Mark the arrival of the first held request.
      const original = rules.get(method) as Rule;
      rules.set(method, {
        kind: 'hold',
        released: (async () => {
          arrivedResolve();
          await (original as { released: Promise<void> }).released;
        })(),
      });
      return {
        arrived,
        release: () => {
          rules.delete(method);
          release();
        },
      };
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
