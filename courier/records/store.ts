import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { LOOPBACK_HOSTS } from '../config';
import { createConditions, type Conditions } from './conditions';
import { createEvents, type Events } from './events';
import { createRuns, type Runs } from './runs';

// The courier's own Postgres (db/schema.sql): how it is reached, and the
// records kept in it. The release step and the web process open their
// connection through openPool, and nowhere else.

export class StoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreRefused';
  }
}

/**
 * The certificate authority the courier verifies its database against, off
 * this machine: db/database-ca.pem, the public bundle that verifies the chain
 * the add-on's host presents, pinned at the first release. Until it is pinned
 * there is no file, and a database off this machine is refused rather than
 * reached with verification turned off.
 */
const PINNED_AUTHORITY = new URL('../../db/database-ca.pem', import.meta.url);

/**
 * The authority to verify against: the pinned bundle, or the file DATABASE_CA_FILE
 * names (a test authority). A named file that cannot be read refuses, rather
 * than falling back to anything; no pinned file and no named file is null,
 * which reaches a database on this machine plain and refuses one elsewhere.
 */
export function pinnedAuthority(file?: string): string | null {
  if (file !== undefined && file !== '') {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      throw new StoreRefused('DATABASE_CA_FILE could not be read');
    }
  }
  return existsSync(PINNED_AUTHORITY) ? readFileSync(PINNED_AUTHORITY, 'utf8') : null;
}

/**
 * pg's settings for DATABASE_URL. Only the URL's user, password, host, port
 * and database are read; its query options are ignored, so none of them (such
 * as sslmode=disable) can replace the TLS settings decided here.
 *
 * With an authority the connection uses TLS and checks the server's
 * certificate against that authority and its name against the host, whatever
 * the host: that is how the tests prove the check against a test authority,
 * and how the app reaches its add-on. With no authority, a database on this
 * machine is reached plain, and one anywhere else is refused.
 */
export function connectionSettings(databaseUrl: string, authority: string | null): pg.PoolConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new StoreRefused('DATABASE_URL could not be read as a postgres:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new StoreRefused('DATABASE_URL could not be read as a postgres:// URL');
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (authority === null && !local) {
    throw new StoreRefused('DATABASE_URL names a database off this machine and no certificate authority is pinned (db/database-ca.pem): it is not reached with verification off');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(database === '' ? {} : { database }),
    ssl: authority === null ? false : { ca: authority, rejectUnauthorized: true },
    max: 4,
    connectionTimeoutMillis: 10_000,
  };
}

/**
 * A pool on DATABASE_URL. The one function the release step and the web
 * process make their connection through. The authority is the pinned bundle
 * unless a caller (a test) passes its own.
 */
export function openPool(databaseUrl: string, authority: string | null = pinnedAuthority()): pg.Pool {
  return new pg.Pool(connectionSettings(databaseUrl, authority));
}

const SCHEMA = new URL('../../db/schema.sql', import.meta.url);

/** Applies db/schema.sql: the release step, and the tests' throwaway databases. Every statement in it runs again safely. */
export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(await readFile(SCHEMA, 'utf8'));
}

/** The error's short code, such as ECONNREFUSED or a Postgres SQLSTATE, found down its cause chain. */
export function failureCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; depth < 8 && typeof e === 'object' && e !== null; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{2,48}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** " (CODE)" for an error that carries a short code, else "". A driver's message can name the host or the user, so only the code is shown. */
export function errorCode(err: unknown): string {
  const code = failureCode(err);
  return code === undefined ? '' : ` (${code})`;
}

/** The codes Node gives a TLS connection whose certificate, or the name in it, does not check out. */
const CERTIFICATE_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
]);

export function isCertificateFailure(err: unknown): boolean {
  const code = failureCode(err);
  return code !== undefined && CERTIFICATE_CODES.has(code);
}

/** The sentence for a database the courier cannot use. It names DATABASE_URL and no part of it. */
export function databaseRefusal(err: unknown): string {
  return isCertificateFailure(err)
    ? `DATABASE_URL: the database's certificate did not verify${errorCode(err)}`
    : `DATABASE_URL: the database did not answer${errorCode(err)}`;
}

/**
 * The columns this build reads and writes, by table. Start-up refuses unless
 * every one is there: db/schema.sql's IF NOT EXISTS matches names only, so a
 * table made by an earlier schema is found out here and not at the first
 * statement that needs the column. Passing says nothing about indexes,
 * constraints or triggers.
 */
