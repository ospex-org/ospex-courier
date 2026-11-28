import type pg from 'pg';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { RELAY_ABI } from '../chain/abi';
import { byHash, receiptOf, transactionCountAt, transactionOf, type Header, type JsonRpc, type TransactionSeen } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import { orderHash, type OrderFields } from '../orders/order';
import { crossesOfKey, crossRow, freeLaneOf, legsOf, writeActionOnce, writeFinal, type CrossRow } from '../records/crosses';
import { lockLane, raiseWatermark, readLane } from '../records/lanes';
import type { OrderRow } from '../records/orders';
import type { Store } from '../records/store';
import { decisionAt, filledAtF, onFinalChain, stillFinal, type Decision, type Named } from './chain';
import { blocksToShow, explainingBlock } from './checks';
import { ran, searchNonce, type Expected } from './outcome';
import { ranWrite } from './settle';

// Recovery under a restore's hold. Nothing is reserved, signed or handed off
// on the restored database, and nothing here releases its hold: retained rows
// are read and reconciled. The fenced key's nonce use on a compatible final
// chain is explained nonce by nonce: by a retained Cross's receipt; by a
// transaction the search finds, joined to the retained bet it carries where
// the evidence permits; or appended to the restore's incident. A retained
// intent closes with its found transaction's outcome from the chain, or, where
// the complete search finds none, expired unmined only at a compatible F at or
// past its bet's own expiry, its total filled read at that same F; its
// transaction hash stays absent and its hand-offs as they were. Missing
// evidence leaves it unresolved, and says what is missing. The reconciliation
// at one F is one decision: where it read a block's header by number, F's own
// height is read again before each thing it writes, and another block there,
// or that read unavailable, leaves it unresolved with nothing more written.

export interface RecoveryDeps {
  store: Store;
  chain: ChainReader;
  rpc: JsonRpc;
  set: BettingSet;
  run: { id: number };
  /** Each lane's epoch as this process's take set it: a write under the hold still needs the lane's owner. */
  epochOf(lane: Address): bigint | null;
  log(line: string): void;
}

export type Reconciled = { done: true } | { done: false; missing: string };

/** What recovery says where its last check of F does not hold: F's own height holds another block now. */
const F_CHANGED = "the final block's own height, read again, holds another block";

const s = (n: bigint) => n.toString();
const finalNamed = (F: Header) => ({ number: s(F.number), hash: F.hash, time: s(F.timestamp) });

async function connect(pool: pg.Pool): Promise<{ client: pg.PoolClient; done: () => void }> {
  const client = await pool.connect();
  const heard = () => undefined;
  client.on('error', heard);
  return {
    client,
    done: () => {
      client.removeListener('error', heard);
      client.release();
    },
  };
}

/** The taking order a relay's Cross carries, by its hash under the set's domain, or null where the input is no Cross. */
function takingOf(set: BettingSet, input: Hex): Hex | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: RELAY_ABI, data: input });
    if (functionName !== 'cross') return null;
    const taking = (args as unknown as [{ order: OrderFields }])[0];
    return orderHash(taking.order, set.chainId, set.matching).toLowerCase() as Hex;
  } catch {
    return null;
  }
}

/** One transaction of the transaction under the lane's owner: the lane's row locked and its epoch this process's. */
async function owned(deps: RecoveryDeps, key: Address, work: (client: pg.PoolClient) => Promise<void>): Promise<boolean> {
  const { client, done } = await connect(deps.store.lane);
  try {
    await client.query('BEGIN');
    const lane = await lockLane(client, key);
    if (lane === null || lane.epoch !== deps.epochOf(key)) {
      await client.query('ROLLBACK');
      return false;
    }
    await work(client);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    done();
  }
}

const lineOn = (deps: RecoveryDeps, client: pg.PoolClient, bet: OrderRow | null, kind: 'incident' | 'cross confirmed' | 'cross reverted' | 'cross expired unmined', reason: string, facts: Record<string, unknown>) =>
  deps.store.events.write(
    bet === null
      ? { run: deps.run.id, kind, reason, facts }
      : { run: deps.run.id, kind, orderHash: bet.hash, betHash: bet.hash, account: bet.order.account.toLowerCase(), gameId: bet.order.gameId, reason, facts },
    client,
  );

/**
 * The fenced lane's nonce use explained at a compatible final block, and its retained intent closed where the chain's
 * evidence allows. Done where every nonce below the key's count at F is explained and no retained intent is left.
 */
