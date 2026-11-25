import type pg from 'pg';
import type { Address, Hex } from 'viem';
import { byHash, headerByHash, receiptOf, transactionCountAt, type Header, type JsonRpc, type Receipt } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import { ORDER_RULES } from '../orders/order';
import { crossesOfKey, crossRow, freeLaneOf, FINAL_STATES, legsOf, lockCross, writeActionOnce, writeFinal, writeOrphaned, writePending, type CrossRow, type FinalOutcome } from '../records/crosses';
import { lockLane, shutLane } from '../records/lanes';
import type { OrderRow } from '../records/orders';
import type { Store } from '../records/store';
import { filledAtF, onFinalChain } from './chain';
import { look, lookFacts, type Expected, type Look, type Ran } from './outcome';
import { reasonFacts, reasonOf, type Reason } from './reason';

// The owner's settling of a Cross at or past the gate: a look at the chain at
// a widening gap of 30 seconds at most, each look's state written only when it
// changes, until the chain's evidence at a final block on F's chain makes the
// Cross final. No timer ends it, no repeated read does, and no wait running out
// does. Each write is one transaction under the lane's guards: the lane's row,
// this process's epoch, the reservation the Cross records, its open Cross this
// one. A final write frees the lane.

export interface SettleDeps {
  store: Store;
  key: Address;
  run: { id: number };
  chain: ChainReader;
  rpc: JsonRpc;
  set: BettingSet;
  /** This process's epoch now, or null. */
  epoch(): bigint | null;
  /** Whether this process still sends. */
  sending(): boolean;
  /** The sender found a contradiction: this process sends nothing more. */
  stopSending(why: string): void;
  log(line: string): void;
  /** The look's gap: the first and the last. */
  gap: { firstMs: number; lastMs: number };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const s = (n: bigint) => n.toString();
const finalNamed = (F: Header) => ({ number: s(F.number), hash: F.hash, time: s(F.timestamp) });

/** A lane connection for one transaction, listened to while it is out. */
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

export interface Settler {
  /** Settles the lane's open Cross from the chain: 'done' once it is final and the lane freed; 'lost' where the lane or its reservation is not this process's; 'stop' where this process stopped sending. */
  settle(bet: OrderRow): Promise<'done' | 'lost' | 'stop'>;
  /** At a read of F: each `expired unmined` Cross of the key whose nonce the count at F shows used has its receipt read by its hash, and is written `reverted` where it is found on F's chain. */
  readExpiredAgain(F: Header): Promise<'none' | 'written' | 'stop'>;
}

export function createSettler(deps: SettleDeps): Settler {
  const { store, key } = deps;
  const outcomeDeps = { chain: deps.chain, rpc: deps.rpc, set: deps.set, key };

  /** One transaction under the lane's guards for this Cross; `work` returns whether it wrote. 'lost' where the guards fail. */
  async function guarded(cross: CrossRow, work: (client: pg.PoolClient) => Promise<boolean>, guard: 'open' | 'epoch' = 'open'): Promise<'written' | 'unchanged' | 'lost'> {
    const { client, done } = await connect(store.lane);
    try {
      await client.query('BEGIN');
      const lane = await lockLane(client, key);
      const ok =
        lane !== null &&
        lane.epoch === deps.epoch() &&
        deps.sending() &&
        (guard === 'epoch' || (lane.reservation === cross.reservation && lane.openCross?.toLowerCase() === cross.betHash.toLowerCase()));
      if (!ok) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      // The bet's row, then the Cross's row: the lock order's fifth kind, then its sixth.
      await client.query('SELECT hash FROM orders WHERE hash = $1 FOR NO KEY UPDATE', [cross.betHash.toLowerCase()]);
      const row = await lockCross(client, cross.betHash);
      if (row === null) throw new Error('the Cross has no row');
      const wrote = await work(client);
      await client.query(wrote ? 'COMMIT' : 'ROLLBACK');
      return wrote ? 'written' : 'unchanged';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      done();
    }
  }

  const lineOf = (client: pg.PoolClient, bet: OrderRow, kind: 'cross pending' | 'cross sent' | 'cross unknown' | 'cross confirmed' | 'cross reverted' | 'cross expired unmined' | 'cross replaced', reason: string, facts: Record<string, unknown>) =>
    store.events.write({ run: deps.run.id, kind, orderHash: bet.hash, betHash: bet.hash, account: bet.order.account.toLowerCase(), gameId: bet.order.gameId, reason, facts }, client);

  /** What a look expects of the receipt: the bet, its expiry and account, the listed occurrences, and the bet's filled amount at H. */
  async function expectedOf(bet: OrderRow, cross: CrossRow): Promise<{ expected: Expected; legs: Awaited<ReturnType<typeof legsOf>> }> {
    const legs = await legsOf(store.lane, bet.hash);
    const atH = typeof cross.checked.betFilled === 'string' ? { block: { number: cross.block.number, hash: cross.block.hash }, betFilled: BigInt(cross.checked.betFilled) } : null;
    return { expected: { betHash: bet.hash, account: bet.order.account, expiry: bet.order.expiry, legs: legs.map((l) => ({ orderHash: l.orderHash })), atH }, legs };
  }

  /** The reason of a reverted Cross, with the expiry beside it where the receipt's block is at or past it. */
  async function revertFacts(bet: OrderRow, cross: CrossRow, legs: Awaited<ReturnType<typeof legsOf>>, receipt: Receipt, F: Header): Promise<{ reason: Reason & { why?: string }; facts: Record<string, unknown> }> {
    const reason = await reasonOf(deps.rpc, deps.set, key, receipt, {
      bettor: bet.order.account,
      positions: deps.set.positions,
      legs: legs.map((l) => ({ orderHash: l.orderHash, account: l.account })),
      calldataHash: typeof cross.checked.calldataHash === 'string' ? (cross.checked.calldataHash as Hex) : null,
    });
    let blockTime: bigint | null = null;
    try {
      const h = await deps.chain.ask(F, () => headerByHash(deps.rpc, receipt.blockHash));
      blockTime = h?.timestamp ?? null;
    } catch (err) {
      if (!(err instanceof ChainUnreachable)) throw err;
    }
    const expiry = blockTime !== null && blockTime >= bet.order.expiry ? { expiry: s(bet.order.expiry), blockTime: s(blockTime) } : null;
    return { reason, facts: { ...reasonFacts(reason), ...(expiry === null ? {} : { expired: expiry }), blockTime: blockTime === null ? null : s(blockTime) } };
  }

  /** The final write of a ran Cross: the receipt's figures, the legs as the chain recorded them, the marks at F, the line, the lane freed. */
  async function writeRan(bet: OrderRow, cross: CrossRow, legs: Awaited<ReturnType<typeof legsOf>>, l: Ran & { F: Header }): Promise<'written' | 'unchanged' | 'lost'> {
    const F = l.F;
    const receipt = l.receipt;
    const base = { txHash: receipt.transactionHash, nonce: s(cross.nonce as bigint), block: { number: s(receipt.blockNumber), hash: receipt.blockHash }, final: finalNamed(F), betFilled: s(l.betFilled), gasUsed: s(receipt.gasUsed), effectiveGasPrice: s(receipt.effectiveGasPrice) };
    if (l.status === 'confirmed') {
      const r = l.record;
      if (r === null || r.crossed === null) throw new Error('a confirmed Cross has its record');
      const recordedLegs = r.legs.map((e, i) => ({ position: i, makerRisk: e.kind === 'filled' ? e.makerRisk : null, takerRisk: e.kind === 'filled' ? e.takerRisk : null, skip: e.kind === 'skipped' ? e.reason : null }));
      const recorded = {
        betFilled: s(l.betFilled),
        final: finalNamed(F),
        totals: { maker: s(r.crossed.totalMakerRisk), taker: s(r.crossed.totalTakerRisk), marketId: s(r.crossed.marketId) },
        marketCreated: r.marketCreated === null ? null : s(r.marketCreated),
        pulls: Object.fromEntries([...r.pulls].map(([a, v]) => [a, s(v)])),
        paysBack: Object.fromEntries([...r.paysBack].map(([a, v]) => [a, s(v)])),
        paysBackRefused: r.paysBackRefused.map((p) => ({ account: p.account, amount: s(p.amount), held: s(p.held), logIndex: p.logIndex })),
        skipped: r.legs.flatMap((e, i) => (e.kind === 'skipped' ? [{ position: i, orderHash: e.orderHash, reason: e.reason }] : [])),
      };
      // The quotes after the outcome, at F: less than a lot of its stake left is filled; skipped Cancelled or GrantGone is cancelled.
      const marks = new Map<string, 'filled' | 'cancelled'>();
      for (const leg of legs) {
        const e = r.legs[leg.position];
        if (e === undefined) continue;
        const q = leg.orderHash.toLowerCase();
        if (e.kind === 'skipped' && (e.reason === 'Cancelled' || e.reason === 'GrantGone')) marks.set(q, 'cancelled');
        else if (e.kind === 'filled' && leg.riskAmount - (l.quotesFilled.get(q) ?? 0n) < ORDER_RULES.lot && !marks.has(q)) marks.set(q, 'filled');
      }
      const outcome: FinalOutcome = { state: 'confirmed', final: { number: F.number, hash: F.hash }, receipt: { number: receipt.blockNumber, hash: receipt.blockHash }, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, recorded, legs: recordedLegs };
      return guarded(cross, async (client) => {
        if (!(await writeFinal(client, bet.hash, outcome))) return false;
        if (marks.size > 0) await store.orders.markEndedAtFinal(client, [...marks].map(([hash, how]) => ({ hash: hash as Hex, how })), { number: F.number, hash: F.hash });
        await lineOf(client, bet, 'cross confirmed', 'CONFIRMED', { ...base, totals: recorded.totals, legs: recordedLegs.map((g) => ({ position: g.position, makerRisk: g.makerRisk === null ? null : s(g.makerRisk), takerRisk: g.takerRisk === null ? null : s(g.takerRisk), skip: g.skip })), marks: Object.fromEntries(marks) });
        await freeLaneOf(client, key, bet.hash);
        return true;
      });
    }
    // Reverted: the failed receipt alone establishes it; the reason from one trace, or unavailable.
    const { reason, facts } = await revertFacts(bet, cross, legs, receipt, F);
    const recorded = { betFilled: s(l.betFilled), final: finalNamed(F), reason: facts };
    const outcome: FinalOutcome = {
      state: 'reverted',
      final: { number: F.number, hash: F.hash },
      receipt: { number: receipt.blockNumber, hash: receipt.blockHash },
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      revert: { reason: reason.name, evidence: reason.evidence, data: reason.data },
      recorded,
    };
    const action = reason.needsLook
      ? { action: { case: 'refusal-needs-look', evidence: { betHash: bet.hash.toLowerCase(), reason: reason.name, evidence: reason.evidence, data: reason.data, final: finalNamed(F), txHash: receipt.transactionHash }, unknown: ['why the chain refused it, in terms the courier knows'] } }
      : {};
    return guarded(cross, async (client) => {
      if (!(await writeFinal(client, bet.hash, outcome))) return false;
      await lineOf(client, bet, 'cross reverted', reason.name, { ...base, ...facts, ...action });
      await freeLaneOf(client, key, bet.hash);
      return true;
    });
  }

  /** The ACTION for case unresolved-after-expiry: once, at the first compatible F at or past the bet's expiry where the outcome cannot be committed whole. */
  async function unresolvedAfterExpiry(bet: OrderRow, cross: CrossRow, l: Look): Promise<void> {
    if (l.kind === 'not comparable' || l.kind === 'contradiction' || l.F.timestamp < bet.order.expiry) return;
    const missing = l.kind === 'unavailable' ? [l.missing] : l.kind === 'pending' ? ['the receipt is in a block above the final block'] : l.kind === 'orphan' ? ["the receipt is in a block not on the final block's chain"] : l.kind === 'missing receipt' ? ["the receipt of the transaction the search found"] : [`the outcome (${l.kind})`];
    const { client, done } = await connect(store.lane);
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
            evidence: { final: finalNamed(l.F), expiry: s(bet.order.expiry), cross: { betHash: cross.betHash, txHash: cross.txHash, nonce: cross.nonce === null ? null : s(cross.nonce), state: cross.state }, look: lookFacts(l) },
            unknown: missing,
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

  /** The key's hold: cross-unreconciled opened, or the one standing, and the lane shut by its line. */
  async function holdKey(facts: Record<string, unknown>): Promise<void> {
    const { line } = await store.conditions.raise('cross-unreconciled', { lane: key, ...facts }, deps.run.id);
    const { client, done } = await connect(store.lane);
    try {
      await shutLane(client, key, line);
    } finally {
      done();
    }
  }

  /**
   * A read closes an ordinary hold that a search the node could not answer opened for this Cross: the search has now
   * answered with the courier's own transaction, and the Cross is settled. The lane opens, and the condition closes
   * once no lane stays shut by a line of its own. A hold for a transaction the records do not hold is never closed so.
   */
  async function openOnRead(bet: OrderRow): Promise<void> {
    const { rows } = await store.lane.query<{ shut_line: string; facts: Record<string, unknown>; kind: string; reason: string | null }>(
      `SELECT l.shut_line::text AS shut_line, e.facts, e.kind, e.reason FROM lanes l JOIN events e ON e.number = l.shut_line WHERE l.sender = $1`,
      [key.toLowerCase()],
    );
    const r = rows[0];
    if (r === undefined || r.kind !== 'condition opened' || r.reason !== 'cross-unreconciled' || r.facts.found !== 'the node could not answer' || String(r.facts.betHash).toLowerCase() !== bet.hash.toLowerCase()) return;
    await store.lane.query('UPDATE lanes SET shut_line = NULL WHERE sender = $1 AND shut_line = $2', [key.toLowerCase(), r.shut_line]);
    const still = await store.lane.query(`SELECT 1 FROM lanes l JOIN events e ON e.number = l.shut_line WHERE e.kind = 'condition opened' AND e.reason = 'cross-unreconciled'`);
    if ((still.rowCount ?? 0) === 0) await store.conditions.applySuccess('cross-unreconciled', { how: "a read: the search answered with the courier's own transaction", lane: key.toLowerCase(), betHash: bet.hash }, deps.run.id);
  }

  async function readExpiredAgain(F: Header): Promise<'none' | 'written' | 'stop'> {
    const expired = (await crossesOfKey(store.lane, key)).filter((c) => c.state === 'expired unmined' && c.txHash !== null && c.nonce !== null);
    if (expired.length === 0) return 'none';
    let count: bigint;
    try {
      count = await deps.chain.ask(F, () => transactionCountAt(deps.rpc, key, byHash(F.hash)));
    } catch (err) {
      if (err instanceof ChainUnreachable) return 'none';
      throw err;
    }
    let wrote: 'none' | 'written' = 'none';
    for (const c of expired) {
      if ((c.nonce as bigint) >= count) continue;
      let receipt: Receipt | null;
      try {
        receipt = await deps.chain.ask(F, () => receiptOf(deps.rpc, c.txHash as Hex));
        if (receipt === null || receipt.blockNumber > F.number) continue;
        const [shown] = await onFinalChain(deps.chain, deps.rpc, F, [{ number: receipt.blockNumber, hash: receipt.blockHash }]);
        if (shown !== true) continue;
      } catch (err) {
        if (err instanceof ChainUnreachable) continue;
        throw err;
      }
      const bet = await store.orders.get(c.betHash, store.lane);
      if (bet === null) throw new Error('an expired unmined Cross has no bet');
      if (receipt.status !== 'reverted') {
        // Expired unmined says it can no longer fill; a successful receipt says it did: a contradiction.
        await store.conditions.raise('courier-fault', { lane: key, betHash: c.betHash, why: 'a Cross closed expired unmined has a successful receipt on the final chain', txHash: c.txHash, final: finalNamed(F) }, deps.run.id);
        deps.stopSending('a Cross closed expired unmined has a successful receipt on the final chain');
        return 'stop';
      }
      const legs = await legsOf(store.lane, c.betHash);
      const { reason, facts } = await revertFacts(bet, c, legs, receipt, F);
      let betFilled: bigint | null = null;
      try {
        betFilled = (await filledAtF(deps.chain, deps.set, F, [c.betHash])).get(c.betHash.toLowerCase()) ?? null;
      } catch (err) {
        if (!(err instanceof ChainUnreachable)) throw err;
      }
      if (betFilled === null) continue;
      const outcome: FinalOutcome = {
        state: 'reverted',
        final: { number: F.number, hash: F.hash },
        receipt: { number: receipt.blockNumber, hash: receipt.blockHash },
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        revert: { reason: reason.name, evidence: reason.evidence, data: reason.data },
        recorded: { ...(c.recorded ?? {}), betFilled: s(betFilled), final: finalNamed(F), reason: facts, wasExpiredUnmined: true },
      };
      const r = await guarded(
        c,
        async (client) => {
          if (!(await writeFinal(client, c.betHash, outcome, 'expired unmined'))) return false;
          await lineOf(client, bet, 'cross reverted', reason.name, { txHash: c.txHash, nonce: s(c.nonce as bigint), block: { number: s(receipt.blockNumber), hash: receipt.blockHash }, final: finalNamed(F), betFilled: s(betFilled as bigint), ...facts, wasExpiredUnmined: true });
          return true;
        },
        'epoch',
      );
      if (r === 'written') wrote = 'written';
    }
    return wrote;
  }

  async function settle(bet: OrderRow): Promise<'done' | 'lost' | 'stop'> {
    let gap = deps.gap.firstMs;
    let lastF: Header | null = null;
    for (;;) {
      if (!deps.sending()) return 'stop';
      const cross = await crossRow(store.lane, bet.hash);
      if (cross === null) throw new Error('the Cross to settle has no row');
      if (FINAL_STATES.includes(cross.state)) return 'done';
      const { expected, legs } = await expectedOf(bet, cross);
      const ours = new Map((await crossesOfKey(store.lane, key)).filter((c) => c.nonce === cross.nonce && c.txHash !== null && c.betHash.toLowerCase() !== cross.betHash.toLowerCase()).map((c) => [(c.txHash as Hex).toLowerCase(), c.betHash]));
      const l = await look(outcomeDeps, cross, expected, lastF, ours);
      if (l.kind !== 'not comparable' && (lastF === null || l.F.number > lastF.number)) lastF = l.F;
      if (l.kind !== 'not comparable' && l.kind !== 'contradiction') {
        const again = await readExpiredAgain(l.F);
        if (again === 'stop') return 'stop';
        if (again === 'written') continue;
      }
      let result: 'written' | 'unchanged' | 'lost' = 'unchanged';
      switch (l.kind) {
        case 'pending':
          result = await guarded(cross, async (client) => {
            if (!(await writePending(client, bet.hash, { number: l.receipt.blockNumber, hash: l.receipt.blockHash }))) return false;
            if (cross.state !== 'pending') await lineOf(client, bet, 'cross pending', 'PENDING', { txHash: cross.txHash, block: { number: s(l.receipt.blockNumber), hash: l.receipt.blockHash }, final: finalNamed(l.F) });
            return true;
          });
          break;
        case 'orphan':
          result = await guarded(cross, async (client) => {
            const back = await writeOrphaned(client, bet.hash);
            if (back === null) return false;
            await lineOf(client, bet, back === 'sent' ? 'cross sent' : 'cross unknown', 'RECEIPT_ORPHANED', { txHash: cross.txHash, orphan: { number: s(l.receipt.blockNumber), hash: l.receipt.blockHash }, final: finalNamed(l.F) });
            return true;
          });
          break;
        case 'ran':
          result = await writeRan(bet, cross, legs, l);
          if (result === 'written') {
            await openOnRead(bet);
            return 'done';
          }
          break;
        case 'expired unmined':
          result = await guarded(cross, async (client) => {
            if (!(await writeFinal(client, bet.hash, { state: 'expired unmined', final: { number: l.F.number, hash: l.F.hash }, recorded: { betFilled: s(l.betFilled), final: finalNamed(l.F), expiry: s(bet.order.expiry) } }))) return false;
            await lineOf(client, bet, 'cross expired unmined', 'EXPIRED_UNMINED', { txHash: cross.txHash, nonce: cross.nonce === null ? null : s(cross.nonce), final: finalNamed(l.F), expiry: s(bet.order.expiry), betFilled: s(l.betFilled) });
            await freeLaneOf(client, key, bet.hash);
            return true;
          });
          if (result === 'written') return 'done';
          break;
        case 'replaced': {
          if (l.ours === null) {
            // A transaction the records do not hold: the key's hold first, so no restart can lose it, then the Cross's answer.
            await holdKey({ why: "the key's nonce was used at a final block by a transaction the records do not hold", nonce: cross.nonce === null ? null : s(cross.nonce), found: { hash: l.by.hash, block: { number: s(l.by.block.number), hash: l.by.block.hash } }, final: finalNamed(l.F), betHash: bet.hash });
          }
          result = await guarded(cross, async (client) => {
            const recorded = { betFilled: s(l.betFilled), final: finalNamed(l.F), replacedByBlock: { number: s(l.by.block.number), hash: l.by.block.hash }, searchReads: l.reads, ...(l.ours === null ? {} : { replacedByBet: l.ours }) };
            if (!(await writeFinal(client, bet.hash, { state: 'replaced', final: { number: l.F.number, hash: l.F.hash }, replacedBy: l.by.hash, replacedByOurs: l.ours !== null, recorded }))) return false;
            await lineOf(client, bet, 'cross replaced', l.ours === null ? 'REPLACED_NOT_OURS' : 'REPLACED_BY_OURS', { txHash: cross.txHash, nonce: cross.nonce === null ? null : s(cross.nonce), replacedBy: l.by.hash, replacedByOurs: l.ours !== null, block: { number: s(l.by.block.number), hash: l.by.block.hash }, final: finalNamed(l.F), betFilled: s(l.betFilled) });
            await freeLaneOf(client, key, bet.hash);
            return true;
          });
          if (result === 'written') {
            if (l.ours !== null) await openOnRead(bet);
            return 'done';
          }
          break;
        }
        case 'unavailable':
          if (l.facts.search === 'unanswered') await holdKey({ why: 'the node could not answer the search for what used the nonce', nonce: cross.nonce === null ? null : s(cross.nonce), found: 'the node could not answer', missing: l.missing, final: finalNamed(l.F), betHash: bet.hash });
          break;
        case 'contradiction':
          await store.conditions.raise('courier-fault', { lane: key, betHash: bet.hash, ...l.facts }, deps.run.id);
          deps.stopSending(`a Cross's outcome contradicts the chain's own state (${String(l.facts.why)})`);
          return 'stop';
        case 'not comparable':
        case 'nothing yet':
        case 'missing receipt':
          break;
      }
      if (result === 'lost') return 'lost';
      await unresolvedAfterExpiry(bet, cross, l);
      await sleep(gap);
      gap = Math.min(gap * 2, deps.gap.lastMs);
    }
  }

  return { settle, readExpiredAgain };
}
