import { decodeErrorResult, type Abi, type Hex } from 'viem';
import { MARKETS_ABI, MATCHING_ABI, POSITIONS_ABI, RELAY_ABI } from '../chain/abi';

// The decoder of a refusal of the exact call: revert data, as the relay
// returns it whole, read by the pinned interface into the contract's own error
// and its arguments. It knows exactly the errors the bet's check can meet: the
// matching contract's taking-order and listed-order refusals, its two
// whole-Cross refusals and the courier test; the positions contract's taking
// pull and its two receipts; the markets contract's close gate; the relay's
// sender test; and a revert with no data. A reason it does not know is said by
// its four-byte selector, and is the courier's own fault.

/** The skip reasons, by the contract's enum: the number a NothingFilled or a leg's report carries. */
export const SKIP_REASONS = ['NoCourier', 'Cancelled', 'Expired', 'NoRoom', 'NothingFits', 'UnderMinFill', 'PullRefused', 'GrantGone'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Every error the decoder names, by the contract that throws it: the ABI test holds each to the pinned build, by name and by arguments. */
export const DECODED_ERRORS = {
  matching: [
    'OspexMatching__NothingFilled',
    'OspexMatching__TakingOrderUnderMinFill',
    'OspexMatching__SenderNotCourier',
    // The taking order's own thirteen refusals, and the up-front checks every listed order meets.
    'OspexMatching__BadSignature',
    'OspexMatching__NoSuchGrant',
    'OspexMatching__PriceOutOfRange',
    'OspexMatching__StakeNotInLots',
    'OspexMatching__MinFillAboveStake',
    'OspexMatching__AgentStakeAboveCap',
    'OspexMatching__LineNotInGrant',
    'OspexMatching__TakingStakeAboveCap',
    'OspexMatching__TakingOrderCancelled',
    'OspexMatching__TakingOrderGrantGone',
    'OspexMatching__TakingOrderExpired',
    'OspexMatching__TakingOrderTooLong',
    'OspexMatching__TakingOrderFilled',
    'OspexMatching__OtherGame',
    'OspexMatching__OtherScorer',
    'OspexMatching__OtherLine',
    'OspexMatching__SameSide',
    'OspexMatching__PricesDoNotMeet',
  ],
  positions: ['OspexPositions__TakerPullRefused', 'OspexPositions__ShortReceipt', 'OspexPositions__MarketShort'],
  markets: ['OspexMarkets__MarketSettled', 'OspexMarkets__GameEnded', 'OspexMarkets__GameNotVerified', 'OspexMarkets__BetsClosed'],
  relay: ['OspexCourierRelay__NotTheSender'],
} as const;

const SOURCES: ReadonlyArray<{ abi: Abi; names: readonly string[] }> = [
  { abi: MATCHING_ABI, names: DECODED_ERRORS.matching },
  { abi: POSITIONS_ABI, names: DECODED_ERRORS.positions },
  { abi: MARKETS_ABI, names: DECODED_ERRORS.markets },
  { abi: RELAY_ABI, names: DECODED_ERRORS.relay },
];

/** One leg's record in a TakingOrderUnderMinFill, as the contract reports it. */
export interface LegReport {
  orderHash: Hex;
  filled: boolean;
  reason: SkipReason;
  makerRisk: bigint;
  takerRisk: bigint;
}

export type Decoded =
  /** A revert that gave no reason: the call ran out of gas, or something below it gave none. */
  | { kind: 'empty' }
  /** An error the decoder names, with its arguments as the ABI decodes them, numbers and hashes as strings. */
  | { kind: 'named'; name: string; args: unknown[]; reasons?: SkipReason[]; legs?: LegReport[] }
  /** A reason the decoder does not know: the courier's own fault. */
  | { kind: 'unknown'; selector: Hex };

const jsonable = (v: unknown): unknown => {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonable);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonable(x)]));
  return v;
};

const skip = (n: unknown): SkipReason => {
  const reason = SKIP_REASONS[Number(n)];
  if (reason === undefined) throw new Error(`a skip reason the contract does not have: ${String(n)}`);
  return reason;
};

/** The refusal's reason, by the pinned interface. */
export function decodeRevert(data: Hex): Decoded {
  if (data === '0x' || data.length < 10) return data === '0x' ? { kind: 'empty' } : { kind: 'unknown', selector: data };
  for (const source of SOURCES) {
    let out: { errorName: string; args?: readonly unknown[] | undefined };
    try {
      out = decodeErrorResult({ abi: source.abi, data }) as { errorName: string; args?: readonly unknown[] };
    } catch {
      continue;
    }
    if (!source.names.includes(out.errorName)) continue;
    const args = [...(out.args ?? [])];
    if (out.errorName === 'OspexMatching__NothingFilled') {
      const reasons = (args[0] as readonly number[]).map(skip);
      return { kind: 'named', name: out.errorName, args: [reasons], reasons };
    }
    if (out.errorName === 'OspexMatching__TakingOrderUnderMinFill') {
      const legs = (args[4] as ReadonlyArray<{ orderHash: Hex; filled: boolean; reason: number; makerRisk: bigint; takerRisk: bigint }>).map((l) => ({
        orderHash: l.orderHash,
        filled: l.filled,
        reason: skip(l.reason),
        makerRisk: l.makerRisk,
        takerRisk: l.takerRisk,
      }));
      return { kind: 'named', name: out.errorName, args: jsonable(args) as unknown[], legs };
    }
    return { kind: 'named', name: out.errorName, args: jsonable(args) as unknown[] };
  }
  return { kind: 'unknown', selector: data.slice(0, 10) as Hex };
}

/** The reason as a short text for a sentence: the error's name and its arguments. */
export function reasonText(d: Decoded): string {
  if (d.kind === 'empty') return 'no reason came back: the call ran out of gas, or something below it gave none';
  if (d.kind === 'unknown') return `an error the courier does not know, selector ${d.selector}`;
  if (d.reasons !== undefined) return `${d.name}(${d.reasons.join(', ')})`;
  return `${d.name}(${d.args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(', ')})`;
}
