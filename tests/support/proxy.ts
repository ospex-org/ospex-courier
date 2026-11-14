import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';

// A small proxy between the courier and the chain, which the tests control.
// It counts requests and their bytes, by method, as they ARRIVE, so a request
// the node rejects or one still being answered is in the count; it can refuse
// one, answer one itself, hold one, or pass it on. It answers the `finalized`
// tag itself, so the test decides which block is final. Everything the courier
// asks of the chain goes through it, and nothing else does: the tests speak to
// the chain on the rig's own address.

export interface Counted {
  method: string;
  requestBytes: number;
  /** The answer's bytes once answered; 0 while the request is still being answered. */
  answerBytes: number;
  /** How the proxy dealt with it: `arrived` until it has been answered. */
  how: 'arrived' | 'passed' | 'refused' | 'answered' | 'held';
}

/** The courier's sends, which this build must never make: counted at the proxy as they arrive. */
export interface Sends {
  eth_sendRawTransaction: number;
  eth_sendTransaction: number;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: unknown[];
}

export type Rule =
  | { kind: 'refuse'; code: number; message: string }
  /** Refuse the nth request of the method to arrive since the rule was set (1 the first), where `refuse(nth)` says so; pass the others on. */
  | { kind: 'refuseWhen'; refuse: (nth: number) => boolean; code: number; message: string }
  | { kind: 'answer'; result: (params: unknown[]) => unknown }
  | { kind: 'rewrite'; params: (params: unknown[]) => unknown[] }
  /** Pass the request on, and answer with the node's result changed: the chain made to say something else. */
  | { kind: 'rewriteResult'; result: (params: unknown[], result: unknown) => unknown }
  /** Hold every request of the method until released; `arrived` is told of the first one. Released, a held request is answered under the rule then in force. */
  | { kind: 'hold'; released: Promise<void>; arrived: () => void };

export interface ChainProxy {
  url: string;
  counted: Counted[];
  /** Requests of the method that have arrived (every method when none is named), answered or not. */
  count(method?: string): number;
  /** The two sends, as they have arrived. */
  sends(): Sends;
  /** Apply a rule to every request of the method until the rule is lifted. */
  rule(method: string, rule: Rule | null): void;
  /** Lift every rule. */
  clear(): void;
  /** The block the proxy answers for the `finalized` tag: by number, read from the node on each request. Null: pass the tag on. */
  setFinal(number: bigint | null): void;
  /**
   * Hold every request of the method until `release` is called; `arrived` resolves when the first such request has
   * arrived. `release(then)` lets the held requests go on under `then` (a rule left in force for the method), or under
   * no rule: passed on to the node.
   */
  hold(method: string): { arrived: Promise<void>; release(then?: Rule | null): void };
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

  /** How many requests of each method had arrived when its current rule was set: the nth under the rule counts from there. */
  const arrivedAtRule = new Map<string, number>();

  async function answerOne(req: JsonRpcRequest, raw: string): Promise<{ text: string; how: Counted['how'] }> {
    const params = req.params ?? [];
    const rule = rules.get(req.method);
    if (rule?.kind === 'refuse') {
      return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: rule.code, message: rule.message } }), how: 'refused' };
    }
    if (rule?.kind === 'refuseWhen') {
      // This request is already counted as arrived, so the nth is the count since the rule less the ones before it.
      const nth = counted.filter((c) => c.method === req.method).length - (arrivedAtRule.get(req.method) ?? 0);
      if (rule.refuse(nth)) return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: rule.code, message: rule.message } }), how: 'refused' };
      return { text: await upstream(raw), how: 'passed' };
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
      rule.arrived();
      await rule.released;
      // Answered under the rule in force now: the one the release installed, or none.
      const again = await answerOne(req, raw);
      return { text: again.text, how: 'held' };
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
      // Counted now, as they arrive: what the courier asked is on record before the node has said anything.
      const arrived: Counted[] = list.map((r) => ({ method: r.method, requestBytes: Buffer.byteLength(raw), answerBytes: 0, how: 'arrived' as const }));
      counted.push(...arrived);
      Promise.all(list.map((r) => answerOne(r, JSON.stringify(r)))).then(
        (answers) => {
          const text = Array.isArray(parsed) ? `[${answers.map((a) => a.text).join(',')}]` : (answers[0]?.text ?? '');
          arrived.forEach((entry, i) => {
            entry.answerBytes = Buffer.byteLength(text);
            entry.how = answers[i]?.how ?? 'passed';
          });
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

  const count = (method?: string) => (method === undefined ? counted.length : counted.filter((c) => c.method === method).length);

  return {
    url: `http://127.0.0.1:${port}`,
    counted,
    count,
    sends() {
      return { eth_sendRawTransaction: count('eth_sendRawTransaction'), eth_sendTransaction: count('eth_sendTransaction') };
    },
    rule(method, rule) {
      if (rule === null) rules.delete(method);
      else {
        rules.set(method, rule);
        arrivedAtRule.set(method, count(method));
      }
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
      rules.set(method, { kind: 'hold', released, arrived: () => arrivedResolve() });
      return {
        arrived,
        release: (then = null) => {
          if (then === null) rules.delete(method);
          else {
            rules.set(method, then);
            arrivedAtRule.set(method, count(method));
          }
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