export const COLUMNS_USED: ReadonlyArray<readonly [table: string, column: string]> = [
  ['runs', 'id'],
  ['runs', 'started_at'],
  ['runs', 'stopped_at'],
  ['runs', 'stop_reason'],
  ['events', 'number'],
  ['events', 'at'],
  ['events', 'run'],
  ['events', 'kind'],
  ['events', 'order_hash'],
  ['events', 'bet_hash'],
  ['events', 'account'],
  ['events', 'game_id'],
  ['events', 'reason'],
  ['events', 'facts'],
  ['conditions', 'id'],
  ['conditions', 'key'],
  ['conditions', 'opened_at'],
  ['conditions', 'opened_line'],
  ['conditions', 'cleared_at'],
  ['conditions', 'cleared_line'],
  ['conditions', 'facts'],
  ['orders', 'hash'],
  ['orders', 'role'],
  ['orders', 'game_id'],
  ['orders', 'scorer'],
  ['orders', 'line_ticks'],
  ['orders', 'side'],
  ['orders', 'odds_tick'],
  ['orders', 'expiry'],
  ['orders', 'record_number'],
  ['orders', 'ended'],
];

/** The tables the schema makes, all of which must exist. */
export const TABLES = ['orders', 'stops', 'lanes', 'crosses', 'legs', 'events', 'conditions', 'accounts', 'runs', 'games'] as const;

/** The tables and columns of COLUMNS_USED and TABLES that the database does not have, as "table" or "table.column". */
export async function missingSchema(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const tables = new Set(rows.map((r) => r.table_name));
  const missing: string[] = [];
  for (const t of TABLES) if (!tables.has(t)) missing.push(t);
  for (const [t, c] of COLUMNS_USED) if (tables.has(t) && !have.has(`${t}.${c}`)) missing.push(`${t}.${c}`);
  return missing;
}

export interface LiveMarketRow {
  scorer: string;
  lineTicks: number;
  side: number;
  live: number;
}

export interface Store {
  pool: pg.Pool;
  runs: Runs;
  events: Events;
  conditions: Conditions;
  /** The database's size in bytes, as the database reports it. */
  databaseSize(): Promise<number>;
  /** The number of the newest report line (a condition's opening or clearing, or an incident), or null. */
  newestReportLine(): Promise<number | null>;
  /**
   * The markets of a game that hold a live quote, with how many live quotes
   * each side has within the bound of rows read, and whether the bound ended
   * the count. Live: a resting order not marked ended whose expiry is past
   * the block's time plus one. This build's book is empty; the read is here
   * so the book has an address, and its index and its cost are the orders
   * build's to make and measure.
   */
  liveMarkets(gameId: bigint, blockTime: bigint, bound: number): Promise<{ markets: LiveMarketRow[]; boundReached: boolean }>;
  close(): Promise<void>;
}

const REPORT_KINDS = ['condition opened', 'condition cleared', 'incident'];

export function createStore(pool: pg.Pool, log: (line: string) => void = () => undefined): Store {
  // An idle connection the database drops raises an error on the pool itself, which with no listener would end the
  // process. It is logged by its code and the pool makes a new connection at the next query.
  pool.on('error', (err) => log(`database: an idle connection failed${errorCode(err)}`));
  return {
    pool,
    runs: createRuns(pool),
    events: createEvents(pool),
    conditions: createConditions(pool),
    async databaseSize() {
      const { rows } = await pool.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
      return Number(rows[0]?.size ?? '0');
    },
    async newestReportLine() {
      const { rows } = await pool.query<{ number: string | null }>('SELECT max(number)::text AS number FROM events WHERE kind = ANY($1)', [REPORT_KINDS]);
      const n = rows[0]?.number;
      return n === null || n === undefined ? null : Number(n);
    },
    async liveMarkets(gameId, blockTime, bound) {
      const { rows } = await pool.query<{ scorer: string; line_ticks: number; side: number; live: string; read: string }>(
        `WITH read AS (
           SELECT scorer, line_ticks, side
           FROM orders
           WHERE role = 'rest' AND ended IS NULL AND game_id = $1 AND expiry > $2
           ORDER BY record_number
           LIMIT $3
         )
         SELECT scorer, line_ticks, side, count(*)::text AS live, (SELECT count(*) FROM read)::text AS read
         FROM read GROUP BY scorer, line_ticks, side ORDER BY scorer, line_ticks, side`,
        [gameId.toString(), (blockTime + 1n).toString(), bound],
      );
      return {
        markets: rows.map((r) => ({ scorer: r.scorer, lineTicks: r.line_ticks, side: r.side, live: Number(r.live) })),
        boundReached: rows.length > 0 && Number(rows[0]?.read) >= bound,
      };
    },
    async close() {
      await pool.end();
    },
  };
}