export async function reconcileRestored(deps: RecoveryDeps, key: Address, restoreLine: number): Promise<Reconciled> {
  const lane = await readLane(deps.store.lane, key);
  if (lane === null) return { done: false, missing: 'the lane has no row' };
  let F: Header;
  try {
    F = await deps.chain.finalHeader();
  } catch (err) {
    if (err instanceof ChainUnreachable) return { done: false, missing: 'the final block could not be read' };
    throw err;
  }
  const decision = decisionAt(F);
  try {
    const crosses = await crossesOfKey(deps.store.lane, key, lane.watermark.to);
    const toShow = blocksToShow(F, lane.watermark, crosses);
    const shown = toShow.length === 0 ? [] : await onFinalChain(deps.chain, deps.rpc, decision, toShow);
    const onF = new Map(toShow.map((b, i) => [b.hash.toLowerCase(), shown[i]]));
    if (lane.watermark.anchor !== null && (F.number < lane.watermark.anchor.number || onF.get(lane.watermark.anchor.hash.toLowerCase()) !== true)) {
      return { done: false, missing: "a final block compatible with the lane's watermark" };
    }
    const count = await deps.chain.ask(F, () => transactionCountAt(deps.rpc, key, byHash(F.hash)));
    const byTx = new Map(crosses.filter((c) => c.txHash !== null).map((c) => [(c.txHash as Hex).toLowerCase(), c]));
    const explained = new Set<bigint>();
    for (const c of crosses) {
      const b = explainingBlock(c);
      if (b !== null && c.nonce !== null && b.number <= F.number && onF.get(b.hash.toLowerCase()) === true) explained.add(c.nonce);
    }
    const open = lane.openCross === null ? null : await crossRow(deps.store.lane, lane.openCross);
    let intent: CrossRow | null = open !== null && open.state === 'intent' ? open : null;
    for (let n = lane.watermark.to; n < count; n++) {
      if (explained.has(n)) continue;
      const found = await searchNonce({ chain: deps.chain, rpc: deps.rpc, set: deps.set, key }, decision, n, lane.watermark.anchor);
      if ('missing' in found) return { done: false, missing: `nonce ${n}: ${found.missing}` };
      const ours = byTx.get(found.found.hash.toLowerCase());
      if (ours !== undefined) continue; // A retained signed row: settled by its own hash.
      const tx = await deps.chain.ask(F, () => transactionOf(deps.rpc, found.found.hash));
      if (tx === null) return { done: false, missing: `nonce ${n}: the transaction the search found could not be read` };
      const taking = tx.to !== null && tx.to.toLowerCase() === deps.set.relay.toLowerCase() ? takingOf(deps.set, tx.input) : null;
      if (intent !== null && taking !== null && taking === intent.betHash.toLowerCase()) {
        const closed = await closeIntentFound(deps, key, intent, decision, n, count, found.found, tx);
        if (closed === 'changed') return { done: false, missing: `nonce ${n}: ${F_CHANGED}` };
        if (closed === 'unresolved') return { done: false, missing: `nonce ${n}: the found transaction's outcome could not be read whole` };
        intent = null;
        continue;
      }
      // A transaction with no retained Cross: appended to the restore's incident, once for each transaction. Where it
      // carries a retained bet, the chain's outcome and the bet's total filled at F go with it.
      let outcome: Record<string, unknown> = {};
      if (taking !== null && (await deps.store.orders.get(taking, deps.store.lane)) !== null) {
        const receipt = await deps.chain.ask(F, () => receiptOf(deps.rpc, found.found.hash));
        const total = (await filledAtF(deps.chain, deps.set, F, [taking])).get(taking);
        outcome = { retainedBet: true, outcome: receipt === null ? null : receipt.status, betFilled: total === undefined ? null : s(total) };
      }
      if (!(await stillFinal(deps.chain, deps.rpc, decision))) return { done: false, missing: `nonce ${n}: ${F_CHANGED}` };
      await owned(deps, key, async (client) => {
        const { rowCount } = await client.query(`SELECT 1 FROM events WHERE kind = 'incident' AND reason = 'RESTORE_UNASSOCIATED' AND facts->>'txHash' = $1`, [found.found.hash.toLowerCase()]);
        if ((rowCount ?? 0) > 0) return;
        await lineOn(deps, client, null, 'incident', 'RESTORE_UNASSOCIATED', {
          restoreLine,
          lane: key.toLowerCase(),
          nonce: s(n),
          txHash: found.found.hash,
          block: { number: s(found.found.block.number), hash: found.found.block.hash },
          carries: taking,
          ...outcome,
          final: finalNamed(F),
        });
      });
    }
    // Every nonce below the count at F explained: the watermark rises to it, anchored at F.
    if (count > lane.watermark.to || lane.watermark.anchor === null) {
      if (!(await stillFinal(deps.chain, deps.rpc, decision))) return { done: false, missing: F_CHANGED };
      await owned(deps, key, async (client) => {
        await raiseWatermark(client, key, lane.watermark, { to: count, anchor: { number: F.number, hash: F.hash } });
      });
    }
    if (intent === null) return { done: true };
    // The retained intent, with no transaction found for it by the complete search: expired unmined only at or past its bet's own expiry.
    const bet = await deps.store.orders.get(intent.betHash, deps.store.lane);
    if (bet === null) throw new Error('a retained intent has no bet');
    if (F.timestamp < bet.order.expiry) return { done: false, missing: 'the retained intent\'s bet has not expired at the final block' };
    const filled = (await filledAtF(deps.chain, deps.set, F, [intent.betHash])).get(intent.betHash.toLowerCase());
    if (filled === undefined) return { done: false, missing: "the bet's total filled at the final block" };
    if (!(await stillFinal(deps.chain, deps.rpc, decision))) return { done: false, missing: F_CHANGED };
    const intentRow = intent;
    await owned(deps, key, async (client) => {
      const wrote = await writeFinal(client, intentRow.betHash, { state: 'expired unmined', final: { number: F.number, hash: F.hash }, recorded: { betFilled: s(filled), final: finalNamed(F), expiry: s(bet.order.expiry), restored: 'intent', restoreLine } }, 'intent');
      if (!wrote) return;
      await lineOn(deps, client, bet, 'cross expired unmined', 'EXPIRED_UNMINED', { restored: 'intent', final: finalNamed(F), expiry: s(bet.order.expiry), betFilled: s(filled), handOffs: intentRow.handOffs, txHash: null });
      await freeLaneOf(client, key, intentRow.betHash);
    });
    return { done: true };
  } catch (err) {
    if (err instanceof ChainUnreachable) return { done: false, missing: `a read at the final block failed twice (${err.failure.method ?? 'a read'})` };
    throw err;
  }
}

