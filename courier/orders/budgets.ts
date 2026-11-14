import type pg from 'pg';
import { BOUNDS } from '../http/limits';

// The two budgets of admitted requests: the account's and the courier's, for
// all accounts together. Each is a row in the accounts table, a bucket and
// when it was last refilled, so it is one count for every process and it
// outlives a restart. The bucket's clock is the chain's time, read at the
// block the door named for the request: the courier keeps no clock of its own
// for anything it decides, and a test moves the chain's.
//
// An admitted request takes one from each. A request over a budget is not
// admitted, and the row counts how many and when last: a number, not a line.
//
// The stored time never goes back. A request that read an older block than the
// one the row was last refilled at, by a reorder of reads between the chain
// and the lock, refills nothing (the clamp below) and writes no older time: the
// row keeps the newest time it has seen, so the same interval cannot refill
// twice.

export const COURIER_ROW = 'courier';

export type BudgetVerdict = { ok: true } | { ok: false; which: 'account' | 'courier'; retryAfterSeconds: number };

interface Row {
  account: string;
  budget: string;
  at: string;
}

/** The bucket as it stands at the chain's time: what it held, plus the refill since, up to its size. */
export function refilled(held: number, heldAt: bigint, now: bigint, size: number, perMinute: number): number {
  const seconds = now > heldAt ? Number(now - heldAt) : 0;
  return Math.min(size, held + (seconds * perMinute) / 60);
}

/** Seconds until the bucket holds one, at its refill rate. */
function secondsUntilOne(held: number, perMinute: number): number {
  return Math.max(1, Math.ceil(((1 - held) * 60) / perMinute));
}

/**
 * Takes one from the account's budget and one from the courier's, inside the
 * caller's transaction, which holds the order's hash lock. The courier's row is
 * locked first, then the account's, so two requests never wait on each other
 * the other way round.
 */
export async function takeBudgets(client: pg.PoolClient, account: string, chainTime: bigint): Promise<BudgetVerdict> {
  const time = chainTime.toString();
  await client.query(
    `INSERT INTO accounts (account, budget, budget_at) VALUES ($1, $2, to_timestamp($3::bigint)) ON CONFLICT (account) DO NOTHING`,
    [COURIER_ROW, BOUNDS.courierBudget.atOnce, time],
  );
  await client.query(
    `INSERT INTO accounts (account, budget, budget_at) VALUES ($1, $2, to_timestamp($3::bigint)) ON CONFLICT (account) DO NOTHING`,
    [account, BOUNDS.accountBudget.atOnce, time],
  );
  const courier = await lockRow(client, COURIER_ROW);
  const own = await lockRow(client, account);
  const courierHeld = refilled(Number(courier.budget), BigInt(courier.at), chainTime, BOUNDS.courierBudget.atOnce, BOUNDS.courierBudget.perMinute);
  const ownHeld = refilled(Number(own.budget), BigInt(own.at), chainTime, BOUNDS.accountBudget.atOnce, BOUNDS.accountBudget.perMinute);
  // Every write keeps the newer of the row's time and this request's: the stored time never goes back.
  const refusedRow = `UPDATE accounts SET budget = $2, budget_at = GREATEST(budget_at, to_timestamp($3::bigint)), refused = refused + 1, last_refused_at = now() WHERE account = $1`;
  const takenRow = `UPDATE accounts SET budget = $2, budget_at = GREATEST(budget_at, to_timestamp($3::bigint)) WHERE account = $1`;
  if (ownHeld < 1) {
    await client.query(refusedRow, [account, ownHeld.toFixed(6), time]);
    return { ok: false, which: 'account', retryAfterSeconds: secondsUntilOne(ownHeld, BOUNDS.accountBudget.perMinute) };
  }
  if (courierHeld < 1) {
    await client.query(refusedRow, [COURIER_ROW, courierHeld.toFixed(6), time]);
    await client.query(takenRow, [account, ownHeld.toFixed(6), time]);
    return { ok: false, which: 'courier', retryAfterSeconds: secondsUntilOne(courierHeld, BOUNDS.courierBudget.perMinute) };
  }
  await client.query(takenRow, [COURIER_ROW, (courierHeld - 1).toFixed(6), time]);
  await client.query(takenRow, [account, (ownHeld - 1).toFixed(6), time]);
  return { ok: true };
}

async function lockRow(client: pg.PoolClient, account: string): Promise<Row> {
  const { rows } = await client.query<Row>(`SELECT account, budget::text AS budget, floor(extract(epoch FROM budget_at))::bigint::text AS at FROM accounts WHERE account = $1 FOR UPDATE`, [account]);
  const row = rows[0];
  if (row === undefined) throw new Error(`the accounts row ${account} was not there after its insert`);
  return row;
}

/** The sentence a request over a budget is answered with. */
export function budgetRefusal(which: 'account' | 'courier', retryAfterSeconds: number): string {
  const b = which === 'account' ? BOUNDS.accountBudget : BOUNDS.courierBudget;
  const whose = which === 'account' ? 'This account has used its budget of admitted requests' : "The courier has used its budget of admitted requests for all accounts together";
  return `${whose} (${b.atOnce.toLocaleString('en-US')} at once, ${b.perMinute} a minute after). Nothing was recorded. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`;
}
