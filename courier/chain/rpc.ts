import { decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Address, type Hex } from 'viem';
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
  /**
   * The block's gas limit, which every block a node serves carries and which a header read from the node always
   * holds (a block without it is an answer the read cannot use). Optional only so a header written by hand, with no
   * node behind it, need not invent one; the bet's check refuses to go on from a header without it.
   */
  gasLimit?: bigint;
  /**
   * The block's base fee, where the node's block carries one: the fee the sender's cap is set from. Absent from a
   * header written by hand, and from a block of a chain before its base fee; the node check requires it of the latest
   * block, and the sender reads it as the chain's own rule for a read, so a block without it is not sent on.
   */
  baseFee?: bigint;
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

/**
 * The node ran the call and the EVM refused it: the JSON-RPC error of a reverted execution (code 3), with the
 * revert's bytes, checked to be whole bytes of hex and kept apart from the node's text. `data` is `0x` for a revert
 * that gave no reason. It is a NodeFailure of the `refused` kind, so every read that is not the bet's check treats it
 * as it treated any refusal before; the bet's check alone reads it as the contract's verdict on the call.
 */
export class ExecutionReverted extends NodeFailure {
  constructor(
    method: string,
    readonly data: Hex,
    detail: string,
  ) {
    super('refused', method, 3, detail);
    this.name = 'ExecutionReverted';
  }
}

/**
 * The node's answer that the call ran out of the gas it was allowed, with no revert data: the out-of-gas error an
 * estimate gives at the node's own cap. A NodeFailure of the `refused` kind for every other reader, as above.
 */
export class OutOfGas extends NodeFailure {
  constructor(method: string, code: number | null, detail: string) {
    super('refused', method, code, detail);
    this.name = 'OutOfGas';
  }
}

/** The node's words for a call that ran out of gas: geth's and Bor's "gas required exceeds allowance", anvil's "Out of gas". */
const OUT_OF_GAS = /gas required exceeds allowance|out of gas/i;
/** Revert data: whole bytes of hex. */
const REVERT_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Removes anything that looks like a URL or a host from a node's text, so a log line cannot carry the provider's address. */
function withheld(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url withheld]').slice(0, 200);
}

export interface JsonRpc {
  /** One request. */
  request<T = unknown>(method: string, params: unknown[]): Promise<T>;
  /**
   * The one hand-off of a signed transaction (see `handOff`): one eth_sendRawTransaction, made once to this node, with
   * no retry and no redirect followed, its time-out running through the answer's body. What the node answered is read
   * inside the client, against this request's own id and the transaction's own hash, and nothing of its text leaves.
   */
  handOff(raw: Hex): Promise<HandOff>;
}

/**
 * A client on one URL. The time-out is per request, and it runs through the whole request: the headers, the body
 * and its decoding. It is cleared only when the request has its answer or has failed, so a node that sends its
 * headers and then holds the body is a failure of the request at the time-out, as one that sends nothing is.
 */
