import type pg from 'pg';
import type { Address, Hex } from 'viem';
import { BOUNDS } from '../http/limits';
import type { OrderFields } from '../orders/order';

// The orders table: one row per order the courier admitted, keyed by its
// hash; and the games table, one row per game seen. The book's scan along its
// index, with the mark of expired quotes, is one statement here, so the test
// that measures its physical work runs the statement the courier runs.

export type Writer = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface OrderRow {
  hash: Hex;
  role: 'rest' | 'take';
  order: OrderFields;
  signature: Hex;
  marketKey: Hex;
  side: 0 | 1;
  recordNumber: number;
  receivedAt: Date;
  receivedBlock: bigint;
  receivedHash: Hex;
  /** The receipt block's time: the chain's time the order was taken at, which a repeat is answered from. */
  receivedTime: bigint;
  /** How the order ended here, if it has: `cancelled` is a quote a read of the chain showed cancelled or under its account's floor, marked at the block read. */
  ended: 'stopped' | 'expired' | 'filled' | 'cancelled' | null;
  endedAt: Date | null;
  /** The block the chain read that marked a quote cancelled was made at; null for the other marks. */
  endedBlock: bigint | null;
  endedBlockHash: Hex | null;
  betState: 'waiting' | 'held' | 'sent' | 'refused' | 'lapsed' | null;
}

export interface NewOrder {
  hash: Hex;
  role: 'rest' | 'take';
  order: OrderFields;
  signature: Hex;
  marketKey: Hex;
  receivedBlock: bigint;
  receivedHash: Hex;
  receivedTime: bigint;
}

/** A quote as the book's scan returns it. */
export interface ScannedQuote {
  hash: Hex;
  account: Address;
  positionType: 0 | 1;
  oddsTick: number;
  riskAmount: bigint;
  nonce: bigint;
  expiry: bigint;
  minFill: bigint;
  recordNumber: number;
}

export interface Cursor {
  oddsTick: number;
  recordNumber: number;
}

export interface AccountQuote {
  hash: Hex;
  expiry: bigint;
  riskAmount: bigint;
  nonce: bigint;
  recordNumber: number;
}

/** A block a chain read was made at, as a mark records it. */
export interface BlockRead {
  number: bigint;
  hash: Hex;
}

export interface ScanResult {
  /** Rows the index's range returned to this request, at most the bound. */
  scanned: number;
  /** Rows this request marked ended: expired at the final block. */
  marked: number;
  /** Rows not expired at the block's time, among those returned. */
  live: number;
  /** The first `page` live rows, in the index's order. */
  rows: ScannedQuote[];
  /** The last row the scan returned, live or not: where the next page starts. Null when nothing was returned. */
  last: Cursor | null;
}

const ORDER_COLUMNS = `hash, role, account, game_id::text AS game_id, scorer, line_ticks, position_type, odds_tick, risk_amount::text AS risk_amount,
  nonce::text AS nonce, expiry::text AS expiry, min_fill::text AS min_fill, signature, market_key, side, record_number::text AS record_number,
  received_at, received_block::text AS received_block, received_hash, received_time::text AS received_time, ended, ended_at,
  ended_block::text AS ended_block, ended_block_hash, bet_state`;

function toRow(r: Record<string, unknown>): OrderRow {
  return {
    hash: r.hash as Hex,
    role: r.role as 'rest' | 'take',
    order: {
      account: r.account as Address,
      gameId: BigInt(r.game_id as string),
      scorer: r.scorer as Address,
      lineTicks: Number(r.line_ticks),
      positionType: Number(r.position_type) as 0 | 1,
      oddsTick: Number(r.odds_tick),
      riskAmount: BigInt(r.risk_amount as string),
      nonce: BigInt(r.nonce as string),
      expiry: BigInt(r.expiry as string),
      minFill: BigInt(r.min_fill as string),
    },
    signature: r.signature as Hex,
    marketKey: r.market_key as Hex,
    side: Number(r.side) as 0 | 1,
    recordNumber: Number(r.record_number),
    receivedAt: r.received_at as Date,
    receivedBlock: BigInt(r.received_block as string),
    receivedHash: r.received_hash as Hex,
    receivedTime: BigInt(r.received_time as string),
    ended: (r.ended as OrderRow['ended']) ?? null,
    endedAt: (r.ended_at as Date | null) ?? null,
    endedBlock: r.ended_block === null || r.ended_block === undefined ? null : BigInt(r.ended_block as string),
    endedBlockHash: (r.ended_block_hash as Hex | null) ?? null,
    betState: (r.bet_state as OrderRow['betState']) ?? null,
  };
}

