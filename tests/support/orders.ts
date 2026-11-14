import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import type { Rig } from './rig';

// Orders from a user's side: signed with a real key under the matching
// contract's domain, written as the wire has them, and posted to the courier
// over HTTP. The signing and the JSON here are the test's own, so a courier
// that hashed or read the wrong thing is not fed its own answer.

export interface Order {
  account: Address;
  gameId: bigint;
  scorer: Address;
  lineTicks: number;
  positionType: 0 | 1;
  oddsTick: number;
  riskAmount: bigint;
  nonce: bigint;
  expiry: bigint;
  minFill: bigint;
}

/** The type string the contract hashes: ten fields, the first account, the last minFill. */
export const ORDER_TYPE = {
  OspexOrder: [
    { name: 'account', type: 'address' },
    { name: 'gameId', type: 'uint256' },
    { name: 'scorer', type: 'address' },
    { name: 'lineTicks', type: 'int32' },
    { name: 'positionType', type: 'uint8' },
    { name: 'oddsTick', type: 'uint16' },
    { name: 'riskAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'minFill', type: 'uint256' },
  ],
} as const;

export const domainOf = (chainId: number, matching: Address) => ({ name: 'Ospex', version: '3', chainId, verifyingContract: matching }) as const;

/** The order's signature by `who`, an EIP-712 signature under the contract's domain. */
export async function sign(who: HDAccount, order: Order, chainId: number, matching: Address): Promise<Hex> {
  return who.signTypedData({ domain: domainOf(chainId, matching), types: ORDER_TYPE, primaryType: 'OspexOrder', message: order });
}

/** The order as the wire carries it: numbers as decimal strings where the contract's are uint256; addresses checksummed. */
export function wire(order: Order): Record<string, string | number> {
  return {
    account: getAddress(order.account),
    gameId: order.gameId.toString(),
    scorer: getAddress(order.scorer),
    lineTicks: order.lineTicks,
    positionType: order.positionType,
    oddsTick: order.oddsTick,
    riskAmount: order.riskAmount.toString(),
    nonce: order.nonce.toString(),
    expiry: order.expiry.toString(),
    minFill: order.minFill.toString(),
  };
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

export async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: res.headers };
}

let nonces = 1_000n;

/** A quote or a bet on the rig's game, with the fields given and the rest a maker's defaults; the nonce is fresh each time. */
export function orderOn(rig: Rig, who: HDAccount, fields: Partial<Order> & { expiry: bigint }): Order {
  return {
    account: who.address,
    gameId: rig.gameId,
    scorer: rig.addresses.moneyline,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    riskAmount: 1_000_000n,
    nonce: nonces++,
    minFill: 0n,
    ...fields,
  };
}

/** Signs and posts an order under a role. */
export async function postOrder(courierUrl: string, rig: Rig, who: HDAccount, role: 'rest' | 'take', order: Order, headers: Record<string, string> = {}): Promise<Answer & { signature: Hex }> {
  const signature = await sign(who, order, 31337, rig.addresses.matching);
  const answer = await post(courierUrl, '/v1/orders', { role, order: wire(order), signature }, headers);
  return { ...answer, signature };
}

/** The contract's own hash of an order, read from the chain. */
export async function contractHash(rig: Rig, order: Order): Promise<Hex> {
  return rig.read<Hex>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 'getOrderHash', [order]);
}

/** The lift of the cap, through the timelock as it runs live. */
export async function liftCap(rig: Rig): Promise<void> {
  await rig.throughTimelock(rig.addresses.matching, encodeFunctionData({ abi: rig.abis.OspexMatching as Abi, functionName: 'liftTakingStakeCap', args: [] } as never));
}

export async function cancelOnChain(rig: Rig, who: HDAccount, order: Order): Promise<void> {
  await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'cancelOrder', [order]);
}

export async function raiseFloor(rig: Rig, who: HDAccount, order: Order, newMinNonce: bigint): Promise<void> {
  await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'raiseMinNonce', [order.gameId, order.scorer, order.lineTicks, newMinNonce]);
}

export interface Signed {
  order: Order;
  signature: Hex;
}

/**
 * One Cross, sent by the test from the relay's sender through the relay: the
 * contract's own side of a boundary. Returns the transaction's hash where it
 * filled, or the revert where the contract refused it. The courier is not
 * involved: nothing in it signs or sends.
 */
export async function crossFromTheTest(rig: Rig, taking: Signed, resting: Signed[]): Promise<{ filled: true; hash: Hex } | { filled: false; reason: string }> {
  try {
    const hash = await rig.write(rig.accounts.sender, rig.addresses.relay, rig.abis.OspexCourierRelay as Abi, 'cross', [taking, resting]);
    return { filled: true, hash };
  } catch (err) {
    return { filled: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The quotes of a page, by hash, in the order served. */
export function hashesOf(page: { quotes: Array<{ orderHash: string }> } | undefined): string[] {
  return (page?.quotes ?? []).map((q) => q.orderHash);
}
