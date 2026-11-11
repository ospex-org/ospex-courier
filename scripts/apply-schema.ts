import { applySchema, databaseRefusal, errorCode, isCertificateFailure, openPool, pinnedAuthority, StoreRefused } from '../courier/records/store';

// The release step (Procfile `release:`, or `yarn db:apply`): applies
// db/schema.sql to DATABASE_URL, through the same function the web process
// opens its connection with, so the two verify the same authority. Every
// statement in the file is safe to run again. Prints one line and never the URL.

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (databaseUrl === '') {
  console.log('schema not applied: DATABASE_URL is not set');
  process.exit(1);
}

let pool;
try {
  pool = openPool(databaseUrl, pinnedAuthority((process.env.DATABASE_CA_FILE ?? '').trim()));
} catch (err) {
  console.log(`schema not applied: ${err instanceof StoreRefused ? err.message : 'DATABASE_URL could not be read as a postgres:// URL'}`);
  process.exit(1);
}
try {
  await applySchema(pool);
  console.log('schema applied: db/schema.sql');
} catch (err) {
  console.log(isCertificateFailure(err) ? `schema not applied: ${databaseRefusal(err)}` : `schema not applied to DATABASE_URL${errorCode(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
