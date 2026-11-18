import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { BOUNDS } from '../http/limits';
import { isChainSignature, readOrderShape, type OrderFields } from './order';

// The signed stop: the message an account signs, or its approved agent signs
// for it, to take orders of the account out of this courier's fills. Two
// fields, the account and the hashes of the orders, under the courier's own
// EIP-712 domain, whose contract is the relay: the one address every account
// registered, so a stop is tied to this courier and this chain. An order is
// signed under another domain (the matching contract's) and another type, so
// an order's signature serves as a stop only on a hash collision. A stop
// message has no nonce or expiry. A recorded stop is permanent for its hash.
// Replaying a message is not universally free or without writes: the replay
// rules are in docs/API.md, part 4.

/** The type: the account, then the order hashes in the message's own order. */
export const STOP_TYPES = {
  OspexStop: [
    { name: 'account', type: 'address' },
    { name: 'orderHashes', type: 'bytes32[]' },
  ],
} as const;

/** The courier's domain: name "Ospex Courier", version "1", the chain and the relay. */
export function stopDomain(chainId: bigint, relay: Address) {
  return { name: 'Ospex Courier', version: '1', chainId: Number(chainId), verifyingContract: getAddress(relay) } as const;
}

/** The signed payload: the account, and the hashes it names, lowercase, in the order given. */
export interface StopMessage {
  account: Address;
  orderHashes: Hex[];
}

/** An order's signed original, sent with a stop for a hash the courier may never have seen. */
export interface Original {
  orderHash: Hex;
  order: OrderFields;
  signature: Hex;
}

export interface StopBody {
  message: StopMessage;
  signature: Hex;
  /** By the hash each names; at most sixteen. Outside the signed payload. */
  originals: Original[];
}

/** The stop message's digest under the courier's domain. Recomputed here from the fields; never compared as bytes with an order's. */
export function stopHash(message: StopMessage, chainId: bigint, relay: Address): Hex {
  return hashTypedData({ domain: stopDomain(chainId, relay), types: STOP_TYPES, primaryType: 'OspexStop', message });
}

export type StopShape = { ok: true; stop: StopBody } | { ok: false; problem: string };

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * The body of a stop, read for shape: exactly `account`, `orderHashes` and
 * `signature`, and optionally `originals`. One to a hundred hashes, each 0x and
 * 64 hex characters, none twice, compared lowercased. A signature of 65 bytes.
 * At most sixteen originals, each exactly `{orderHash, order, signature}`, the
 * order in the door's own shape, each naming a hash of the message and no two
 * the same hash. Nothing here is a judgement of a signature or of an order's
 * rules: only the shape, and a body that fails it fails whole.
 */
export function readStopShape(raw: unknown): StopShape {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'The body must be an object: {account, orderHashes, signature} and, where a stop is sent ahead of its order, originals' };
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'account,orderHashes,signature' && keys !== 'account,orderHashes,originals,signature') {
    return { ok: false, problem: 'The body must have exactly account, orderHashes and signature, and may have originals' };
  }
  if (typeof body.account !== 'string' || !isAddress(body.account, { strict: false })) return { ok: false, problem: 'account must be an address' };
  if (!Array.isArray(body.orderHashes) || body.orderHashes.length < 1 || body.orderHashes.length > BOUNDS.hashesInStop) {
    return { ok: false, problem: `orderHashes must be a list of 1 to ${BOUNDS.hashesInStop} order hashes` };
  }
  const orderHashes: Hex[] = [];
  const named = new Set<string>();
  for (const value of body.orderHashes as unknown[]) {
    if (typeof value !== 'string' || !HASH.test(value)) return { ok: false, problem: 'each of orderHashes must be an order hash: 0x and 64 hex characters' };
    const hash = value.toLowerCase() as Hex;
    if (named.has(hash)) return { ok: false, problem: 'orderHashes names a hash twice; each hash is named once' };
    named.add(hash);
    orderHashes.push(hash);
  }
  if (typeof body.signature !== 'string' || !SIGNATURE.test(body.signature)) return { ok: false, problem: 'signature must be 65 bytes as 0x and 130 hex characters' };
  const originals: Original[] = [];
  if (body.originals !== undefined) {
    if (!Array.isArray(body.originals) || body.originals.length > BOUNDS.originalsInStop) return { ok: false, problem: `originals must be a list of at most ${BOUNDS.originalsInStop} signed orders` };
    const carried = new Set<string>();
    for (const value of body.originals as unknown[]) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, problem: 'each of originals must be an object: {orderHash, order, signature}' };
      const original = value as Record<string, unknown>;
      if (Object.keys(original).sort().join(',') !== 'order,orderHash,signature') return { ok: false, problem: 'each of originals must have exactly orderHash, order and signature' };
      if (typeof original.orderHash !== 'string' || !HASH.test(original.orderHash)) return { ok: false, problem: "an original's orderHash must be an order hash: 0x and 64 hex characters" };
      const hash = original.orderHash.toLowerCase() as Hex;
      if (!named.has(hash)) return { ok: false, problem: 'an original names a hash that is not in orderHashes' };
      if (carried.has(hash)) return { ok: false, problem: 'two originals name the same hash; each original names a different one' };
      carried.add(hash);
      const shape = readOrderShape(original.order);
      if (!shape.ok) return { ok: false, problem: `an original's ${shape.problem}` };
      if (typeof original.signature !== 'string' || !SIGNATURE.test(original.signature)) return { ok: false, problem: "an original's signature must be 65 bytes as 0x and 130 hex characters" };
      originals.push({ orderHash: hash, order: shape.order, signature: original.signature.toLowerCase() as Hex });
    }
  }
  return { ok: true, stop: { message: { account: getAddress(body.account), orderHashes }, signature: body.signature.toLowerCase() as Hex, originals } };
}

/**
 * The signer of a stop message, or null for a signature that recovers to
 * nothing the chain would take: one not in the form the matching contract's
 * check takes (its last byte 27 or 28, its `s` in the lower half of the curve's
 * order), or one no address recovers from. The courier holds a stop to the rule
 * the chain holds every signature to. Who the signer is to the account (the
 * account itself, its live agent, or nobody) is the route's to decide.
 */
export async function stopSigner(message: StopMessage, signature: Hex, chainId: bigint, relay: Address): Promise<Address | null> {
  if (!isChainSignature(signature)) return null;
  try {
    return await recoverTypedDataAddress({ domain: stopDomain(chainId, relay), types: STOP_TYPES, primaryType: 'OspexStop', message, signature });
  } catch {
    return null;
  }
}