export function createJsonRpc(url: string, timeoutMs = 10_000): JsonRpc {
  let id = 0;
  return {
    async request<T>(method: string, params: unknown[]): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const aborted = (err: unknown) => controller.signal.aborted || (err as { name?: unknown })?.name === 'AbortError';
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
            signal: controller.signal,
          });
        } catch (err) {
          throw new NodeFailure(aborted(err) ? 'timeout' : 'unreachable', method, aborted(err) ? null : ((err as { cause?: { code?: string } })?.cause?.code ?? null), '');
        }
        if (!response.ok) {
          // The body is not read; the request is done with.
          controller.abort();
          throw new NodeFailure('refused', method, response.status, '');
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (err) {
          if (aborted(err)) throw new NodeFailure('timeout', method, null, 'the answer\'s body did not arrive whole in time');
          throw new NodeFailure('malformed', method, null, 'the answer was not JSON');
        }
        if (typeof body !== 'object' || body === null) throw new NodeFailure('malformed', method, null, 'the answer was not an object');
        const { error, result } = body as { error?: { code?: unknown; message?: unknown; data?: unknown }; result?: unknown };
        if (error !== undefined && error !== null) {
          const code = typeof error.code === 'number' ? error.code : null;
          const message = typeof error.message === 'string' ? withheld(error.message) : '';
          // The EVM's refusal of the call: code 3, with its revert data as whole bytes of hex, kept apart from the text.
          if (code === 3 && typeof error.data === 'string' && REVERT_DATA.test(error.data)) {
            throw new ExecutionReverted(method, error.data.toLowerCase() as Hex, message);
          }
          // The call ran out of the gas it was allowed, and no revert data came back.
          if ((error.data === undefined || error.data === null) && typeof error.message === 'string' && OUT_OF_GAS.test(error.message)) {
            throw new OutOfGas(method, code, message);
          }
          throw new NodeFailure('refused', method, code, message);
        }
        if (!('result' in (body as object))) throw new NodeFailure('malformed', method, null, 'the answer had no result');
        return result as T;
      } finally {
        clearTimeout(timer);
      }
    },
    async handOff(raw) {
      const expected = keccak256(raw).toLowerCase();
      const requestId = ++id;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'eth_sendRawTransaction', params: [raw] }),
            signal: controller.signal,
            // A redirect is not followed: the one request goes to this node and to no other.
            redirect: 'manual',
          });
        } catch {
          return { kind: 'unknown' };
        }
        if (response.status !== 200) {
          // A redirect, or any other HTTP answer: the body is not read, and the request is done with.
          controller.abort();
          return { kind: 'unknown' };
        }
        let text: string;
        try {
          text = await response.text();
        } catch {
          return { kind: 'unknown' };
        }
        return readHandOff(text, requestId, expected);
      } finally {
        clearTimeout(timer);
      }
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
  const gasLimit = block?.gasLimit;
  const baseFee = block?.baseFeePerGas;
  if (
    typeof number !== 'string' || !QUANTITY.test(number) || typeof timestamp !== 'string' || !QUANTITY.test(timestamp) || typeof hash !== 'string' || !HASH.test(hash) ||
    typeof parentHash !== 'string' || !HASH.test(parentHash) || typeof gasLimit !== 'string' || !QUANTITY.test(gasLimit) ||
    (baseFee !== undefined && baseFee !== null && (typeof baseFee !== 'string' || !QUANTITY.test(baseFee)))
  ) {
    throw new NodeFailure('malformed', method, null, 'the block lacks a field the header needs, or one does not decode');
  }
  return {
    number: BigInt(number),
    hash: hash as Hex,
    parentHash: parentHash as Hex,
    timestamp: BigInt(timestamp),
    gasLimit: BigInt(gasLimit),
    ...(typeof baseFee === 'string' ? { baseFee: BigInt(baseFee) } : {}),
  };
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

/**
 * A call, as eth_call and eth_estimateGas take it. The fields a transaction signs that a call can carry: the sender,
 * the target, the calldata, the value and the gas limit. `gas` is the exact limit a transaction would be signed with,
 * so a call made at that limit runs as the transaction would; absent, the node chooses. The nonce and the fees are
 * not a call's to carry: the nonce is read at the block, and the fees are the sender's.
 */
export interface Call {
  to: Address;
  data: Hex;
  from?: Address;
  value?: bigint;
  gas?: bigint;
}

/** One state override, as eth_call takes it: an account's balance, its nonce, its code, or slots of its storage, set for this call only. */
export type StateOverride = Record<Address, { balance?: Hex; nonce?: Hex; code?: Hex; stateDiff?: Record<Hex, Hex> }>;

const quantity = (n: bigint): Hex => `0x${n.toString(16)}`;

/** The call as the node takes it: every field the call carries, the numbers as hex quantities. */
function callObject(call: Call): Record<string, string> {
  return {
    ...(call.from === undefined ? {} : { from: call.from }),
    to: call.to,
    data: call.data,
    ...(call.value === undefined ? {} : { value: quantity(call.value) }),
    ...(call.gas === undefined ? {} : { gas: quantity(call.gas) }),
  };
}

