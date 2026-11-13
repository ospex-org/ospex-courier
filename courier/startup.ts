import { createServer, type Server } from 'node:http';
import { checkNode, type NodeCheck } from './chain/node';
import { chainId, createJsonRpc, describeNodeFailure, type JsonRpc } from './chain/rpc';
import { readSet, SetRefused, type BettingSet } from './chain/set';
import { createChainReader, type ChainReader } from './chain/snapshot';
import { readCourierConfig, type CourierConfig } from './config';
import { BOUNDS, createAddressLimiter, createCounters } from './http/limits';
import { createRequestHandler } from './http/service';
import { PublishedListRefused, readPublishedReporters } from './orders/published';
import { applySchema, createStore, databaseRefusal, missingSchema, openPool, pinnedAuthority, StoreRefused, type Store } from './records/store';
import type { Run } from './records/runs';

// The courier's start-up, in order: the settings, the database and its
// schema, the chain and the set read from the signpost, what the node can do,
// this run's row, then listen. Each refusal is a plain sentence that names the
// setting and never prints a value.

export class StartupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupRefused';
  }
}

/** What this build does not yet do, published on the status address. */
export const NOT_YET_BUILT = [
  'stops (the stop build): a stop on record is honoured at the door, but none can be recorded yet',
  'the lanes and the pre-check (the pre-check build): a bet posted is recorded and waits, and nothing examines it',
  'the sender and the key (the sender build): nothing is signed or sent',
  'incidents and their cursor (the reports build)',
  "the netted pull's payable (the order-4 build): the book's payable is what a balance and an allowance cover",
] as const;

export interface RunningService {
  port: number;
  run: Run;
  set: BettingSet;
  node: NodeCheck;
  store: Store;
  chain: ChainReader;
  rpc: JsonRpc;
  config: CourierConfig;
  /** Stops taking requests, writes this run's stop, and closes the database. */
  close(reason?: string): Promise<void>;
}

export interface StartupOptions {
  log?: (line: string) => void;
  /** Applies db/schema.sql before the columns are checked: the tests' throwaway databases. The app's release step does it. */
  applySchema?: boolean;
  now?: () => Date;
}

export async function startService(env: Record<string, string | undefined>, options: StartupOptions = {}): Promise<RunningService> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());

  const read = readCourierConfig(env);
  if (!read.ok) throw new StartupRefused(`settings: ${read.problems.join('; ')}`);
  const config = read.config;

  // The published list of reporters: a file, read once.
  let published;
  try {
    published = readPublishedReporters(config.publishedReportersFile);
  } catch (err) {
    throw new StartupRefused(err instanceof PublishedListRefused ? `the published list: ${err.message}` : 'the published list could not be read');
  }

  // The database.
  let store: Store;
  try {
    store = createStore(openPool(config.databaseUrl, pinnedAuthority(config.databaseCaFile)), log);
  } catch (err) {
    throw new StartupRefused(err instanceof StoreRefused ? err.message : 'DATABASE_URL could not be read as a postgres:// URL');
  }
  try {
    await store.pool.query('SELECT 1');
    if (options.applySchema === true) await applySchema(store.pool);
  } catch (err) {
    await store.close().catch(() => undefined);
    throw new StartupRefused(databaseRefusal(err));
  }
  const missing = await missingSchema(store.pool);
  if (missing.length > 0) {
    await store.close().catch(() => undefined);
    throw new StartupRefused(`DATABASE_URL: the database answers but does not have the courier's schema (missing: ${missing.join(', ')}); apply db/schema.sql`);
  }

  // The chain, and the set read from the signpost.
  const rpc = createJsonRpc(config.rpcUrl);
  let set: BettingSet;
  let id: bigint;
  try {
    id = await chainId(rpc);
    set = await readSet(rpc, { signpostAddress: config.signpostAddress, bettingEntryId: config.bettingEntryId }, id);
  } catch (err) {
    await store.close().catch(() => undefined);
    if (err instanceof SetRefused) throw new StartupRefused(`the set: ${err.message}`);
    const d = describeNodeFailure(err);
    throw new StartupRefused(`POLYGON_RPC_URL: the node did not answer${d.method === null ? '' : ` ${d.method}`} (${d.kind}${d.code === null ? '' : ` ${d.code}`})`);
  }
  log(`courier: the set is entry ${set.entryId} on ${set.signpost}, chain ${set.chainId}: core ${set.core}, relay ${set.relay}, coin ${set.coin}`);

  // What the node can do, proved. While it fails one the pre-check needs, the courier takes no order; this build
  // takes none, and serves the verdicts.
  const node = await checkNode(rpc, { relay: set.relay, sender: set.sender }, now);
  log(`courier: the node ${node.usable ? 'honours' : 'does not honour'} every request the pre-check makes at a block's hash; override ${node.overrideTaken.ok ? 'taken' : 'not taken'}`);

  // This run.
  const run = await store.runs.start();
  await store.events.write({ run: run.id, kind: 'run started', facts: { chainId: set.chainId.toString(), entry: set.entryId.toString(), nodeUsable: node.usable } });

  const counters = createCounters(now);
  const limiter = createAddressLimiter(BOUNDS.requestsPerAddressPerMinute);
  const chain = createChainReader({ rpc, conditions: store.conditions, run: run.id, now, log });
  const handler = createRequestHandler({ store, chain, set, node, run, counters, limiter, settings: { lowPol: config.lowPol }, published, notYetBuilt: NOT_YET_BUILT, log });
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  let closing: Promise<void> | null = null;
  return {
    port,
    run,
    set,
    node,
    store,
    chain,
    rpc,
    config,
    close(reason = 'close') {
      closing ??= (async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        limiter.close();
        try {
          await store.events.write({ run: run.id, kind: 'run stopped', reason });
          await store.runs.stop(run.id, reason);
        } finally {
          await store.close().catch(() => undefined);
        }
      })();
      return closing;
    },
  };
}
