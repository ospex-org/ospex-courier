import type pg from 'pg';
import type { Address, Hex } from 'viem';
import type { LegRow } from './lanes';

// A Cross's row, as the sender writes it: the intent, the signed record, the
// gate's mark or its stop, the node's answer, and the outcome. Each write is a
// statement of a transaction the caller opened under the lane's guards (the
// lane's row locked, its epoch and reservation checked), and each moves the row
// only from the state it expects: a write that finds the row elsewhere changes
// nothing and says so. The times decide nothing.

export type Client = Pick<pg.PoolClient, 'query'>;

/** The Cross's row as the sender reads it back. */
export interface CrossRow {
  betHash: Hex;
  lane: Address;
  epoch: bigint;
  reservation: bigint;
  block: { number: bigint; hash: Hex; time: bigint };
  sender: Address | null;
  nonce: bigint | null;
  gasLimit: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFee: bigint | null;
  txHash: Hex | null;
  state: CrossState;
  handOffs: number;
  nodeAnswer: Record<string, unknown> | null;
  receipt: { number: bigint; hash: Hex } | null;
  final: { number: bigint; hash: Hex } | null;
  replacedBy: Hex | null;
  replacedByOurs: boolean | null;
  revertReason: string | null;
  revertEvidence: 'trace' | 'unavailable' | null;
  revertData: Hex | null;
  notSentReason: NotSentReason | null;
  gasUsed: bigint | null;
  effectiveGasPrice: bigint | null;
  checked: Record<string, unknown>;
  recorded: Record<string, unknown> | null;
  times: { intentAt: Date | null; signedAt: Date | null; gateAt: Date | null; answeredAt: Date | null; receiptSeenAt: Date | null; outcomeAt: Date | null };
}

export type CrossState = 'intent' | 'signed' | 'handing off' | 'sent' | 'pending' | 'confirmed' | 'reverted' | 'unknown' | 'not sent' | 'expired unmined' | 'replaced';
export type NotSentReason = 'STOPPED_AT_GATE' | 'COURIER_RESTARTED' | 'NODE_REFUSED';

/** The states that are final: a Cross in one of them holds its lane no longer. */
export const FINAL_STATES: readonly CrossState[] = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];

const COLUMNS = `bet_hash, lane, epoch::text AS epoch, reservation::text AS reservation, block_number::text AS block_number, block_hash, block_time::text AS block_time,
  sender, nonce::text AS nonce, gas_limit::text AS gas_limit, max_fee_per_gas::text AS max_fee_per_gas, max_priority_fee::text AS max_priority_fee, tx_hash, state, hand_offs, node_answer,
  receipt_block_number::text AS receipt_block_number, receipt_block_hash, final_block_number::text AS final_block_number, final_block_hash, replaced_by, replaced_by_ours,
  revert_reason, revert_evidence, revert_data, not_sent_reason, gas_used::text AS gas_used, effective_gas_price::text AS effective_gas_price, checked, recorded,
  intent_at, signed_at, gate_at, answered_at, receipt_seen_at, outcome_at`;

const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(String(v)));

export function toCross(r: Record<string, unknown>): CrossRow {
  return {
    betHash: r.bet_hash as Hex,
    lane: r.lane as Address,
    epoch: BigInt(String(r.epoch)),
    reservation: BigInt(String(r.reservation)),
    block: { number: BigInt(String(r.block_number)), hash: r.block_hash as Hex, time: BigInt(String(r.block_time)) },
    sender: (r.sender as Address | null) ?? null,
    nonce: big(r.nonce),
    gasLimit: big(r.gas_limit),
    maxFeePerGas: big(r.max_fee_per_gas),
    maxPriorityFee: big(r.max_priority_fee),
    txHash: (r.tx_hash as Hex | null) ?? null,
    state: r.state as CrossState,
    handOffs: Number(r.hand_offs),
    nodeAnswer: (r.node_answer as Record<string, unknown> | null) ?? null,
    receipt: r.receipt_block_number === null ? null : { number: BigInt(String(r.receipt_block_number)), hash: r.receipt_block_hash as Hex },
    final: r.final_block_number === null ? null : { number: BigInt(String(r.final_block_number)), hash: r.final_block_hash as Hex },
    replacedBy: (r.replaced_by as Hex | null) ?? null,
    replacedByOurs: (r.replaced_by_ours as boolean | null) ?? null,
    revertReason: (r.revert_reason as string | null) ?? null,
    revertEvidence: (r.revert_evidence as 'trace' | 'unavailable' | null) ?? null,
    revertData: (r.revert_data as Hex | null) ?? null,
    notSentReason: (r.not_sent_reason as NotSentReason | null) ?? null,
    gasUsed: big(r.gas_used),
    effectiveGasPrice: big(r.effective_gas_price),
    checked: (r.checked as Record<string, unknown>) ?? {},
    recorded: (r.recorded as Record<string, unknown> | null) ?? null,
    times: {
      intentAt: (r.intent_at as Date | null) ?? null,
      signedAt: (r.signed_at as Date | null) ?? null,
      gateAt: (r.gate_at as Date | null) ?? null,
      answeredAt: (r.answered_at as Date | null) ?? null,
      receiptSeenAt: (r.receipt_seen_at as Date | null) ?? null,
      outcomeAt: (r.outcome_at as Date | null) ?? null,
    },
  };
}

