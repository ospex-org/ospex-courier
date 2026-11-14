import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { connectionSettings, databaseRefusal, errorCode, failureCode, isCertificateFailure, openPool, pinnedAuthority, POOL_WAIT_EXHAUSTED, StoreRefused } from '../courier/records/store';
import { testServer } from './support/database';
import { makeAuthorities, startTlsFront, type TestAuthorities, type TlsFront } from './support/tls';

// The store's connection: what it reads from DATABASE_URL, and the TLS check
// proved against a test authority. A TLS front presents a certificate from
// authority A for localhost; the store connects when given A and is refused
// when given B, or when the name in the certificate is another host. The
// release step makes its connection through the same function, so it is run
// as the Procfile runs it, against the front, with each authority.

const db = testServer();
let database: { name: string; url: string };
let authorities: TestAuthorities;
let front: TlsFront;
let otherNameFront: TlsFront;
let serverPort: number;
let credentials: { user: string; password: string };

const run = promisify(execFile);
const ROOT = new URL('../', import.meta.url);

/** The database's URL through a front, with localhost as the host so the certificate's name is checked against it. */
function throughFront(port: number): string {
  const url = new URL(database.url);
  url.hostname = 'localhost';
  url.port = String(port);
  return url.toString();
}

before(async () => {
  database = await db.createWithSchema('store');
  const direct = new URL(database.url);
  serverPort = Number(direct.port === '' ? 5432 : direct.port);
  credentials = { user: decodeURIComponent(direct.username), password: decodeURIComponent(direct.password) };
  authorities = makeAuthorities();
  front = await startTlsFront(serverPort, authorities.serverCert, authorities.serverKey);
  otherNameFront = await startTlsFront(serverPort, authorities.otherNameCert, authorities.otherNameKey);
});

after(async () => {
  await front.close();
  await otherNameFront.close();
  await db.end();
});

test('only the URL\'s user, password, host, port and database are read; its options cannot turn TLS off', () => {
  const settings = connectionSettings('postgres://u:p%40ss@db.example:6543/courier?sslmode=disable&ssl=0', 'AUTHORITY PEM');
  assert.equal(settings.host, 'db.example');
  assert.equal(settings.port, 6543);
  assert.equal(settings.user, 'u');
  assert.equal(settings.password, 'p@ss');
  assert.equal(settings.database, 'courier');
  assert.deepEqual(settings.ssl, { ca: 'AUTHORITY PEM', rejectUnauthorized: true });
});

test('with no authority, a database on this machine is reached plain and one elsewhere is refused', () => {
  assert.equal(connectionSettings('postgres://u:p@127.0.0.1:5440/c', null).ssl, false);
  assert.equal(connectionSettings('postgres://u:p@localhost/c', null).ssl, false);
  assert.throws(() => connectionSettings('postgres://u:p@db.example/c', null), (err: unknown) => err instanceof StoreRefused && /no certificate authority is pinned/.test(err.message));
  assert.throws(() => connectionSettings('mysql://u:p@127.0.0.1/c', null), StoreRefused);
  assert.throws(() => connectionSettings('not a url', null), StoreRefused);
});

test('a named authority file that cannot be read refuses, and falls back to nothing', () => {
  assert.throws(() => pinnedAuthority(join(authorities.dir, 'no-such-file.pem')), StoreRefused);
  assert.equal(pinnedAuthority(join(authorities.dir, 'a.pem')), authorities.authorityA);
  // No bundle is pinned in this build: with no file named, there is no authority.
  assert.equal(pinnedAuthority(), null);
});

test('given the authority that issued the server\'s certificate, the store connects over TLS', async () => {
  const before = front.handshakes;
  const pool = openPool(throughFront(front.port), authorities.authorityA);
  try {
    const { rows } = await pool.query<{ one: number; ssl: boolean }>('SELECT 1 AS one, (SELECT count(*) > 0 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) AS ssl');
    assert.equal(rows[0]?.one, 1);
    assert.equal(front.handshakes, before + 1, 'the connection went through the TLS front');
  } finally {
    await pool.end();
  }
});