/** eth_call at a named block, with an optional state override. */
export async function callAt(rpc: JsonRpc, call: Call, ref: BlockRef, override?: StateOverride): Promise<Hex> {
  const tx = callObject(call);
  return rpc.request<Hex>('eth_call', override === undefined ? [tx, ref] : [tx, ref, override]);
}

export async function transactionCountAt(rpc: JsonRpc, address: Address, ref: BlockRef): Promise<bigint> {
  return BigInt(await rpc.request<string>('eth_getTransactionCount', [address, ref]));
}

/** eth_estimateGas of the call, at a named block: by its hash, as every request for a value is made. */
export async function estimateGasAt(rpc: JsonRpc, call: Call, ref: BlockRef): Promise<bigint> {
  const answer = await rpc.request<unknown>('eth_estimateGas', [callObject(call), ref]);
  if (typeof answer !== 'string' || !QUANTITY.test(answer)) throw new NodeFailure('malformed', 'eth_estimateGas', null, 'the estimate is not a hex quantity');
  return BigInt(answer);
}

/** One storage slot of an account, at a named block. */
export async function storageAt(rpc: JsonRpc, address: Address, slot: bigint, ref: BlockRef): Promise<Hex> {
  const answer = await rpc.request<unknown>('eth_getStorageAt', [address, quantity(slot), ref]);
  if (typeof answer !== 'string' || !HASH.test(answer)) throw new NodeFailure('malformed', 'eth_getStorageAt', null, 'the slot is not one word of hex');
  return answer.toLowerCase() as Hex;
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
export async function multicallAt(rpc: JsonRpc, header: Header, calls: Array<{ target: Address; callData: Hex; allowFailure?: boolean }>, override?: StateOverride): Promise<MulticallResult[]> {
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
  const out = await callAt(rpc, { to: MULTICALL_ADDRESS, data }, byHash(header.hash), override);
  const results = decoded('the multicall envelope', () => decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: out }) as readonly MulticallResult[]);
  if (results.length !== probes.length + calls.length) throw new NodeFailure('malformed', 'eth_call', null, 'the multicall answered the wrong number of results');
  // A result marked failed where the call allowed no failure is an answer the read cannot use, whatever its bytes
  // decode to: a conforming multicall reverts the whole call on such a failure, so a flag like this is the node's
  // answer and not the contract's. The three probes allow none; an inner call allows it only where the read said so
  // (the games set's negatives), and those keep their flag for the read to judge. Checked here, before any result
  // leaves this function, so no decoder of a required value is reached past it.
  for (let i = 0; i < results.length; i++) {
    const allowed = i < probes.length ? false : (calls[i - probes.length]?.allowFailure ?? false);
    if (!allowed && (results[i] as MulticallResult).success !== true) {
      throw new NodeFailure('malformed', 'eth_call', null, i < probes.length ? 'a block probe answered failed' : 'a required call answered failed');
    }
  }
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

// ──────────────────────────── the sender's requests ────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** eth_maxPriorityFeePerGas: the tip the node suggests. Not a value at a block: the node's suggestion now. */
export async function maxPriorityFee(rpc: JsonRpc): Promise<bigint> {
  const answer = await rpc.request<unknown>('eth_maxPriorityFeePerGas', []);
  if (typeof answer !== 'string' || !QUANTITY.test(answer)) throw new NodeFailure('malformed', 'eth_maxPriorityFeePerGas', null, 'the tip is not a hex quantity');
  return BigInt(answer);
}

/**
 * The node's named errors to a transaction it will not take: the texts Bor's pool and RPC give (Bor v2.10.2), found in
 * any letter case anywhere in the node's text, tried in this order, and the fixed words the courier keeps for each. A
 * longer text comes before one it contains. The words are kept for diagnosis only: a named error after the hand-off
 * does not show that no node took the transaction, and it decides nothing.
 */
