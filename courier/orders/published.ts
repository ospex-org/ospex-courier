import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address } from 'viem';

// The published list of reporters: the courier carries a game only when its
// reporters are exactly this list. A file in this repository, changed by a
// reviewed commit, and never read from the chain's approved list. A test
// names another file (the rig's reporter) through PUBLISHED_REPORTERS_FILE.

export class PublishedListRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishedListRefused';
  }
}

const REPO_FILE = new URL('../../published-reporters.json', import.meta.url);

/** The list, read and checked: one address or more, each an address, none twice; checksummed. */
export function readPublishedReporters(file?: string): Address[] {
  const where = file === undefined || file === '' ? REPO_FILE : file;
  let text: string;
  try {
    text = readFileSync(where, 'utf8');
  } catch {
    throw new PublishedListRefused(file === undefined || file === '' ? 'published-reporters.json could not be read' : 'PUBLISHED_REPORTERS_FILE could not be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PublishedListRefused('the published list is not JSON');
  }
  const list = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { reporters?: unknown }).reporters : parsed;
  if (!Array.isArray(list) || list.length === 0) throw new PublishedListRefused('the published list must hold at least one reporter under "reporters"');
  const out: Address[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || !isAddress(entry, { strict: false })) throw new PublishedListRefused('the published list holds an entry that is not an address');
    const address = getAddress(entry);
    if (out.includes(address)) throw new PublishedListRefused(`the published list names ${address} twice`);
    out.push(address);
  }
  return out;
}

/** Whether a game's reporters are exactly the published list: the same addresses, each once, and no other. */
export function isPublishedList(reporters: readonly Address[], published: readonly Address[]): boolean {
  if (reporters.length !== published.length) return false;
  const have = new Set(reporters.map((r) => getAddress(r)));
  if (have.size !== reporters.length) return false;
  return published.every((p) => have.has(getAddress(p)));
}
