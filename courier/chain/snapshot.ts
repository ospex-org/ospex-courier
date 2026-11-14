import type { Address, Hex } from 'viem';
import type { Conditions } from '../records/conditions';
import { failureCode } from '../records/store';
import { describeNodeFailure, headerByTag, multicallAt, NodeFailure, StateMismatch, type Header, type JsonRpc, type MulticallResult } from './rpc';

// One block, by hash. A read of the chain starts from a block's header, the
// latest or the final one, and from then on names that block by its hash in
// every request that follows.
//
// A read that fails is tried once more, and a read that fails twice is the
// chain unreachable: the condition opens when the records process it, with
// the failure's class and code as its fact, and the route answers 503. A
// failure of the read is anything the node did not answer as asked, including
// an answer the read cannot use: a header short of a field, a multicall whose
// envelope or whose required state values do not decode, a read refused at the
// named block. What the read requires is decoded inside the read, before it
// is a success. An intelligible negative from a contract (a game the set
// refuses, where the call allowed failure) is a usable answer and a success.
// A fault of the courier's own, which is no failure of the node's, is thrown
// at once, tried no more, recorded as nothing, and answered 500 by the
// catch-all.
//
// Each read's outcome goes to the records at once, by the read itself,
// before the value returns or the failure is thrown: nothing is kept for
// later and nothing is settled when the request ends, so no outcome is lent
// to another request and this process holds no belief about the condition.
// The records decide (records/conditions.ts): closed and a success, nothing;
// closed and a failure, the opening; open and a success, the clearing; open
// and a failure, nothing, in the order they process the outcomes. The request
// holds no connection of the reads' pool at any of its reads (the door's read
// of an account's standing quotes holds the door's own connection and asks
// the reads' pool for one: never the same pool twice). A statement that fails
// is a log line, and the outcome is dropped with it; the next read makes its
// own.

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
  /**
   * The reads of state, in one call at the header's hash, decoded into what the read is for by `decode` inside the
   * read: an answer `decode` cannot use (it throws the node's `malformed` failure) is a failure of the read, tried
   * once more, and twice is the chain unreachable.
   */
  read<T>(header: Header, calls: MulticallCall[], decode: (results: MulticallResult[]) => T): Promise<T>;
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

/** Whether a failure is the node's (a request not answered as asked, an answer that cannot be used, a read at the wrong block), and not a fault of the courier's own. */
const isTheNodes = (err: unknown): boolean => err instanceof NodeFailure || err instanceof StateMismatch;

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

  /**
   * Once, and once more; a second failure of the node's is the condition's opening and a success its clearing, each
   * applied to the records before the value is returned or the failure thrown. A fault of the courier's own is thrown
   * as it is, at once.
   */
  async function attempt<T>(once: () => Promise<T>, fact: (value: T) => Record<string, unknown>): Promise<T> {
    let value: T;
    try {
      value = await once();
    } catch (first) {
      if (!isTheNodes(first)) throw first;
      try {
        value = await once();
      } catch (second) {
        if (!isTheNodes(second)) throw second;
        const failure = describeNodeFailure(second);
        const facts = { ...failure, first: describeNodeFailure(first) };
        await applied(async () => {
          const { opened } = await deps.conditions.applyFailure('chain-unreachable', facts, deps.run);
          if (opened) log(`condition opened: chain-unreachable (${described(facts)})`);
        });
        throw new ChainUnreachable(failure);
      }
    }
    const facts = fact(value);
    await applied(async () => {
      const { cleared } = await deps.conditions.applySuccess('chain-unreachable', facts, deps.run);
      if (cleared) log('condition cleared: chain-unreachable');
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
    async read(header, calls, decode) {
      return attempt(async () => decode(await multicallAt(deps.rpc, header, calls)), () => headerFact(header));
    },
    last() {
      return last;
    },
  };
}