const NAMED = [
  ['replacement transaction underpriced', 'replacement transaction underpriced'],
  ['transaction underpriced', 'transaction underpriced'],
  ['transaction gas price below minimum', 'transaction gas price below minimum'],
  ['nonce too low', 'nonce too low'],
  ['nonce too high', 'nonce too high'],
  ['insufficient funds for gas * price + value', 'insufficient funds for gas * price + value'],
  ['exceeds block gas limit', 'exceeds block gas limit'],
  ['transaction gas limit too high', 'transaction gas limit too high'],
  ['intrinsic gas too low', 'intrinsic gas too low'],
  ['max priority fee per gas higher than max fee per gas', 'max priority fee per gas higher than max fee per gas'],
  ['max fee per gas less than block base fee', 'max fee per gas less than block base fee'],
  ['exceeds the configured cap', "the transaction's fee exceeds the node's configured cap"],
  ['txpool is full', 'txpool is full'],
  ['future transaction tries to replace pending', 'future transaction tries to replace pending'],
  ['account limit exceeded', 'account limit exceeded'],
  ['in-flight transaction limit reached for delegated accounts', 'in-flight transaction limit reached for delegated accounts'],
  ['address already reserved', 'address already reserved'],
  ['invalid sender', 'invalid sender'],
  ['oversized data', 'oversized data'],
] as const;

export type NamedError = (typeof NAMED)[number][1];

/** Every named error's words, in the order they are tried. */
export const NAMED_ERRORS: readonly NamedError[] = NAMED.map(([, words]) => words);

/**
 * The node's answer to the one hand-off: taken, bound to this request; or not known, with the list's fixed words where
 * the node's error named one. A named error is not known too: the words say which error the node gave, and nothing
 * more.
 */
export type HandOff = { kind: 'taken' } | { kind: 'unknown'; words?: NamedError };

/**
 * The node's answer to this request, read inside the client: this request's own answer only, JSON-RPC 2.0 with its id,
 * and a result or an error, never both. Taken where the result is this transaction's own hash, or where the error's
 * whole message, in any letter case and with the space around it, is "already known". Every other answer is not known,
 * with the list's fixed words where the error names one. Only those words come out.
 */
function readHandOff(text: string, requestId: number, expected: string): HandOff {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'unknown' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'unknown' };
  const envelope = body as Record<string, unknown>;
  if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId) return { kind: 'unknown' };
  const hasResult = 'result' in envelope;
  const hasError = envelope.error !== undefined && envelope.error !== null;
  if (hasResult === hasError) return { kind: 'unknown' };
  if (hasResult) return typeof envelope.result === 'string' && envelope.result.toLowerCase() === expected ? { kind: 'taken' } : { kind: 'unknown' };
  const error = envelope.error;
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '';
  if (message.trim().toLowerCase() === 'already known') return { kind: 'taken' };
  const lower = message.toLowerCase();
  const found = NAMED.find(([match]) => lower.includes(match));
  return found === undefined ? { kind: 'unknown' } : { kind: 'unknown', words: found[1] };
}

/**
 * The hand-off: one eth_sendRawTransaction of the signed bytes, made once, with no retry and no redirect followed, its
 * time-out running through the answer's body. Taken only where the node's answer to this request is this
 * transaction's own hash, or an error whose whole message is "already known"; every other answer is not known: a
 * time-out, a failure of the connection, an HTTP failure or a redirect, an answer that is not this request's, and a
 * named error, which keeps only the list's words. It never throws for the node, and nothing of the node's text leaves
 * it.
 */
export async function handOff(rpc: JsonRpc, raw: Hex): Promise<HandOff> {
  return rpc.handOff(raw);
}

/** One log of a receipt, as the node gives it, every field checked. */
export interface ReceiptLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  logIndex: number;
  blockHash: Hex;
  transactionHash: Hex;
}

/** A transaction's receipt: where it was mined, whether it succeeded, what it cost, its sender and target, and its logs. */
export interface Receipt {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  from: Address;
  to: Address | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: ReceiptLog[];
}