test('given another authority, the store is refused, and names the refusal without the host', async () => {
  const before = front.handshakes;
  const pool = openPool(throughFront(front.port), authorities.authorityB);
  try {
    await assert.rejects(pool.query('SELECT 1'), (err: unknown) => {
      assert.ok(isCertificateFailure(err), `a certificate failure, not ${failureCode(err)}: ${(err as Error).message}`);
      const sentence = databaseRefusal(err);
      assert.match(sentence, /^DATABASE_URL: the database's certificate did not verify \([A-Z_]+\)$/);
      assert.ok(!sentence.includes('localhost') && !sentence.includes(String(front.port)));
      return true;
    });
    assert.equal(front.handshakes, before, 'no handshake completed');
  } finally {
    await pool.end();
  }
});

test('a certificate from the right authority for another name is refused on the name', async () => {
  const pool = openPool(throughFront(otherNameFront.port), authorities.authorityA);
  try {
    await assert.rejects(pool.query('SELECT 1'), (err: unknown) => {
      assert.ok(isCertificateFailure(err), `a certificate failure, not ${failureCode(err)}`);
      assert.equal(failureCode(err), 'ERR_TLS_CERT_ALTNAME_INVALID');
      return true;
    });
  } finally {
    await pool.end();
  }
});

test('the release step connects through the same function: applied with the right authority, refused with another', async () => {
  const env = { ...process.env, DATABASE_URL: throughFront(front.port), PATH: process.env.PATH };
  const good = await run(process.execPath, ['--import', 'tsx', 'scripts/apply-schema.ts'], { cwd: ROOT, env: { ...env, DATABASE_CA_FILE: join(authorities.dir, 'a.pem') } });
  assert.match(good.stdout, /^schema applied: db\/schema\.sql/m);
  await assert.rejects(
    run(process.execPath, ['--import', 'tsx', 'scripts/apply-schema.ts'], { cwd: ROOT, env: { ...env, DATABASE_CA_FILE: join(authorities.dir, 'b.pem') } }),
    (err: unknown) => {
      const e = err as { code?: number; stdout?: string };
      assert.equal(e.code, 1);
      // One line, and nothing else: no URL, no host, no user, no password.
      assert.match(e.stdout ?? '', /^schema not applied: DATABASE_URL: the database's certificate did not verify \([A-Z_]+\)\r?\n$/);
      assert.ok(credentials.user !== '', 'the test URL names a user');
      return true;
    },
  );
  // A named file that is not there: refused, not reached with verification off.
  await assert.rejects(
    run(process.execPath, ['--import', 'tsx', 'scripts/apply-schema.ts'], { cwd: ROOT, env: { ...env, DATABASE_CA_FILE: join(authorities.dir, 'missing.pem') } }),
    (err: unknown) => {
      assert.match((err as { stdout?: string }).stdout ?? '', /^schema not applied: DATABASE_CA_FILE could not be read/m);
      return true;
    },
  );
});

test("a pool's wait for a connection that runs out is the driver's own codeless message, which the routes read as the database being unavailable", async () => {
  // One connection, a short wait: a second connect() while the first client is held waits the whole wait and fails.
  const pool = new pg.Pool({ ...connectionSettings(database.url, null, 1), connectionTimeoutMillis: 200 });
  const held = await pool.connect();
  try {
    await assert.rejects(pool.connect(), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(failureCode(err), undefined, 'no code: the message is what tells it');
      assert.match(err.message, POOL_WAIT_EXHAUSTED);
      return true;
    });
  } finally {
    held.release();
    await pool.end();
  }
});

test('the failure helpers find a code down a cause chain and show nothing else', () => {
  const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 user=courier'), { code: 'ECONNREFUSED' });
  const outer = new Error('the pool failed', { cause: inner });
  assert.equal(failureCode(outer), 'ECONNREFUSED');
  assert.equal(errorCode(outer), ' (ECONNREFUSED)');
  assert.equal(databaseRefusal(outer), 'DATABASE_URL: the database did not answer (ECONNREFUSED)');
  assert.equal(errorCode(new Error('no code')), '');
  writeFileSync(join(authorities.dir, '.read'), 'the test ran');
});
