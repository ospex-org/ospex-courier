import type { Hex } from 'viem';
import type { SignerSeams } from '../send/signer';

// The points where a test can hold the bet's check and its send, and end the
// process there: after the reservation; between the reservation's find and its
// update; after read A; after read C; just before the result; after a
// reservation that found nothing, before the runner decides whether to stop;
// and the sender's: after the intent; after the signature, before the signed
// record commits; after the signed record, before the gate; after the gate,
// before the hand-off; and after the hand-off's answer, before it is recorded.
// And the faults a test can plant, and the seams inside the signing path. They
// are passed by the tests' start file only. The production start file passes
// none, and then each point is passed at once and no fault or seam exists.

export type HoldPoint =
  | 'after-reservation'
  | 'between-find-and-update'
  | 'after-read-a'
  | 'after-read-c'
  | 'before-result'
  | 'after-empty-reservation'
  | 'after-intent'
  | 'after-signature'
  | 'after-signed-record'
  | 'after-gate'
  | 'after-hand-off';

export const HOLD_POINTS: readonly HoldPoint[] = [
  'after-reservation',
  'between-find-and-update',
  'after-read-a',
  'after-read-c',
  'before-result',
  'after-empty-reservation',
  'after-intent',
  'after-signature',
  'after-signed-record',
  'after-gate',
  'after-hand-off',
];

export interface LaneHooks {
  /** Reached at each point, with the bet's hash where there is one. The check goes on when the promise settles. */
  at(point: HoldPoint, bet: Hex | null): Promise<void>;
  /** A fault: the predicted pull of this quote's leg changed by this much after selection, the simulation unchanged. */
  skewPull?: (quote: Hex) => bigint | null;
  /** A fault: this quote taken as live by the walk whatever the reads say of it. */
  listAsLive?: (quote: Hex) => boolean;
  /** A lower ceiling on one transaction's gas than the chain's own, for a test of the search for a shorter fill. */
  transactionGasCap?: bigint | undefined;
  /** Told what the check saw at the boundary between the candidates and the listing: the candidate statement's rows, and the walk's input, by hash. */
  observe?: (what: 'candidates' | 'walk input', hashes: Hex[]) => void;
  /** A fault: one order of the ready Cross changed before the pre-check seals it, so it no longer hashes to the hash it carries. */
  unhashBeforeSeal?: () => boolean;
  /** The seams inside the signing path. */
  signer?: SignerSeams;
}

/** No hooks: every point passed at once, and no fault. What the production start file gives. */
export const NO_HOOKS: LaneHooks = { at: async () => undefined };
