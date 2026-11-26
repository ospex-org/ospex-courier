import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { keccak256, type Hex } from 'viem';
import { closeEach } from './close';
import { testServer } from './database';
import { startCourier, startHookedCourier, type CourierProcess, type HookControl } from './courier';
import { testKeystoreFor } from './keystore';
export type { CourierProcess };
import { startProxy, type ChainProxy, type Sends } from './proxy';
import { startRig, type Rig } from './rig';
import { startTcpRelay, type TcpRelay } from './tcp';

// The whole rig for a test file: the chain, the proxy in front of it, a
// database with the schema applied, a relay in front of the database, and the
// courier as its own process against the two. At its close every stack prints
// what the courier sent through the proxy, counted as the requests arrived,
// and asserts that it never asked the node to sign anything, and that it sent no
// transaction but the Crosses its records hold as handed to the node, each
// once by its own bytes, unless the file names why its records cannot be held
// to its sends (`sendsApart`).

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
  /** The stack's own courier: the one its tests post to. A restart replaces it. */
  courier: CourierProcess & { hooks?: HookControl };
  /**
   * Stops the stack's courier and starts it again, so the stack's process owns the lanes again (its take raises every
   * lane's epoch): after a case that started another process on the stack's database, and wherever a case needs the
   * runner held from the start. `hooked` starts it through the tests' start file; `holds` arms its points before the
   * service starts.
   */
  restartCourier(options?: { hooked?: boolean; holds?: string }): Promise<CourierProcess & { hooks?: HookControl }>;
  env: { DATABASE_URL: string; POLYGON_RPC_URL: string; SIGNPOST_ADDRESS: string; BETTING_ENTRY_ID: string; PUBLISHED_REPORTERS_FILE: string; COURIER_ADDRESS: string; COURIER_KEYSTORE_JSON: string; COURIER_KEYSTORE_PASSWORD: string };
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

/** Starts the stack's courier: through the production start file, or through the tests' start file where `hooked`. */
function launchCourier(env: Stack['env'], options: { hooked?: boolean; holds?: string }): Promise<CourierProcess & { hooks?: HookControl }> {
  return options.hooked === true || options.holds !== undefined ? startHookedCourier(env, options.holds ?? '') : startCourier(env);
}

/**
 * The stack's options. `blockTime` mines a block every so many seconds with the pool open, as the sender's tests need;
 * `sending` is a stack whose courier sends, where each test counts its own signatures and hand-offs, and whose close
 * holds the sends to the records as any stack's does.
 */
export interface StackOptions {
  hooked?: boolean;
  holds?: string;
  genesisTime?: bigint;
  coin?: 'TestCoin' | 'RefusingCoin' | 'FalseCoin';
  blockTime?: number;
  sending?: true;
  /**
   * Why this file's records cannot be held to its sends at the close, in the file's own words. `copies`: its couriers
   * on copies of the stack's database send through the same proxy and keep their records in the copies, so the close
   * asserts only that nothing asked the node to sign. `unsent`: its records hold hand-offs that never reached the
   * node, laid by the test or cut off by a kill between the gate and the request, so the close still holds every send
   * to a hand-off its records hold, by the transaction's own bytes, once, and does not hold every hand-off to a send.
   */
  sendsApart?: { copies: string } | { unsent: string };
}