/** The Cross's row, read with no lock (a record, the status), or null. */
export async function crossRow(on: Pick<pg.Pool, 'query'> | Client, betHash: Hex): Promise<CrossRow | null> {
  const { rows } = await on.query(`SELECT ${COLUMNS} FROM crosses WHERE bet_hash = $1`, [betHash.toLowerCase()]);
  return rows[0] === undefined ? null : toCross(rows[0] as Record<string, unknown>);
}

/** The Cross's row under its lock, in a transaction that already holds the lane's row: the lock order's sixth kind. */
export async function lockCross(on: Client, betHash: Hex): Promise<CrossRow | null> {
  const { rows } = await on.query(`SELECT ${COLUMNS} FROM crosses WHERE bet_hash = $1 FOR UPDATE`, [betHash.toLowerCase()]);
  return rows[0] === undefined ? null : toCross(rows[0] as Record<string, unknown>);
}

/** The intent: the Cross's row and its legs as expected, the lane's open Cross set, the bet's stage sent. */
export async function writeIntent(
  on: Client,
  c: { betHash: Hex; lane: Address; epoch: bigint; reservation: bigint; block: { number: bigint; hash: Hex; time: bigint }; checked: Record<string, unknown>; legs: LegRow[] },
): Promise<void> {
  await on.query(
    `INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, state, hand_offs, checked, intent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'intent', 0, $8, now())`,
    [c.betHash.toLowerCase(), c.lane.toLowerCase(), c.epoch.toString(), c.reservation.toString(), c.block.number.toString(), c.block.hash.toLowerCase(), c.block.time.toString(), JSON.stringify(c.checked)],
  );
  await on.query(
    `INSERT INTO legs (bet_hash, position, order_hash, expected_maker_risk, expected_taker_risk)
     SELECT $1, l.position, l.order_hash, l.maker::numeric, l.taker::numeric
     FROM unnest($2::smallint[], $3::text[], $4::text[], $5::text[]) AS l(position, order_hash, maker, taker)`,
    [c.betHash.toLowerCase(), c.legs.map((_, i) => i), c.legs.map((l) => l.orderHash.toLowerCase()), c.legs.map((l) => l.makerRisk.toString()), c.legs.map((l) => l.takerRisk.toString())],
  );
  await on.query('UPDATE lanes SET open_cross = $2 WHERE sender = $1', [c.lane.toLowerCase(), c.betHash.toLowerCase()]);
  await on.query(`UPDATE orders SET bet_state = 'sent' WHERE hash = $1`, [c.betHash.toLowerCase()]);
}

/** The signed record: what was signed, and its hash. From the intent only. True where it moved the row. */
export async function writeSigned(on: Client, betHash: Hex, s: { sender: Address; nonce: bigint; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFee: bigint; txHash: Hex }): Promise<boolean> {
  const { rowCount } = await on.query(
    `UPDATE crosses SET state = 'signed', sender = $2, nonce = $3, gas_limit = $4, max_fee_per_gas = $5, max_priority_fee = $6, tx_hash = $7, signed_at = now(), updated_at = now()
     WHERE bet_hash = $1 AND state = 'intent'`,
    [betHash.toLowerCase(), s.sender.toLowerCase(), s.nonce.toString(), s.gasLimit.toString(), s.maxFeePerGas.toString(), s.maxPriorityFee.toString(), s.txHash.toLowerCase()],
  );
  return (rowCount ?? 0) === 1;
}

