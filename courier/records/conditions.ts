import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import { createEvents } from './events';

// The standing conditions of the reports: each opening and each clearing is a
// numbered line in the events table, written in the same transaction as the
// condition's row, so a condition that opened and cleared between two looks
// is still there to be read. One condition of a key is open at a time.
//
// The records decide every transition, and nothing a process remembers does.
// A read's outcome (the chain unreachable after two failures, or a read that
// succeeded) comes here by the statement that follows the node's answer, and
// the rule is applied in the order the outcomes are placed in: closed and a
// success, no line; closed and a failure, the opening, unless a clearing newer
// than the failure is on record (the failure belonged to the outage that
// ended); open and a failure, no line, the failure remembered on the row where
// it is the newest; open and a success newer than the opening, the clearing,
// unless a failure newer than the success is remembered, and then the
// recovery and the outage that went on are both recorded, the clearing and a
// new opening from that failure, in one transaction. A success older than the
// opening clears nothing.
//
// "Newer" is decided on the database's one clock. An outcome is placed at
// now() less the time it waited on its process for its statement, a duration
// on that process's monotonic clock, not a time of its own; the rows' instants
// (opened_at, cleared_at, failed_at) are placed the same way. So two
// processes' clocks are never compared, and a statement that waited on its
// process (the pool, the event loop) does not make its outcome look later
// than it was. What remains is the statement's trip to the database, which no
// process can measure: an outcome is placed later than it was by that trip.

/** The five standing conditions. Incidents (a reverted Cross, a lapsed bet) are lines, not conditions. */
export const CONDITION_KEYS = ['cross-unreconciled', 'wallet-low', 'sender-not-our-key', 'chain-unreachable', 'courier-fault'] as const;

export type ConditionKey = (typeof CONDITION_KEYS)[number];

/** A moment on this process's monotonic clock, `performance.now()`: when a read's outcome was learned. */
export type Moment = number;

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
  /**
   * A read that failed twice, learned at `at`. Where a condition of the key is open, no line: the failure is remembered
   * on the row where it is newer than what the row holds (one statement). Where none is open, the opening, with its
   * line, unless a clearing newer than the failure is on record (a transaction under the key's lock).
   */
  applyFailure(key: ConditionKey, facts: Record<string, unknown>, run: number, at: Moment): Promise<{ opened: boolean }>;
  /**
   * A read that succeeded, learned at `at`. One statement: where a condition of the key is open from before `at`, the
   * clearing with its line, unless a failure newer than `at` is remembered on it; then a transaction under the key's
   * lock writes the clearing and a new opening from that failure, whose facts are returned. Nothing open from before
   * `at`: nothing written.
   */
  applySuccess(key: ConditionKey, facts: Record<string, unknown>, run: number, at: Moment): Promise<{ cleared: boolean; reopened: Record<string, unknown> | null }>;
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

/** The outcome's instant on the database's clock: now() at the statement, less the milliseconds the outcome waited, parameter `n`. */
const placed = (n: number) => `(now() - $${n}::float8 * interval '1 millisecond')`;

