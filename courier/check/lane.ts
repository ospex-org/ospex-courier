import type pg from 'pg';
import { keccak256, type Address, type Hex } from 'viem';
import { handOff, NodeFailure, type HandOff, type Header } from '../chain/rpc';
import { ChainUnreachable } from '../chain/snapshot';
import { lockKey } from '../orders/door';
import { coinAmount } from '../orders/order';
import { inLockOrder } from '../orders/stops';
import { closeBeforeGate, crossesOfKey, crossRow, freeLaneOfCross, lockCross, markHandingOff, writeAnswer, writeIntent, writeSigned } from '../records/crosses';
import { firstWaitingBet, type OrderRow } from '../records/orders';
import { free, holdBet, lockBet, lockLane, otherOpenCrosses, putBack, raiseWatermark, readLane, reserve, restoreHold, setBetState, shareLane, shutLane, take, type LaneRow, type Taken } from '../records/lanes';
import type { Run } from '../records/runs';
import { failureCode, type Store } from '../records/store';
import { onFinalChain, type Named } from '../send/chain';
import { searchNonce } from '../send/outcome';
import { repairMarks } from '../send/marks';
import { reconcileRestored, unresolvedWaiting } from '../send/recovery';
import { createSettler, type Settler } from '../send/settle';
import { blocksToShow, chooseFees, proveNonce, walletCovers, type NonceProof } from '../send/checks';
import { SignatureRefused, type Signer, type SignedCross } from '../send/signer';
import type { LaneHooks } from './hooks';
import { checkBet, named, sealSend, type CheckDeps, type CheckOutcome, type Incident, type ReadyCross, type Verdict } from './precheck';
import { VERDICT } from './sentences';

// The lane: one per sender key, one owner by its epoch, one bet at a time.
//
// The take at start makes this process the owner of every lane, puts each bet a
// lane held back to waiting, finishes as STOPPED one a stop ended while it was
// held, and frees the lanes. The runner is one per process, in memory, woken
// and never timed: by the take, and by a bet this process admitted, after the
// door's commit; by nothing else, so with no request nothing runs. A wake sets
// a flag, which the runner reads again after a reservation that found nothing,
// so a wake that comes as the runner ends is not lost.
//
// Each reservation is one transaction: the lane's row locked, its epoch this
// process's; the first waiting bet found with no lock; the bet made held by a
// guarded update that judges it on its row after any wait, and that a stop's
// mark makes lose; then the lane holds it under a new reservation number. A
// lost update ends the transaction, and the next attempt is a new one. Each
// outcome is one transaction: the lane's row locked and its epoch and
// reservation checked, the bet's row read again under its lock (a stop found
// there makes the outcome STOPPED, whatever the check found), the outcome and
// its line written, the lane freed. A transaction that fails for a reason of
// the database stops this process taking bets until it restarts; the next
// start's take settles what was left.
//
// A ready bet goes on to the send's steps, each recorded before the next, each
// one transaction under the same guards and the Cross in the state the step
// expects: the send's own checks (the lane not shut, the nonce held against the
// key's count at the final block, the fees, the wallet), which write only their
// refusal; the intent; the signature, in memory, from the pre-check's sealed
// snapshot, and the signed record; the gate, under the hash locks of the bet and
// of every quote listed, held for the session through the one hand-off and the
// record of its answer. A step that finds the lane, the reservation or the Cross
// otherwise commits nothing, and this process sends nothing more.

export interface LaneDeps {
  store: Store;
  key: Address;
  run: Run;
  check: Omit<CheckDeps, 'lane' | 'orders' | 'hooks' | 'courier'>;
  hooks: LaneHooks;
  /** The one signer, opened at start. */
  signer: Pick<Signer, 'address' | 'signCross'>;
  log(line: string): void;
}

export interface Lane {
  key: Address;
  /** The epoch this process took, or null before the take. */
  epoch(): bigint | null;
  /** Whether this process still takes bets: false once a lane step failed for a reason of the database, or the sender stopped sending. */
  takingBets(): boolean;
  /** The take at start, in one transaction with this run's `run started` line, which carries the lanes and the counts. */
  take(runFacts: Record<string, unknown>): Promise<Taken>;
  /** Check 17, in the door's transaction: the lane's epoch under a share lock is this process's, and this process takes bets. */
  admits(client: Pick<pg.PoolClient, 'query'>): Promise<boolean>;
  /** A bet was admitted here, or the take is done: the runner goes on, or starts. */
  wake(): void;
  /** Whether the runner is running now. */
  running(): boolean;
  /** The lane's epoch and the reservation this process holds now, from its own memory: null where it holds none. What the signer holds a sealed send to. */
  held(): { epoch: bigint; reservation: bigint } | null;
}

/**
 * The facts of a refusal's line: the check's own fields first, then the last header read where no check decided, then
 * the line's own code, sentence and block, last, so that no field of the check's can replace them.
 */
export function refusalFacts(v: Verdict): Record<string, unknown> {
  return { ...v.fields, ...(v.lastObservedBlock === undefined ? {} : { lastObservedBlock: v.lastObservedBlock }), code: v.code, error: v.error, block: v.block };
}