/** The receipt of the transaction with this hash, or null where the node has none. An answer that does not decode is the node's `malformed` failure. */
export async function receiptOf(rpc: JsonRpc, hash: Hex): Promise<Receipt | null> {
  const raw = await rpc.request<unknown>('eth_getTransactionReceipt', [hash]);
  if (raw === null) return null;
  const r = typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const bad = () => new NodeFailure('malformed', 'eth_getTransactionReceipt', null, 'the receipt lacks a field, or one does not decode');
  if (r === null) throw bad();
  const q = (v: unknown) => typeof v === 'string' && QUANTITY.test(v);
  const h = (v: unknown) => typeof v === 'string' && HASH.test(v);
  const a = (v: unknown) => typeof v === 'string' && ADDRESS.test(v);
  if (!h(r.transactionHash) || !q(r.status) || !q(r.blockNumber) || !h(r.blockHash) || !q(r.transactionIndex) || !a(r.from) || !(r.to === null || a(r.to)) || !q(r.gasUsed) || !q(r.effectiveGasPrice) || !Array.isArray(r.logs)) throw bad();
  const status = BigInt(r.status as string);
  if (status !== 0n && status !== 1n) throw bad();
  const logs = (r.logs as unknown[]).map((l): ReceiptLog => {
    const g = typeof l === 'object' && l !== null ? (l as Record<string, unknown>) : null;
    if (g === null || !a(g.address) || !Array.isArray(g.topics) || !(g.topics as unknown[]).every(h) || typeof g.data !== 'string' || !BYTES.test(g.data) || !q(g.logIndex) || !h(g.blockHash) || !h(g.transactionHash)) throw bad();
    return { address: g.address as Address, topics: (g.topics as string[]).map((t) => t.toLowerCase() as Hex), data: (g.data as string).toLowerCase() as Hex, logIndex: Number(BigInt(g.logIndex as string)), blockHash: (g.blockHash as string).toLowerCase() as Hex, transactionHash: (g.transactionHash as string).toLowerCase() as Hex };
  });
  return {
    transactionHash: (r.transactionHash as string).toLowerCase() as Hex,
    status: status === 1n ? 'success' : 'reverted',
    blockNumber: BigInt(r.blockNumber as string),
    blockHash: (r.blockHash as string).toLowerCase() as Hex,
    transactionIndex: Number(BigInt(r.transactionIndex as string)),
    from: r.from as Address,
    to: r.to === null ? null : (r.to as Address),
    gasUsed: BigInt(r.gasUsed as string),
    effectiveGasPrice: BigInt(r.effectiveGasPrice as string),
    logs,
  };
}

/** A block's header and its transactions in full, as far as the search for what used a nonce needs them: each one's hash, sender and nonce. Null where the node has no block of that number. */
export async function blockWithTransactions(rpc: JsonRpc, number: bigint): Promise<{ header: Header; transactions: Array<{ hash: Hex; from: Address; nonce: bigint }> } | null> {
  const raw = await rpc.request<unknown>('eth_getBlockByNumber', [`0x${number.toString(16)}`, true]);
  if (raw === null) return null;
  const header = toHeader(raw, 'eth_getBlockByNumber');
  const txs = (raw as Record<string, unknown>).transactions;
  if (!Array.isArray(txs)) throw new NodeFailure('malformed', 'eth_getBlockByNumber', null, 'the block lacks its transactions');
  return {
    header,
    transactions: txs.map((t) => {
      const x = typeof t === 'object' && t !== null ? (t as Record<string, unknown>) : null;
      if (x === null || typeof x.hash !== 'string' || !HASH.test(x.hash) || typeof x.from !== 'string' || !ADDRESS.test(x.from) || typeof x.nonce !== 'string' || !QUANTITY.test(x.nonce)) {
        throw new NodeFailure('malformed', 'eth_getBlockByNumber', null, 'a transaction of the block lacks its hash, sender or nonce');
      }
      return { hash: x.hash.toLowerCase() as Hex, from: x.from as Address, nonce: BigInt(x.nonce) };
    }),
  };
}

