import { afterEach } from 'node:test';

// What a chain proxy of the tests saw (tests/support/proxy.ts), kept for the print of a failed case alone
// (tests/support/courier.ts): each request's method, the block or the transaction it named, when it arrived and when it
// was answered, how, and what its answer said in typed form; and each change of the proxy's rules, with its time. Never
// a transaction's signed bytes, a node's own words, or any value a key setting holds.
//
// With them, each change seen of a final block the test held at a height: a case in which one is seen fails at its end,
// saying so, whatever else it did.

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
  /** Each change seen of a final block the test held at a height, said whole; the first `heldTaken` of them already said. */
  held: string[];
  heldTaken: number;
  /** The checks of a held final block that have begun and are not done. */
  checking: Set<Promise<void>>;
}

const journals: Journal[] = [];

/** A journal for one proxy, kept for this test process's life. */
export function openJournal(label: string, blockHash: Journal['blockHash']): Journal {
  const journal: Journal = { label, entries: [], rules: [], blockHash, held: [], heldTaken: 0, checking: new Set() };
  journals.push(journal);
  return journal;
}

/** Every proxy's journal in this test process. */
export function allJournals(): readonly Journal[] {
  return journals;
}

/** Resolves once every check of a held final block that has begun in the journal is done, those begun meanwhile too. */
export async function heldChecked(journal: Journal): Promise<void> {
  while (journal.checking.size > 0) await Promise.all([...journal.checking]);
}

/** The changes of a held final block not yet said; taking them says them, so each is said once. */
export function takeHeld(journal: Journal): string[] {
  const changes = journal.held.slice(journal.heldTaken);
  journal.heldTaken = journal.held.length;
  return changes;
}

/** A case's context, as its hooks read it: whether it passed, and where its notes are printed. */
export interface CaseContext {
  passed?: boolean;
  diagnostic?: (message: string) => void;
}

const atEnd: Array<(failed: boolean, t: CaseContext) => Promise<void>> = [];

/** Work for each case's end (the couriers' print, tests/support/courier.ts), told whether the case failed. */
export function atCaseEnd(work: (failed: boolean, t: CaseContext) => Promise<void>): void {
  atEnd.push(work);
}

// The one hook at each case's end: the checks of any held final block finished, the work for the case's end done with
// what decides failure, and the case failed where a held final block changed, saying so. It is the last thing a case
// runs, so the print comes before it.
afterEach(async (context) => {
  const t = context as unknown as CaseContext;
  const changes: string[] = [];
  for (const journal of journals) {
    await heldChecked(journal);
    for (const change of takeHeld(journal)) changes.push(`${journal.label}: ${change}`);
  }
  const failed = t.passed === false || changes.length > 0;
  for (const work of atEnd) {
    try {
      await work(failed, t);
    } catch {
      // The work says its own failure; the case's own result stands.
    }
  }
  if (changes.length > 0) {
    for (const change of changes) t.diagnostic?.(`the final block the rig held changed: ${change}`);
    throw new Error(`the final block the rig held changed: ${changes.join('; ')}`);
  }
});

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
