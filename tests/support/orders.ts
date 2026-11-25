import { decodeErrorResult, encodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem';
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

/**
 * Raises `account`'s floor on the order's line, at the account's current version, to `floor`: an order number, the
 * nonce's low 96 bits. Sent by `who`, the account itself or its live agent.
 */
export async function raiseFloor(rig: Rig, who: HDAccount, account: Address, order: Order, floor: bigint): Promise<void> {
  await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'raiseFloor', [account, order.gameId, order.scorer, order.lineTicks, floor]);
}

/** The account cancels everything: the contract moves it to a new version, which is returned as the chain then holds it. */
export async function cancelAll(rig: Rig, who: HDAccount): Promise<bigint> {
  await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'cancelAll', [who.address]);
  return BigInt(await rig.read<bigint>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_version', [who.address]));
}

/** A line as a grant's list names it. */
export interface GrantLine {
  gameId: bigint;
  scorer: Address;
  lineTicks: number;
}

/**
 * `who` grants `agent`: the most one order the agent signs may stake, the second the grant ends at, and the lines
 * it may sign on, none for every market. Returns the grant's number, read back as the account's current grant.
 */
export async function grantAgent(rig: Rig, who: HDAccount, agent: Address, stakeCap: bigint, endsAt: bigint, lines: GrantLine[] = []): Promise<number> {
  await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'grantAgent', [agent, stakeCap, endsAt, lines]);
  return Number(await rig.read<number>(rig.addresses.matching, rig.abis.OspexMatching as Abi, 's_currentGrant', [who.address]));
}

/** `who` ends its current grant. */
export async function revokeAgent(rig: Rig, who: HDAccount): Promise<void> {
  await rig.write(who, rig.addresses.matching, rig.abis.OspexMatching as Abi, 'revokeAgent', []);
}

/**
 * A nonce, packed as the contract's `_split` reads the word: the version above bit 128, the grant number in the
 * 32 bits above bit 96, the order number in the low 96.
 */
export function nonceOf(version: bigint, grantNumber: number, orderNumber: bigint): bigint {
  return (version << 128n) | (BigInt(grantNumber) << 96n) | orderNumber;
}

/** An order number no earlier order of this run has used: the counter `orderOn` draws its nonces from. */
export function nextOrderNumber(): bigint {
  return nonces++;
}

/**
 * Signs an order with `signer`, whoever the order's account is, and posts it under a role: an order its account's
 * agent signs, or one a stranger does.
 */
export async function postOrderAs(courierUrl: string, rig: Rig, signer: HDAccount, role: 'rest' | 'take', order: Order, headers: Record<string, string> = {}): Promise<Answer & { signature: Hex }> {
  return postOrder(courierUrl, rig, signer, role, order, headers);
}

/** The order of the curve the signatures are on. */
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * A signature of the same signer over the same hash in a form the contract refuses. `v as parity`: the last byte
 * written 0 or 1, the parity itself, in place of 27 or 28. `upper s`: the other signature the same key and hash
 * allow, its `s` taken from the curve's order, which puts it in the upper half, and its `v` flipped to match. A
 * library that recovers leniently reads the signer from either; the contract's check takes neither.
 */
export function refusedForm(signature: Hex, how: 'v as parity' | 'upper s'): Hex {
  const r = signature.slice(2, 66);
  const s = signature.slice(66, 130);
  const v = Number.parseInt(signature.slice(130), 16);
  if (v !== 27 && v !== 28) throw new Error(`a signature to reshape ends in 27 or 28; this one ends in ${v}`);
  if (how === 'v as parity') return `0x${r}${s}${(v - 27).toString(16).padStart(2, '0')}`;
  const upper = CURVE_ORDER - BigInt(`0x${s}`);
  return `0x${r}${upper.toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
}

export interface Signed {
  order: Order;
  signature: Hex;
}

/**
 * One Cross, sent by the test through another courier the accounts register, from that courier's own sender: the
 * contract's own side of a boundary. Returns the transaction's hash where it filled, or the revert where the contract
 * refused it. The courier under test is not involved, and its key's line of transactions stays its own.
 */
export async function crossFromTheTest(rig: Rig, taking: Signed, resting: Signed[]): Promise<{ filled: true; hash: Hex } | { filled: false; reason: string }> {
  try {
    const hash = await rig.write(rig.accounts.otherSender, rig.addresses.otherRelay, rig.abis.OspexCourierRelay as Abi, 'cross', [taking, resting]);
    return { filled: true, hash };
  } catch (err) {
    return { filled: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What the contract would answer one Cross with, asked of the chain without sending it: null where it would fill,
 * else the contract's own error, by name and with its values, read against the matching contract's errors. The
 * call is made as the relay's sender through the relay, which hands the matching contract's refusal back as it
 * is. A refusal that is not one of the matching contract's errors is thrown, not named. Where the refusal looked
 * for is another contract's of the set, which the matching contract hands up as it is, `errorsOf` is that
 * contract's interface, and the refusal is read against its errors in place of the matching contract's.
 */
export async function crossRefusal(rig: Rig, taking: Signed, resting: Signed[], errorsOf: Abi = rig.abis.OspexMatching as Abi): Promise<{ name: string; args: readonly unknown[] } | null> {
  const data = encodeFunctionData({ abi: rig.abis.OspexCourierRelay as Abi, functionName: 'cross', args: [taking, resting] } as never);
  const res = await fetch(rig.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: rig.accounts.sender.address, to: rig.addresses.relay, data }, 'latest'] }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string; data?: unknown } };
  if (body.error === undefined) return null;
  if (typeof body.error.data !== 'string') throw new Error(`the Cross was refused with no data to name the refusal by: ${String(body.error.message)}`);
  const refusal = decodeErrorResult({ abi: errorsOf, data: body.error.data as Hex });
  return { name: refusal.errorName, args: refusal.args ?? [] };
}

/** The quotes of a page, by hash, in the order served. */
export function hashesOf(page: { quotes: Array<{ orderHash: string }> } | undefined): string[] {
  return (page?.quotes ?? []).map((q) => q.orderHash);
}