/** The gate's mark: handing off, handed once, from the signed record only. True where it moved the row. */
export async function markHandingOff(on: Client, betHash: Hex): Promise<boolean> {
  const { rowCount } = await on.query(`UPDATE crosses SET state = 'handing off', hand_offs = 1, gate_at = now(), updated_at = now() WHERE bet_hash = $1 AND state = 'signed'`, [betHash.toLowerCase()]);
  return (rowCount ?? 0) === 1;
}

/** A Cross closed not sent before the gate let it through: a stop at the gate, or a restart before it; never handed off. From the states before the gate only. */
export async function closeBeforeGate(on: Client, betHash: Hex, reason: 'STOPPED_AT_GATE' | 'COURIER_RESTARTED'): Promise<boolean> {
  const { rowCount } = await on.query(
    `UPDATE crosses SET state = 'not sent', not_sent_reason = $2, hand_offs = 0, outcome_at = now(), updated_at = now() WHERE bet_hash = $1 AND state IN ('intent', 'signed')`,
    [betHash.toLowerCase(), reason],
  );
  return (rowCount ?? 0) === 1;
}

/** The node's answer to the one hand-off, from handing off only: sent, not sent by the node's named refusal, or unknown. */
export async function writeAnswer(on: Client, betHash: Hex, answer: { kind: 'taken' } | { kind: 'refused'; words: string } | { kind: 'unknown' }): Promise<boolean> {
  const state = answer.kind === 'taken' ? 'sent' : answer.kind === 'refused' ? 'not sent' : 'unknown';
  const { rowCount } = await on.query(
    `UPDATE crosses SET state = $2, not_sent_reason = $3, node_answer = $4, answered_at = now(), outcome_at = CASE WHEN $2 = 'not sent' THEN now() ELSE outcome_at END, updated_at = now()
     WHERE bet_hash = $1 AND state = 'handing off'`,
    [betHash.toLowerCase(), state, answer.kind === 'refused' ? 'NODE_REFUSED' : null, JSON.stringify(answer)],
  );
  return (rowCount ?? 0) === 1;
}

/** The lane freed of its bet and its open Cross together. */
export async function freeLaneOfCross(on: Client, lane: Address): Promise<void> {
  await on.query('UPDATE lanes SET held_bet = NULL, reservation = NULL, reserved_at = NULL, open_cross = NULL WHERE sender = $1', [lane.toLowerCase()]);
}

/**
 * A key's Crosses that bear on its nonces from `fromNonce` up, oldest nonce first: one range of the key's index on its
 * sender and nonce. The nonces below the lane's watermark were explained at an earlier final block and are not read
 * again, so an ordinary read stays the same size as the history grows.
 */
export async function crossesOfKey(on: Pick<pg.Pool, 'query'> | Client, sender: Address, fromNonce: bigint): Promise<CrossRow[]> {
  const { rows } = await on.query(`SELECT ${COLUMNS} FROM crosses c WHERE c.sender = $1 AND c.nonce >= $2 ORDER BY c.nonce, c.bet_hash`, [sender.toLowerCase(), fromNonce.toString()]);
  return rows.map((r) => toCross(r as Record<string, unknown>));
}

/** The key's Crosses at one nonce: what a replacement's fees rise over, and what a search's find is held against. */
export async function crossesAtNonce(on: Pick<pg.Pool, 'query'> | Client, sender: Address, nonce: bigint): Promise<CrossRow[]> {
  const { rows } = await on.query(`SELECT ${COLUMNS} FROM crosses c WHERE c.sender = $1 AND c.nonce = $2 ORDER BY c.bet_hash`, [sender.toLowerCase(), nonce.toString()]);
  return rows.map((r) => toCross(r as Record<string, unknown>));
}

