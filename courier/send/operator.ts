import type pg from 'pg';
import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { RELAY_ABI } from '../chain/abi';
import { byHash, headerByTag, transactionCountAt, type Header, type JsonRpc } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import { crossesOfKey } from '../records/crosses';
import { lockLane, raiseWatermark, readLane, restoreHold } from '../records/lanes';
import type { Store } from '../records/store';
import { onFinalChain } from './chain';
import { blocksToShow, explainingBlock } from './checks';
import { searchNonce } from './outcome';

// The operator's command, run by hand, and the closing of a key's hold by a
// rotation, which the courier records itself.
//
// The restore's shut: after every old courier process is stopped and before
// any courier starts on the restored database, it records the restore's
// incident and the database-wide sending hold, the copy's time and two
// diagnostic times, and the relay's sender with the block it was read at;
// makes that sender's lane where it has none, and shuts every lane by the
// incident's line. A read that fails leaves sending held all the same. Nothing
// in this build releases that hold.
//
// The clear: the operator's recorded step for an ordinary hold. It names the
// lane and what the operator found, and opens the lane only when every nonce
// below the key's count at a compatible final block is explained, by the
// records or by a transaction this step shows on that block's chain and
// records. It refuses a lane shut at a restore, whatever the final block shows
// and however complete the nonce account. Nothing clears by time.

export interface OperatorDeps {
  store: Store;
  rpc: JsonRpc;
  chain: ChainReader;
  set: BettingSet;
  /** The run the command's lines are written under. */
  run: number;
}

const s = (n: bigint) => n.toString();
const named = (h: Header) => ({ number: s(h.number), hash: h.hash, time: s(h.timestamp) });

/** The relay's sender at a block, by the block's hash. */
async function senderAt(rpc: JsonRpc, relay: Address, at: Header): Promise<Address> {
  const data = await rpc.request<Hex>('eth_call', [{ to: relay, data: encodeFunctionData({ abi: RELAY_ABI, functionName: 's_sender' }) }, byHash(at.hash)]);
  return getAddress(decodeFunctionResult({ abi: RELAY_ABI, functionName: 's_sender', data }) as Address);
}

export interface Shut {
  line: number;
  lanes: string[];
  relaySender: { address: Address; block: { number: string; hash: Hex; time: string } } | 'unavailable';
}