/** One frame of the call tracer's trace: the call, its output where it returned or reverted with data, its error where it failed, and the calls it made. */
export interface TraceFrame {
  type: string;
  from: Address | null;
  to: Address | null;
  input: Hex;
  output: Hex | null;
  error: string | null;
  calls: TraceFrame[];
}

function toFrame(raw: unknown): TraceFrame {
  const f = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  const bad = () => new NodeFailure('malformed', 'debug_traceTransaction', null, 'a frame of the trace does not decode');
  if (f === null || typeof f.type !== 'string') throw bad();
  const addr = (v: unknown) => (typeof v === 'string' && ADDRESS.test(v) ? (v as Address) : null);
  const bytes = (v: unknown) => (typeof v === 'string' && BYTES.test(v) ? (v.toLowerCase() as Hex) : null);
  const calls = f.calls === undefined || f.calls === null ? [] : Array.isArray(f.calls) ? f.calls.map(toFrame) : (() => { throw bad(); })();
  return { type: f.type, from: addr(f.from), to: addr(f.to), input: bytes(f.input) ?? '0x', output: bytes(f.output), error: typeof f.error === 'string' ? f.error.slice(0, 120) : null, calls };
}

/**
 * The node's trace of a mined transaction, with the call tracer: the top call and every call below it, each with its
 * output and its error. The node's failure to trace, or an answer that does not decode as frames, is thrown as the
 * node's failure; what an incomplete trace means is the reader's to say.
 */
export async function traceOf(rpc: JsonRpc, hash: Hex): Promise<TraceFrame> {
  const raw = await rpc.request<unknown>('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
  return toFrame(raw);
}

/** The class and code of a failure, for a record or a log: the node's text is never copied whole. */
export function describeNodeFailure(err: unknown): { kind: string; code: number | string | null; method: string | null } {
  if (err instanceof NodeFailure) return { kind: err.kind, code: err.code, method: err.method };
  if (err instanceof StateMismatch) return { kind: 'state-mismatch', code: null, method: 'eth_call' };
  const name = err instanceof Error ? err.name : typeof err;
  return { kind: name, code: null, method: null };
}

/** A mined or pending transaction as the recovery under a restore's hold reads it: its sender, its nonce, its target and its input, and its block where it has one. */
export interface TransactionSeen {
  hash: Hex;
  from: Address;
  nonce: bigint;
  to: Address | null;
  input: Hex;
  block: { number: bigint; hash: Hex } | null;
}

/** The transaction with this hash, or null where the node has none. An answer that does not decode is the node's `malformed` failure. */
export async function transactionOf(rpc: JsonRpc, hash: Hex): Promise<TransactionSeen | null> {
  const raw = await rpc.request<unknown>('eth_getTransactionByHash', [hash]);
  if (raw === null) return null;
  const t = typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const bad = () => new NodeFailure('malformed', 'eth_getTransactionByHash', null, 'the transaction lacks a field, or one does not decode');
  if (t === null || typeof t.hash !== 'string' || !HASH.test(t.hash) || typeof t.from !== 'string' || !ADDRESS.test(t.from) || typeof t.nonce !== 'string' || !QUANTITY.test(t.nonce)) throw bad();
  if (!(t.to === null || (typeof t.to === 'string' && ADDRESS.test(t.to))) || typeof t.input !== 'string' || !BYTES.test(t.input)) throw bad();
  const mined = typeof t.blockNumber === 'string' && QUANTITY.test(t.blockNumber) && typeof t.blockHash === 'string' && HASH.test(t.blockHash);
  return {
    hash: t.hash.toLowerCase() as Hex,
    from: t.from as Address,
    nonce: BigInt(t.nonce),
    to: t.to === null ? null : (t.to as Address),
    input: t.input.toLowerCase() as Hex,
    block: mined ? { number: BigInt(t.blockNumber as string), hash: (t.blockHash as string).toLowerCase() as Hex } : null,
  };
}
