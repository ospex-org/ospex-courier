import type { NodeCheck } from '../chain/node';
import type { BettingSet } from '../chain/set';
import type { ChainReader } from '../chain/snapshot';
import { BOUNDS, type Counters } from '../http/limits';
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
  settings: { lowPol: number };
  /** What this build does not yet do, named so a reader does not take its absence for a quiet courier. */
  notYetBuilt: readonly string[];
}

export async function status(deps: StatusDeps): Promise<Record<string, unknown>> {
  let conditions;
  let newestReportLine;
  let databaseSize;
  let run;
  try {
    [conditions, newestReportLine, databaseSize, run] = await Promise.all([
      deps.store.conditions.open_(),
      deps.store.newestReportLine(),
      deps.store.databaseSize(),
      deps.store.runs.get(deps.run.id),
    ]);
  } catch (err) {
    throw new DatabaseUnreadable(err);
  }
  const last = deps.chain.last();
  const set = deps.set;
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
      games: set.games,
      timelock: set.timelock,
      readAt: { number: set.readAt.number.toString(), hash: set.readAt.hash },
    },
    sender: { relay: set.sender, key: null },
    node: deps.node,
    bounds: BOUNDS,
    settings: { lowPol: deps.settings.lowPol },
    refusedBeforeAdmission: { since: deps.counters.since.toISOString(), byCode: deps.counters.snapshot() },
    database: { sizeBytes: databaseSize },
    notYetBuilt: deps.notYetBuilt,
  };
}