/**
 * A retained intent whose transaction the search found at nonce n, in a block on F's chain: closed as the settling
 * closes any Cross, with the same checks at F, its record from the receipt, its quotes' marks at F and, for a revert,
 * the reason from one trace; the key, nonce and hash written with it. Under recovery's own guard: the hold stands,
 * and the intent's hand-offs stay as recorded. Inside the reconciliation's decision at F: its last check of F comes
 * after the trace and the receipt's block time, and 'changed' where it does not hold, with nothing written.
 */
async function closeIntentFound(deps: RecoveryDeps, key: Address, intent: CrossRow, decision: Decision, n: bigint, count: bigint, found: { hash: Hex; block: Named }, tx: TransactionSeen): Promise<'closed' | 'unresolved' | 'changed'> {
  const F = decision.F;
  const bet = await deps.store.orders.get(intent.betHash, deps.store.lane);
  if (bet === null) throw new Error('a retained intent has no bet');
  /** Evidence that conflicts with what the search found: an incident line with the reads judged, written once and only where F's own height still holds F; the intent stays unresolved. */
  const conflicting = async (facts: Record<string, unknown>): Promise<'unresolved' | 'changed'> => {
    if (!(await stillFinal(deps.chain, deps.rpc, decision))) return 'changed';
    await owned(deps, key, async (client) => {
      const { rowCount } = await client.query(`SELECT 1 FROM events WHERE kind = 'incident' AND reason = 'CHAIN_CONTRADICTS_RECORDS' AND bet_hash = $1`, [bet.hash.toLowerCase()]);
      if ((rowCount ?? 0) > 0) return;
      await lineOn(deps, client, bet, 'incident', 'CHAIN_CONTRADICTS_RECORDS', { lane: key, betHash: bet.hash, restored: 'intent', final: finalNamed(F), ...facts });
    });
    deps.log(`recovery: the evidence for a retained intent's found transaction conflicts (${String(facts.why)}); it stays unresolved`);
    return 'unresolved';
  };
  // Bound to one another before any of the settling's checks, as the settling's look binds them: the transaction the
  // search found from this key at this nonce, its receipt by its own hash, and that receipt's block, the one the search
  // found, shown on F's chain.
  if (tx.hash.toLowerCase() !== found.hash.toLowerCase() || tx.from.toLowerCase() !== key.toLowerCase() || tx.nonce !== n) {
    return conflicting({ why: 'the transaction read by the found hash is not the one the search found from the key at this nonce', found: found.hash, nonce: s(n), read: { hash: tx.hash, from: tx.from, nonce: s(tx.nonce) } });
  }
  const receipt = await deps.chain.ask(F, () => receiptOf(deps.rpc, found.hash));
  if (receipt === null) return 'unresolved';
  if (receipt.transactionHash.toLowerCase() !== found.hash.toLowerCase()) {
    return conflicting({ why: 'the receipt read by the found hash is of another transaction', asked: found.hash, got: receipt.transactionHash });
  }
  if (receipt.blockNumber !== found.block.number || receipt.blockHash.toLowerCase() !== found.block.hash.toLowerCase()) {
    return conflicting({ why: "the receipt's block is not the block the search found", found: { number: s(found.block.number), hash: found.block.hash }, receipt: { number: s(receipt.blockNumber), hash: receipt.blockHash } });
  }
  const [shown] = await onFinalChain(deps.chain, deps.rpc, decision, [{ number: receipt.blockNumber, hash: receipt.blockHash }]);
  if (shown !== true) return 'unresolved';
  const legs = await legsOf(deps.store.lane, intent.betHash);
  // The Cross as the search found it: this transaction, at this nonce.
  const asFound: CrossRow = { ...intent, nonce: n, txHash: found.hash };
  const ranDeps = { chain: deps.chain, rpc: deps.rpc, set: deps.set, key };
  const atH = typeof intent.checked.betFilled === 'string' ? { block: { number: intent.block.number, hash: intent.block.hash }, betFilled: BigInt(intent.checked.betFilled) } : null;
  const expected: Expected = { betHash: bet.hash, account: bet.order.account, expiry: bet.order.expiry, legs: legs.map((l) => ({ orderHash: l.orderHash })), atH };
  const l = await ran(ranDeps, decision, asFound, expected, receipt, count);
  // The chain's own state at F contradicts the receipt, as the settling judges it. Under the hold nothing is sent in any case.
  if (l.kind === 'contradiction') return conflicting(l.facts);
  if (l.kind !== 'ran') return 'unresolved';
  const w = await ranWrite(ranDeps, bet, asFound, legs, l);
  if (!(await stillFinal(deps.chain, deps.rpc, decision))) return 'changed';
  // The association, the record, the legs, the marks and the line commit together, or none of them: under the lane's
  // owner and the move from intent alone. A stale owner, or a Cross already moved, writes nothing.
  let wrote = false;
  const mine = await owned(deps, key, async (client) => {
    wrote = await writeFinal(client, intent.betHash, { ...w.outcome, recorded: { ...w.outcome.recorded, restored: 'intent', foundBySearch: true }, associate: { sender: key, nonce: n, txHash: found.hash } }, 'intent');
    if (!wrote) return;
    if (w.marks.length > 0) await deps.store.orders.markEndedAtFinal(client, w.marks, { number: F.number, hash: F.hash });
    await lineOn(deps, client, bet, w.line.kind, w.line.reason, { ...w.line.facts, restored: 'intent', handOffs: intent.handOffs });
    await freeLaneOf(client, key, intent.betHash);
  });
  if (!mine || !wrote) deps.log(`recovery: a retained intent's found transaction was not written by this process: ${mine ? 'its Cross had already moved from intent' : 'the lane is not this process\'s now'}`);
  return 'closed';
}

