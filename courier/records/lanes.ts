import type pg from 'pg';
import type { Address, Hex } from 'viem';
import type { EventLine } from './events';
import type { OrderRow } from './orders';

// The lanes table, as the bet's check uses it. One row a sender key. Owning a
// lane is a number, the epoch: the take at a start raises every lane's epoch
// and makes this run the owner, and every later step of the check locks its
// lane's row and writes only if the epoch and the reservation are still the
// ones this process holds. A lane holds one bet at a time.
//
// The order of locks every transaction here keeps: the lane's row, then the
// bet's row; a statement that locks several orders rows locks them in one
// statement, ascending by hash, FOR NO KEY UPDATE. No transaction here reads
// the chain or waits on another connection while it holds a lock.

export type Client = Pick<pg.PoolClient, 'query'>;

/** The take's result: every lane and its new epoch, this key's epoch, and the held bets it put back to waiting or finished as stopped. */
export interface Taken {
  epoch: bigint;
  lanes: Array<{ sender: string; epoch: string }>;
  returned: Hex[];
  stopped: Array<{ hash: Hex; account: string; gameId: string }>;
}

/**
 * The take, in one transaction the caller opened: this key's lane made if it is new; every lane's row locked in one
 * statement, in the order of the sender's address; every epoch raised by one and this run made the owner; then the
 * bets the lanes hold, locked in one statement ascending by hash and each judged on its row as it stands after any
 * wait: one not ended goes back to waiting; one a stop ended while it was held is finished as refused (its line is
 * the caller's, with STOPPED). Then every lane that holds a bet and no open Cross is freed.
 */
export async function take(on: Client, key: Address, run: number): Promise<Taken> {
  await on.query('INSERT INTO lanes (sender) VALUES ($1) ON CONFLICT DO NOTHING', [key.toLowerCase()]);
  await on.query('SELECT sender FROM lanes ORDER BY sender FOR UPDATE');
  const raised = await on.query<{ sender: string; epoch: string }>('UPDATE lanes SET epoch = epoch + 1, owner_run = $1 RETURNING sender, epoch::text AS epoch', [run]);
  const judged = await on.query<{ hash: Hex; bet_state: string; account: string; game_id: string }>(
    `WITH held AS (
       SELECT o.hash FROM orders o
       WHERE o.hash IN (SELECT l.held_bet FROM lanes l WHERE l.held_bet IS NOT NULL AND l.open_cross IS NULL)
       ORDER BY o.hash FOR NO KEY UPDATE
     )
     UPDATE orders o SET bet_state = CASE WHEN o.ended IS NULL THEN 'waiting' ELSE 'refused' END
     WHERE o.hash IN (SELECT h.hash FROM held h) AND o.bet_state = 'held'
     RETURNING o.hash, o.bet_state, o.account, o.game_id::text AS game_id`,
  );
  await on.query('UPDATE lanes SET held_bet = NULL, reservation = NULL, reserved_at = NULL WHERE held_bet IS NOT NULL AND open_cross IS NULL');
  const lanes = raised.rows.map((r) => ({ sender: r.sender, epoch: r.epoch })).sort((a, b) => (a.sender < b.sender ? -1 : 1));
  const mine = lanes.find((l) => l.sender === key.toLowerCase());
  if (mine === undefined) throw new Error('the take found no lane for its own key');
  return {
    epoch: BigInt(mine.epoch),
    lanes,
    returned: judged.rows.filter((r) => r.bet_state === 'waiting').map((r) => r.hash),
    stopped: judged.rows.filter((r) => r.bet_state === 'refused').map((r) => ({ hash: r.hash, account: r.account, gameId: r.game_id })),
  };
}

/** The lane's row, as a lane step reads it: the epoch, the reservation, what it holds, the line that shut it, and its watermark. */
export interface LaneRow {
  epoch: bigint;
  reservation: bigint | null;
  heldBet: Hex | null;
  openCross: Hex | null;
  /** The line that shut the lane, while it is shut; null while it is open. */
  shutLine: number | null;
  /** Every nonce below `to` explained at the anchor, a final block named by number and hash; no anchor before the first proof. */
  watermark: { to: bigint; anchor: { number: bigint; hash: Hex } | null };
}

const LANE_COLUMNS = `epoch::text AS epoch, reservation::text AS reservation, held_bet, open_cross, shut_line::text AS shut_line,
  verified_nonce_to::text AS verified_nonce_to, verified_block_number::text AS verified_block_number, verified_block_hash`;

