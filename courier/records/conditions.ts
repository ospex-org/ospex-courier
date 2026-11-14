import type pg from 'pg';
import { createEvents } from './events';

// The standing conditions of the reports: each opening and each clearing is a
// numbered line in the events table, written in the same transaction as the
// condition's row, so a condition that opened and cleared between two looks
// is still there to be read. One condition of a key is open at a time.
//
// Four cases, and no others. The records decide each against the state they
// find when they process the outcome: closed and a read that succeeded,
// nothing; closed and a read that failed twice, one opening and its line; open
// and a read that succeeded, one clearing and its line; open and a read that
// failed twice, nothing. Outcomes are applied in the records' processing
// order, not in the order the chain was observed: a success recorded late may
// clear a failure observed after it, and a failure recorded late may open
// after a success observed after it. No outcome is discarded for its age, its
// wait on the process or its trip to the database. No time guards a
// transition: the rows' and the lines' times are the writing transaction's,
// and diagnostics.
//
// One writer form for every write: the key's advisory lock, the open row
// locked, the deciding fact (is a condition of the key open?) read again on
// fresh state after the lock, then the line and the row in that one
// transaction. The lookup made before the lock decides only that nothing need
// be written; it never authorizes a write.

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
  /** A read that failed twice. Open: nothing, and no line. Closed: the opening and its line, under the writer's lock. Returns whether this call opened it. */
  applyFailure(key: ConditionKey, facts: Record<string, unknown>, run: number): Promise<{ opened: boolean }>;
  /** A read that succeeded. Closed: nothing, and no line. Open: the clearing and its line, under the writer's lock. Returns whether this call cleared it. */
  applySuccess(key: ConditionKey, facts: Record<string, unknown>, run: number): Promise<{ cleared: boolean }>;
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

  /**
   * The lookup: one read-only statement, prepared once a connection, a probe of the open conditions' index. It says
   * whether a condition of the key is open as the records stand, and decides a no-op and nothing else: a write is
   * decided again under the lock.
   */
  async function standsOpen(key: ConditionKey): Promise<boolean> {
    const { rowCount } = await pool.query({ name: 'condition-open', text: 'SELECT 1 FROM conditions WHERE key = $1 AND cleared_at IS NULL', values: [key] });
    return (rowCount ?? 0) > 0;
  }

  /**
   * The one writer form. One transaction on one connection of the pool: the key's advisory lock, so one writer of
   * the key runs at a time, in this process or another; the open row of the key read again and locked, so the
   * decision is made on what stands after the lock and not on what the lookup saw; then `work`, which writes the line
   * and the row or nothing; then the commit, or the rollback of both.
   */
  async function write<T>(key: ConditionKey, work: (client: pg.PoolClient, openId: string | null) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`condition:${key}`]);
        const { rows } = await client.query<{ id: string }>('SELECT id FROM conditions WHERE key = $1 AND cleared_at IS NULL FOR UPDATE', [key]);
        const out = await work(client, rows[0]?.id ?? null);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    } finally {
      client.release();
    }
  }

  return {
    async applyFailure(key, facts, run) {
      if (await standsOpen(key)) return { opened: false };
      return write(key, async (client, openId) => {
        if (openId !== null) return { opened: false };
        const line = await events.write({ run, kind: 'condition opened', reason: key, facts }, client);
        await client.query('INSERT INTO conditions (key, opened_line, facts) VALUES ($1, $2, $3)', [key, line, JSON.stringify(facts)]);
        return { opened: true };
      });
    },

    async applySuccess(key, facts, run) {
      if (!(await standsOpen(key))) return { cleared: false };
      return write(key, async (client, openId) => {
        if (openId === null) return { cleared: false };
        const line = await events.write({ run, kind: 'condition cleared', reason: key, facts }, client);
        await client.query('UPDATE conditions SET cleared_at = now(), cleared_line = $2 WHERE id = $1', [openId, line]);
        return { cleared: true };
      });
    },

    async open_() {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM conditions WHERE cleared_at IS NULL ORDER BY opened_at, id`);
      return rows.map((r) => toCondition(r as Record<string, unknown>));
    },
  };
}
