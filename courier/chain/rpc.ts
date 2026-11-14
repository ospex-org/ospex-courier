import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { MULTICALL_ABI, MULTICALL_ADDRESS } from './abi';

// The courier's own JSON-RPC client: one HTTP request per call, no retry, no
// batching and a fixed time-out, so the proxy in the tests counts exactly
// what the courier did. A failure is described by its class and its code,
// never by text that can carry the node's address.

/** How a block is named in a request: by its hash, which must be canonical, or by a tag. */
export type BlockRef = { blockHash: Hex; requireCanonical: true } | 'latest' | 'finalized';

export function byHash(hash: Hex): BlockRef {
  return { blockHash: hash, requireCanonical: true };
}

export interface Header {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

export type NodeFailureKind = 'refused' | 'unreachable' | 'timeout' | 'malformed';

/** A request the node did not answer as asked. `code` is the JSON-RPC error's code where there was one. */
export class NodeFailure extends Error {
  constructor(
    readonly kind: NodeFailureKind,
    readonly method: string,
    readonly code: number | string | null,
    detail: string,
  ) {
    super(`${method}: ${kind}${code === null ? '' : ` (${code})`}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'NodeFailure';
  }
}

/** Removes anything that looks like a URL or a host from a node's text, so a log line cannot carry the provider's address. */
function withheld(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url withheld]').slice(0, 200);
}

export interface JsonRpc {
  request<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

/** A client on one URL. The time-out is per request. */
export function createJsonRpc(url: string, timeoutMs = 10_000): JsonRpc {
  let id = 0;
  return {
    async request<T>(method: string, params: unknown[]): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = (err as { name?: unknown })?.name === 'AbortError';
        throw new NodeFailure(aborted ? 'timeout' : 'unreachable', method, aborted ? null : ((err as { cause?: { code?: string } })?.cause?.code ?? null), '');
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new NodeFailure('refused', method, response.status, '');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new NodeFailure('malformed', method, null, 'the answer was not JSON');
      }
      if (typeof body !== 'object' || body === null) throw new NodeFailure('malformed', method, null, 'the answer was not an object');
      const { error, result } = body as { error?: { code?: unknown; message?: unknown }; result?: unknown };
      if (error !== undefined && error !== null) {
        const code = typeof error.code === 'number' ? error.code : null;
        const message = typeof error.message === 'string' ? withheld(error.message) : '';
        throw new NodeFailure('refused', method, code, message);
      }
      if (!('result' in (body as object))) throw new NodeFailure('malformed', method, null, 'the answer had no result');
      return result as T;
    },
  };
}

const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The header a read requires out of the node's block, each field checked for what it must be and decoded: a block
 * short of a field, or with one that is not a hex quantity or a hash, is an answer the read cannot use, which is the
 * node's `malformed` failure and not a cast.
 */
function toHeader(raw: unknown, method: string): Header {
  const block = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  const number = block?.number;
  const hash = block?.hash;
  const parentHash = block?.parentHash;
  const timestamp = block?.timestamp;
  if (typeof number !== 'string' || !QUANTITY.test(number) || typeof timestamp !== 'string' || !QUANTITY.test(timestamp) || typeof hash !== 'string' || !HASH.test(hash) || typeof parentHash !== 'string' || !HASH.test(parentHash)) {
    throw new NodeFailure('malformed', method, null, 'the block lacks a field the header needs, or one does not decode');
  }
  return { number: BigInt(number), hash: hash as Hex, parentHash: parentHash as Hex, timestamp: BigInt(timestamp) };
}

/** The header of the block a tag names. */
export async function headerByTag(rpc: JsonRpc, tag: 'latest' | 'finalized'): Promise<Header> {
  const raw = await rpc.request<unknown>('eth_getBlockByNumber', [tag, false]);
  if (raw === null) throw new NodeFailure('malformed', 'eth_getBlockByNumber', null, `no block for ${tag}`);
  return toHeader(raw, 'eth_getBlockByNumber');
}

/** The header of the block with this hash, or null where the node has none. */
export async function headerByHash(rpc: JsonRpc, hash: Hex): Promise<Header | null> {
  const raw = await rpc.request<unknown>('eth_getBlockByHash', [hash, false]);
  return raw === null ? null : toHeader(raw, 'eth_getBlockByHash');
}

/** The header of the block at this height, or null. */
export async function headerByNumber(rpc: JsonRpc, number: bigint): Promise<Header | null> {
  const raw = await rpc.request<unknown>('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]);
  return raw === null ? null : toHeader(raw, 'eth_getBlockByNumber');
}

/**
 * A decoding of what a read requires out of the node's answer, where the bytes may not be what the ABI says: an answer
 * that does not decode is the node's `malformed` failure of the read, named for what did not decode, never a cast and
 * never a fault of the courier's.
 */
export function decoded<T>(what: string, decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new NodeFailure('malformed', 'eth_call', null, `${what} did not decode`);
  }
}

export async function chainId(rpc: JsonRpc): Promise<bigint> {
  return BigInt(await rpc.request<string>('eth_chainId', []));
}

export async function codeAt(rpc: JsonRpc, address: Address, ref: BlockRef): Promise<Hex> {
  return rpc.request<Hex>('eth_getCode', [address, ref]);
}

export interface Call {
  to: Address;
  data: Hex;
  from?: Address;
}

/** One state override, as eth_call takes it: an account's balance set for this call only. */
export type StateOverride = Record<Address, { balance?: Hex; nonce?: Hex; code?: Hex; stateDiff?: Record<Hex, Hex> }>;

/** eth_call at a named block, with an optional state override. */
export async function callAt(rpc: JsonRpc, call: Call, ref: BlockRef, override?: StateOverride): Promise<Hex> {
  const tx = { to: call.to, data: call.data, ...(call.from === undefined ? {} : { from: call.from }) };
  return rpc.request<Hex>('eth_call', override === undefined ? [tx, ref] : [tx, ref, override]);
}

export async function transactionCountAt(rpc: JsonRpc, address: Address, ref: BlockRef): Promise<bigint> {
  return BigInt(await rpc.request<string>('eth_getTransactionCount', [address, ref]));
}

export async function estimateGasAt(rpc: JsonRpc, call: Call, ref: BlockRef): Promise<bigint> {
  const tx = { to: call.to, data: call.data, ...(call.from === undefined ? {} : { from: call.from }) };
  return BigInt(await rpc.request<string>('eth_estimateGas', [tx, ref]));
}

/** A contract read at a named block, encoded and decoded through its ABI. */
export async function readAt<T>(rpc: JsonRpc, abi: Abi, address: Address, functionName: string, args: readonly unknown[], ref: BlockRef): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const out = await callAt(rpc, { to: address, data }, ref);
  return decodeFunctionResult({ abi, functionName, data: out } as never) as T;
}

/** The answer to a read of state that was not computed on the block the request named. */
export class StateMismatch extends Error {
  constructor(readonly expected: Header, readonly found: { number: bigint; timestamp: bigint; parentHash: Hex }) {
    super(`the node answered for block ${found.number} (time ${found.timestamp}, parent ${found.parentHash}), not block ${expected.number} (${expected.hash})`);
    this.name = 'StateMismatch';
  }
}

export interface MulticallResult {
  success: boolean;
  returnData: Hex;
}

/**
 * The reads of state, in one call to the multicall contract at the named
 * header's hash. The same call asks the multicall contract for the block's
 * number, its time and its parent's hash, and the three are compared with the
 * header: an answer that differs in any of them is thrown away. That does not
 * prove the node ran the call on that block; it catches a node that ignored
 * the hash and answered at its head.
 */
export async function multicallAt(rpc: JsonRpc, header: Header, calls: Array<{ target: Address; callData: Hex; allowFailure?: boolean }>): Promise<MulticallResult[]> {
  const probes = [
    { target: MULTICALL_ADDRESS, allowFailure: false, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getBlockNumber' }) },
    { target: MULTICALL_ADDRESS, allowFailure: false, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getCurrentBlockTimestamp' }) },
    { target: MULTICALL_ADDRESS, allowFailure: false, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getLastBlockHash' }) },
  ];
  const data = encodeFunctionData({
    abi: MULTICALL_ABI,
    functionName: 'aggregate3',
    args: [[...probes, ...calls.map((c) => ({ target: c.target, allowFailure: c.allowFailure ?? false, callData: c.callData }))]],
  });
  const out = await callAt(rpc, { to: MULTICALL_ADDRESS, data }, byHash(header.hash));
  const results = decoded('the multicall envelope', () => decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: out }) as readonly MulticallResult[]);
  if (results.length !== probes.length + calls.length) throw new NodeFailure('malformed', 'eth_call', null, 'the multicall answered the wrong number of results');
  const [number, time, parent] = results as [MulticallResult, MulticallResult, MulticallResult];
  const found = {
    number: decoded("the block's number", () => decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getBlockNumber', data: number.returnData }) as bigint),
    timestamp: decoded("the block's time", () => decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getCurrentBlockTimestamp', data: time.returnData }) as bigint),
    parentHash: decoded("the parent's hash", () => decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getLastBlockHash', data: parent.returnData }) as Hex),
  };
  if (found.number !== header.number || found.timestamp !== header.timestamp || found.parentHash.toLowerCase() !== header.parentHash.toLowerCase()) {
    throw new StateMismatch(header, found);
  }
  return results.slice(3);
}

/** The class and code of a failure, for a record or a log: the node's text is never copied whole. */
export function describeNodeFailure(err: unknown): { kind: string; code: number | string | null; method: string | null } {
  if (err instanceof NodeFailure) return { kind: err.kind, code: err.code, method: err.method };
  if (err instanceof StateMismatch) return { kind: 'state-mismatch', code: null, method: 'eth_call' };
  const name = err instanceof Error ? err.name : typeof err;
  return { kind: name, code: null, method: null };
}