/**
 * The book's scan, with the mark, as one statement. The inner scan walks the
 * book's index for one side of one market from the cursor, in the index's
 * order, and returns at most the bound of rows: `LIMIT` counts rows returned,
 * not the entries visited, the rows fetched or the pages read. Of what it was
 * returned, the request marks ended every quote whose expiry is at or under
 * the final block's time plus one (it can fill in no block after F), and
 * passes to the caller those whose expiry is above the block's time plus one.
 * $1 market key, $2 side, $3 $4 the cursor, $5 the bound, $6 F + 1, $7 T + 1,
 * $8 the page. The order and the cursor are both on the table's columns as
 * numbers (`odds_tick`, `record_number`); the text casts are inside the JSON
 * built last, where no ORDER BY can take them for the columns.
 */
export const SCAN_SQL = `WITH scanned AS (
  SELECT hash, account, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, record_number
  FROM orders
  WHERE role = 'rest' AND ended IS NULL AND market_key = $1::text AND side = $2::smallint
    AND (odds_tick, record_number) > ($3::integer, $4::bigint)
  ORDER BY odds_tick, record_number
  LIMIT $5::integer
),
marked AS (
  UPDATE orders SET ended = 'expired', ended_at = now()
  WHERE hash IN (SELECT hash FROM scanned WHERE expiry <= $6::numeric)
  RETURNING hash
),
live AS (
  SELECT hash, account, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, record_number
  FROM scanned WHERE expiry > $7::numeric
  ORDER BY odds_tick, record_number
)
SELECT (SELECT count(*) FROM scanned)::int AS scanned,
       (SELECT count(*) FROM marked)::int AS marked,
       (SELECT count(*) FROM live)::int AS live,
       (SELECT odds_tick FROM scanned ORDER BY odds_tick DESC, record_number DESC LIMIT 1) AS last_tick,
       (SELECT record_number FROM scanned ORDER BY odds_tick DESC, record_number DESC LIMIT 1)::text AS last_record,
       (SELECT coalesce(json_agg(json_build_object(
          'hash', l.hash, 'account', l.account, 'positionType', l.position_type, 'oddsTick', l.odds_tick,
          'riskAmount', l.risk_amount::text, 'nonce', l.nonce::text, 'expiry', l.expiry::text, 'minFill', l.min_fill::text,
          'recordNumber', l.record_number::text)), '[]'::json)
        FROM (SELECT * FROM live LIMIT $8::integer) l) AS rows`;

export interface ScanArgs {
  marketKey: Hex;
  side: 0 | 1;
  after: Cursor | null;
  /** The block's time, T: a quote whose expiry is at or under T + 1 is not live. */
  blockTime: bigint;
  /** The final block's time, F: a quote whose expiry is at or under F + 1 is marked. */
  finalTime: bigint;
  /** How many live rows to return: the page. 0 for a count alone. */
  page: number;
  /** The bound of rows returned from the index. BOUNDS.scanRows unless a test says otherwise. */
  bound?: number;
}

export function scanParams(a: ScanArgs): unknown[] {
  return [
    a.marketKey.toLowerCase(),
    a.side,
    a.after === null ? 0 : a.after.oddsTick,
    a.after === null ? 0 : a.after.recordNumber,
    a.bound ?? BOUNDS.scanRows,
    (a.finalTime + 1n).toString(),
    (a.blockTime + 1n).toString(),
    a.page,
  ];
}

