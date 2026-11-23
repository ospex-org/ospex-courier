import type pg from 'pg';
import type { Address, Hex } from 'viem';
import { NodeFailure } from '../chain/rpc';
import { firstWaitingBet, type OrderRow } from '../records/orders';
import { free, holdBet, lockBet, lockLane, reserve, setBetState, shareLane, take, writeNotSent, type Taken } from '../records/lanes';
import type { Run } from '../records/runs';
import { failureCode, type Store } from '../records/store';
import type { LaneHooks } from './hooks';
import { checkBet, named, type CheckDeps, type CheckOutcome, type Incident } from './precheck';
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

export interface LaneDeps {
  store: Store;
  key: Address;
  run: Run;
  check: Omit<CheckDeps, 'lane' | 'orders' | 'hooks' | 'courier'>;
  hooks: LaneHooks;
  log(line: string): void;
}

export interface Lane {
  key: Address;
  /** The epoch this process took, or null before the take. */
  epoch(): bigint | null;
  /** Whether this process still takes bets: false once a lane step failed for a reason of the database. */
  takingBets(): boolean;
  /** The take at start, in one transaction with this run's `run started` line, which carries the lanes and the counts. */
  take(runFacts: Record<string, unknown>): Promise<Taken>;
  /** Check 17, in the door's transaction: the lane's epoch under a share lock is this process's, and this process takes bets. */
  admits(client: Pick<pg.PoolClient, 'query'>): Promise<boolean>;
  /** A bet was admitted here, or the take is done: the runner goes on, or starts. */
  wake(): void;
  /** Whether the runner is running now. */
  running(): boolean;
}

/** Whether a failure is the database's: a driver or server code, or the driver's codeless connection message. */
const CODELESS = /connection terminated|connection timeout|timeout expired|timeout exceeded when trying to connect|not queryable|connection ended|terminating connection|connection refused/i;
export const isDatabaseFailure = (err: unknown) =>
  !(err instanceof NodeFailure) && (failureCode(err) !== undefined || (err instanceof Error && CODELESS.test(err.message)));

interface Reserved {
  bet: OrderRow;
  reservation: bigint;
}

/** What the guard below does with a lane connection's error: nothing; the step's own statement fails with it. */
const heardByTheStep = () => undefined;

/**
 * A lane connection, checked out for one transaction. While a connection is out of its pool nothing listens to it,
 * and one the database drops raises its error on nobody, which would end the process, quotes and all. So it is
 * listened to while it is out. The statement in flight fails with the same error, as does the next one sent, and
 * that failure is what stops this process taking bets. `done` gives it back; the pool drops it if it is broken.
 */
async function laneClient(pool: pg.Pool): Promise<{ client: pg.PoolClient; done: () => void }> {
  const client = await pool.connect();
  client.on('error', heardByTheStep);
  return {
    client,
    done: () => {
      client.removeListener('error', heardByTheStep);
      client.release();
    },
  };
}

