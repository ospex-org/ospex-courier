import type pg from 'pg';
import { createEvents } from './events';

// The standing conditions of the reports: each opening and each clearing is a
// numbered line in the events table, written in the same transaction as the
// condition's row, so a condition that opened and cleared between two looks
// is still there to be read. One condition of a key is open at a time.

/** The five standing conditions. Incidents (a reverted Cross, a lapsed bet) are lines, not conditions. */
export const CONDITION_KEYS = ['cross-unreconciled', 'wallet-low', 'sender-not-our-key', 'chain-unreachable', 'courier-fault'] as const;

export type ConditionKey = (typeof CONDITION_KEYS)[number];

export interface Condition {
  id: number;
  key: ConditionKey;
  openedAt: Date;
  openedLine: number;
  clearedAt: Date | null;
  clearedLine: number | null;
  facts: Record<string, unknown>;
}

export interface Conditions {
  /** Opens the condition unless one of its key is open; returns whether this call opened it. */
  open(key: ConditionKey, facts: Record<string, unknown>, run: number): Promise<boolean>;
  /** Clears the open condition of the key, if any; returns whether this call cleared one. */
  clear(key: ConditionKey, facts: Record<string, unknown>, run: number): Promise<boolean>;
  /** The conditions open now, oldest first. */
  open_(): Promise<Condition[]>;
}

function toCondition(row: Record<string, unknown>): Condition {
  return {
    id: Number(row.id),
    key: row.key as ConditionKey,
    openedAt: row.opened_at as Date,
    openedLine: Number(row.opened_line),
    clearedAt: (row.cleared_at as Date | null) ?? null,
    clearedLine: row.cleared_line === null ? null : Number(row.cleared_line),
    facts: (row.facts as Record<string, unknown>) ?? {},
  };
}

const COLUMNS = 'id, key, opened_at, opened_line, cleared_at, cleared_line, facts';

export function createConditions(pool: pg.Pool): Conditions {
  const events = createEvents(pool);

  async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    open(key, facts, run) {
      return inTransaction(async (client) => {
        // One writer per key at a time, so two readers that both find the chain down open one condition.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`condition:${key}`]);
        const { rowCount } = await client.query('SELECT 1 FROM conditions WHERE key = $1 AND cleared_at IS NULL', [key]);
        if ((rowCount ?? 0) > 0) return false;
        const line = await events.write({ run, kind: 'condition opened', reason: key, facts }, client);
        await client.query('INSERT INTO conditions (key, opened_at, opened_line, facts) VALUES ($1, now(), $2, $3)', [key, line, JSON.stringify(facts)]);
        return true;
      });
    },
    clear(key, facts, run) {
      return inTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`condition:${key}`]);
        const { rows } = await client.query<{ id: string }>('SELECT id FROM conditions WHERE key = $1 AND cleared_at IS NULL', [key]);
        if (rows.length === 0) return false;
        const line = await events.write({ run, kind: 'condition cleared', reason: key, facts }, client);
        await client.query('UPDATE conditions SET cleared_at = now(), cleared_line = $2 WHERE id = $1', [rows[0]?.id, line]);
        return true;
      });
    },
    async open_() {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM conditions WHERE cleared_at IS NULL ORDER BY opened_at, id`);
      return rows.map((r) => toCondition(r as Record<string, unknown>));
    },
  };
}
