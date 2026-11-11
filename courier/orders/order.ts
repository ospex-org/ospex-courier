import { encodeAbiParameters, getAddress, hashTypedData, isAddress, keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem';

// The signed order: the ten fields an account signs under the matching
// contract's EIP-712 domain, their hash as the contract computes it, the
// signer recovered from a signature, the market's key, and the contract's own
// rules on an order (price, lots, minimum fill, market contract, line), each
// with the refusal code the door answers.

/** The ten fields, as received: numbers as decimal strings, addresses as given. */
export interface OrderFields {
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

/** The type, as the contract's ORDER_TYPEHASH has it: ten fields, the first `account`, the last `minFill`. */
export const ORDER_TYPES = {
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

/** The contract's domain: name "Ospex", version "3", its chain and its own address. */
export function orderDomain(chainId: bigint, matching: Address) {
  return { name: 'Ospex', version: '3', chainId: Number(chainId), verifyingContract: getAddress(matching) } as const;
}

/** The contract's constants, written out; the ABI test holds them to the pinned build. */
export const ORDER_RULES = {
  minOdds: 101,
  maxOdds: 10_100,
  lot: 100n,
  maxLineTicks: 1_000_000,
  /** The most seconds a taking order may have left to its expiry. */
  maxTakingLife: 30n,
} as const;

const UINT256_MAX = 2n ** 256n - 1n;

export type Shape = { ok: true; order: OrderFields } | { ok: false; problem: string };

/** One decimal string to a bigint within uint256, or null. */
function uint(value: unknown, name: string): { ok: true; value: bigint } | { ok: false; problem: string } {
  if (typeof value !== 'string' || !/^[0-9]{1,78}$/.test(value)) return { ok: false, problem: `order.${name} must be a whole number as a decimal string` };
  const n = BigInt(value);
  if (n > UINT256_MAX) return { ok: false, problem: `order.${name} is above uint256` };
  return { ok: true, value: n };
}

/**
 * The body's order, read for shape: ten fields, each of its type. Nothing here
 * is a rule of the contract; that is checkOrderRules. An address is kept as
 * given and compared checksummed.
 */
export function readOrderShape(raw: unknown): Shape {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'order must be an object of the ten fields' };
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const expected = ['account', 'expiry', 'gameId', 'lineTicks', 'minFill', 'nonce', 'oddsTick', 'positionType', 'riskAmount', 'scorer'];
  if (keys.length !== 10 || keys.some((k, i) => k !== expected[i])) return { ok: false, problem: `order must have exactly the ten fields: ${expected.join(', ')}` };
  if (typeof o.account !== 'string' || !isAddress(o.account, { strict: false })) return { ok: false, problem: 'order.account must be an address' };
  if (typeof o.scorer !== 'string' || !isAddress(o.scorer, { strict: false })) return { ok: false, problem: 'order.scorer must be an address' };
  if (typeof o.lineTicks !== 'number' || !Number.isInteger(o.lineTicks) || o.lineTicks < -2_147_483_648 || o.lineTicks > 2_147_483_647) {
    return { ok: false, problem: 'order.lineTicks must be a whole number within int32' };
  }
  if (o.positionType !== 0 && o.positionType !== 1) return { ok: false, problem: 'order.positionType must be 0 (side A) or 1 (side B)' };
  if (typeof o.oddsTick !== 'number' || !Number.isInteger(o.oddsTick) || o.oddsTick < 0 || o.oddsTick > 65_535) return { ok: false, problem: 'order.oddsTick must be a whole number within uint16' };
  const gameId = uint(o.gameId, 'gameId');
  if (!gameId.ok) return gameId;
  const riskAmount = uint(o.riskAmount, 'riskAmount');
  if (!riskAmount.ok) return riskAmount;
  const nonce = uint(o.nonce, 'nonce');
  if (!nonce.ok) return nonce;
  const expiry = uint(o.expiry, 'expiry');
  if (!expiry.ok) return expiry;
  const minFill = uint(o.minFill, 'minFill');
  if (!minFill.ok) return minFill;
  return {
    ok: true,
    order: {
      account: getAddress(o.account),
      gameId: gameId.value,
      scorer: getAddress(o.scorer),
      lineTicks: o.lineTicks,
      positionType: o.positionType,
      oddsTick: o.oddsTick,
      riskAmount: riskAmount.value,
      nonce: nonce.value,
      expiry: expiry.value,
      minFill: minFill.value,
    },
  };
}

/** The order's hash, as the contract's getOrderHash computes it: the EIP-712 digest under the contract's domain. */
export function orderHash(order: OrderFields, chainId: bigint, matching: Address): Hex {
  return hashTypedData({ domain: orderDomain(chainId, matching), types: ORDER_TYPES, primaryType: 'OspexOrder', message: order });
}

/** The signer of the order's hash, or null for a signature that recovers to nothing. */
export async function orderSigner(order: OrderFields, signature: Hex, chainId: bigint, matching: Address): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({ domain: orderDomain(chainId, matching), types: ORDER_TYPES, primaryType: 'OspexOrder', message: order, signature });
  } catch {
    return null;
  }
}