/** Where a hand-off stood, as a stop's answer gives it: the transaction, its state for the maker, the bet's hash, and the block once a receipt is seen. */
export interface HandOffAnswer {
  txHash: Hex;
  state: 'sent' | 'pending' | 'uncertain';
  bet: Hex;
  block?: { number: string; hash: Hex };
}

/**
 * The hand-off of the Cross that names each of these orders, by the bet or by a leg, through the gate and not yet
 * final: found from the lanes' open Cross, joined to its legs by the bet's hash, a handful of rows. A Cross not yet
 * through the gate, and one already final, give none. An answer recorded as `unknown` is no answer: it reads
 * `uncertain`, as a Cross handing off with no answer on record does.
 */
export async function handOffsNaming(on: Pick<pg.Pool, 'query'> | Client, hashes: readonly Hex[]): Promise<Map<string, HandOffAnswer>> {
  const out = new Map<string, HandOffAnswer>();
  if (hashes.length === 0) return out;
  const { rows } = await on.query<{ bet_hash: Hex; tx_hash: Hex | null; state: CrossState; receipt_block_number: string | null; receipt_block_hash: Hex | null; order_hash: Hex | null }>(
    `SELECT c.bet_hash, c.tx_hash, c.state, c.receipt_block_number::text AS receipt_block_number, c.receipt_block_hash, g.order_hash
     FROM lanes l
     JOIN crosses c ON c.bet_hash = l.open_cross
     LEFT JOIN legs g ON g.bet_hash = c.bet_hash
     WHERE l.open_cross IS NOT NULL AND c.state IN ('handing off', 'sent', 'pending', 'unknown')`,
  );
  const wanted = new Set(hashes.map((h) => h.toLowerCase()));
  for (const r of rows) {
    if (r.tx_hash === null) continue;
    const answer: HandOffAnswer = {
      txHash: r.tx_hash,
      state: r.state === 'sent' ? 'sent' : r.state === 'pending' ? 'pending' : 'uncertain',
      bet: r.bet_hash,
      ...(r.state === 'pending' && r.receipt_block_number !== null && r.receipt_block_hash !== null ? { block: { number: r.receipt_block_number, hash: r.receipt_block_hash } } : {}),
    };
    for (const h of [r.bet_hash, r.order_hash]) if (h !== null && wanted.has(h.toLowerCase()) && !out.has(h.toLowerCase())) out.set(h.toLowerCase(), answer);
  }
  return out;
}

/** A block named by its number and hash, as an outcome writes it. */
export interface BlockNamed {
  number: bigint;
  hash: Hex;
}

/** The open states a look can move from: at or past the gate, not final. */
const OPEN_STATES = `('handing off', 'sent', 'pending', 'unknown')`;

/** A receipt seen above F: pending, from an open state. True where the row moved. */
export async function writePending(on: Client, betHash: Hex, receipt: BlockNamed): Promise<boolean> {
  const { rowCount } = await on.query(
    `UPDATE crosses SET state = 'pending', receipt_block_number = $2, receipt_block_hash = $3, receipt_seen_at = coalesce(receipt_seen_at, now()), updated_at = now()
     WHERE bet_hash = $1 AND state IN ${OPEN_STATES}
       AND (state <> 'pending' OR receipt_block_hash IS DISTINCT FROM $3)`,
    [betHash.toLowerCase(), receipt.number.toString(), receipt.hash.toLowerCase()],
  );
  return (rowCount ?? 0) === 1;
}

/** A pending Cross whose receipt is an orphan's: back to sent where the node's answer took it, or to unknown where no answer is on record. Returns the state it went back to, or null. */
export async function writeOrphaned(on: Client, betHash: Hex): Promise<'sent' | 'unknown' | null> {
  const { rows } = await on.query<{ state: 'sent' | 'unknown' }>(
    `UPDATE crosses SET state = CASE WHEN node_answer->>'kind' = 'taken' THEN 'sent' ELSE 'unknown' END,
       receipt_block_number = NULL, receipt_block_hash = NULL, updated_at = now()
     WHERE bet_hash = $1 AND state = 'pending' RETURNING state`,
    [betHash.toLowerCase()],
  );
  return rows[0]?.state ?? null;
}

