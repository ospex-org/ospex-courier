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
// it learned (the chain unreachable after two failures, or a read that
// succeeded) in memory; the request acts on it afterwards, with `settle`,
// once it holds no connection of the pool. So a request never asks the pool
// for a second connection while it holds one. The clearing is the next read
// that succeeds, whichever process makes it: another process may have opened
// the condition while this one ran, and nothing this process remembers can
// say so. So a read that succeeds asks the records, with one statement and
// no transaction, whether the condition stands open, unless this process
// already knows it does (it opened it, or found it open when it started);
// where it stands open, the clear runs under the condition's lock, so two
// processes that read successfully at once write one clearing line.

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
   * Acts on what the reads learned about the chain-unreachable condition since
   * the last settle, if anything: its opening after a read failed twice, its
   * clearing after a read succeeded while it stood open, in whichever process.
   * A request calls it once it holds no connection of the pool. Nothing where
   * no chain was read; after a read that succeeded, one statement asking
   * whether the condition stands open (none where this process knows it does),
   * then the clearing's transaction only where it does; after a read that
   * failed twice, the opening's transaction, unless this process knows it is
   * open already. A statement that fails is kept for the next settle.
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
  /**
   * Whether this process knows the condition stands open: it opened it, or found it open at its start. True is
   * knowledge, and the clear needs no lookup first; false is not, since another process may have opened it.
   */
  let open = deps.openAtStart;
  /** The newest observation not yet settled: the chain unreachable, or a read that succeeded. */
  let observed: { unreachable: boolean; facts: Record<string, unknown> } | null = null;

  /** Once, and once more; a second failure is noted as the condition's opening. A success is noted, and settles as its clearing where it stands open. */
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
    observed = { unreachable: false, facts: fact(value) };
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
        if (o.unreachable) {
          if (!open) {
            const opened = await deps.conditions.open('chain-unreachable', o.facts, deps.run);
            open = true;
            if (opened) log(`condition opened: chain-unreachable (${String(o.facts.kind)}${o.facts.code === null || o.facts.code === undefined ? '' : ` ${String(o.facts.code)}`})`);
          }
        } else if (open || (await deps.conditions.standsOpen('chain-unreachable'))) {
          // A read succeeded while the condition stands open, opened by this process or by another: the next read
          // that succeeds clears it, whichever process makes it. The clear is under the condition's lock, so of two
          // processes clearing at once one writes the line and the other finds it cleared.
          const cleared = await deps.conditions.clear('chain-unreachable', o.facts, deps.run);
          open = false;
          if (cleared) log('condition cleared: chain-unreachable');
        }
      } catch (err) {
        // The records could not be read or written now: the observation is kept for the next settle.
        if (observed === null) observed = o;
        throw err;
      }
    },
  };
}