/**
 * The ACTION for case unresolved-after-expiry, for a retained taking order with no Cross under the hold: once, at the
 * first compatible F at or past its expiry. Its outcome cannot be committed: whether a transaction lost to the restore
 * carried it is what recovery cannot show.
 */
export async function unresolvedWaiting(deps: RecoveryDeps, F: Header): Promise<void> {
  const { rows } = await deps.store.lane.query<{ hash: Hex }>(
    `SELECT o.hash FROM orders o WHERE o.role = 'take' AND o.bet_state IN ('waiting', 'held') AND o.expiry <= $1
       AND NOT EXISTS (SELECT 1 FROM crosses c WHERE c.bet_hash = o.hash) ORDER BY o.hash`,
    [F.timestamp.toString()],
  );
  for (const r of rows) {
    const bet = await deps.store.orders.get(r.hash, deps.store.lane);
    if (bet === null) continue;
    const { client, done } = await connect(deps.store.lane);
    try {
      await client.query('BEGIN');
      await writeActionOnce(client, {
        run: deps.run.id,
        betHash: bet.hash,
        account: bet.order.account,
        gameId: bet.order.gameId,
        reason: 'unresolved-after-expiry',
        facts: {
          action: {
            case: 'unresolved-after-expiry',
            evidence: { final: finalNamed(F), expiry: s(bet.order.expiry), cross: null, restored: true },
            unknown: ['whether a transaction lost to the restore carried this bet', "the bet's total filled at the final block"],
          },
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      done();
    }
  }
}
