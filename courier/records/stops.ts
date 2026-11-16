import type pg from 'pg';
import type { Address, Hex } from 'viem';

// The stops table and the stop_messages table: one row per order hash a stop
// stopped, and one row per message that stopped at least one. A stop is
// permanent for its hash: a row is written once and never removed. A stop
// recorded ahead of its order keeps the order's signed original; the one
// statement that names that column is the insert below, and no statement here
// reads it back, since nothing lists, serves or fills it.

export type Writer = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** What the records hold for an order hash a stop names: the order's row where it is carried, the stop's where it is stopped. */
export interface Looked {
  /** The carried orders among the hashes, by hash. */
  orders: Map<string, { account: string; nonce: bigint; role: 'rest' | 'take'; ended: string | null; betState: string | null }>;
  /** The hashes among them that hold a stop, by hash. */
  stops: Map<string, { account: string; ahead: boolean }>;
}

/** The block a stop message's chain read was made at. */
export interface BlockNamed {
  number: bigint;
  hash: Hex;
  time: bigint;
}

export interface NewStopMessage {
  account: Address;
  /** The address the message's signature recovered to: the account, or its agent. */
  signer: Address;
  /** The payload kept, written as it is given: the caller gives what was signed, {account, orderHashes}, and nothing else. */
  message: { account: Address; orderHashes: Hex[] };
  signature: Hex;
  /** The block the chain was read at for the message, or null where it was not read. */
  block: BlockNamed | null;
}

export interface NewStop {
  hash: Hex;
  /** Recorded ahead of its order: the signed original, the second it can fill no more from, and the number of the grant it was signed under (0 for the account's own signature). Null for a carried order's stop. */
  ahead: { original: { order: Record<string, string | number>; signature: Hex }; originalExpiry: bigint; grantNumber: number } | null;
}

/**
 * The count of an account's stops ahead that still count against its bound: the ones whose original has not expired
 * ($2 is the chain's time plus one) and that are the account's own signature or under its current grant ($3). One
 * range of `stops_ahead_by_account`, the account's stops ahead from the latest original_expiry down to $2: what it
 * reads is the account's stops ahead whose originals have not expired, whatever else the table holds.
 */
export const AHEAD_COUNT_SQL = `SELECT count(*) AS standing FROM stops s
  WHERE s.account = $1 AND s.ahead AND s.original_expiry > $2::numeric AND (s.grant_number = 0 OR s.grant_number = $3::bigint)`;

export interface Stops {
  /** The orders and the stops on record for these hashes: two statements, each one probe a hash along a primary key. */
  lookup(on: Writer, hashes: readonly Hex[]): Promise<Looked>;
  /** Writes the message's one row and returns its number. */
  insertMessage(on: Writer, message: NewStopMessage): Promise<number>;
  /** Writes one row a stopped hash, each pointing at the message. The caller's transaction holds every hash's lock. */
  insertStops(on: Writer, account: Address, messageId: number, stops: readonly NewStop[]): Promise<void>;
  /**
   * Marks the carried orders among the hashes `stopped`, the ones not ended already; returns the hashes it marked.
   * An order that ended another way first keeps that end: its stop row alone makes the stop permanent.
   */
  markStopped(on: Writer, hashes: readonly Hex[]): Promise<Hex[]>;
  /** The account's stops ahead that still count against its bound: see AHEAD_COUNT_SQL. */
  aheadCount(on: Writer, account: Address, afterTime: bigint, currentGrant: number): Promise<number>;
  /** When a hash was stopped ahead of its order, or null where it holds no such stop. The original is not read. */
  aheadOf(hash: Hex, on?: Writer): Promise<Date | null>;
}

export function createStops(pool: pg.Pool): Stops {
  return {
    async lookup(on, hashes) {
      const wanted = hashes.map((h) => h.toLowerCase());
      const orders = await on.query<{ hash: string; account: string; nonce: string; role: 'rest' | 'take'; ended: string | null; bet_state: string | null }>(
        `SELECT o.hash, o.account, o.nonce, o.role, o.ended, o.bet_state FROM orders o WHERE o.hash = ANY($1::text[])`,
        [wanted],
      );
      const stops = await on.query<{ hash: string; account: string; ahead: boolean }>(`SELECT s.hash, s.account, s.ahead FROM stops s WHERE s.hash = ANY($1::text[])`, [wanted]);
      return {
        orders: new Map(orders.rows.map((r) => [r.hash, { account: r.account, nonce: BigInt(r.nonce), role: r.role, ended: r.ended, betState: r.bet_state }])),
        stops: new Map(stops.rows.map((r) => [r.hash, { account: r.account, ahead: r.ahead }])),
      };
    },
    async insertMessage(on, m) {
      const { rows } = await on.query<{ id: string }>(
        `INSERT INTO stop_messages (account, signer, message, signature, block_number, block_hash, block_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          m.account.toLowerCase(),
          m.signer.toLowerCase(),
          JSON.stringify(m.message),
          m.signature.toLowerCase(),
          m.block === null ? null : m.block.number.toString(),
          m.block === null ? null : m.block.hash.toLowerCase(),
          m.block === null ? null : m.block.time.toString(),
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the stop message was given no number');
      return Number(id);
    },
    async insertStops(on, account, messageId, stops) {
      if (stops.length === 0) return;
      await on.query(
        `INSERT INTO stops (hash, account, ahead, message_id, original, original_expiry, grant_number)
         SELECT n.hash, $1::text, n.ahead, $2::bigint, n.original::jsonb, n.original_expiry::numeric, n.grant_number::bigint
         FROM unnest($3::text[], $4::boolean[], $5::text[], $6::text[], $7::text[]) AS n(hash, ahead, original, original_expiry, grant_number)`,
        [
          account.toLowerCase(),
          messageId,
          stops.map((s) => s.hash.toLowerCase()),
          stops.map((s) => s.ahead !== null),
          stops.map((s) => (s.ahead === null ? null : JSON.stringify(s.ahead.original))),
          stops.map((s) => (s.ahead === null ? null : s.ahead.originalExpiry.toString())),
          stops.map((s) => (s.ahead === null ? null : String(s.ahead.grantNumber))),
        ],
      );
    },
    async markStopped(on, hashes) {
      if (hashes.length === 0) return [];
      const { rows } = await on.query<{ hash: Hex }>(`UPDATE orders SET ended = 'stopped', ended_at = now() WHERE hash = ANY($1::text[]) AND ended IS NULL RETURNING hash`, [hashes.map((h) => h.toLowerCase())]);
      return rows.map((r) => r.hash);
    },
    async aheadCount(on, account, afterTime, currentGrant) {
      const { rows } = await on.query<{ standing: string }>(AHEAD_COUNT_SQL, [account.toLowerCase(), afterTime.toString(), currentGrant]);
      return Number(rows[0]?.standing ?? 0);
    },
    async aheadOf(hash, on = pool) {
      const { rows } = await on.query<{ received_at: Date }>(`SELECT s.received_at FROM stops s WHERE s.hash = $1 AND s.ahead`, [hash.toLowerCase()]);
      return rows[0]?.received_at ?? null;
    },
  };
}
