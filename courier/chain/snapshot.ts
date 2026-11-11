import type { Address, Hex } from 'viem';
import type { Conditions } from '../records/conditions';
import { describeNodeFailure, headerByTag, multicallAt, type Header, type JsonRpc, type MulticallResult } from './rpc';

// One block, by hash. A read of the chain starts from a block's header, the
// latest or the final one, and from then on names that block by its hash in
// every request that follows. A read that fails is tried once more; a second
// failure opens the chain-unreachable condition with the failure's class and
// code as its fact, and the next read that succeeds clears it.

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

  /** Once, and once more; a second failure opens the condition. A success clears it. */
  async function attempt<T>(once: () => Promise<T>, fact: (value: T) => Record<string, unknown>): Promise<T> {
    let value: T;
    try {
      value = await once();
    } catch (first) {
      try {
        value = await once();
      } catch (second) {
        const failure = describeNodeFailure(second);
        const opened = await deps.conditions.open('chain-unreachable', { ...failure, first: describeNodeFailure(first) }, deps.run);
        if (opened) log(`condition opened: chain-unreachable (${failure.kind}${failure.code === null ? '' : ` ${failure.code}`})`);
        throw new ChainUnreachable(failure);
      }
    }
    const cleared = await deps.conditions.clear('chain-unreachable', fact(value), deps.run);
    if (cleared) log('condition cleared: chain-unreachable');
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
