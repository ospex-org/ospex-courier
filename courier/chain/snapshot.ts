import { performance } from 'node:perf_hooks';
import type { Address, Hex } from 'viem';
import type { Conditions, Moment } from '../records/conditions';
import { failureCode } from '../records/store';
import { describeNodeFailure, headerByTag, multicallAt, type Header, type JsonRpc, type MulticallResult } from './rpc';

// One block, by hash. A read of the chain starts from a block's header, the
// latest or the final one, and from then on names that block by its hash in
// every request that follows. A read that fails is tried once more; a second
// failure opens the chain-unreachable condition with the failure's class and
// code as its fact, and the next read that succeeds clears it.
//
// Each read's outcome goes to the records at once, by the statement that
// follows the node's answer, before the request goes on (records/conditions.ts
// has the rule and the order). Nothing is kept for later and nothing is
// settled when the request ends, so no outcome is left for a later request to
// settle, and this process holds no belief about the condition for a decision
// to rest on: the records decide every opening and clearing. The moment the
// answer arrived goes with the outcome, so a statement that waited on this
// process does not make the outcome look later than it was. The request holds
// no connection of the reads' pool at any of its reads (the door's read of an
// account's standing quotes holds the door's own connection, and asks the
// reads' pool for one: never the same pool twice). A statement that fails is a
// log line, and the outcome is dropped with it; the next read makes its own.

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
}

export interface ChainReaderDeps {
  rpc: JsonRpc;
  conditions: Conditions;
  run: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export function createChainReader(deps: ChainReaderDeps): ChainReader {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  let last: LastRead | null = null;

  const described = (facts: Record<string, unknown>) => `${String(facts.kind)}${facts.code === null || facts.code === undefined ? '' : ` ${String(facts.code)}`}`;

  /** The outcome's bookkeeping, awaited: the request goes on once the records have it. A statement that fails is a line, and the outcome is dropped. */
  async function applied(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      log(`condition: the chain-unreachable bookkeeping could not be read or written${failureCode(err) === undefined ? '' : ` (${failureCode(err)})`}`);
    }
  }

  /** Once, and once more; a second failure is the condition's opening and a success its clearing, each applied to the records before the value is returned or the failure thrown. */
  async function attempt<T>(once: () => Promise<T>, fact: (value: T) => Record<string, unknown>): Promise<T> {
    let value: T;
    try {
      value = await once();
    } catch (first) {
      try {
        value = await once();
      } catch (second) {
        const at: Moment = performance.now();
        const failure = describeNodeFailure(second);
        const facts = { ...failure, first: describeNodeFailure(first) };
        await applied(async () => {
          const { opened } = await deps.conditions.applyFailure('chain-unreachable', facts, deps.run, at);
          if (opened) log(`condition opened: chain-unreachable (${described(facts)})`);
        });
        throw new ChainUnreachable(failure);
      }
    }
    const at: Moment = performance.now();
    const facts = fact(value);
    await applied(async () => {
      const { cleared, reopened } = await deps.conditions.applySuccess('chain-unreachable', facts, deps.run, at);
      if (cleared) log('condition cleared: chain-unreachable');
      if (reopened !== null) log(`condition opened: chain-unreachable (${described(reopened)})`);
    });
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
  };
}
