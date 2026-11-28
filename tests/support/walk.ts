import type { Hex } from 'viem';
import { headerByHash, type Header, type JsonRpc } from '../../courier/chain/rpc';

// The earlier build's walk, kept here in the tests' support alone, as the control of the crossed-history cases
// (tests/deep.test.ts): a block below the final block F shown on F's chain by reading F's parents by hash, one request
// a block, down to the block's height, each parent held to the height below and the hash asked for. The courier no
// longer does this; it reads the header at the block's own height by number (courier/send/chain.ts). This keeps the
// one thing that walk caught and the method does not: a block of another history at that height, served by a
// provider whose answers by number and by hash come from different histories.

/** Whether `block` is F's ancestor by F's parent links, or 'contradiction' where a parent is not the block below or not the one asked for, or 'missing' where one is not returned. */
export async function walkedTo(rpc: JsonRpc, F: Header, block: { number: bigint; hash: Hex }): Promise<boolean | 'contradiction' | 'missing'> {
  let at = F;
  while (at.number > block.number) {
    const below = at.parentHash;
    const parent = await headerByHash(rpc, below);
    if (parent === null) return 'missing';
    if (parent.number !== at.number - 1n || parent.hash.toLowerCase() !== below.toLowerCase()) return 'contradiction';
    at = parent;
  }
  return at.number === block.number && at.hash.toLowerCase() === block.hash.toLowerCase();
}