/** A final outcome of an open Cross: what the chain showed, at the final block that showed it. */
export interface FinalOutcome {
  state: 'confirmed' | 'reverted' | 'expired unmined' | 'replaced';
  final: BlockNamed;
  receipt?: BlockNamed;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  replacedBy?: Hex;
  replacedByOurs?: boolean;
  revert?: { reason: string; evidence: 'trace' | 'unavailable'; data: Hex | null };
  recorded: Record<string, unknown>;
  /** The legs as the chain recorded them, by position: filled with the two stakes, or skipped with the contract's reason. */
  legs?: Array<{ position: number; makerRisk: bigint | null; takerRisk: bigint | null; skip: string | null }>;
  /** A restored intent's transaction, found by the recovery's search: the key, the nonce and the hash, written with the outcome. */
  associate?: { sender: Address; nonce: bigint; txHash: Hex };
}

/** The longest revert data kept: whole bytes, 32,768 hex digits. */
const REVERT_DATA_DIGITS = 32_768;

/** The outcome written: the Cross's row from an open state (or, for `reverted` alone, from `expired unmined`), and its legs. True where the row moved. */
export async function writeFinal(on: Client, betHash: Hex, o: FinalOutcome, from: 'open' | 'expired unmined' | 'intent' = 'open'): Promise<boolean> {
  const data = o.revert?.data ?? null;
  const digits = data === null ? '' : data.slice(2, 2 + REVERT_DATA_DIGITS);
  const kept = data === null ? null : (`0x${digits.slice(0, digits.length - (digits.length % 2))}` as Hex);
  const { rowCount } = await on.query(
    `UPDATE crosses SET state = $2, final_block_number = $3, final_block_hash = $4,
       receipt_block_number = coalesce($5::numeric, receipt_block_number), receipt_block_hash = coalesce($6::text, receipt_block_hash),
       receipt_seen_at = CASE WHEN $5::numeric IS NULL THEN receipt_seen_at ELSE coalesce(receipt_seen_at, now()) END,
       gas_used = $7, effective_gas_price = $8, replaced_by = $9, replaced_by_ours = $10,
       revert_reason = $11, revert_evidence = $12, revert_data = $13, recorded = $14, outcome_at = now(), updated_at = now(),
       sender = coalesce($15, sender), nonce = coalesce($16::bigint, nonce), tx_hash = coalesce($17, tx_hash)
     WHERE bet_hash = $1 AND ${from === 'open' ? `state IN ${OPEN_STATES}` : from === 'intent' ? `state = 'intent'` : `state = 'expired unmined'`}`,
    [
      betHash.toLowerCase(),
      o.state,
      o.final.number.toString(),
      o.final.hash.toLowerCase(),
      o.receipt?.number.toString() ?? null,
      o.receipt?.hash.toLowerCase() ?? null,
      o.gasUsed?.toString() ?? null,
      o.effectiveGasPrice?.toString() ?? null,
      o.replacedBy?.toLowerCase() ?? null,
      o.replacedByOurs ?? null,
      o.revert?.reason ?? null,
      o.revert?.evidence ?? null,
      kept,
      JSON.stringify(o.recorded),
      o.associate?.sender.toLowerCase() ?? null,
      o.associate?.nonce.toString() ?? null,
      o.associate?.txHash.toLowerCase() ?? null,
    ],
  );
  if ((rowCount ?? 0) !== 1) return false;
  if (o.legs !== undefined && o.legs.length > 0) {
    await on.query(
      `UPDATE legs AS g SET recorded_maker_risk = l.maker::numeric, recorded_taker_risk = l.taker::numeric, skip_reason = l.skip
       FROM unnest($2::smallint[], $3::text[], $4::text[], $5::text[]) AS l(position, maker, taker, skip)
       WHERE g.bet_hash = $1 AND g.position = l.position`,
      [betHash.toLowerCase(), o.legs.map((l) => l.position), o.legs.map((l) => l.makerRisk?.toString() ?? null), o.legs.map((l) => l.takerRisk?.toString() ?? null), o.legs.map((l) => l.skip)],
    );
  }
  return true;
}

/** The lane freed of its bet and its open Cross, where that Cross is this one. */
export async function freeLaneOf(on: Client, lane: Address, betHash: Hex): Promise<void> {
  await on.query('UPDATE lanes SET held_bet = NULL, reservation = NULL, reserved_at = NULL, open_cross = NULL WHERE sender = $1 AND open_cross = $2', [lane.toLowerCase(), betHash.toLowerCase()]);
}