function toLane(r: Record<string, unknown>): LaneRow {
  return {
    epoch: BigInt(String(r.epoch)),
    reservation: r.reservation === null ? null : BigInt(String(r.reservation)),
    heldBet: (r.held_bet as Hex | null) ?? null,
    openCross: (r.open_cross as Hex | null) ?? null,
    shutLine: r.shut_line === null ? null : Number(r.shut_line),
    watermark: {
      to: BigInt(String(r.verified_nonce_to)),
      anchor: r.verified_block_number === null ? null : { number: BigInt(String(r.verified_block_number)), hash: r.verified_block_hash as Hex },
    },
  };
}

/** The lane's row under its lock: FOR UPDATE for a lane step. */
export async function lockLane(on: Client, key: Address): Promise<LaneRow | null> {
  const { rows } = await on.query(`SELECT ${LANE_COLUMNS} FROM lanes WHERE sender = $1 FOR UPDATE`, [key.toLowerCase()]);
  return rows[0] === undefined ? null : toLane(rows[0] as Record<string, unknown>);
}

/** The lane's row read with no lock, as the send's own checks read it before deciding: what a step decides is decided again under the lock. */
export async function readLane(on: Client, key: Address): Promise<LaneRow | null> {
  const { rows } = await on.query(`SELECT ${LANE_COLUMNS} FROM lanes WHERE sender = $1`, [key.toLowerCase()]);
  return rows[0] === undefined ? null : toLane(rows[0] as Record<string, unknown>);
}

/** The watermark raised to the count at a final block, that block its anchor: only from the watermark the proof read. True where it moved. */
export async function raiseWatermark(on: Client, key: Address, from: LaneRow['watermark'], to: LaneRow['watermark']): Promise<boolean> {
  if (to.anchor === null) throw new Error('a watermark rises only at a final block');
  const { rowCount } = await on.query(
    `UPDATE lanes SET verified_nonce_to = $2, verified_block_number = $3, verified_block_hash = $4
     WHERE sender = $1 AND verified_nonce_to = $5 AND verified_block_hash IS NOT DISTINCT FROM $6`,
    [key.toLowerCase(), to.to.toString(), to.anchor.number.toString(), to.anchor.hash.toLowerCase(), from.to.toString(), from.anchor === null ? null : from.anchor.hash.toLowerCase()],
  );
  return (rowCount ?? 0) === 1;
}

/** The lane shut by a line, where it is open: the line that opened cross-unreconciled. */
export async function shutLane(on: Client, key: Address, line: number): Promise<void> {
  await on.query('UPDATE lanes SET shut_line = $2 WHERE sender = $1 AND shut_line IS NULL', [key.toLowerCase(), line]);
}

/** The held bet back to waiting and the lane freed: a send that cannot go on now and has signed nothing. True where the bet was held. */
export async function putBack(on: Client, key: Address, hash: Hex): Promise<boolean> {
  const { rowCount } = await on.query(`UPDATE orders SET bet_state = 'waiting' WHERE hash = $1 AND bet_state = 'held'`, [hash.toLowerCase()]);
  await on.query('UPDATE lanes SET held_bet = NULL, reservation = NULL, reserved_at = NULL WHERE sender = $1', [key.toLowerCase()]);
  return (rowCount ?? 0) === 1;
}

/** The lane's row as it stands, for the status: the run that owns it and its epoch, read with no lock, or null where the lane has no row. */
export async function laneNow(on: Client, key: Address): Promise<{ ownerRun: number | null; epoch: bigint } | null> {
  const { rows } = await on.query<{ owner_run: string | null; epoch: string }>('SELECT owner_run::text AS owner_run, epoch::text AS epoch FROM lanes WHERE sender = $1', [key.toLowerCase()]);
  const r = rows[0];
  if (r === undefined) return null;
  return { ownerRun: r.owner_run === null ? null : Number(r.owner_run), epoch: BigInt(r.epoch) };
}

/** Check 17's read, in the door's transaction: the lane's epoch under a share lock, or null where the lane has no row. */
export async function shareLane(on: Client, key: Address): Promise<bigint | null> {
  const { rows } = await on.query<{ epoch: string }>('SELECT epoch::text AS epoch FROM lanes WHERE sender = $1 FOR SHARE', [key.toLowerCase()]);
  return rows[0] === undefined ? null : BigInt(rows[0].epoch);
}

/** The reservation's guarded update: the bet becomes held only if it is still a waiting bet no stop has ended, judged on the row after any wait. True where it took it. */
export async function holdBet(on: Client, hash: Hex): Promise<boolean> {
  const { rowCount } = await on.query(`UPDATE orders SET bet_state = 'held' WHERE hash = $1 AND role = 'take' AND bet_state = 'waiting' AND ended IS NULL`, [hash.toLowerCase()]);
  return (rowCount ?? 0) === 1;
}

