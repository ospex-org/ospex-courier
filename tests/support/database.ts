import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { applySchema, openPool } from '../../courier/records/store';

// The test Postgres: TEST_DATABASE_URL names a server on this machine (CI
// starts one). Each test file creates its own databases there and drops them.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function testServer() {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl, 'set TEST_DATABASE_URL to a Postgres server on this machine; these tests create and drop their own databases there');
  assert.ok(LOOPBACK_HOSTS.has(new URL(adminUrl).hostname), 'TEST_DATABASE_URL must be a server on this machine');
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const created: string[] = [];

  const urlFor = (database: string) => {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    return url.toString();
  };

  return {
    admin,
    urlFor,
    /** A new, empty database; dropped by `end`. */
    async createDatabase(prefix: string): Promise<string> {
      const name = `${prefix}_${randomBytes(5).toString('hex')}`;
      await admin.query(`CREATE DATABASE ${name}`);
      created.push(name);
      return name;
    },
    /** A new database with db/schema.sql applied, and its URL. */
    async createWithSchema(prefix: string): Promise<{ name: string; url: string }> {
      const name = await this.createDatabase(prefix);
      const url = urlFor(name);
      const pool = openPool(url, null);
      try {
        await applySchema(pool);
      } finally {
        await pool.end();
      }
      return { name, url };
    },
    /**
     * Drops every database made here. pg's pool.end() resolves once its
     * clients are told to close, before their connections are gone; dropping
     * then would cut one still closing, so wait until the server shows none.
     */
    async end() {
      for (const name of created) {
        for (let i = 0; i < 100; i++) {
          const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
          if ((rows[0] as { n: number }).n === 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      await admin.end();
    },
  };
}
