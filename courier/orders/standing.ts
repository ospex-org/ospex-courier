import type { Address, Hex } from 'viem';
import type { QuotesRead } from '../chain/reads';
import { floorKey, grantKey } from '../chain/reads';
import type { EndSeen } from '../records/orders';
import { ORDER_RULES, splitNonce, type NonceParts } from './order';

// An order's standing on chain, as the matching contract judges it where it
// checks a taking order and at every leg, in two halves. The door's check and
// the two marks (the door's, of an account's standing quotes; the book's, of a
// page) are this one predicate, each from one read of the chain at one block.
//
// The order's half is the account's own act on the order: its cancel, a
// cancel of everything (the account's version moved on from the one the
// nonce names), or a floor raised above its order number on its line, at the
// version the nonce names.
//
// The grant's half is for an order signed under a grant (a nonzero grant
// number in its nonce): the grant is no longer the account's current one (a
// revoke, or another grant made, to the same key or to another), or it ends at
// or before the block's time plus one. The contract refuses such an order from
// the second its grant ends at, and the next block's time is at least the
// block's plus one, so an order whose grant ends at or before that can fill in
// no later block: the boundary the expiry has, with no margin either way. An
// order its account signs (grant number 0) has no such half, whatever the
// account's current grant is.

export interface OrderStandingRead {
  /** The order's hash is marked cancelled. */
  cancelled: boolean;
  /** The account's current version. */
  version: bigint;
  /** The floor of the order's line at the version the order's nonce names. */
  floorAtVersion: bigint;
}

export interface GrantStandingRead {
  /** The number of the account's current grant, 0 for none. */
  currentGrant: number;
  /** The second the grant the order's nonce names ends at. */
  endsAt: bigint;
}

/** The order's half: cancelled, at a version its account has left, or its order number under its line's floor at its version. */
export function orderGone(nonce: NonceParts, read: OrderStandingRead): boolean {
  return read.cancelled || nonce.version !== read.version || nonce.orderNumber < read.floorAtVersion;
}

/** The grant's half, at the time of the block read: for an order under a grant, the grant not the account's current one, or ending at or before that time plus one. */
export function grantGone(nonce: NonceParts, read: GrantStandingRead, chainTime: bigint): boolean {
  return nonce.grantNumber !== 0 && (nonce.grantNumber !== read.currentGrant || read.endsAt <= chainTime + 1n);
}

/** An answer the read was asked for and must hold: its absence is a fault of the courier's own, never taken for a standing quote. */
function held<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the read of the quotes holds no ${what}`);
  return value;
}

/**
 * How one read of the chain shows a stored quote ended, at the time of the block read, or null where it stands:
 * `cancelled` for either half of the standing above (the order's own end, or its grant's), `filled` where less
 * than a lot of its stake is left. Every value comes from the one read; one the read was asked for and does not
 * hold is thrown as a fault, and no quote is taken to stand for want of an answer.
 */
export function quoteEnd(quote: { hash: Hex; account: Address; nonce: bigint; riskAmount: bigint }, state: QuotesRead, chainTime: bigint): EndSeen | null {
  const nonce = splitNonce(quote.nonce);
  const seen = held(state.quotes.get(quote.hash.toLowerCase()), `answer for the quote ${quote.hash}`);
  const account = held(state.accounts.get(quote.account.toLowerCase()), `answer for the account ${quote.account}`);
  const floorAtVersion = held(state.floors.get(floorKey(quote.account, nonce.version)), `floor for ${quote.account} at the version of ${quote.hash}`);
  if (orderGone(nonce, { cancelled: seen.cancelled, version: account.version, floorAtVersion })) return 'cancelled';
  if (nonce.grantNumber !== 0) {
    const grant = held(state.grants.get(grantKey(quote.account, nonce.grantNumber)), `record of grant ${nonce.grantNumber} of ${quote.account}`);
    if (grantGone(nonce, { currentGrant: account.currentGrant, endsAt: grant.endsAt }, chainTime)) return 'cancelled';
  }
  if (quote.riskAmount - seen.filled < ORDER_RULES.lot) return 'filled';
  return null;
}