/** The lane holds the bet, under a new reservation number and the transaction's time. Returns the reservation. */
export async function reserve(on: Client, key: Address, hash: Hex): Promise<bigint> {
  const { rows } = await on.query<{ reservation: string }>(
    `UPDATE lanes SET held_bet = $2, reservation = nextval('lane_reservations'), reserved_at = now() WHERE sender = $1 RETURNING reservation::text AS reservation`,
    [key.toLowerCase(), hash.toLowerCase()],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('the lane to reserve has no row');
  return BigInt(r.reservation);
}

/** The bet's row read again under its lock, the lock its update takes: whether a stop has ended it. */
export async function lockBet(on: Client, hash: Hex): Promise<{ ended: OrderRow['ended']; betState: OrderRow['betState'] } | null> {
  const { rows } = await on.query<{ ended: OrderRow['ended']; bet_state: OrderRow['betState'] }>('SELECT ended, bet_state FROM orders WHERE hash = $1 FOR NO KEY UPDATE', [hash.toLowerCase()]);
  const r = rows[0];
  return r === undefined ? null : { ended: r.ended, betState: r.bet_state };
}

/** The bet's stage, written with its outcome. */
export async function setBetState(on: Client, hash: Hex, state: 'refused' | 'lapsed' | 'sent'): Promise<void> {
  await on.query('UPDATE orders SET bet_state = $2 WHERE hash = $1', [hash.toLowerCase(), state]);
}

/** The lane freed: the bet, the reservation and its time emptied together. */
export async function free(on: Client, key: Address): Promise<void> {
  await on.query('UPDATE lanes SET held_bet = NULL, reservation = NULL, reserved_at = NULL WHERE sender = $1', [key.toLowerCase()]);
}

/** One leg of a Cross as it is written. */
export interface LegRow {
  orderHash: Hex;
  makerRisk: bigint;
  takerRisk: bigint;
}

/** The verdict a bet's record shows, read from its outcome's line along `events_bet_lines`. */
export interface VerdictLine {
  kind: 'bet refused' | 'bet lapsed' | 'cross not sent';
  reason: string | null;
  at: Date;
  facts: Record<string, unknown>;
}

/** The bet's first outcome line, along `events_bet_lines`: the one line of its outcome, which is written once. */
export async function verdictLine(on: Pick<pg.Pool, 'query'>, betHash: Hex): Promise<VerdictLine | null> {
  const { rows } = await on.query<{ kind: VerdictLine['kind']; reason: string | null; at: Date; facts: Record<string, unknown> }>(
    `SELECT kind, reason, at, facts FROM events WHERE bet_hash = $1 AND kind IN ('bet refused', 'bet lapsed', 'cross not sent') ORDER BY number LIMIT 1`,
    [betHash.toLowerCase()],
  );
  return rows[0] ?? null;
}

/** A bet's Cross, as its record shows it: the row and its legs. Null where it has none. */
export async function crossOf(
  on: Pick<pg.Pool, 'query'>,
  betHash: Hex,
): Promise<{ state: string; handOffs: number; reason: string | null; block: { number: string; hash: Hex; time: string }; checked: Record<string, unknown>; legs: Array<{ position: number; orderHash: Hex; makerRisk: string; takerRisk: string; account: string; oddsTick: number }> } | null> {
  const { rows } = await on.query<{ state: string; hand_offs: number; not_sent_reason: string | null; block_number: string; block_hash: Hex; block_time: string; checked: Record<string, unknown> }>(
    `SELECT state, hand_offs, not_sent_reason, block_number::text AS block_number, block_hash, block_time::text AS block_time, checked FROM crosses WHERE bet_hash = $1`,
    [betHash.toLowerCase()],
  );
  const c = rows[0];
  if (c === undefined) return null;
  const legs = await on.query<{ position: number; order_hash: Hex; expected_maker_risk: string; expected_taker_risk: string; account: string; odds_tick: number }>(
    `SELECT l.position, l.order_hash, l.expected_maker_risk::text AS expected_maker_risk, l.expected_taker_risk::text AS expected_taker_risk, o.account, o.odds_tick
     FROM legs l JOIN orders o ON o.hash = l.order_hash WHERE l.bet_hash = $1 ORDER BY l.position`,
    [betHash.toLowerCase()],
  );
  return {
    state: c.state,
    handOffs: Number(c.hand_offs),
    reason: c.not_sent_reason,
    block: { number: c.block_number, hash: c.block_hash, time: c.block_time },
    checked: c.checked,
    legs: legs.rows.map((l) => ({ position: Number(l.position), orderHash: l.order_hash, makerRisk: l.expected_maker_risk, takerRisk: l.expected_taker_risk, account: l.account, oddsTick: Number(l.odds_tick) })),
  };
}

export type { EventLine };