export function createLane(deps: LaneDeps): Lane {
  const { store, key, run, hooks } = deps;
  let epoch: bigint | null = null;
  let stopped = false;
  let flag = false;
  let running = false;

  const checkDeps: CheckDeps = { ...deps.check, courier: key, lane: store.lane, orders: store.orders, hooks };

  /** The database failed under a lane step: this process takes no more bets until it restarts. */
  const failStop = (err: unknown, where: string) => {
    stopped = true;
    deps.log(`lane: the database failed in ${where}${failureCode(err) === undefined ? '' : ` (${failureCode(err)})`}; this process takes no more bets until it restarts`);
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
        if (lane.heldBet !== null || lane.openCross !== null) {
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
  async function checked(bet: OrderRow): Promise<CheckOutcome> {
    try {
      return await checkBet(checkDeps, bet);
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

  const line = (client: Pick<pg.PoolClient, 'query'>, bet: OrderRow, kind: 'bet refused' | 'bet lapsed' | 'cross not sent' | 'incident', reason: string, facts: Record<string, unknown>, orderHash?: Hex) =>
    store.events.write({ run: run.id, kind, orderHash: orderHash ?? bet.hash, betHash: bet.hash, account: bet.order.account.toLowerCase(), gameId: bet.order.gameId, reason, facts }, client);

  /** The outcome, in one transaction under the lane's guards. 'lost' where this process no longer holds the lane or the reservation: nothing is written. */
  async function writeOutcome(res: Reserved, outcome: CheckOutcome): Promise<'written' | 'lost'> {
    const { client, done } = await laneClient(store.lane);
    try {
      await client.query('BEGIN');
      const lane = await lockLane(client, key);
      if (lane === null || lane.epoch !== epoch || lane.reservation !== res.reservation || stopped) {
        await client.query('ROLLBACK');
        return 'lost';
      }
      const row = await lockBet(client, res.bet.hash);
      if (row === null) throw new Error('the held bet has no row');
      const incidents: Incident[] = outcome.incidents;
      if (row.ended === 'stopped') {
        // A stop came while the bet was held: STOPPED, whatever the check found, and no intent.
        await line(client, res.bet, 'bet refused', 'STOPPED', { code: 'STOPPED', error: VERDICT.STOPPED, block: null, found: outcome.kind === 'ready' ? 'ready' : outcome.verdict.code });
        await setBetState(client, res.bet.hash, 'refused');
      } else if (row.ended !== null) {
        throw new Error(`a held bet ended ${row.ended}: only a stop ends a bet in this build`);
      } else if (outcome.kind === 'ready') {
        const c = outcome.cross;
        await writeNotSent(client, {
          betHash: res.bet.hash,
          lane: key,
          epoch: epoch as bigint,
          reservation: res.reservation,
          block: { number: c.block.number, hash: c.block.hash, time: c.block.timestamp },
          checked: { ...c.checked, pulls: c.pulls, paysBack: c.paysBack, gas: { estimate: c.gas.estimate.toString(), limit: c.gas.limit.toString(), ...((c.checked.gas as object) ?? {}) }, takerRisk: c.takerRisk.toString() },
          legs: c.legs.map((l) => ({ orderHash: l.orderHash, makerRisk: l.makerRisk, takerRisk: l.takerRisk })),
        });
        await setBetState(client, res.bet.hash, 'sent');
        await line(client, res.bet, 'cross not sent', 'SENDER_NOT_BUILT', { message: VERDICT.NOT_SENT(c.block.number.toString()), block: named(c.block), legs: c.legs.length, takerRisk: c.takerRisk.toString() });
      } else {
        const v = outcome.verdict;
        await line(client, res.bet, outcome.kind === 'lapsed' ? 'bet lapsed' : 'bet refused', v.code, { code: v.code, error: v.error, block: v.block, ...(v.lastObservedBlock === undefined ? {} : { lastObservedBlock: v.lastObservedBlock }), ...v.fields });
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

  async function loop(): Promise<void> {
    try {
      for (;;) {
        if (stopped) break;
        flag = false;
        const r = await reserveOne();
        if (r === 'stop') break;
        if (r === null) {
          await hooks.at('after-empty-reservation', null);
          // Read after the reservation that found nothing: a wake that came meanwhile is not lost.
          if (!flag) break;
          continue;
        }
        await hooks.at('after-reservation', r.bet.hash);
        const outcome = await checked(r.bet);
        await hooks.at('before-result', r.bet.hash);
        if ((await writeOutcome(r, outcome)) === 'lost') {
          deps.log('lane: the outcome of a bet was not written: this process no longer holds its lane or its reservation');
          break;
        }
      }
    } catch (err) {
      failStop(err, 'a lane step');
    } finally {
      running = false;
    }
  }

  return {
    key,
    epoch: () => epoch,
    takingBets: () => epoch !== null && !stopped,
    running: () => running,
    async take(runFacts) {
      const { client, done } = await laneClient(store.lane);
      try {
        await client.query('BEGIN');
        const taken = await take(client, key, run.id);
        await store.events.write(
          { run: run.id, kind: 'run started', facts: { ...runFacts, key, epoch: taken.epoch.toString(), lanes: taken.lanes, heldReturnedToWaiting: taken.returned.length, heldFinishedStopped: taken.stopped.length } },
          client,
        );
        for (const s of taken.stopped) {
          await store.events.write(
            { run: run.id, kind: 'bet refused', orderHash: s.hash, betHash: s.hash, account: s.account, gameId: BigInt(s.gameId), reason: 'STOPPED', facts: { code: 'STOPPED', error: VERDICT.STOPPED, block: null, run: run.id, byTheTake: true } },
            client,
          );
        }
        await client.query('COMMIT');
        epoch = taken.epoch;
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
      return e !== null && epoch !== null && e === epoch && !stopped;
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