/** Whether a failure is the database's: a driver or server code, or the driver's codeless connection message. */
const CODELESS = /connection terminated|connection timeout|timeout expired|timeout exceeded when trying to connect|not queryable|connection ended|terminating connection|connection refused/i;
export const isDatabaseFailure = (err: unknown) =>
  !(err instanceof NodeFailure) && (failureCode(err) !== undefined || (err instanceof Error && CODELESS.test(err.message)));

interface Reserved {
  bet: OrderRow;
  reservation: bigint;
}

type Ready = Extract<CheckOutcome, { kind: 'ready' }>;

/** How a bet's time on the lane ended: written, or the lane or the reservation lost, or this process stopped sending. */
type Carried = 'done' | 'lost' | 'stop';

/** The look's gap, widening from the first to the last: how often the lane looks again. It ends nothing. */
export const LOOK_GAP = { firstMs: 1_000, lastMs: 30_000 } as const;

/** What the guard below does with a lane connection's error: nothing; the step's own statement fails with it. */
const heardByTheStep = () => undefined;

/**
 * A lane connection, checked out for one transaction. While a connection is out of its pool nothing listens to it,
 * and one the database drops raises its error on nobody, which would end the process, quotes and all. So it is
 * listened to while it is out. The statement in flight fails with the same error, as does the next one sent, and
 * that failure is what stops this process taking bets. `done` gives it back; the pool drops it if it is broken, and
 * `done(true)` destroys it, its session and every lock the session holds.
 */
