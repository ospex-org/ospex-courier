import type pg from 'pg';

// The events table: one numbered line per event, written in the same
// transaction as the change it records, and never changed after. Nothing is
// written when nothing happens.

/** The kinds, as the plan lists them. The schema refuses any other. */
export const EVENT_KINDS = [
  'order received',
  'order refused',
  'stop received',
  'stop refused',
  'start unreadable',
  'bet refused',
  'bet lapsed',
  'cross sent',
  'cross pending',
  'cross confirmed',
  'cross reverted',
  'cross unknown',
  'cross not sent',
  'cross expired unmined',
  'cross replaced',
  'condition opened',
  'condition cleared',
  'incident',
  'run started',
  'run stopped',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventLine {
  run: number;
  kind: EventKind;
  orderHash?: string;
  betHash?: string;
  account?: string;
  gameId?: bigint;
  reason?: string;
  facts?: Record<string, unknown>;
}

export interface StoredEvent extends EventLine {
  number: number;
  at: Date;
}

/** A connection a line can be written on: the pool, or a client inside a transaction. */
export type Writer = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface Events {
  /** Writes one line and returns its number. Pass the transaction's client to write it with the change it records. */
  write(line: EventLine, on?: Writer): Promise<number>;
  /** The lines with a number above `after`, in order, at most `limit`. */
  page(after: number, limit: number): Promise<StoredEvent[]>;
}

function toEvent(row: Record<string, unknown>): StoredEvent {
  const out: StoredEvent = {
    number: Number(row.number),
    at: row.at as Date,
    run: Number(row.run),
    kind: row.kind as EventKind,
    facts: (row.facts as Record<string, unknown>) ?? {},
  };
  if (row.order_hash !== null) out.orderHash = row.order_hash as string;
  if (row.bet_hash !== null) out.betHash = row.bet_hash as string;
  if (row.account !== null) out.account = row.account as string;
  if (row.game_id !== null) out.gameId = BigInt(String(row.game_id));
  if (row.reason !== null) out.reason = row.reason as string;
  return out;
}

export function createEvents(pool: pg.Pool): Events {
  return {
    async write(line, on = pool) {
      const { rows } = await on.query(
        `INSERT INTO events (run, kind, order_hash, bet_hash, account, game_id, reason, facts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING number`,
        [
          line.run,
          line.kind,
          line.orderHash ?? null,
          line.betHash ?? null,
          line.account ?? null,
          line.gameId === undefined ? null : line.gameId.toString(),
          line.reason ?? null,
          JSON.stringify(line.facts ?? {}),
        ],
      );
      return Number((rows[0] as { number: string }).number);
    },
    async page(after, limit) {
      const { rows } = await pool.query(
        'SELECT number, at, run, kind, order_hash, bet_hash, account, game_id, reason, facts FROM events WHERE number > $1 ORDER BY number LIMIT $2',
        [after, limit],
      );
      return rows.map((r) => toEvent(r as Record<string, unknown>));
    },
  };
}