export async function startStack(prefix: string, options: StackOptions = {}): Promise<Stack> {
  const rig = await startRig({
    ...(options.genesisTime === undefined ? {} : { genesisTime: options.genesisTime }),
    ...(options.coin === undefined ? {} : { coin: options.coin }),
    ...(options.blockTime === undefined ? {} : { blockTime: options.blockTime }),
  });
  const proxy = await startProxy(rig.url);
  const db = testServer();
  const { name, url } = await db.createWithSchema(prefix);
  const direct = new URL(url);
  const dbRelay = await startTcpRelay(Number(direct.port === '' ? 5432 : direct.port));
  const relayed = new URL(url);
  relayed.hostname = '127.0.0.1';
  relayed.port = String(dbRelay.port);
  const publishedListFile = publishedList([rig.addresses.reporter]);
  // The key: the relay's sender on the rig, account 4 of the local chain's published test accounts, in the run's test
  // keystore, made in memory and handed to the courier's own process alone.
  const keystore = testKeystoreFor(rig.accounts.sender.address);
  if (keystore === null) throw new Error("the relay's sender on the rig is not one of the local chain's test accounts");
  const env = {
    DATABASE_URL: relayed.toString(),
    POLYGON_RPC_URL: proxy.url,
    SIGNPOST_ADDRESS: rig.addresses.signpost,
    BETTING_ENTRY_ID: rig.bettingEntryId.toString(),
    PUBLISHED_REPORTERS_FILE: publishedListFile,
    COURIER_ADDRESS: rig.accounts.sender.address,
    COURIER_KEYSTORE_JSON: keystore.json,
    COURIER_KEYSTORE_PASSWORD: keystore.password,
  };
  let courier: CourierProcess & { hooks?: HookControl };
  try {
    courier = await launchCourier(env, options);
  } catch (err) {
    await closeEach(
      () => dbRelay.close(),
      () => proxy.close(),
      () => rig.close(),
      () => db.end(),
    ).catch(() => undefined);
    throw err;
  }
  const stack: Stack = {
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
    async restartCourier(again = {}) {
      await stack.courier.stop();
      stack.courier = await launchCourier(env, again);
      return stack.courier;
    },
    async close() {
      let sends: Sends = { eth_sendRawTransaction: 0, eth_sendTransaction: 0 };
      let sent: string[] = [];
      let handed: string[] = [];
      const apart = options.sendsApart;
      // Each step in its own try: the database is dropped whatever failed before it.
      await closeEach(
        () => stack.courier.stop(),
        async () => {
          // Counted once the courier has stopped, so a send in flight at the close is in the count too.
          sends = proxy.sends();
          sent = proxy.counted.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => (c.sent === undefined ? 'a send with no bytes' : keccak256(c.sent as Hex).toLowerCase()));
          console.log(`# the courier's sends through the proxy (${prefix}): eth_sendRawTransaction ${sends.eth_sendRawTransaction}, eth_sendTransaction ${sends.eth_sendTransaction}`);
          if (apart !== undefined && 'copies' in apart) return;
          // The Crosses the records hold as handed to the node: what the sends must be, one each, by their own bytes.
          const records = new pg.Pool({ connectionString: url, max: 1 });
          try {
            const { rows } = await records.query<{ tx_hash: string | null }>('SELECT tx_hash FROM crosses WHERE hand_offs = 1');
            handed = rows.map((r) => String(r.tx_hash).toLowerCase());
          } finally {
            await records.end();
          }
        },
        () => dbRelay.close(),
        () => proxy.close(),
        () => rig.close(),
        () => db.end(),
      );
      assert.equal(sends.eth_sendTransaction, 0, 'the courier asked the node to sign a transaction');
      if (apart !== undefined && 'copies' in apart) {
        console.log(`# the sends held to no records at the close (${prefix}): ${apart.copies}`);
        return;
      }
      if (apart !== undefined && 'unsent' in apart) {
        console.log(`# the hand-offs not held to sends at the close (${prefix}): ${apart.unsent}`);
        const left = [...handed];
        for (const s of sent) {
          const i = left.indexOf(s);
          assert.ok(i >= 0, `the courier sent a transaction its records do not hold as handed off, or sent one twice: ${s}`);
          left.splice(i, 1);
        }
        return;
      }
      assert.deepEqual([...sent].sort(), [...handed].sort(), 'the courier sent a transaction its records do not hold as handed off once, or its records hold a hand-off that never reached the node');
    },
  };
  return stack;
}
