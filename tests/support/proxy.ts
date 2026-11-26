import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { keccak256 } from 'viem';

// A small proxy between the courier and the chain, which the tests control.
// It counts requests and their bytes, by method, as they ARRIVE, so a request
// the node rejects or one still being answered is in the count; it can refuse
// one, drop one with no answer, answer one itself, hold one, pass one on and
// hold the chain's answer, keep a raw transaction from the chain while it
// answers it taken, or pass it on. It answers the `finalized` tag itself, so
// the test decides which block is final. Everything the courier asks of the
// chain goes through it, and nothing else does: the tests speak to the chain on
// the rig's own address. It outlives a courier's restart, so its counts are
// across the lives of the process.

export interface Counted {
  method: string;
  requestBytes: number;
  /** The answer's bytes once answered; 0 while the request is still being answered. */
  answerBytes: number;
  /** How the proxy dealt with it: `arrived` until it has been answered. */
  how: 'arrived' | 'passed' | 'refused' | 'answered' | 'held' | 'dropped' | 'withheld' | 'passedThenRefused';
  /** A raw transaction's own bytes, as the request carried them, so that one transaction's requests are counted by its bytes. */
  sent?: string;
  /** Any other request's params, as it carried them: the block a count or a block's read names, among them. */
  params?: unknown[];
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
  /** Refuse the requests of the method whose params `refuse` picks, with this error and no data; pass the others on. */
  | { kind: 'refuseIf'; refuse: (params: unknown[]) => boolean; code: number; message: string }
  | { kind: 'answer'; result: (params: unknown[]) => unknown }
  | { kind: 'rewrite'; params: (params: unknown[]) => unknown[] }
  /** Pass the request on, and answer with the node's result changed: the chain made to say something else. */
  | { kind: 'rewriteResult'; result: (params: unknown[], result: unknown) => unknown }
  /**
   * Hold every request of the method until released, or only the ones `when` picks by their params, the others
   * passing as if no rule stood; `arrived` is told of the first one held. Released, a held request is answered
   * under the rule then in force.
   */
  | { kind: 'hold'; released: Promise<void>; arrived: () => void; when?: (params: unknown[]) => boolean }
  /** Answer nothing: the connection is closed with no answer, as a node that dropped the request. */
  | { kind: 'drop' }
  /** The next request only: its connection closed before the request reaches the node, with no answer; the rule goes as it arrives. */
  | { kind: 'dropOnce' }
  /**
   * Pass the request on at once, and hold the chain's answer until released: the node has the request, and the
   * courier does not hear what it said. Released with `drop`, the connection is closed with no answer.
   */
  | { kind: 'passHold'; passed: () => void; released: Promise<{ drop: boolean }> }
  /**
   * A raw transaction answered taken by the proxy itself, with its hash, and kept from the chain: the courier is told
   * the node took it while the chain never sees it, until the test hands it on.
   */
  | { kind: 'withhold'; kept: (raw: string) => void }
  /**
   * Pass the request on to the chain, and answer it with this error in place of the chain's answer, where `when` picks
   * it by its params (every request of the method without it): the node has the request, and the client hears a named
   * error. `forwarded` is told the chain's own answer to each, in the order they came.
   */
  | { kind: 'passThenError'; code: number; message: string; when?: (params: unknown[]) => boolean; forwarded: (answer: string) => void };

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
   * The `finalized` tag answered as the block this many below the latest, read from the node on each request: a chain
   * whose final block follows its head, as Polygon's does. Null: lift it. `setFinal` with a number wins over it.
   */
  finalFollows(lag: bigint | null): void;
  /**
   * Hold every request of the method until `release` is called; `arrived` resolves when the first such request has
   * arrived. `release(then)` lets the held requests go on under `then` (a rule left in force for the method), or under
   * no rule: passed on to the node. With `when`, only the requests it picks by their params are held, and `arrived`
   * is the arrival of the first of those: every other request of the method passes on as if no rule stood. A held
   * request is let go by `release` and by nothing else: lifting the rules (`clear`) holds no later request and
   * lets none go that is held already.
   */
  hold(method: string, when?: (params: unknown[]) => boolean): { arrived: Promise<void>; release(then?: Rule | null): void };
  /** Every request of the method, from now until the rule is lifted, is dropped: its connection closed with no answer. */
  drop(method: string): void;
  /**
   * The next request of the method is refused its connection: closed before the request reaches the node, with no
   * answer. The rule is lifted as that request arrives, so a later one passes as usual.
   */
  dropNext(method: string): void;
  /**
   * The next request of the method is passed on to the chain at once and its answer held: `passed` resolves once the
   * chain has the request; `release()` answers with what the chain said, `release({ drop: true })` closes the
   * connection with no answer. The rule is lifted as the first such request arrives, so a later one passes as usual.
   */
  passAndHold(method: string): { passed: Promise<void>; release(how?: { drop?: boolean }): void };
  /**
   * Every raw transaction from now on is answered taken, with its own hash, by the proxy itself, and kept from the
   * chain. `kept` holds them in the order they came; `forward` hands them to the chain, in that order, and returns
   * the chain's answers; `stop` lifts the rule, so later ones pass as usual.
   */
  withhold(): { kept: string[]; arrived: Promise<void>; forward(): Promise<unknown[]>; stop(): void };
  /**
   * The requests of the method that `when` picks by their params (every one without it) are passed on to the chain,
   * and each is answered with this error in place of the chain's answer: the node has the request, and the client
   * hears a named error. `forwarded` holds the chain's own answers, in the order they came; `stop` lifts the rule.
   */
  passThenError(method: string, error: { code: number; message: string }, when?: (params: unknown[]) => boolean): { forwarded: unknown[]; stop(): void };
  close(): Promise<void>;
}