/** The restore's shut, in one transaction once its reads are made. The reads decide nothing about whether the hold is recorded. */
export async function restoreShut(deps: OperatorDeps, copyTime: string): Promise<Shut> {
  let latest: Header | null = null;
  let relaySender: Shut['relaySender'] = 'unavailable';
  let readProblem: string | null = null;
  try {
    latest = await headerByTag(deps.rpc, 'latest');
    relaySender = { address: await senderAt(deps.rpc, deps.set.relay, latest), block: named(latest) };
  } catch (err) {
    readProblem = err instanceof Error ? err.name : 'the read failed';
  }
  const run = deps.run;
  {
    const client = await deps.store.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT sender FROM lanes ORDER BY sender FOR UPDATE');
      const { rows } = await client.query<{ t: Date }>('SELECT now() AS t');
      const line = await deps.store.events.write(
        {
          run,
          kind: 'incident',
          reason: 'RESTORE_SHUT',
          facts: {
            copyTime,
            databaseTime: (rows[0] as { t: Date }).t.toISOString(),
            latestHeader: latest === null ? null : named(latest),
            relaySender,
            readProblem,
            hold: 'database-wide: no lane, old or new, reserves, signs or hands off on this database, and the door takes no new bet',
          },
        },
        client,
      );
      if (relaySender !== 'unavailable') await client.query('INSERT INTO lanes (sender, shut_line) VALUES ($1, $2) ON CONFLICT DO NOTHING', [relaySender.address.toLowerCase(), line]);
      const shut = await client.query<{ sender: string }>('UPDATE lanes SET shut_line = $1 RETURNING sender', [line]);
      await client.query('COMMIT');
      return { line, lanes: shut.rows.map((r) => r.sender).sort(), relaySender };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export type Cleared = { cleared: true; line: number; explainedBySearch: Array<{ nonce: string; txHash: Hex; block: { number: string; hash: Hex } }> } | { cleared: false; why: string };

/** The line that shut a lane: its kind and reason. */
async function shutBy(on: Pick<pg.Pool, 'query'>, line: number): Promise<{ kind: string; reason: string | null; facts: Record<string, unknown> } | null> {
  const { rows } = await on.query<{ kind: string; reason: string | null; facts: Record<string, unknown> }>('SELECT kind, reason, facts FROM events WHERE number = $1', [line]);
  return rows[0] ?? null;
}

/** The operator's clear of an ordinary hold on one lane. */
export async function clearLane(deps: OperatorDeps, lane: Address, found: string): Promise<Cleared> {
  if (found.trim() === '') return { cleared: false, why: 'the clear names what the operator found, and none was given' };
  const row = await readLane(deps.store.pool, lane);
  if (row === null) return { cleared: false, why: `no lane of ${lane}` };
  if (row.shutLine === null) return { cleared: false, why: 'the lane is not shut' };
  const by = await shutBy(deps.store.pool, row.shutLine);
  // A lane shut at a restore: refused, whatever the final block shows and however complete the nonce account.
  if (by !== null && by.kind === 'incident' && by.reason === 'RESTORE_SHUT') return { cleared: false, why: `the lane is shut at a restore (line ${row.shutLine}); nothing in this build opens it` };
  let F: Header;
  try {
    F = await deps.chain.finalHeader();
    const crosses = await crossesOfKey(deps.store.pool, lane);
    const toShow = blocksToShow(F, row.watermark, crosses);
    const shown = toShow.length === 0 ? [] : await onFinalChain(deps.chain, deps.rpc, F, toShow);
    const onF = new Map(toShow.map((b, i) => [b.hash.toLowerCase(), shown[i]]));
    if (row.watermark.anchor !== null && (F.number < row.watermark.anchor.number || onF.get(row.watermark.anchor.hash.toLowerCase()) !== true)) {
      return { cleared: false, why: "the final block is not compatible with the lane's watermark: read again at a later one" };
    }
    const count = await deps.chain.ask(F, () => transactionCountAt(deps.rpc, lane, byHash(F.hash)));
    const explained = new Set<bigint>();
    for (const c of crosses) {
      const b = explainingBlock(c);
      if (b !== null && c.nonce !== null && b.number <= F.number && onF.get(b.hash.toLowerCase()) === true) explained.add(c.nonce);
    }
    const bySearch: Array<{ nonce: string; txHash: Hex; block: { number: string; hash: Hex } }> = [];
    for (let n = row.watermark.to; n < count; n++) {
      if (explained.has(n)) continue;
      const hit = await searchNonce({ chain: deps.chain, rpc: deps.rpc, set: deps.set, key: lane }, F, n, row.watermark.anchor);
      if ('missing' in hit) return { cleared: false, why: `nonce ${n} is not explained: ${hit.missing}` };
      bySearch.push({ nonce: s(n), txHash: hit.found.hash, block: { number: s(hit.found.block.number), hash: hit.found.block.hash } });
    }
    const run = deps.run;
    {
      const client = await deps.store.lane.connect();
      try {
        await client.query('BEGIN');
        const locked = await lockLane(client, lane);
        if (locked === null || locked.shutLine !== row.shutLine) {
          await client.query('ROLLBACK');
          return { cleared: false as const, why: 'the lane changed while the clear read the chain: run it again' };
        }
        const line = await deps.store.events.write(
          { run, kind: 'incident', reason: 'LANE_CLEARED', facts: { lane: lane.toLowerCase(), found, shutLine: row.shutLine, final: named(F), countAtFinal: s(count), explainedBySearch: bySearch } },
          client,
        );
        if (count > row.watermark.to || row.watermark.anchor === null) await raiseWatermark(client, lane, row.watermark, { to: count, anchor: { number: F.number, hash: F.hash } });
        await client.query('UPDATE lanes SET shut_line = NULL WHERE sender = $1 AND shut_line = $2', [lane.toLowerCase(), row.shutLine]);
        await client.query('COMMIT');
        // The condition closes once no lane stays shut by a line of its own.
        const still = await deps.store.pool.query(`SELECT 1 FROM lanes l JOIN events e ON e.number = l.shut_line WHERE e.kind = 'condition opened' AND e.reason = 'cross-unreconciled'`);
        if ((still.rowCount ?? 0) === 0) await deps.store.conditions.applySuccess('cross-unreconciled', { how: 'cleared by the operator', lane: lane.toLowerCase(), clearLine: line }, run);
        return { cleared: true as const, line, explainedBySearch: bySearch };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
  } catch (err) {
    if (err instanceof ChainUnreachable) return { cleared: false, why: `the chain could not be read (${err.failure.method ?? 'a read'}): run it again` };
    throw err;
  }
}

/**
 * A rotation: a lane whose key is no longer the relay's sender at the final block is retired. Its ordinary hold's
 * condition closes, with "retired at F; the unexplained transaction stays on the record", once no lane of a key still
 * the sender is shut by it. The retired lane stays shut and never reserves again. Under a restore's hold the
 * retirement is recorded and nothing is opened.
 */
export async function closeByRotation(deps: OperatorDeps): Promise<Address[]> {
  let F: Header;
  let sender: Address;
  try {
    F = await deps.chain.finalHeader();
    sender = await deps.chain.ask(F, () => senderAt(deps.rpc, deps.set.relay, F));
  } catch (err) {
    if (err instanceof ChainUnreachable) return [];
    throw err;
  }
  const { rows } = await deps.store.pool.query<{ sender: Address; shut_line: string; kind: string; reason: string | null }>(
    `SELECT l.sender, l.shut_line::text AS shut_line, e.kind, e.reason FROM lanes l JOIN events e ON e.number = l.shut_line ORDER BY l.sender`,
  );
  const retired = rows.filter((r) => r.sender.toLowerCase() !== sender.toLowerCase());
  if (retired.length === 0) return [];
  const held = await restoreHold(deps.store.pool);
  for (const r of retired) {
    const seen = await deps.store.pool.query(`SELECT 1 FROM events WHERE kind = 'incident' AND reason = 'LANE_RETIRED' AND facts->>'lane' = $1`, [r.sender.toLowerCase()]);
    if ((seen.rowCount ?? 0) === 0) {
      await deps.store.events.write({ run: deps.run, kind: 'incident', reason: 'LANE_RETIRED', facts: { lane: r.sender.toLowerCase(), relaySender: sender, final: named(F), restoreHold: held, note: 'retired at F; the unexplained transaction stays on the record' } });
    }
  }
  const stillShutBySender = rows.some((r) => r.sender.toLowerCase() === sender.toLowerCase() && r.kind === 'condition opened' && r.reason === 'cross-unreconciled');
  if (held === null && !stillShutBySender && retired.some((r) => r.kind === 'condition opened' && r.reason === 'cross-unreconciled')) {
    await deps.store.conditions.applySuccess('cross-unreconciled', { how: 'retired at F; the unexplained transaction stays on the record', lanes: retired.map((r) => r.sender.toLowerCase()), final: named(F), relaySender: sender }, deps.run);
  }
  return retired.map((r) => r.sender);
}
