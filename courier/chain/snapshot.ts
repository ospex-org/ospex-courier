import type { Address, Hex } from 'viem';
import type { Conditions } from '../records/conditions';
import { describeNodeFailure, headerByTag, multicallAt, type Header, type JsonRpc, type MulticallResult } from './rpc';

// One block, by hash. A read of the chain starts from a block's header, the
// latest or the final one, and from then on names that block by its hash in
// every request that follows. A read that fails is tried once more; a second
// failure opens the chain-unreachable condition with the failure's class and
// code as its fact, and the next read that succeeds clears it.
//
// The condition's bookkeeping is kept apart from the reads. A read notes what
// it learned (the chain unreachable, or reachable again while the condition
// stood open) in memory; the request writes it afterwards, with `settle`,
// once it holds no connection of the pool. So a request never asks the pool
// for a second connection while it holds one, and where the condition does
// not change no statement is made at all: this process knows whether it
// opened the condition, or found it open when it started.

export class ChainUnreachable extends Error {
  constructor(readonly failure: { kind: string; code: number | string | null; method: string | null }) {
    super(`the chain could not be read: ${failure.kind}${failure.code === null ? '' : ` (${failure.code})`}`);
    this.name = 'ChainUnreachable';
  }
}

export interface LastRead {
  header: Header;
  readAt: Date;
}

export interface MulticallCall {
  target: Address;
  callData: Hex;
  allowFailure?: boolean;
}

export interface ChainReader {
  /** The latest block's header: the block the request that follows names by its hash. */
  latestHeader(): Promise<Header>;
  /** The final block's header, by the tag. */
  finalHeader(): Promise<Header>;
  /** The reads of state, in one call at the header's hash, each result in the order asked. */
  read(header: Header, calls: MulticallCall[]): Promise<MulticallResult[]>;
  /** The last latest-block header read, and when. Null before the first read. */
  last(): LastRead | null;
  /**
   * Writes what the reads learned about the chain-unreachable condition since
   * the last settle, if anything: its opening after a read failed twice, its
   * clearing after a read succeeded while it stood open. A request calls it
   * once it holds no connection of the pool. At most one statement, and none
   * while nothing changed. A write that fails is kept for the next settle.
   */
  settle(): Promise<void>;
}

export interface ChainReaderDeps {
  rpc: JsonRpc;
  conditions: Conditions;
  run: number;
  /** Whether the chain-unreachable condition stood open in the records when this process started. */
  openAtStart: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export function createChainReader(deps: ChainReaderDeps): ChainReader {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  let last: LastRead | null = null;
  /** Whether this process believes the condition stands open: it opened it, or found it open at its start. */
  let open = deps.openAtStart;
  /** The newest observation not yet written: the chain unreachable, or reachable again while the condition stood open. */
  let observed: { unreachable: boolean; facts: Record<string, unknown> } | null = null;

  /** Once, and once more; a second failure is noted as the condition's opening. A success while it stands open is noted as its clearing. */
  async function attempt<T>(once: () => Promise<T>, fact: (value: T) => Record<string, unknown>): Promise<T> {
    let value: T;
    try {
      value = await once();
    } catch (first) {
      try {
        value = await once();
      } catch (second) {
        const failure = describeNodeFailure(second);
        observed = { unreachable: true, facts: { ...failure, first: describeNodeFailure(first) } };
        throw new ChainUnreachable(failure);
      }
    }
    if (open || observed?.unreachable === true) observed = { unreachable: false, facts: fact(value) };
    return value;
  }

  const headerFact = (header: Header) => ({ block: header.number.toString(), hash: header.hash });

  return {
    async latestHeader() {
      const header = await attempt(() => headerByTag(deps.rpc, 'latest'), headerFact);
      last = { header, readAt: now() };
      return header;
    },
    async finalHeader() {
      return attempt(() => headerByTag(deps.rpc, 'finalized'), headerFact);
    },
    async read(header, calls) {
      return attempt(() => multicallAt(deps.rpc, header, calls), () => headerFact(header));
    },
    last() {
      return last;
    },
    async settle() {
      const o = observed;
      if (o === null) return;
      observed = null;
      try {
        if (o.unreachable && !open) {
          const opened = await deps.conditions.open('chain-unreachable', o.facts, deps.run);
          open = true;
          if (opened) log(`condition opened: chain-unreachable (${String(o.facts.kind)}${o.facts.code === null || o.facts.code === undefined ? '' : ` ${String(o.facts.code)}`})`);
        } else if (!o.unreachable && open) {
          const cleared = await deps.conditions.clear('chain-unreachable', o.facts, deps.run);
          open = false;
          if (cleared) log('condition cleared: chain-unreachable');
        }
      } catch (err) {
        // The records could not be written now: the observation is kept for the next settle.
        if (observed === null) observed = o;
        throw err;
      }
    },
  };
}
