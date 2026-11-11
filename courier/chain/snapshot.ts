import type { Conditions } from '../records/conditions';
import { describeNodeFailure, headerByTag, type Header, type JsonRpc } from './rpc';

// One block, by hash. A read of the chain starts from the latest block's
// header, and from then on names that block by its hash in every request that
// follows. A read that fails is tried once more; a second failure opens the
// chain-unreachable condition with the failure's class and code as its fact,
// and the next read that succeeds clears it.

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

export interface ChainReader {
  /** The latest block's header: the block the request that follows names by its hash. */
  latestHeader(): Promise<Header>;
  /** The last block read, and when. Null before the first read. */
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

  async function once(): Promise<Header> {
    return headerByTag(deps.rpc, 'latest');
  }

  return {
    async latestHeader() {
      let header: Header;
      try {
        header = await once();
      } catch (first) {
        try {
          header = await once();
        } catch (second) {
          const failure = describeNodeFailure(second);
          const opened = await deps.conditions.open('chain-unreachable', { ...failure, first: describeNodeFailure(first) }, deps.run);
          if (opened) log(`condition opened: chain-unreachable (${failure.kind}${failure.code === null ? '' : ` ${failure.code}`})`);
          throw new ChainUnreachable(failure);
        }
      }
      last = { header, readAt: now() };
      const cleared = await deps.conditions.clear('chain-unreachable', { block: header.number.toString(), hash: header.hash }, deps.run);
      if (cleared) log(`condition cleared: chain-unreachable (block ${header.number})`);
      return header;
    },
    last() {
      return last;
    },
  };
}
