import { createServer, type Server } from 'node:http';
import type { Address } from 'viem';
import { checkNode, type NodeCheck } from './chain/node';
import { chainId, createJsonRpc, describeNodeFailure, type JsonRpc } from './chain/rpc';
import { readSet, SetRefused, type BettingSet } from './chain/set';
import { createChainReader, type ChainReader } from './chain/snapshot';
import { createLane } from './check/lane';
import { NO_HOOKS, type LaneHooks } from './check/hooks';
import { isSealedSend } from './check/precheck';
import { KeystoreRefused, openSigner, type Signer } from './send/signer';
import { readCourierConfig, type CourierConfig } from './config';
import { BOUNDS, createAddressLimiter, createCounters, TIMEOUTS } from './http/limits';
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

/**
 * The key's two settings and the keystore opened: the signer, or a refusal that names the settings and no value. The
 * two settings are removed from `env` once the keystore is open, so nothing later in the process can read them.
 */
function openKey(
  env: Record<string, string | undefined>,
  at: { address: Address; relay: Address; matching: Address; chainId: bigint; laneNow: () => { epoch: bigint; reservation: bigint } | null; hooks: LaneHooks | undefined },
): Signer {
  const json = (env.COURIER_KEYSTORE_JSON ?? '').trim();
  const password = env.COURIER_KEYSTORE_PASSWORD ?? '';
  const missing = [...(json === '' ? ['COURIER_KEYSTORE_JSON is not set'] : []), ...(password === '' ? ['COURIER_KEYSTORE_PASSWORD is not set'] : [])];
  if (missing.length > 0) throw new StartupRefused(`settings: ${missing.join('; ')}`);
  let signer: Signer;
  try {
    signer = openSigner({ keystoreJson: json, keystorePassword: password, address: at.address, relay: at.relay, matching: at.matching, chainId: at.chainId, isSealed: isSealedSend, laneNow: at.laneNow, ...(at.hooks?.signer === undefined ? {} : { seams: at.hooks.signer }) });
  } catch (err) {
    if (!(err instanceof KeystoreRefused)) throw new StartupRefused('the key: COURIER_KEYSTORE_JSON could not be opened');
    if (err.problem === 'wrong-password') throw new StartupRefused("the key: COURIER_KEYSTORE_PASSWORD does not open COURIER_KEYSTORE_JSON (the keystore's MAC does not match)");
    if (err.problem === 'not-the-address') throw new StartupRefused('the key: COURIER_KEYSTORE_JSON holds a key whose address is not COURIER_ADDRESS');
    throw new StartupRefused(`the key: COURIER_KEYSTORE_JSON could not be read as a keystore (${err.message.replace(/^keystore: /, '')})`);
  }
  delete env.COURIER_KEYSTORE_JSON;
  delete env.COURIER_KEYSTORE_PASSWORD;
  return signer;
}

/** What this build does not yet do, published on the status address. */
export const NOT_YET_BUILT = [
  'the sender and the key (the sender build): nothing is signed or sent; a bet found ready is closed not sent',
  'incidents and their cursor (the reports build)',
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
  /** The lane's hold points and test faults. Passed by the tests' start file only; the production start file passes none. */
  hooks?: LaneHooks;
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
    const authority = pinnedAuthority(config.databaseCaFile);
    store = createStore(openPool(config.databaseUrl, authority), openPool(config.databaseUrl, authority, 1), log, openPool(config.databaseUrl, authority, 1));
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

  // What the node can do, proved, from the key's address. The verdict is kept: while it fails one the pre-check needs,
  // the door takes no order (the node's gate), and it is served on the status address.
  const node = await checkNode(rpc, { relay: set.relay, sender: config.courierAddress, ...(config.traceCheckTransaction === undefined ? {} : { traceTransaction: config.traceCheckTransaction }) }, now);
  log(`courier: the node ${node.usable ? 'honours' : 'does not honour'} every request the pre-check makes at a block's hash; override ${node.overrideTaken.ok ? 'taken' : 'not taken'}`);

  // The key: its two settings, read here and nowhere else, the keystore opened at once and the key turned into the
  // signer's account, which is all that is kept. Once it is open the two settings leave this process's environment.
  // A refusal names the settings and never a value.
  let signer: Signer;
  let laneHeld: () => { epoch: bigint; reservation: bigint } | null = () => null;
  try {
    signer = openKey(env, { address: config.courierAddress, relay: set.relay, matching: set.matching, chainId: set.chainId, laneNow: () => laneHeld(), hooks: options.hooks });
  } catch (err) {
    await store.close().catch(() => undefined);
    throw err;
  }
  log(`courier: the key is open; it signs for ${signer.address} alone`);

  // This run.
  const run = await store.runs.start();

  // The reads of the chain. Each applies its outcome to the records at once; this process keeps nothing of the
  // chain-unreachable condition, since another process may open or clear it at any moment while this one runs.
  const chain = createChainReader({ rpc, conditions: store.conditions, run: run.id, now, log });

  // The lane, taken before the server listens: this process owns every lane from here, the bets a lane held are back
  // waiting or finished as stopped, and the `run started` line, written in the take's transaction, says so.
  const lane = createLane({
    store,
    key: config.courierAddress,
    run,
    check: { chain, rpc, set, published, overrideTaken: node.overrideTaken.ok },
    hooks: options.hooks ?? NO_HOOKS,
    log,
  });
  laneHeld = () => lane.held();
  let taken;
  try {
    taken = await lane.take({ chainId: set.chainId.toString(), entry: set.entryId.toString(), nodeUsable: node.usable });
  } catch (err) {
    await store.close().catch(() => undefined);
    throw new StartupRefused(`the lane could not be taken: ${databaseRefusal(err)}`);
  }
  log(`courier: lane ${config.courierAddress} taken at epoch ${taken.epoch}; ${taken.returned.length} held bet${taken.returned.length === 1 ? '' : 's'} back to waiting, ${taken.stopped.length} finished as stopped`);

  const counters = createCounters(now);
  const limiter = createAddressLimiter(BOUNDS.requestsPerAddressPerMinute);
  // The stop route's own count: a second limiter, so a stop is held up by no other request from its address, and holds none up.
  const stopLimiter = createAddressLimiter(BOUNDS.stopsPerAddressPerMinute);
  const handler = createRequestHandler({ store, chain, set, node, lane, run, counters, limiter, stopLimiter, settings: { lowPol: config.lowPol }, published, notYetBuilt: NOT_YET_BUILT, log });
  // The server's own timeout on a request arriving: a stated number (http/limits.ts), not Node's five minutes; and
  // how often it looks, so the close comes within a second of the number and not within Node's thirty.
  const server: Server = createServer({ requestTimeout: TIMEOUTS.requestMs, connectionsCheckingInterval: TIMEOUTS.checkEveryMs }, handler);
  server.headersTimeout = TIMEOUTS.headersMs;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  // The runner, woken once the take is done: it checks the bets the take found waiting, in record order.
  lane.wake();

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
        stopLimiter.close();
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