export function createConditions(pool: pg.Pool): Conditions {
  const events = createEvents(pool);

  /** How long the outcome has waited on this process, measured once the connection is in hand, right before the statement. */
  const waited = (at: Moment) => Math.max(0, performance.now() - at);

  async function onClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  /** One transaction under the key's lock. now() inside it is its BEGIN's time, and the wait is measured right before BEGIN, so the two place the outcome together. */
  async function underLock<T>(key: ConditionKey, at: Moment, work: (client: pg.PoolClient, ago: number) => Promise<T>): Promise<T> {
    return onClient(async (client) => {
      const ago = waited(at);
      await client.query('BEGIN');
      try {
        // One writer per key at a time, so two readers that both find the chain down open one condition.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`condition:${key}`]);
        const out = await work(client, ago);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }

  /** The failure remembered on an open row, by id, where it is newer than the row's opening and the failure the row holds. $1 id, $2 waited, $3 facts, $4 run. */
  const REMEMBER = `UPDATE conditions c SET failed_at = ${placed(2)}, failed_facts = $3::jsonb, failed_run = $4 WHERE c.id = $1 AND ${placed(2)} > coalesce(c.failed_at, c.opened_at)`;

  return {
    async applyFailure(key, facts, run, at) {
      // Open already: no line, the failure remembered where newest. The row is locked for the statement, so a clearing
      // at the same moment is ordered before or after it, never beside it.
      const open = await onClient(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `WITH open AS (SELECT c.id FROM conditions c WHERE c.key = $1 AND c.cleared_at IS NULL FOR UPDATE),
                remembered AS (
                  UPDATE conditions c SET failed_at = ${placed(2)}, failed_facts = $3::jsonb, failed_run = $4
                  FROM open WHERE c.id = open.id AND ${placed(2)} > coalesce(c.failed_at, c.opened_at)
                  RETURNING c.id)
           SELECT open.id FROM open`,
          [key, waited(at), JSON.stringify(facts), run],
        );
        return rows[0] ?? null;
      });
      if (open !== null) return { opened: false };
      // None open: the opening, unless the records show it was opened meanwhile, or cleared by a read newer than
      // this failure, in which case the failure belonged to the outage that ended and opens nothing.
      return underLock(key, at, async (client, ago) => {
        const { rows } = await client.query<{ id: string; open: boolean; newer_clearing: boolean }>(
          `SELECT id, cleared_at IS NULL AS open, cleared_at IS NOT NULL AND cleared_at > ${placed(2)} AS newer_clearing
           FROM conditions WHERE key = $1 ORDER BY id DESC LIMIT 1`,
          [key, ago],
        );
        const newest = rows[0];
        if (newest !== undefined && newest.open) {
          await client.query(REMEMBER, [newest.id, ago, JSON.stringify(facts), run]);
          return { opened: false };
        }
        if (newest !== undefined && newest.newer_clearing) return { opened: false };
        const line = await events.write({ run, kind: 'condition opened', reason: key, facts }, client);
        await client.query(`INSERT INTO conditions (key, opened_at, opened_line, facts) VALUES ($1, ${placed(2)}, $3, $4)`, [key, ago, line, JSON.stringify(facts)]);
        return { opened: true };
      });
    },

    async applySuccess(key, facts, run, at) {
      // One statement: the condition open from before the success, locked for the statement; its clearing and the
      // line, unless a failure newer than the success is remembered on it. Two processes clearing at once: the second
      // waits on the row and then finds it cleared, so one line is written. Nothing open from before: nothing written.
      const found = await onClient(async (client) => {
        const { rows } = await client.query<{ id: string; overtaken: boolean; cleared: boolean }>(
          `WITH open AS (
             SELECT c.id, c.failed_at IS NOT NULL AND c.failed_at > ${placed(4)} AS overtaken
             FROM conditions c
             WHERE c.key = $1 AND c.cleared_at IS NULL AND c.opened_at < ${placed(4)}
             FOR UPDATE),
           line AS (
             INSERT INTO events (run, kind, reason, facts)
             SELECT $2, 'condition cleared', $1, $3::jsonb FROM open WHERE NOT open.overtaken
             RETURNING number),
           cleared AS (
             UPDATE conditions c SET cleared_at = ${placed(4)}, cleared_line = line.number
             FROM open, line WHERE c.id = open.id
             RETURNING c.id)
           SELECT open.id, open.overtaken, EXISTS (SELECT 1 FROM cleared) AS cleared FROM open`,
          [key, run, JSON.stringify(facts), waited(at)],
        );
        return rows[0] ?? null;
      });
      if (found === null) return { cleared: false, reopened: null };
      if (found.cleared) return { cleared: true, reopened: null };
      // Overtaken: a read failed twice after this one succeeded, and the records heard of that failure first. The
      // recovery and the outage that went on are both recorded, in their order: the clearing, then a new opening
      // from the remembered failure, under its run, placed at its instant.
      return underLock(key, at, async (client, ago) => {
        const { rows } = await client.query<{ id: string; overtaken: boolean; failed_facts: Record<string, unknown>; failed_run: string }>(
          `SELECT id, failed_at IS NOT NULL AND failed_at > ${placed(2)} AS overtaken, failed_facts, failed_run
           FROM conditions WHERE key = $1 AND cleared_at IS NULL AND opened_at < ${placed(2)}`,
          [key, ago],
        );
        const row = rows[0];
        if (row === undefined) return { cleared: false, reopened: null };
        const clearedLine = await events.write({ run, kind: 'condition cleared', reason: key, facts }, client);
        await client.query(`UPDATE conditions SET cleared_at = ${placed(2)}, cleared_line = $3 WHERE id = $1`, [row.id, ago, clearedLine]);
        if (!row.overtaken) return { cleared: true, reopened: null };
        const openedLine = await events.write({ run: Number(row.failed_run), kind: 'condition opened', reason: key, facts: row.failed_facts }, client);
        await client.query('INSERT INTO conditions (key, opened_at, opened_line, facts) SELECT key, failed_at, $2, failed_facts FROM conditions WHERE id = $1', [row.id, openedLine]);
        return { cleared: true, reopened: row.failed_facts };
      });
    },

    async open_() {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM conditions WHERE cleared_at IS NULL ORDER BY opened_at, id`);
      return rows.map((r) => toCondition(r as Record<string, unknown>));
    },
  };
}