async function laneClient(pool: pg.Pool): Promise<{ client: pg.PoolClient; done: (destroy?: boolean) => void }> {
  const client = await pool.connect();
  client.on('error', heardByTheStep);
  return {
    client,
    done: (destroy = false) => {
      client.removeListener('error', heardByTheStep);
      client.release(destroy);
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The hashes the gate locks: the bet's and every quote's listed, each once. */
const gateHashes = (bet: Hex, legs: ReadonlyArray<{ orderHash: Hex }>): Hex[] => [...new Set([bet, ...legs.map((l) => l.orderHash)].map((h) => h.toLowerCase() as Hex))];

/** The lock statement of the gate: every hash lock, for the session, in `inLockOrder`, in one statement over `unnest`. */
const GATE_LOCKS = 'SELECT count(pg_advisory_lock(t.k)) AS locked FROM (SELECT u.k FROM unnest($1::bigint[]) WITH ORDINALITY AS u(k, i) ORDER BY u.i) AS t';

export function createLane(deps: LaneDeps): Lane {
  const { store, key, run, hooks } = deps;
  let epoch: bigint | null = null;
  let stopped = false;
  let flag = false;
  let running = false;
  /** The reservation the runner is working on now, from its reservation to its outcome. */
  let current: Reserved | null = null;
  /** Every lane's epoch as this process's take set it: the owner's guard for a lane of another key, a retired one's. */
  let laneEpochs = new Map<string, bigint>();
  const epochOf = (laneKey: Address): bigint | null => (laneKey.toLowerCase() === key.toLowerCase() ? epoch : (laneEpochs.get(laneKey.toLowerCase()) ?? null));

  /** The marks' repair at a read of F, on the pool, in a transaction of its own. */
  const marksAt = async (F: Header): Promise<void> => {
    await repairMarks({ pool: store.pool, chain: deps.check.chain, rpc: deps.check.rpc, set: deps.check.set }, F);
  };
  const checkDeps: CheckDeps = { ...deps.check, courier: key, lane: store.lane, orders: store.orders, hooks, repairMarks: marksAt };

  const settlerFor = (laneKey: Address): Settler =>
    createSettler({
      store,
      key: laneKey,
      run,
      chain: deps.check.chain,
      rpc: deps.check.rpc,
      set: deps.check.set,
      epoch: () => epochOf(laneKey),
      sending: () => !stopped,
      stopSending: (why) => stopSending(why),
      log: deps.log,
      gap: LOOK_GAP,
      repairMarks: marksAt,
    });
  const settler = settlerFor(key);
  const others = new Map<string, Settler>();

  /**
   * Before the lane reserves anything: its own open Cross settled from the chain, and every other lane's, a retired
   * key's included, since no lane reserves while another holds an open Cross (the drain). Settling reads and records;
   * it signs and sends nothing. 'stop' where this process stopped sending or no longer owns a lane.
   */
  async function settleOpen(): Promise<'clear' | 'stop'> {
    const { client, done } = await laneClient(store.lane);
    let own: Hex | null;
    let rest: Array<{ sender: Address; betHash: Hex }>;
    let hold: number | null;
    try {
      own = (await readLane(client, key))?.openCross ?? null;
      rest = await otherOpenCrosses(client, key);
      hold = await restoreHold(client);
    } finally {
      done();
    }
    if (hold !== null) return recoverUnderHold(hold);
    for (const open of [...(own === null ? [] : [{ sender: key, betHash: own }]), ...rest]) {
      const bet = await store.orders.get(open.betHash, store.lane);
      if (bet === null) throw new Error('an open Cross has no bet');
      let s = open.sender.toLowerCase() === key.toLowerCase() ? settler : others.get(open.sender.toLowerCase());
      if (s === undefined) {
        s = settlerFor(open.sender);
        others.set(open.sender.toLowerCase(), s);
      }
      deps.log(`lane: settling the open Cross of lane ${open.sender} from the chain before anything is reserved`);
      const r = await s.settle(bet);
      if (r !== 'done') return 'stop';
    }
    return 'clear';
  }

  const recoveryDeps = { store, chain: deps.check.chain, rpc: deps.check.rpc, set: deps.check.set, run, epochOf, log: deps.log };

  /**
   * Under a restore's hold: every lane's nonce use reconciled and its retained intent closed where the chain allows;
   * each signed or later Cross settled by its own hash; each retained bet with no Cross given its ACTION once its
   * expiry is past a final block. Looked at again at the gap for as long as this process runs: a transaction kept
   * from the chain can land at any later block, and the hold never lifts. Nothing is reserved, signed or handed off.
   * 'stop' once this process stops.
   */
  async function recoverUnderHold(hold: number): Promise<'stop'> {
    let gap: number = LOOK_GAP.firstMs;
    for (;;) {
      if (stopped) return 'stop';
      const { rows } = await store.lane.query<{ sender: Address; open_cross: Hex | null }>('SELECT sender, open_cross FROM lanes ORDER BY sender');
      let all = true;
      for (const lane of rows) {
        const r = await reconcileRestored(recoveryDeps, lane.sender, hold);
        if (!r.done) {
          all = false;
          deps.log(`lane: under the restore's hold, lane ${lane.sender} is not yet reconciled: ${r.missing}`);
        }
        if (lane.open_cross === null) continue;
        const cross = await store.lane.query<{ state: string }>('SELECT state FROM crosses WHERE bet_hash = $1', [lane.open_cross]);
        const state = cross.rows[0]?.state;
        if (state === undefined || state === 'intent') continue;
        const bet = await store.orders.get(lane.open_cross, store.lane);
        if (bet === null) throw new Error('an open Cross has no bet');
        let sr = lane.sender.toLowerCase() === key.toLowerCase() ? settler : others.get(lane.sender.toLowerCase());
        if (sr === undefined) {
          sr = settlerFor(lane.sender);
          others.set(lane.sender.toLowerCase(), sr);
        }
        if ((await sr.settle(bet)) !== 'done') all = false;
      }
      try {
        await unresolvedWaiting(recoveryDeps, await deps.check.chain.finalHeader());
      } catch (err) {
        if (!(err instanceof ChainUnreachable)) throw err;
        all = false;
      }
      if (all) deps.log("lane: under the restore's hold, every lane is reconciled as the final block stands; looking again at the gap");
      await sleep(gap);
      gap = Math.min(gap * 2, LOOK_GAP.lastMs);
    }
  }

  /** The database failed under a lane step: this process takes no more bets until it restarts. */
  const failStop = (err: unknown, where: string) => {
    stopped = true;
    deps.log(`lane: the database failed in ${where}${failureCode(err) === undefined ? '' : ` (${failureCode(err)})`}; this process takes no more bets until it restarts`);
  };

  /** The sender found something it must not go past: this process sends nothing more, and takes no more bets, until it restarts. */
  const stopSending = (why: string) => {
    stopped = true;
    deps.log(`lane: ${why}; this process sends nothing more until it restarts`);
  };

  /** One reservation: the bet it took and the reservation, null where the queue is empty, or 'stop' where this process no longer owns the lane. At most 33 attempts. */
  async function reserveOne(): Promise<Reserved | null | 'stop'> {
    for (let attempt = 1; attempt <= 33; attempt++) {
      const { client, done } = await laneClient(store.lane);
      try {
        await client.query('BEGIN');
        const lane = await lockLane(client, key);
        if (lane === null || lane.epoch !== epoch || stopped) {
          await client.query('ROLLBACK');
          return 'stop';
        }
        if (lane.heldBet !== null || lane.openCross !== null || lane.shutLine !== null) {
          await client.query('ROLLBACK');
          return 'stop';
        }
        // The database-wide restore hold, and the drain: no lane reserves while another lane holds an open Cross.
        if ((await restoreHold(client)) !== null || (await otherOpenCrosses(client, key)).length > 0) {
          await client.query('ROLLBACK');
          return 'stop';
        }
        const bet = await firstWaitingBet(client);
        if (bet === null) {
          await client.query('COMMIT');
          return null;
        }
        await hooks.at('between-find-and-update', bet.hash);
        if (!(await holdBet(client, bet.hash))) {
          await client.query('ROLLBACK');
          continue;
        }
        const reservation = await reserve(client, key, bet.hash);
        await client.query('COMMIT');
        return { bet, reservation };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        done();
      }
    }
    return null;
  }

  /** The check, its own faults recorded as COURIER_FAULT; the database's failures thrown on, to stop the process. */
  async function checked(res: Reserved): Promise<CheckOutcome> {
    const bet = res.bet;
    try {
      return await checkBet(checkDeps, bet, { epoch: epoch as bigint, reservation: res.reservation });
    } catch (err) {
      if (isDatabaseFailure(err)) throw err;
      deps.log(`lane: the check of a bet failed inside the courier (${err instanceof Error ? err.name : typeof err})`);
      return {
        kind: 'refused',
        verdict: { code: 'COURIER_FAULT', error: VERDICT.COURIER_FAULT, fields: {}, block: null },
        incidents: [{ reason: 'CHECK_FAILED', orderHash: bet.hash, facts: { error: err instanceof Error ? err.name : typeof err } }],
      };
    }
  }

  type LineKind = 'bet refused' | 'bet lapsed' | 'cross sent' | 'cross not sent' | 'cross unknown' | 'incident';
  const line = (client: Pick<pg.PoolClient, 'query'>, bet: OrderRow, kind: LineKind, reason: string, facts: Record<string, unknown>, orderHash?: Hex) =>
    store.events.write({ run: run.id, kind, orderHash: orderHash ?? bet.hash, betHash: bet.hash, account: bet.order.account.toLowerCase(), gameId: bet.order.gameId, reason, facts }, client);

  /** The lane's guards, under its lock: this process's epoch, the reservation the Cross records, the bet held, not stopped. */
  const holds = (lane: LaneRow | null, res: Reserved): lane is LaneRow =>
    lane !== null && lane.epoch === epoch && lane.reservation === res.reservation && lane.heldBet !== null && lane.heldBet.toLowerCase() === res.bet.hash.toLowerCase() && !stopped;

  /** A stop came while the bet was held: STOPPED, whatever the check found, and no Cross. */
  async function finishStopped(client: Pick<pg.PoolClient, 'query'>, res: Reserved, found: string): Promise<void> {
    await line(client, res.bet, 'bet refused', 'STOPPED', { code: 'STOPPED', error: VERDICT.STOPPED, block: null, found });
    await setBetState(client, res.bet.hash, 'refused');
  }

  /** A refusal or a lapse, in one transaction under the lane's guards. 'lost' where this process no longer holds the lane or the reservation: nothing is written. */
  async function writeOutcome(res: Reserved, outcome: Exclude<CheckOutcome, Ready>): Promise<'written' | 'lost'> {
    const { client, done } = await laneClient(store.lane);
    try {
      await client.query('BEGIN');
      const lane = await lockLane(client, key);
      if (!holds(lane, res) || lane.openCross !== null) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      const row = await lockBet(client, res.bet.hash);
      if (row === null) throw new Error('the held bet has no row');
      const incidents: Incident[] = outcome.incidents;
      if (row.ended === 'stopped') {
        await finishStopped(client, res, outcome.verdict.code);
      } else if (row.ended !== null) {
        throw new Error(`a held bet ended ${row.ended}: only a stop ends a bet in this build`);
      } else {
        const v = outcome.verdict;
        await line(client, res.bet, outcome.kind === 'lapsed' ? 'bet lapsed' : 'bet refused', v.code, refusalFacts(v));
        await setBetState(client, res.bet.hash, outcome.kind === 'lapsed' ? 'lapsed' : 'refused');
      }
      for (const i of incidents) await line(client, res.bet, 'incident', i.reason, i.facts, i.orderHash);
      await free(client, key);
      await client.query('COMMIT');
      return 'written';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      done();
    }
  }

  /** The bet back to waiting and the lane freed, nothing signed: a send that cannot go on now. As the take puts a held bet back, it writes no line of the bet's; what stopped it is the lane's line. */
  async function backToWaiting(res: Reserved): Promise<'written' | 'lost'> {
    const { client, done } = await laneClient(store.lane);
    try {
      await client.query('BEGIN');
      const lane = await lockLane(client, key);
      if (lane === null || lane.epoch !== epoch || lane.reservation !== res.reservation || lane.openCross !== null) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      await putBack(client, key, res.bet.hash);
      await client.query('COMMIT');
      return 'written';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      done();
    }
  }

  /** The verdict of a send check's read that failed twice: CHAIN_UNREACHABLE, as the check's own reads give it. */
  const unreachable = (err: ChainUnreachable, H: Header): Exclude<CheckOutcome, Ready> => ({
    kind: 'refused',
    verdict: {
      code: 'CHAIN_UNREACHABLE',
      error: VERDICT.CHAIN_UNREACHABLE,
      fields: { operation: err.failure.method, failureKind: err.failure.kind, failureCode: err.failure.code },
      block: null,
      lastObservedBlock: named(H),
    },
    incidents: [],
  });

  /**
   * The nonce proof's reads and its decision: the lane's row, the key's Crosses, and the blocks the proof needs shown
   * on F's chain, read at F by its hash. The decision is the proof's; nothing here is written.
   */
  async function nonceProof(c: ReadyCross): Promise<{ proof: NonceProof | null; lane: LaneRow }> {
    const { client, done } = await laneClient(store.lane);
    let lane: LaneRow | null;
    let crosses;
    try {
      lane = await readLane(client, key);
      crosses = await crossesOfKey(client, key);
    } finally {
      done();
    }
    if (lane === null) throw new Error('the lane has no row');
    // The lane not shut, first: a shut lane reads nothing more.
    if (lane.shutLine !== null) return { proof: null, lane };
    const F = c.send.final;
    const toShow = blocksToShow(F, lane.watermark, crosses);
    const shown = toShow.length === 0 ? [] : await onFinalChain(deps.check.chain, deps.check.rpc, F, toShow);
    const onF = new Map(toShow.map((b, i) => [b.hash.toLowerCase(), shown[i] as boolean | 'not comparable']));
    return { proof: proveNonce({ F, countAtFinal: c.send.countAtFinal, countAtH: c.nonce, watermark: lane.watermark, crosses, onF }), lane };
  }

  /**
   * The key's nonce used and not explained: the search for what used it runs from the watermark's anchor, the
   * recorded height at which the nonce was unused; cross-unreconciled opens with the reads and what the search found,
   * or that the node could not answer; the lane is shut by its line, and the bet goes back to waiting. Nothing is
   * signed.
   */
  async function shutForNonce(res: Reserved, facts: Record<string, unknown>, F: Header, nonce: bigint, unusedAt: Named | null): Promise<Carried> {
    const hit = await searchNonce({ chain: deps.check.chain, rpc: deps.check.rpc, set: deps.check.set, key }, F, nonce, unusedAt);
    const found = 'missing' in hit ? { found: 'the node could not answer', missing: hit.missing } : { found: { hash: hit.found.hash, block: { number: hit.found.block.number.toString(), hash: hit.found.block.hash } } };
    const { line: opened } = await store.conditions.raise('cross-unreconciled', { lane: key, why: "the key's nonce was used at a final block and nothing the records hold explains it", ...facts, ...found, searchReads: hit.reads }, run.id);
    const { client, done } = await laneClient(store.lane);
    try {
      await client.query('BEGIN');
      const lane = await lockLane(client, key);
      if (lane === null || lane.epoch !== epoch || lane.reservation !== res.reservation || lane.openCross !== null) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      await shutLane(client, key, opened);
      await putBack(client, key, res.bet.hash);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      done();
    }
    deps.log(`lane: the key's nonce ${String(facts.nonce)} is used at the final block and nothing the records hold explains it; the lane is shut`);
    return 'stop';
  }

  /** The records and the chain disagree: courier-fault opened with the reads judged, and this process sends nothing more. The bet goes back to waiting. */
  async function contradiction(res: Reserved, facts: Record<string, unknown>): Promise<Carried> {
    await store.conditions.raise('courier-fault', { lane: key, betHash: res.bet.hash, ...facts }, run.id);
    await backToWaiting(res);
    stopSending('the records and the chain disagree at the same final block');
    return 'stop';
  }

  /**
   * The send's own checks, at the check's H and F, in order: the lane not shut; the nonce, with the count at F held
   * against the records and the watermark with its anchor; the fees; the wallet. A wallet that does not cover the
   * gas is the one refusal written, `COURIER_CANNOT_SEND` in the wallet's form, marked as the ACTION for its case.
   */
  async function sendChecks(res: Reserved, ready: Ready): Promise<Carried | 'read again' | { nonce: bigint; fees: ReturnType<typeof chooseFees>; proof: Extract<NonceProof, { kind: 'proved' }>; lane: LaneRow }> {
    const c = ready.cross;
    const H = c.block;
    let got: { proof: NonceProof | null; lane: LaneRow };
    try {
      got = await nonceProof(c);
    } catch (err) {
      if (err instanceof ChainUnreachable) return (await writeOutcome(res, unreachable(err, H))) === 'lost' ? 'lost' : 'done';
      throw err;
    }
    const { proof, lane } = got;
    if (proof === null) {
      // Shut since the reservation: the bet waits, and the lane reserves nothing while it is shut.
      deps.log(`lane: the lane is shut by line ${String(lane.shutLine)}; the bet goes back to waiting`);
      return (await backToWaiting(res)) === 'lost' ? 'lost' : 'stop';
    }
    if (proof.kind === 'not comparable') {
      deps.log(`lane: the final block cannot be compared with the records yet (${String(proof.facts.why)}); the lane holds and reads again`);
      return 'read again';
    }
    if (proof.kind === 'read again') {
      // An `expired unmined` Cross at a used nonce: its receipt is read by its hash first, with the outcome's reads.
      return settleExpiredAgain(ready, proof);
    }
    if (proof.kind === 'unexplained') return shutForNonce(res, proof.facts, c.send.final, proof.nonce, lane.watermark.anchor);
    if (proof.kind === 'contradiction') return contradiction(res, proof.facts);

    const crosses = await crossesOfKey(store.lane, key);
    const earlier = crosses.filter((x) => x.nonce === proof.nonce && x.state === 'expired unmined');
    const fees = chooseFees(c.send.tip, c.send.baseFee, earlier);
    const wallet = walletCovers(c.send.keyPol, c.gas.limit, fees.maxFeePerGas);
    if (!wallet.ok) {
      const n = H.number.toString();
      const pol = coinAmount(c.send.keyPol, 18);
      const cost = coinAmount(wallet.required, 18);
      const evidence = {
        betHash: res.bet.hash.toLowerCase(),
        sender: key.toLowerCase(),
        block: named(H),
        pol: c.send.keyPol.toString(),
        gasLimit: c.gas.limit.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        required: wallet.required.toString(),
      };
      const verdict: Verdict = {
        code: 'COURIER_CANNOT_SEND',
        error: VERDICT.COURIER_CANNOT_SEND_WALLET(n, pol, cost),
        fields: { form: 'wallet', ...evidence, maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), action: { case: 'wallet-cannot-send', evidence, unknown: [] } },
        block: named(H),
      };
      return (await writeOutcome(res, { kind: 'refused', verdict, incidents: ready.incidents })) === 'lost' ? 'lost' : 'done';
    }
    return { nonce: proof.nonce, fees, proof, lane };
  }

  /** An `expired unmined` Cross at a nonce the count at F shows used: its receipt read by its hash first, then the check made again. */
  async function settleExpiredAgain(ready: Ready, proof: Extract<NonceProof, { kind: 'read again' }>): Promise<Carried | 'read again'> {
    deps.log(`lane: the nonce of an expired unmined Cross is used at the final block; its receipt is read again (${proof.cross.betHash})`);
    const again = await settler.readExpiredAgain(ready.cross.send.final);
    return again === 'stop' ? 'stop' : 'read again';
  }

  /** The intent, in one transaction under the lane's guards: the watermark raised, the Cross's row and its legs, the lane's open Cross, the bet's stage sent. */
  async function writeIntentStep(res: Reserved, ready: Ready, chosen: { nonce: bigint; fees: ReturnType<typeof chooseFees>; proof: Extract<NonceProof, { kind: 'proved' }>; lane: LaneRow }): Promise<'written' | 'stopped' | 'lost'> {
    const c = ready.cross;
    const { client, done } = await laneClient(store.lane);
    try {
      await client.query('BEGIN');
      const lane = await lockLane(client, key);
      if (!holds(lane, res) || lane.openCross !== null || lane.shutLine !== null || (await restoreHold(client)) !== null) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      const row = await lockBet(client, res.bet.hash);
      if (row === null) throw new Error('the held bet has no row');
      if (row.ended === 'stopped') {
        await finishStopped(client, res, 'ready');
        for (const i of ready.incidents) await line(client, res.bet, 'incident', i.reason, i.facts, i.orderHash);
        await free(client, key);
        await client.query('COMMIT');
        return 'stopped';
      }
      if (row.ended !== null) throw new Error(`a held bet ended ${row.ended}: only a stop ends a bet in this build`);
      if (chosen.proof.raised && !(await raiseWatermark(client, key, chosen.lane.watermark, chosen.proof.watermark))) {
        // The watermark moved since the proof read it: the proof is not this lane's now.
        await client.query('ROLLBACK');
        return 'lost';
      }
      await writeIntent(client, {
        betHash: res.bet.hash,
        lane: key,
        epoch: epoch as bigint,
        reservation: res.reservation,
        block: { number: c.block.number, hash: c.block.hash, time: c.block.timestamp },
        checked: {
          ...c.checked,
          pulls: c.pulls,
          paysBack: c.paysBack,
          gas: { estimate: c.gas.estimate.toString(), limit: c.gas.limit.toString(), ...((c.checked.gas as object) ?? {}) },
          takerRisk: c.takerRisk.toString(),
          calldataHash: keccak256(c.sealed.calldata),
          send: { nonce: chosen.proof.facts, fees: chosen.fees.facts, wallet: { pol: c.send.keyPol.toString(), required: (c.gas.limit * chosen.fees.maxFeePerGas).toString() } },
        },
        legs: c.legs.map((l) => ({ orderHash: l.orderHash, makerRisk: l.makerRisk, takerRisk: l.takerRisk })),
      });
      for (const i of ready.incidents) await line(client, res.bet, 'incident', i.reason, i.facts, i.orderHash);
      await client.query('COMMIT');
      return 'written';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      done();
    }
  }

  /** The signed record, in one transaction under the lane's guards, from the intent only. A failure of the database here stops this process sending; the next start closes the Cross. */
  async function writeSignedStep(res: Reserved, signed: SignedCross): Promise<'written' | 'lost'> {
    const { client, done } = await laneClient(store.lane);
    try {
      await client.query('BEGIN');
      const lane = await lockLane(client, key);
      if (!holds(lane, res) || lane.openCross?.toLowerCase() !== res.bet.hash.toLowerCase()) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      const cross = await lockCross(client, res.bet.hash);
      if (cross === null || cross.state !== 'intent') {
        await client.query('ROLLBACK');
        return 'lost';
      }
      const moved = await writeSigned(client, res.bet.hash, {
        sender: signed.fields.from,
        nonce: signed.fields.nonce,
        gasLimit: signed.fields.gas,
        maxFeePerGas: signed.fields.maxFeePerGas,
        maxPriorityFee: signed.fields.maxPriorityFeePerGas,
        txHash: signed.hash,
      });
      if (!moved) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      await client.query('COMMIT');
      return 'written';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      done();
    }
  }

  /** What a read back of the Cross's row says, after a commit whose acknowledgement was lost: its state, or null where it cannot be read. */
  async function readBack(bet: Hex): Promise<string | null> {
    try {
      const row = await crossRow(store.lane, bet);
      return row === null ? null : row.state;
    } catch {
      return null;
    }
  }

  /**
   * The gate, the one hand-off, and its answer. The hash locks are taken for the session on the lane's own
   * connection and held through the answer's record; from the locks to the unlock, any failure releases the connection
   * destroyed, so no lock outlives the request that took it. The check and the mark are one transaction; from its
   * commit the Cross counts as possibly handed to the node, whatever happens next.
   */
  async function gateAndHandOff(res: Reserved, ready: Ready, signed: SignedCross): Promise<Carried | 'settle'> {
    const bet = res.bet.hash.toLowerCase() as Hex;
    const hashes = inLockOrder(gateHashes(bet, ready.cross.legs));
    const { client, done } = await laneClient(store.lane);
    let destroy = false;
    let released = false;
    const release = (destroyed: boolean) => {
      if (released) return;
      released = true;
      done(destroyed);
    };
    try {
      await client.query(GATE_LOCKS, [hashes.map((h) => lockKey(h))]);
      destroy = true;

      // The check, and the mark: one transaction.
      await client.query('BEGIN');
      let gate: 'marked' | 'stopped' | 'lost';
      try {
        const lane = await lockLane(client, key);
        const cross = holds(lane, res) && lane.openCross?.toLowerCase() === bet && (await restoreHold(client)) === null ? await lockCross(client, bet) : null;
        if (cross === null || cross.state !== 'signed' || cross.txHash?.toLowerCase() !== signed.hash.toLowerCase()) {
          gate = 'lost';
        } else {
          // No stop on any of the hashes: no stopped mark on an order's row, and no row in stops. Read with no lock: under the hash locks, no stop on them can commit.
          const { rows } = await client.query<{ hash: Hex }>(
            `SELECT hash FROM orders WHERE hash = ANY($1::text[]) AND ended = 'stopped'
             UNION SELECT hash FROM stops WHERE hash = ANY($1::text[])`,
            [hashes],
          );
          const stoppedHashes = [...new Set(rows.map((r) => r.hash.toLowerCase() as Hex))].sort();
          if (stoppedHashes.length > 0) {
            await closeBeforeGate(client, bet, 'STOPPED_AT_GATE');
            if (stoppedHashes.includes(bet)) {
              // The bet itself: it ends as a bet stopped while it was held.
              await finishStopped(client, res, 'signed');
            } else {
              await line(client, res.bet, 'cross not sent', 'STOPPED_AT_GATE', { txHash: signed.hash, nonce: signed.fields.nonce.toString(), stopped: stoppedHashes, handOffs: 0 });
            }
            await freeLaneOfCross(client, key);
            gate = 'stopped';
          } else {
            gate = (await markHandingOff(client, bet)) ? 'marked' : 'lost';
          }
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      if (gate === 'lost') {
        await client.query('ROLLBACK');
        await client.query('SELECT pg_advisory_unlock_all()');
        destroy = false;
        return 'lost';
      }
      try {
        await client.query('COMMIT');
      } catch (err) {
        if (gate === 'stopped') throw err;
        // The gate's acknowledgement lost: this process hands nothing over. The uncertain session goes first, its locks with it.
        release(true);
        const state = await readBack(bet);
        if (state === 'handing off') {
          deps.log("lane: the gate's commit was not acknowledged and reads back as handing off; nothing is handed over, and the Cross is settled from the chain");
          return 'settle';
        }
        stopSending(`the gate's commit was not acknowledged and reads back as ${state ?? 'nothing'}`);
        return 'stop';
      }
      if (gate === 'stopped') {
        await client.query('SELECT pg_advisory_unlock_all()');
        destroy = false;
        return 'done';
      }

      // The hand-off: one request, no retry, with the locks still held.
      await hooks.at('after-gate', bet);
      const answer: HandOff = await handOff(deps.check.rpc, signed.raw);
      await hooks.at('after-hand-off', bet);

      // The answer, in its own transaction, under the lane's guards; then every hash lock let go.
      await client.query('BEGIN');
      let recorded: 'written' | 'lost';
      try {
        const lane = await lockLane(client, key);
        const cross = holds(lane, res) && lane.openCross?.toLowerCase() === bet ? await lockCross(client, bet) : null;
        if (cross === null || cross.state !== 'handing off') {
          recorded = 'lost';
        } else {
          const kept = answer.kind === 'refused' ? { kind: 'refused' as const, words: answer.words } : answer.kind === 'taken' ? { kind: 'taken' as const } : { kind: 'unknown' as const };
          await writeAnswer(client, bet, kept);
          const facts = { txHash: signed.hash, nonce: signed.fields.nonce.toString(), handOffs: 1, answer: kept };
          if (answer.kind === 'taken') await line(client, res.bet, 'cross sent', 'TAKEN', facts);
          else if (answer.kind === 'refused') {
            await line(client, res.bet, 'cross not sent', 'NODE_REFUSED', { ...facts, kind: answer.words });
            await freeLaneOfCross(client, key);
          } else await line(client, res.bet, 'cross unknown', 'NO_ANSWER', facts);
          recorded = 'written';
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      if (recorded === 'lost') await client.query('ROLLBACK');
      else await client.query('COMMIT');
      await client.query('SELECT pg_advisory_unlock_all()');
      destroy = false;
      if (recorded === 'lost') return 'lost';
      return answer.kind === 'refused' ? 'done' : 'settle';
    } finally {
      release(destroy);
    }
  }

  /** The outcome, settled from the chain at final blocks, before the lane reserves anything else. */
  async function settle(res: Reserved): Promise<Carried> {
    return settler.settle(res.bet);
  }

  /** A ready bet's send: the send's own checks, the intent, the signature and its record, the gate and the hand-off, and the outcome. */
  async function sendSteps(res: Reserved, ready: Ready): Promise<Carried | 'read again'> {
    const chosen = await sendChecks(res, ready);
    if (typeof chosen === 'string') return chosen;
    const intent = await writeIntentStep(res, ready, chosen);
    if (intent === 'lost') return 'lost';
    if (intent === 'stopped') return 'done';
    await hooks.at('after-intent', res.bet.hash);

    let signed: SignedCross;
    try {
      signed = await deps.signer.signCross(sealSend(ready.cross.sealed, { nonce: chosen.nonce, maxFeePerGas: chosen.fees.maxFeePerGas, maxPriorityFeePerGas: chosen.fees.maxPriorityFeePerGas }));
    } catch (err) {
      if (!(err instanceof SignatureRefused)) throw err;
      // The courier's own fault: nothing is recorded as signed, nothing is sent, and an incident line is written.
      await store.events.write({ run: run.id, kind: 'incident', orderHash: res.bet.hash, betHash: res.bet.hash, account: res.bet.order.account.toLowerCase(), gameId: res.bet.order.gameId, reason: 'SIGNATURE_REFUSED', facts: { check: err.check } });
      stopSending('the signer refused the Cross');
      return 'stop';
    }
    await hooks.at('after-signature', res.bet.hash);
    let rec: 'written' | 'lost';
    try {
      rec = await writeSignedStep(res, signed);
    } catch (err) {
      if (!isDatabaseFailure(err)) throw err;
      // The signed record's acknowledgement lost, or the database failed under it: read back, and this process stops sending either way.
      const state = await readBack(res.bet.hash);
      failStop(err, `the signed record (it reads back as ${state ?? 'nothing'})`);
      return 'stop';
    }
    if (rec === 'lost') return 'lost';
    await hooks.at('after-signed-record', res.bet.hash);

    const gated = await gateAndHandOff(res, ready, signed);
    if (gated !== 'settle') return gated;
    return settle(res);
  }

  /** One bet on the lane, from its check to its end here: refused, lapsed, or sent and settled. A check whose final block cannot be compared yet is made again after the look's gap. */
  async function carry(res: Reserved): Promise<Carried> {
    let gap: number = LOOK_GAP.firstMs;
    for (;;) {
      const outcome = await checked(res);
      await hooks.at('before-result', res.bet.hash);
      if (outcome.kind !== 'ready') return (await writeOutcome(res, outcome)) === 'lost' ? 'lost' : 'done';
      const sent = await sendSteps(res, outcome);
      if (sent !== 'read again') return sent;
      await sleep(gap);
      gap = Math.min(gap * 2, LOOK_GAP.lastMs);
      if (stopped) return 'stop';
    }
  }

  async function loop(): Promise<void> {
    try {
      for (;;) {
        if (stopped) break;
        flag = false;
        if ((await settleOpen()) === 'stop') break;
        const r = await reserveOne();
        if (r === 'stop') break;
        if (r === null) {
          await hooks.at('after-empty-reservation', null);
          // Read after the reservation that found nothing: a wake that came meanwhile is not lost.
          if (!flag) break;
          continue;
        }
        current = r;
        await hooks.at('after-reservation', r.bet.hash);
        const carried = await carry(r);
        current = null;
        if (carried === 'lost') {
          deps.log('lane: a step of a bet was not written: this process no longer holds its lane or its reservation');
          break;
        }
        if (carried === 'stop') break;
      }
    } catch (err) {
      failStop(err, 'a lane step');
    } finally {
      current = null;
      running = false;
    }
  }

  return {
    key,
    epoch: () => epoch,
    takingBets: () => epoch !== null && !stopped,
    running: () => running,
    held: () => (epoch === null || current === null ? null : { epoch, reservation: current.reservation }),
    async take(runFacts) {
      const { client, done } = await laneClient(store.lane);
      try {
        await client.query('BEGIN');
        const taken = await take(client, key, run.id);
        await store.events.write(
          { run: run.id, kind: 'run started', facts: { ...runFacts, key, epoch: taken.epoch.toString(), lanes: taken.lanes, heldReturnedToWaiting: taken.returned.length, heldFinishedStopped: taken.stopped.length, crossesClosedRestarted: taken.closed.length, restoreHold: taken.restoreHold } },
          client,
        );
        for (const s of taken.stopped) {
          await store.events.write(
            { run: run.id, kind: 'bet refused', orderHash: s.hash, betHash: s.hash, account: s.account, gameId: BigInt(s.gameId), reason: 'STOPPED', facts: { code: 'STOPPED', error: VERDICT.STOPPED, block: null, run: run.id, byTheTake: true } },
            client,
          );
        }
        for (const c of taken.closed) {
          await store.events.write(
            { run: run.id, kind: 'cross not sent', orderHash: c.hash, betHash: c.hash, account: c.account, gameId: BigInt(c.gameId), reason: 'COURIER_RESTARTED', facts: { lane: c.lane, was: c.state, txHash: c.txHash, nonce: c.nonce, handOffs: 0, byTheTake: true } },
            client,
          );
        }
        await client.query('COMMIT');
        epoch = taken.epoch;
        laneEpochs = new Map(taken.lanes.map((l) => [l.sender.toLowerCase(), BigInt(l.epoch)]));
        return taken;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        done();
      }
    },
    async admits(client) {
      const e = await shareLane(client, key);
      return e !== null && epoch !== null && e.epoch === epoch && e.shutLine === null && !stopped && (await restoreHold(client)) === null;
    },
    wake() {
      if (epoch === null || stopped) return;
      flag = true;
      if (!running) {
        running = true;
        void loop();
      }
    },
  };
}