export async function startProxy(upstreamUrl: string): Promise<ChainProxy> {
  const rules = new Map<string, Rule>();
  const counted: Counted[] = [];
  let finalNumber: bigint | null = null;
  let finalLag: bigint | null = null;

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

  /**
   * A request passed on to the node. The finalized tag is answered here, under any rule as without one: by the block
   * the test named, or by the head less the lag, each read from the node by number. Every other request goes as it is.
   */
  async function passOn(req: JsonRpcRequest, params: unknown[], raw: string | null): Promise<{ text: string; standIn: boolean }> {
    if (req.method === 'eth_getBlockByNumber' && params[0] === 'finalized' && finalNumber !== null) {
      const text = await upstream(JSON.stringify({ jsonrpc: '2.0', id: req.id, method: 'eth_getBlockByNumber', params: [`0x${finalNumber.toString(16)}`, params[1] ?? false] }));
      return { text, standIn: true };
    }
    if (req.method === 'eth_getBlockByNumber' && params[0] === 'finalized' && finalLag !== null) {
      const head = JSON.parse(await upstream(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }))) as { result: string };
      const latest = BigInt(head.result);
      const at = latest > finalLag ? latest - finalLag : 0n;
      const text = await upstream(JSON.stringify({ jsonrpc: '2.0', id: req.id, method: 'eth_getBlockByNumber', params: [`0x${at.toString(16)}`, params[1] ?? false] }));
      return { text, standIn: true };
    }
    return { text: await upstream(raw ?? JSON.stringify({ ...req, params })), standIn: false };
  }

  async function answerOne(req: JsonRpcRequest, raw: string): Promise<{ text: string | null; how: Counted['how'] }> {
    const params = req.params ?? [];
    const rule = rules.get(req.method);
    if (rule?.kind === 'drop') return { text: null, how: 'dropped' };
    if (rule?.kind === 'dropOnce') {
      // One request only, never passed on: the rule goes as it arrives, so the next of the method passes as usual.
      rules.delete(req.method);
      return { text: null, how: 'dropped' };
    }
    if (rule?.kind === 'passHold') {
      // One request only: the rule goes as this one arrives, so the next of the method passes as usual. `passed` once
      // the chain has answered it: the chain has the request; its answer waits here.
      rules.delete(req.method);
      const text = await upstream(raw);
      rule.passed();
      const { drop } = await rule.released;
      return drop ? { text: null, how: 'dropped' } : { text, how: 'held' };
    }
    if (rule?.kind === 'withhold') {
      const rawTx = typeof params[0] === 'string' ? params[0] : '';
      rule.kept(rawTx);
      return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: keccak256(rawTx as `0x${string}`) }), how: 'withheld' };
    }
    if (rule?.kind === 'refuse') {
      return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: rule.code, message: rule.message } }), how: 'refused' };
    }
    if (rule?.kind === 'passThenError' && (rule.when === undefined || rule.when(params))) {
      // The chain has the request first, and answers it; then the client hears the error in place of that answer.
      const text = await upstream(raw);
      rule.forwarded(text);
      return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: rule.code, message: rule.message } }), how: 'passedThenRefused' };
    }
    if (rule?.kind === 'refuseWhen') {
      // This request is already counted as arrived, so the nth is the count since the rule less the ones before it.
      const nth = counted.filter((c) => c.method === req.method).length - (arrivedAtRule.get(req.method) ?? 0);
      if (rule.refuse(nth)) return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: rule.code, message: rule.message } }), how: 'refused' };
      return { text: (await passOn(req, params, raw)).text, how: 'passed' };
    }
    if (rule?.kind === 'refuseIf') {
      if (rule.refuse(params)) return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: rule.code, message: rule.message } }), how: 'refused' };
      return { text: (await passOn(req, params, raw)).text, how: 'passed' };
    }
    if (rule?.kind === 'answer') {
      return { text: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: rule.result(params) }), how: 'answered' };
    }
    if (rule?.kind === 'rewrite') {
      const text = (await passOn(req, rule.params(params), null)).text;
      return { text, how: 'passed' };
    }
    if (rule?.kind === 'rewriteResult') {
      const text = (await passOn(req, params, raw)).text;
      const answer = JSON.parse(text) as Record<string, unknown>;
      if (!('result' in answer)) return { text, how: 'passed' };
      return { text: JSON.stringify({ ...answer, result: rule.result(params, answer.result) }), how: 'answered' };
    }
    if (rule?.kind === 'hold' && (rule.when === undefined || rule.when(params))) {
      rule.arrived();
      await rule.released;
      // Answered under the rule in force now: the one the release installed, or none.
      const again = await answerOne(req, raw);
      return { text: again.text, how: again.text === null ? 'dropped' : 'held' };
    }
    // The finalized tag, answered here: the block the test named, or the head less the lag, read from the node by number.
    const passed = await passOn(req, params, raw);
    return { text: passed.text, how: passed.standIn ? 'answered' : 'passed' };
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
      const arrived: Counted[] = list.map((r) => ({
        method: r.method,
        requestBytes: Buffer.byteLength(raw),
        answerBytes: 0,
        how: 'arrived' as const,
        ...(r.method === 'eth_sendRawTransaction' && typeof r.params?.[0] === 'string' ? { sent: r.params[0] } : {}),
        ...(r.method !== 'eth_sendRawTransaction' && Array.isArray(r.params) ? { params: r.params } : {}),
      }));
      counted.push(...arrived);
      Promise.all(list.map((r) => answerOne(r, JSON.stringify(r)))).then(
        (answers) => {
          if (answers.some((a) => a.text === null)) {
            // Dropped: the connection is closed with no answer at all.
            arrived.forEach((entry, i) => {
              entry.how = answers[i]?.how ?? 'dropped';
            });
            res.socket?.destroy();
            return;
          }
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
    finalFollows(lag) {
      finalLag = lag;
    },
    hold(method, when) {
      let release = () => undefined as void;
      let arrivedResolve = () => undefined as void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const arrived = new Promise<void>((resolve) => (arrivedResolve = resolve));
      rules.set(method, { kind: 'hold', released, arrived: () => arrivedResolve(), ...(when === undefined ? {} : { when }) });
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
    drop(method) {
      rules.set(method, { kind: 'drop' });
      arrivedAtRule.set(method, count(method));
    },
    dropNext(method) {
      rules.set(method, { kind: 'dropOnce' });
      arrivedAtRule.set(method, count(method));
    },
    passAndHold(method) {
      let passedResolve = () => undefined as void;
      let releaseResolve = (_: { drop: boolean }) => undefined as void;
      const passed = new Promise<void>((resolve) => (passedResolve = resolve));
      const released = new Promise<{ drop: boolean }>((resolve) => (releaseResolve = resolve));
      rules.set(method, { kind: 'passHold', passed: () => passedResolve(), released });
      return { passed, release: (how = {}) => releaseResolve({ drop: how.drop === true }) };
    },
    passThenError(method, error, when) {
      const forwarded: unknown[] = [];
      rules.set(method, { kind: 'passThenError', code: error.code, message: error.message, ...(when === undefined ? {} : { when }), forwarded: (answer) => forwarded.push(JSON.parse(answer) as unknown) });
      return {
        forwarded,
        stop: () => {
          if (rules.get(method)?.kind === 'passThenError') rules.delete(method);
        },
      };
    },
    withhold() {
      const kept: string[] = [];
      let arrivedResolve = () => undefined as void;
      const arrived = new Promise<void>((resolve) => (arrivedResolve = resolve));
      rules.set('eth_sendRawTransaction', {
        kind: 'withhold',
        kept: (raw) => {
          kept.push(raw);
          arrivedResolve();
        },
      });
      return {
        kept,
        arrived,
        async forward() {
          const answers: unknown[] = [];
          for (const raw of kept) {
            const text = await upstream(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }));
            answers.push(JSON.parse(text) as unknown);
          }
          return answers;
        },
        stop() {
          if (rules.get('eth_sendRawTransaction')?.kind === 'withhold') rules.delete('eth_sendRawTransaction');
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
