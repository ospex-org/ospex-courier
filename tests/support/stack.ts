import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testServer } from './database';
import { startCourier, type CourierProcess } from './courier';
export type { CourierProcess };
import { startProxy, type ChainProxy } from './proxy';
import { startRig, type Rig } from './rig';
import { startTcpRelay, type TcpRelay } from './tcp';

// The whole rig for a test file: the chain, the proxy in front of it, a
// database with the schema applied, a relay in front of the database, and the
// courier as its own process against the two. At its close every stack prints
// what the courier sent through the proxy, counted as the requests arrived,
// and asserts it sent nothing: this build holds no key and sends no
// transaction, and the suite shows it rather than the source alone.

export interface Stack {
  rig: Rig;
  proxy: ChainProxy;
  db: ReturnType<typeof testServer>;
  databaseName: string;
  /** The database's URL, straight to the server. */
  databaseUrl: string;
  /** The database's URL through the relay the test can cut: what the courier is given. */
  relayedUrl: string;
  dbRelay: TcpRelay;
  courier: CourierProcess;
  env: { DATABASE_URL: string; POLYGON_RPC_URL: string; SIGNPOST_ADDRESS: string; BETTING_ENTRY_ID: string; PUBLISHED_REPORTERS_FILE: string };
  /** A published list naming the rig's reporter: what the courier under test is given. */
  publishedListFile: string;
  close(): Promise<void>;
}

/** Writes a published list naming these reporters to a fresh temporary file and returns its path. */
export function publishedList(reporters: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'courier-published-'));
  const file = join(dir, 'published-reporters.json');
  writeFileSync(file, JSON.stringify({ reporters }), 'utf8');
  return file;
}

export async function startStack(prefix: string): Promise<Stack> {
  const rig = await startRig();
  const proxy = await startProxy(rig.url);
  const db = testServer();
  const { name, url } = await db.createWithSchema(prefix);
  const direct = new URL(url);
  const dbRelay = await startTcpRelay(Number(direct.port === '' ? 5432 : direct.port));
  const relayed = new URL(url);
  relayed.hostname = '127.0.0.1';
  relayed.port = String(dbRelay.port);
  const publishedListFile = publishedList([rig.addresses.reporter]);
  const env = {
    DATABASE_URL: relayed.toString(),
    POLYGON_RPC_URL: proxy.url,
    SIGNPOST_ADDRESS: rig.addresses.signpost,
    BETTING_ENTRY_ID: rig.bettingEntryId.toString(),
    PUBLISHED_REPORTERS_FILE: publishedListFile,
  };
  let courier: CourierProcess;
  try {
    courier = await startCourier(env);
  } catch (err) {
    await dbRelay.close();
    await proxy.close();
    await rig.close();
    await db.end();
    throw err;
  }
  return {
    rig,
    proxy,
    db,
    databaseName: name,
    databaseUrl: url,
    relayedUrl: relayed.toString(),
    dbRelay,
    courier,
    env,
    publishedListFile,
    async close() {
      await courier.stop();
      // Counted once the courier has stopped, so a send in flight at the close is in the count too.
      const sends = proxy.sends();
      console.log(`# the courier's sends through the proxy (${prefix}): eth_sendRawTransaction ${sends.eth_sendRawTransaction}, eth_sendTransaction ${sends.eth_sendTransaction}`);
      await dbRelay.close();
      await proxy.close();
      await rig.close();
      await db.end();
      assert.deepEqual(sends, { eth_sendRawTransaction: 0, eth_sendTransaction: 0 }, 'the courier sent a transaction, or tried to: this build signs and sends nothing');
    },
  };
}