export interface Orders {
  /** Inserts the order and returns the row with its record number. The caller's transaction holds the hash lock. */
  insert(on: Writer, order: NewOrder): Promise<OrderRow>;
  get(hash: Hex, on?: Writer): Promise<OrderRow | null>;
  /** How many bets wait their turn: the account's, and everyone's. */
  waiting(on: Writer, account: Address): Promise<{ account: number; all: number }>;
  /**
   * One page of an account's quotes on one side of one market the courier has
   * not marked ended and the block's time has not expired (expiry above T + 1),
   * newest expiry first, at most the bound plus one rows. One page is the whole
   * count: the records hold at most sixteen such quotes of an account on a side
   * that the chain has not been asked about, since the door marks the ones a
   * read shows ended.
   */
  quotesOfAccount(on: Writer, account: Address, marketKey: Hex, side: 0 | 1, blockTime: bigint): Promise<AccountQuote[]>;
  /**
   * Marks quotes cancelled, at the block the chain read that showed them so was
   * made at: the ones among `hashes` not already marked. Returns the hashes it
   * marked.
   */
  markCancelled(on: Writer, hashes: Hex[], block: BlockRead): Promise<Hex[]>;
  /** The book's scan with the mark, one statement. */
  scan(on: Writer, args: ScanArgs): Promise<ScanResult>;
  /**
   * The (market, side) pairs that hold a quote not marked ended, found by
   * walking the book's index one pair at a time, filtered to one game. The
   * work is one index probe per pair the whole book holds, live or expired
   * and unmarked, and does not grow with the orders kept.
   */
  marketsOfGame(on: Writer, gameId: bigint): Promise<Array<{ marketKey: Hex; side: 0 | 1; scorer: Address; lineTicks: number }>>;
}

export const MARKETS_OF_GAME_SQL = `WITH RECURSIVE pairs AS (
  (SELECT market_key, side, game_id, scorer, line_ticks FROM orders
   WHERE role = 'rest' AND ended IS NULL ORDER BY market_key, side LIMIT 1)
  UNION ALL
  SELECT n.market_key, n.side, n.game_id, n.scorer, n.line_ticks FROM pairs p, LATERAL (
    SELECT market_key, side, game_id, scorer, line_ticks FROM orders
    WHERE role = 'rest' AND ended IS NULL AND (market_key, side) > (p.market_key, p.side)
    ORDER BY market_key, side LIMIT 1) n
)
SELECT market_key, side, scorer, line_ticks FROM pairs WHERE game_id = $1::numeric ORDER BY scorer, line_ticks, side`;

