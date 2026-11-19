import type { Address, Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { post, wire, type Answer, type Order } from './orders';
import type { Rig } from './rig';

// Stops from a user's side: the message signed with a real key under the
// courier's own domain, and posted to the courier over HTTP. The type, the
// domain and the JSON here are the test's own words, so a courier that hashed
// or read the wrong thing is not fed its own answer.

/** The type string the courier's domain hashes a stop by: the account, then the order hashes. */
export const STOP_TYPE = {
  OspexStop: [
    { name: 'account', type: 'address' },
    { name: 'orderHashes', type: 'bytes32[]' },
  ],
} as const;

/** The courier's domain: its name and version, the chain, and the relay as its contract. */
export const stopDomainOf = (chainId: number, relay: Address) => ({ name: 'Ospex Courier', version: '1', chainId, verifyingContract: relay }) as const;

export interface StopMessage {
  account: Address;
  orderHashes: Hex[];
}

/** A stop message of `account` naming these hashes, in this order. */
export function stopMessage(account: Address, orderHashes: Hex[]): StopMessage {
  return { account, orderHashes };
}

/** The message's signature by `who`: an EIP-712 signature under the courier's domain. */
export async function signStop(who: HDAccount, message: StopMessage, chainId: number, relay: Address): Promise<Hex> {
  return who.signTypedData({ domain: stopDomainOf(chainId, relay), types: STOP_TYPE, primaryType: 'OspexStop', message });
}

/** An order's signed original, as a stop carries it for a hash the courier may never have seen. */
export interface OriginalSent {
  orderHash: Hex;
  order: Order;
  signature: Hex;
}

/** The body of a stop as the wire carries it. */
export function stopBody(message: StopMessage, signature: Hex, originals?: OriginalSent[]): Record<string, unknown> {
  return {
    account: message.account,
    orderHashes: message.orderHashes,
    signature,
    ...(originals === undefined ? {} : { originals: originals.map((o) => ({ orderHash: o.orderHash, order: wire(o.order), signature: o.signature })) }),
  };
}

/** Sends a stop's body as it is given: for a signature made some other way than `postStop` makes it. */
export async function sendStop(courierUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return post(courierUrl, '/v1/stops', body, headers);
}

/** Signs a stop message with `who` on the rig's chain under the rig's relay, and posts it, with its originals where it has any. */
export async function postStop(courierUrl: string, rig: Rig, who: HDAccount, message: StopMessage, originals?: OriginalSent[], headers: Record<string, string> = {}): Promise<Answer & { signature: Hex }> {
  const signature = await signStop(who, message, 31337, rig.addresses.relay);
  const answer = await sendStop(courierUrl, stopBody(message, signature, originals), headers);
  return { ...answer, signature };
}

/** One hash's result in a stop's answer. */
export interface StopResultSeen {
  orderHash: string;
  status: string;
  code?: string;
  error?: string;
}

/** The results of a stop's answer, in the message's order. */
export function resultsOf(answer: Answer): StopResultSeen[] {
  return (answer.body.results as StopResultSeen[] | undefined) ?? [];
}

/** Each result as its status, or its code where it was refused: what a case compares. */
export function outcomes(answer: Answer): string[] {
  return resultsOf(answer).map((r) => (r.status === 'refused' ? String(r.code) : r.status));
}

/** The 64-bit key of an order hash's lock, as the database's advisory lock takes it: the hash's first eight bytes as a signed number. Computed here, not taken from the courier. */
export function hashLockKey(hash: Hex): bigint {
  return BigInt.asIntN(64, BigInt(`0x${hash.slice(2, 18)}`));
}