/** The market's key, keccak256(abi.encode(gameId, scorer, lineTicks)), as the matching contract computes it. */
export function marketKey(gameId: bigint, scorer: Address, lineTicks: number): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }], [gameId, getAddress(scorer), lineTicks]));
}

export interface MarketContracts {
  moneyline: Address;
  spread: Address;
  total: Address;
}

export type RuleVerdict = { ok: true } | { ok: false; code: string; error: string };

/**
 * The order's own rules, as the contract has them: price 101 to 10,100; stake
 * above zero and in whole lots of 100; minimum fill not above the stake; the
 * market contract one of the set's three; the line within the contract's
 * bound, a moneyline's zero and a total's not negative.
 */
export function checkOrderRules(order: OrderFields, contracts: MarketContracts): RuleVerdict {
  if (order.oddsTick < ORDER_RULES.minOdds || order.oddsTick > ORDER_RULES.maxOdds) {
    return { ok: false, code: 'PRICE_OUT_OF_RANGE', error: `The price must be a tick from ${ORDER_RULES.minOdds} to ${ORDER_RULES.maxOdds}; this order's is ${order.oddsTick}.` };
  }
  if (order.riskAmount === 0n || order.riskAmount % ORDER_RULES.lot !== 0n) {
    return { ok: false, code: 'STAKE_NOT_IN_LOTS', error: `The stake must be above zero and a whole number of lots of ${ORDER_RULES.lot} units; this order's is ${order.riskAmount}.` };
  }
  if (order.minFill > order.riskAmount) {
    return { ok: false, code: 'MIN_FILL_ABOVE_STAKE', error: `The minimum fill, ${order.minFill}, is above the stake, ${order.riskAmount}.` };
  }
  const scorer = getAddress(order.scorer);
  const known = [contracts.moneyline, contracts.spread, contracts.total].map((a) => getAddress(a));
  if (!known.includes(scorer)) {
    return { ok: false, code: 'UNKNOWN_MARKET_CONTRACT', error: `The market contract ${scorer} is not one of the set's three: the moneyline ${known[0]}, the spread ${known[1]}, the total ${known[2]}.` };
  }
  if (order.lineTicks > ORDER_RULES.maxLineTicks || order.lineTicks < -ORDER_RULES.maxLineTicks) {
    return { ok: false, code: 'INVALID_LINE', error: `The line must be within ${ORDER_RULES.maxLineTicks} ticks either side of zero; this order's is ${order.lineTicks}.` };
  }
  if (scorer === getAddress(contracts.moneyline) && order.lineTicks !== 0) {
    return { ok: false, code: 'INVALID_LINE', error: `A moneyline's line is zero; this order's is ${order.lineTicks}.` };
  }
  if (scorer === getAddress(contracts.total) && order.lineTicks < 0) {
    return { ok: false, code: 'INVALID_LINE', error: `A total's line is not negative; this order's is ${order.lineTicks}.` };
  }
  return { ok: true };
}

/** The ten fields as decimal strings and checksummed addresses, for a record or an answer. */
export function orderToJson(order: OrderFields): Record<string, string | number> {
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

/** An amount in the coin's smallest unit as a decimal of the coin, with no trailing zeroes beyond the first two places: 10100 at six decimals is "0.0101". */
export function coinAmount(units: bigint, decimals: number): string {
  const whole = units / 10n ** BigInt(decimals);
  let frac = (units % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${whole}.${frac}`;
}