export function createOrders(pool: pg.Pool): Orders {
  return {
    async insert(on, o) {
      const { rows } = await on.query(
        `INSERT INTO orders (hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill,
           signature, market_key, side, received_block, received_hash, bet_state, received_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING ${ORDER_COLUMNS}`,
        [
          o.hash.toLowerCase(),
          o.role,
          o.order.account.toLowerCase(),
          o.order.gameId.toString(),
          o.order.scorer.toLowerCase(),
          o.order.lineTicks,
          o.order.positionType,
          o.order.oddsTick,
          o.order.riskAmount.toString(),
          o.order.nonce.toString(),
          o.order.expiry.toString(),
          o.order.minFill.toString(),
          o.signature.toLowerCase(),
          o.marketKey.toLowerCase(),
          o.order.positionType,
          o.receivedBlock.toString(),
          o.receivedHash.toLowerCase(),
          o.role === 'take' ? 'waiting' : null,
          o.receivedTime.toString(),
        ],
      );
      return toRow(rows[0] as Record<string, unknown>);
    },
    async get(hash, on = pool) {
      const { rows } = await on.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE hash = $1`, [hash.toLowerCase()]);
      return rows.length === 0 ? null : toRow(rows[0] as Record<string, unknown>);
    },
    async waiting(on, account) {
      const { rows } = await on.query<{ mine: string; all: string }>(
        `SELECT count(*) FILTER (WHERE account = $1)::text AS mine, count(*)::text AS all FROM orders
         WHERE role = 'take' AND bet_state IN ('waiting', 'held') AND ended IS NULL AND bet_state = 'waiting'`,
        [account.toLowerCase()],
      );
      return { account: Number(rows[0]?.mine ?? 0), all: Number(rows[0]?.all ?? 0) };
    },
    async quotesOfAccount(on, account, marketKey, side, blockTime) {
      const { rows } = await on.query<{ hash: Hex; expiry: string; risk_amount: string; nonce: string; record_number: string }>(
        // Ordered by the table's own columns, named with the table: a bare name in ORDER BY that an output column
        // shares is the output column, and here the outputs are the numbers cast to text, whose order is not the
        // numbers' once they differ in digits.
        `SELECT o.hash, o.expiry::text AS expiry, o.risk_amount::text AS risk_amount, o.nonce::text AS nonce, o.record_number::text AS record_number FROM orders o
         WHERE o.role = 'rest' AND o.ended IS NULL AND o.account = $1 AND o.market_key = $2 AND o.side = $3 AND o.expiry > $5::numeric
         ORDER BY o.expiry DESC, o.record_number DESC LIMIT $4`,
        [account.toLowerCase(), marketKey.toLowerCase(), side, BOUNDS.liveQuotesPerAccountSideMarket + 1, (blockTime + 1n).toString()],
      );
      return rows.map((r) => ({ hash: r.hash, expiry: BigInt(r.expiry), riskAmount: BigInt(r.risk_amount), nonce: BigInt(r.nonce), recordNumber: Number(r.record_number) }));
    },
    async markCancelled(on, hashes, block) {
      if (hashes.length === 0) return [];
      const { rows } = await on.query<{ hash: Hex }>(
        `UPDATE orders SET ended = 'cancelled', ended_at = now(), ended_block = $2::numeric, ended_block_hash = $3
         WHERE hash = ANY($1::text[]) AND ended IS NULL RETURNING hash`,
        [hashes.map((h) => h.toLowerCase()), block.number.toString(), block.hash.toLowerCase()],
      );
      return rows.map((r) => r.hash);
    },
    async scan(on, args) {
      const { rows } = await on.query<{ scanned: number; marked: number; live: number; last_tick: number | null; last_record: string | null; rows: Array<Record<string, unknown>> }>(
        SCAN_SQL,
        scanParams(args),
      );
      const r = rows[0];
      if (r === undefined) throw new Error('the scan returned no summary row');
      return {
        scanned: r.scanned,
        marked: r.marked,
        live: r.live,
        last: r.last_tick === null || r.last_record === null ? null : { oddsTick: Number(r.last_tick), recordNumber: Number(r.last_record) },
        rows: r.rows.map((q) => ({
          hash: q.hash as Hex,
          account: q.account as Address,
          positionType: Number(q.positionType) as 0 | 1,
          oddsTick: Number(q.oddsTick),
          riskAmount: BigInt(q.riskAmount as string),
          nonce: BigInt(q.nonce as string),
          expiry: BigInt(q.expiry as string),
          minFill: BigInt(q.minFill as string),
          recordNumber: Number(q.recordNumber),
        })),
      };
    },
    async marketsOfGame(on, gameId) {
      const { rows } = await on.query<{ market_key: Hex; side: number; scorer: Address; line_ticks: number }>(MARKETS_OF_GAME_SQL, [gameId.toString()]);
      return rows.map((r) => ({ marketKey: r.market_key, side: Number(r.side) as 0 | 1, scorer: r.scorer, lineTicks: Number(r.line_ticks) }));
    },
  };
}

// ──────────────────────────── games ───────────────────────────────────────

export interface GameSeen {
  gameId: bigint;
  /** The start, where it could be read. */
  start: bigint | null;
  reportersPublished: boolean | null;
}

export interface Games {
  /**
   * Records what the door read of a game: its start once written, whether its
   * reporters are the published list; and the time a start could first not be
   * read. Returns whether this call is the first to find the start unreadable
   * since it was last read, which is when the one `start unreadable` line is
   * written.
   */
  seen(on: Writer, game: GameSeen): Promise<{ firstUnreadable: boolean }>;
}

export function createGames(): Games {
  return {
    async seen(on, g) {
      const { rows } = await on.query<{ first: boolean }>(
        `INSERT INTO games (game_id, start, reporters_published, start_unreadable_at)
         VALUES ($1, $2, $3, CASE WHEN $2::numeric IS NULL THEN now() ELSE NULL END)
         ON CONFLICT (game_id) DO UPDATE SET
           start = coalesce(EXCLUDED.start, games.start),
           reporters_published = coalesce(EXCLUDED.reporters_published, games.reporters_published),
           start_unreadable_at = CASE WHEN EXCLUDED.start IS NOT NULL THEN NULL
                                      WHEN games.start IS NOT NULL THEN NULL
                                      ELSE coalesce(games.start_unreadable_at, now()) END
         RETURNING (xmax = 0 OR (start IS NULL AND start_unreadable_at = now())) AS first`,
        [g.gameId.toString(), g.start === null ? null : g.start.toString(), g.reportersPublished],
      );
      const first = rows[0]?.first ?? false;
      return { firstUnreadable: g.start === null && first };
    },
  };
}