/** The legs of a bet's Cross, in list order, with each quote's account and stake: what a look expects of the receipt, and what the marks at F need. */
export async function legsOf(on: Pick<pg.Pool, 'query'> | Client, betHash: Hex): Promise<Array<{ position: number; orderHash: Hex; account: Address; riskAmount: bigint }>> {
  const { rows } = await on.query<{ position: number; order_hash: Hex; account: Address; risk_amount: string }>(
    `SELECT l.position, l.order_hash, o.account, o.risk_amount::text AS risk_amount FROM legs l JOIN orders o ON o.hash = l.order_hash WHERE l.bet_hash = $1 ORDER BY l.position`,
    [betHash.toLowerCase()],
  );
  return rows.map((r) => ({ position: Number(r.position), orderHash: r.order_hash, account: r.account, riskAmount: BigInt(r.risk_amount) }));
}

/**
 * An ACTION line, once for each bet and case, under the bet's serialization: the bet's row locked, and the events'
 * unique index on the bet and the case as the durable guard. A repeated look, a duplicate request, a restart or a
 * competing worker writes no second line. Returns the line's number, or null where one stands.
 */
export async function writeActionOnce(
  on: Client,
  line: { run: number; betHash: Hex; account: string; gameId: bigint; reason: string; facts: Record<string, unknown> & { action: { case: string; evidence: Record<string, unknown>; unknown: string[] } } },
): Promise<number | null> {
  await on.query('SELECT hash FROM orders WHERE hash = $1 FOR NO KEY UPDATE', [line.betHash.toLowerCase()]);
  const { rows } = await on.query<{ number: string }>(
    `INSERT INTO events (run, kind, order_hash, bet_hash, account, game_id, reason, facts)
     VALUES ($1, 'incident', $2, $2, $3, $4, $5, $6)
     ON CONFLICT (bet_hash, ((facts->'action'->>'case'))) WHERE facts ? 'action' DO NOTHING
     RETURNING number::text AS number`,
    [line.run, line.betHash.toLowerCase(), line.account.toLowerCase(), line.gameId.toString(), line.reason, JSON.stringify(line.facts)],
  );
  return rows[0] === undefined ? null : Number(rows[0].number);
}

/** A bet's legs as its record serves them: the expected stakes, and what the chain recorded where it has. */
export async function legsForRecord(on: Pick<pg.Pool, 'query'>, betHash: Hex): Promise<Array<{ position: number; orderHash: Hex; account: string; oddsTick: number; makerRisk: string; takerRisk: string; recordedMakerRisk: string | null; recordedTakerRisk: string | null; skip: string | null }>> {
  const { rows } = await on.query<{ position: number; order_hash: Hex; account: string; odds_tick: number; m: string; t: string; rm: string | null; rt: string | null; skip_reason: string | null }>(
    `SELECT l.position, l.order_hash, o.account, o.odds_tick, l.expected_maker_risk::text AS m, l.expected_taker_risk::text AS t,
            l.recorded_maker_risk::text AS rm, l.recorded_taker_risk::text AS rt, l.skip_reason
     FROM legs l JOIN orders o ON o.hash = l.order_hash WHERE l.bet_hash = $1 ORDER BY l.position`,
    [betHash.toLowerCase()],
  );
  return rows.map((r) => ({ position: Number(r.position), orderHash: r.order_hash, account: r.account, oddsTick: Number(r.odds_tick), makerRisk: r.m, takerRisk: r.t, recordedMakerRisk: r.rm, recordedTakerRisk: r.rt, skip: r.skip_reason }));
}

/** Whether a Cross is reconciled: false while cross-unreconciled holds it, its condition open and naming this bet. */
export async function reconciledOf(on: Pick<pg.Pool, 'query'>, betHash: Hex): Promise<boolean> {
  const { rowCount } = await on.query(`SELECT 1 FROM conditions WHERE key = 'cross-unreconciled' AND cleared_at IS NULL AND lower(facts->>'betHash') = $1`, [betHash.toLowerCase()]);
  return (rowCount ?? 0) === 0;
}
