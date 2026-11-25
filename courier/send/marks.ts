import type pg from 'pg';
import type { Address, Hex } from 'viem';
import { readQuotes } from '../chain/reads';
import type { Header, JsonRpc } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import type { ChainReader } from '../chain/snapshot';
import { lockKey } from '../orders/door';
import { quoteEnd } from '../orders/standing';
import { inLockOrder } from '../orders/stops';
import { BLOCKHASH_WINDOW, onFinalChain } from './chain';

// The marks, read again at the final block. A quote marked ended at a block
// that was not yet final can be marked at a block that is later orphaned, and
// then it keeps a live quote off the book. So a mark made at a block not yet
// shown final is read again once F reaches its height: where the block is on
// F's chain, the mark stands and is final now; where it is not, the order is
// read at F, and the mark is written again at F where the order is still ended
// there (cancelled, filled, or expired by F's time), or lifted where it is not,
// unless a stop stands for its hash, when it is set stopped and never cleared.
// A mark more than 256 blocks below F, where the chain's own hash of its
// height cannot be read at F, is read at F as an orphaned one is. This runs at
// each read of F the courier makes anyway: the pre-check's, before its
// candidate query; each outcome's settling; and the take. No timer is added.

export interface MarksDeps {
  pool: pg.Pool;
  chain: ChainReader;
  rpc: JsonRpc;
  set: BettingSet;
}

/** How many marks one pass reads again at most: the rest wait for the next read of F. */
export const MARKS_PER_PASS = 200;

interface Waiting {
  hash: Hex;
  account: Address;
  nonce: string;
  risk_amount: string;
  expiry: string;
  market_key: Hex;
  ended: string;
  ended_block: string;
  ended_block_hash: Hex;
}

export interface Repaired {
  final: number;
  rewritten: number;
  lifted: number;
  stopped: number;
}

export async function repairMarks(deps: MarksDeps, F: Header): Promise<Repaired> {
  const out: Repaired = { final: 0, rewritten: 0, lifted: 0, stopped: 0 };
  const { rows } = await deps.pool.query<Waiting>(
    `SELECT hash, account, nonce::text AS nonce, risk_amount::text AS risk_amount, expiry::text AS expiry, market_key, ended, ended_block::text AS ended_block, ended_block_hash
     FROM orders WHERE ended_block IS NOT NULL AND NOT ended_final AND ended_block <= $1 ORDER BY ended_block, hash LIMIT $2`,
    [F.number.toString(), MARKS_PER_PASS],
  );
  if (rows.length === 0) return out;
  // The heights within the window: shown on F's chain, or not. Further back: read at F.
  const windowed = rows.filter((r) => F.number - BigInt(r.ended_block) <= BLOCKHASH_WINDOW);
  const shown = windowed.length === 0 ? [] : await onFinalChain(deps.chain, deps.rpc, F, windowed.map((r) => ({ number: BigInt(r.ended_block), hash: r.ended_block_hash })));
  const final = windowed.filter((_, i) => shown[i] === true);
  const orphaned = rows.filter((r) => !final.includes(r));
  if (final.length > 0) {
    const { rowCount } = await deps.pool.query(
      `UPDATE orders AS o SET ended_final = true FROM unnest($1::text[], $2::text[]) AS m(hash, block_hash)
       WHERE o.hash = m.hash AND o.ended_block_hash = m.block_hash AND NOT o.ended_final`,
      [final.map((r) => r.hash), final.map((r) => r.ended_block_hash)],
    );
    out.final = rowCount ?? 0;
  }
  if (orphaned.length === 0) return out;
  // Each orphaned mark's order read at F, by market, as the book reads a quote's standing.
  const ends = new Map<string, 'cancelled' | 'filled' | 'expired' | null>();
  const byMarket = new Map<Hex, Waiting[]>();
  for (const r of orphaned) byMarket.set(r.market_key, [...(byMarket.get(r.market_key) ?? []), r]);
  for (const [market, group] of byMarket) {
    for (let i = 0; i < group.length; i += 100) {
      const batch = group.slice(i, i + 100);
      const read = await readQuotes(deps.chain, deps.set, F, market, batch.map((r) => ({ hash: r.hash, account: r.account, nonce: BigInt(r.nonce) })));
      for (const r of batch) {
        const how = quoteEnd({ hash: r.hash, account: r.account, nonce: BigInt(r.nonce), riskAmount: BigInt(r.risk_amount) }, read, F.timestamp);
        ends.set(r.hash.toLowerCase(), how ?? (BigInt(r.expiry) <= F.timestamp ? 'expired' : null));
      }
    }
  }
  // The writes, in one transaction: the hash locks of the orders it may lift, in the stops' order, then their rows in
  // one statement, ascending by hash; each judged on its row as it stands after the locks.
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const hashes = inLockOrder(orphaned.map((r) => r.hash.toLowerCase() as Hex));
    for (const h of hashes) await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(h)]);
    const locked = await client.query<{ hash: Hex; ended_block_hash: Hex | null; ended_final: boolean; stopped: boolean }>(
      `SELECT o.hash, o.ended_block_hash, o.ended_final, EXISTS (SELECT 1 FROM stops s WHERE s.hash = o.hash) AS stopped
       FROM orders o WHERE o.hash = ANY($1::text[]) ORDER BY o.hash FOR NO KEY UPDATE`,
      [orphaned.map((r) => r.hash.toLowerCase())],
    );
    for (const row of locked.rows) {
      const was = orphaned.find((r) => r.hash.toLowerCase() === row.hash.toLowerCase());
      if (was === undefined || row.ended_final || row.ended_block_hash !== was.ended_block_hash) continue;
      const how = ends.get(row.hash.toLowerCase()) ?? null;
      if (how === 'cancelled' || how === 'filled') {
        await client.query('UPDATE orders SET ended = $2, ended_at = now(), ended_block = $3, ended_block_hash = $4, ended_final = true WHERE hash = $1', [row.hash, how, F.number.toString(), F.hash.toLowerCase()]);
        out.rewritten++;
      } else if (how === 'expired') {
        await client.query(`UPDATE orders SET ended = 'expired', ended_at = now(), ended_block = NULL, ended_block_hash = NULL, ended_final = false WHERE hash = $1`, [row.hash]);
        out.rewritten++;
      } else if (row.stopped) {
        await client.query(`UPDATE orders SET ended = 'stopped', ended_at = now(), ended_block = NULL, ended_block_hash = NULL, ended_final = false WHERE hash = $1`, [row.hash]);
        out.stopped++;
      } else {
        await client.query('UPDATE orders SET ended = NULL, ended_at = NULL, ended_block = NULL, ended_block_hash = NULL, ended_final = false WHERE hash = $1', [row.hash]);
        out.lifted++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return out;
}
