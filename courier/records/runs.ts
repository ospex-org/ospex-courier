import type pg from 'pg';

// The runs table: one row per start of the process, and the stop where the
// process wrote it itself. A process that dies writes nothing, and no later
// start writes it for it: that run is shown as it is, started and never
// stopped. This is the courier's own account of when it was running, and not
// a measure of whether a caller could reach it.

export interface Run {
  id: number;
  startedAt: Date;
  stoppedAt: Date | null;
  stopReason: string | null;
}

export interface Runs {
  /** A new row for this process, now. */
  start(): Promise<Run>;
  /** This process's own stop, with how it stopped. Written once; a second call changes nothing. */
  stop(id: number, reason: string): Promise<void>;
  /** The runs with an id above `after`, oldest first, at most `limit`. */
  page(after: number, limit: number): Promise<Run[]>;
  get(id: number): Promise<Run | null>;
}

function toRun(row: Record<string, unknown>): Run {
  return {
    id: Number(row.id),
    startedAt: row.started_at as Date,
    stoppedAt: (row.stopped_at as Date | null) ?? null,
    stopReason: (row.stop_reason as string | null) ?? null,
  };
}

export function createRuns(pool: pg.Pool): Runs {
  return {
    async start() {
      const { rows } = await pool.query('INSERT INTO runs DEFAULT VALUES RETURNING id, started_at, stopped_at, stop_reason');
      return toRun(rows[0] as Record<string, unknown>);
    },
    async stop(id, reason) {
      await pool.query('UPDATE runs SET stopped_at = now(), stop_reason = $2 WHERE id = $1 AND stopped_at IS NULL', [id, reason]);
    },
    async page(after, limit) {
      const { rows } = await pool.query('SELECT id, started_at, stopped_at, stop_reason FROM runs WHERE id > $1 ORDER BY id LIMIT $2', [after, limit]);
      return rows.map((r) => toRun(r as Record<string, unknown>));
    },
    async get(id) {
      const { rows } = await pool.query('SELECT id, started_at, stopped_at, stop_reason FROM runs WHERE id = $1', [id]);
      return rows.length === 0 ? null : toRun(rows[0] as Record<string, unknown>);
    },
  };
}
