// What a chain proxy of the tests saw (tests/support/proxy.ts), kept for the print of a failed case alone
// (tests/support/courier.ts): each request's method, the block or the transaction it named, when it arrived and when it
// was answered, how, and what its answer said in typed form; and each change of the proxy's rules, with its time. Never
// a transaction's signed bytes, a node's own words, or any value a key setting holds.

export interface JournalEntry {
  n: number;
  method: string;
  /** The block the request named (a tag, a number or a hash), or for a transaction's receipt or trace, its hash. */
  named: string | null;
  arrivedAt: number;
  answeredAt: number | null;
  how: string;
  /** What the answer said, typed: a block's number, hash and time, a count, a receipt's block and status, or an error's code. */
  answer: string | null;
}

export interface RuleChange {
  at: number;
  what: string;
  /** For a final block held by number: that number, whose hash the print reads from the chain. */
  finalNumber?: bigint;
}

export interface Journal {
  label: string;
  entries: JournalEntry[];
  rules: RuleChange[];
  /** The hash of the chain's block at a number, read from the chain itself, past the proxy; null where it has none. */
  blockHash(number: bigint): Promise<string | null>;
}

const journals: Journal[] = [];

/** A journal for one proxy, kept for this test process's life. */
export function openJournal(label: string, blockHash: Journal['blockHash']): Journal {
  const journal: Journal = { label, entries: [], rules: [], blockHash };
  journals.push(journal);
  return journal;
}

/** Every proxy's journal in this test process. */
export function allJournals(): readonly Journal[] {
  return journals;
}

const decimal = (v: unknown): string => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v).toString() : String(v));

/** The block a request named, or the transaction it named, by its method; null where it names neither, or where what it carries is a signed transaction. */
export function namedBy(method: string, params: unknown[]): string | null {
  const block = (v: unknown): string | null => {
    if (typeof v === 'string') return /^0x[0-9a-fA-F]{1,16}$/.test(v) ? decimal(v) : v;
    if (typeof v === 'object' && v !== null && typeof (v as { blockHash?: unknown }).blockHash === 'string') return (v as { blockHash: string }).blockHash;
    if (typeof v === 'object' && v !== null && typeof (v as { blockNumber?: unknown }).blockNumber === 'string') return decimal((v as { blockNumber: string }).blockNumber);
    return null;
  };
  switch (method) {
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return block(params[0]);
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
    case 'debug_traceTransaction':
      return typeof params[0] === 'string' ? params[0] : null;
    case 'eth_sendRawTransaction':
    case 'eth_sendTransaction':
      return null;
    default:
      return params.length === 0 ? null : block(params[params.length - 1]);
  }
}

/** What an answer said, typed by its method: never a node's own words, and never more than the fields named here. */
export function answerOf(method: string, text: string | null): string | null {
  if (text === null) return null;
  let doc: { result?: unknown; error?: { code?: unknown } };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    return 'not JSON';
  }
  if (doc.error !== undefined) return `error ${String(doc.error?.code)}`;
  const r = doc.result;
  if (r === null || r === undefined) return 'null';
  switch (method) {
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash': {
      const b = r as { number?: unknown; hash?: unknown; timestamp?: unknown };
      return `block ${decimal(b.number)} ${String(b.hash)} time ${decimal(b.timestamp)}`;
    }
    case 'eth_getTransactionReceipt': {
      const t = r as { blockNumber?: unknown; blockHash?: unknown; status?: unknown };
      return `receipt in block ${decimal(t.blockNumber)} ${String(t.blockHash)} status ${decimal(t.status)}`;
    }
    case 'eth_getTransactionCount':
    case 'eth_blockNumber':
    case 'eth_estimateGas':
    case 'eth_maxPriorityFeePerGas':
    case 'eth_gasPrice':
    case 'eth_chainId':
    case 'eth_getBalance':
      return decimal(r);
    case 'eth_sendRawTransaction':
      return typeof r === 'string' ? `taken as ${r}` : 'answered';
    default:
      return typeof r === 'string' ? `answered, ${Math.max(0, (r.length - 2) / 2)} bytes` : 'answered';
  }
}
