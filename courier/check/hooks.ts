import type { Hex } from 'viem';

// The points where a test can hold the bet's check, and end the process there:
// after the reservation; between the reservation's find and its update; after
// read A; after read C; just before the result; and after a reservation that
// found nothing, before the runner decides whether to stop. And the faults a
// test can plant. They are passed by the tests' start file only. The
// production start file passes none, and then each point is passed at once and
// no fault exists.

export type HoldPoint = 'after-reservation' | 'between-find-and-update' | 'after-read-a' | 'after-read-c' | 'before-result' | 'after-empty-reservation';

export const HOLD_POINTS: readonly HoldPoint[] = ['after-reservation', 'between-find-and-update', 'after-read-a', 'after-read-c', 'before-result', 'after-empty-reservation'];

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
}

/** No hooks: every point passed at once, and no fault. What the production start file gives. */
export const NO_HOOKS: LaneHooks = { at: async () => undefined };
