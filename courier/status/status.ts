import type { Address } from 'viem';
import type { NodeCheck } from '../chain/node';
import type { BettingSet } from '../chain/set';
import type { ChainReader } from '../chain/snapshot';
import { BOUNDS, TIMEOUTS, type AddressLimiter, type Counters } from '../http/limits';
import type { Store } from '../records/store';
import type { Run } from '../records/runs';

// What stands now, served at GET /v1/status. Public, and nothing in it is a
// secret: every fact is on chain or is the courier's own. If the database
// cannot be read the status answers 503 and says that: it does not serve what
// it last knew as if it were now.

export class DatabaseUnreadable extends Error {
  constructor(cause: unknown) {
    super('the database could not be read', { cause });
    this.name = 'DatabaseUnreadable';
  }
}

export interface StatusDeps {
  store: Store;
  chain: ChainReader;
  set: BettingSet;
  node: NodeCheck;
  run: Run;
  counters: Counters;
  /** The one limit kept in memory: each address's minute. */
  limiter: AddressLimiter;
  settings: { lowPol: number };
  /** The published list of reporters, read at start. */
  published: readonly Address[];
  /** What this build does not yet do, named so a reader does not take its absence for a quiet courier. */
  notYetBuilt: readonly string[];
}

/** The two rates the growth is said at: the courier's budget refilling all day, and one maker at its card's defaults. */
export const GROWTH_RATES = {
  /** The courier's budget: 60 a minute, all day. */
  budgetRefillPerDay: 60 * 60 * 24,
  /** One maker: 13 games, 3 markets, 2 sides, re-signed every 10 minutes. */
  makerDefaultsPerDay: 13 * 3 * 2 * 144,
} as const;

export async function status(deps: StatusDeps): Promise<Record<string, unknown>> {
  let conditions;
  let newestReportLine;
  let databaseSize;
  let run;
  let maintenance;
  let growth;
  try {
    [conditions, newestReportLine, databaseSize, run, maintenance, growth] = await Promise.all([
      deps.store.conditions.open_(),
      deps.store.newestReportLine(),
      deps.store.databaseSize(),
      deps.store.runs.get(deps.run.id),
      deps.store.maintenance(),
      deps.store.growth(),
    ]);
  } catch (err) {
    throw new DatabaseUnreadable(err);
  }
  const last = deps.chain.last();
  const set = deps.set;
  // The growth a day: each admitted order is one orders row and one events line; said at two rates, from the
  // bytes per row the database reports today, where it has rows enough to say.
  const perRow = (table: string) => growth.find((g) => g.table === table)?.bytesPerRow ?? null;
  const perOrder = perRow('orders') !== null && perRow('events') !== null ? (perRow('orders') as number) + (perRow('events') as number) : null;
  return {
    run: run === null ? null : { id: run.id, startedAt: run.startedAt.toISOString() },
    conditions: conditions.map((c) => ({ key: c.key, openedAt: c.openedAt.toISOString(), openedLine: c.openedLine, facts: c.facts })),
    newestReportLine,
    lastBlockRead:
      last === null
        ? null
        : { number: last.header.number.toString(), hash: last.header.hash, time: last.header.timestamp.toString(), readAt: last.readAt.toISOString() },
    set: {
      chainId: set.chainId.toString(),
      signpost: set.signpost,
      entryId: set.entryId.toString(),
      commit: set.commit,
      core: set.core,
      markets: set.markets,
      positions: set.positions,
      matching: set.matching,
      moneyline: set.moneyline,
      spread: set.spread,
      total: set.total,
      relay: set.relay,
      coin: set.coin,
      coinDecimals: set.coinDecimals,
      games: set.games,
      timelock: set.timelock,
      readAt: { number: set.readAt.number.toString(), hash: set.readAt.hash },
    },
    sender: { relay: set.sender, key: null },
    node: deps.node,
    bounds: BOUNDS,
    /** How long the server waits for a request to arrive whole, in milliseconds. */
    timeouts: TIMEOUTS,
    published: { reporters: deps.published },
    settings: { lowPol: deps.settings.lowPol },
    refusedBeforeAdmission: { since: deps.counters.since.toISOString(), byCode: deps.counters.snapshot() },
    /** The addresses holding a request in the last minute, this process: a count, never an address. */
    addressMinute: { addresses: deps.limiter.addresses(), perMinute: BOUNDS.requestsPerAddressPerMinute },
    database: {
      sizeBytes: databaseSize,
      /** The orders table's maintenance settings, as the database holds them. */
      maintenance: { orders: maintenance },
      tables: growth,
      growth: {
        bytesPerAdmittedOrder: perOrder,
        perDay: perOrder === null ? null : { atBudgetRefill: perOrder * GROWTH_RATES.budgetRefillPerDay, atMakerDefaults: perOrder * GROWTH_RATES.makerDefaultsPerDay },
        rates: GROWTH_RATES,
        note: 'bytes per row are read from the database where a table holds 1,000 rows or more; an order is one orders row and one events line',
      },
    },
    notYetBuilt: deps.notYetBuilt,
  };
}
