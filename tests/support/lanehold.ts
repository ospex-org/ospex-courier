import assert from 'node:assert/strict';
import type pg from 'pg';
import type { Held, HookControl } from './courier';
import { orderOn, postOrder } from './orders';
import type { Stack } from './stack';

// Set-up for a case written before bets were checked, whose bets must wait their turn as they did then. The lane is
// held by a bet of an account of its own, never by one of the case's: the stack's courier is started again through
// the tests' start file, and so takes the lane; a set-up bet is posted, and its check is held just after its
// reservation has committed. The lane holds that bet, so every bet the case posts waits. The case's own bets, the
// door and its checks are untouched; nothing is switched off.
//
// At the case's end the hold is let go, the lane's work is seen settled (no bet held, none waiting), and the stack's
// courier is started again through the production start file. The stack's close stops whichever process holds
// `stack.courier` then, so the process started here is the teardown's.

/** An account no case of the suite uses: the set-up bet's. */
const SETUP_ACCOUNT = 4_000;

/** A market of its own for each set-up bet, so its check, once let go, meets no quote of any case. */
let nextLine = 0;

/** The set-up accounts funded and registered, by chain. */
const funded = new Set<string>();

export interface LaneHold {
  /** The set-up bet's hash. */
  bet: string;
  /** Lets the hold go, waits for the lane's work to settle, and starts the stack's courier again as production does. */
  release(): Promise<void>;
}

export async function holdTheLane(stack: Stack, pool: pg.Pool): Promise<LaneHold> {
  const rig = stack.rig;
  const setup = rig.account(SETUP_ACCOUNT);
  const key = `${rig.url} ${setup.address}`;
  if (!funded.has(key)) {
    await rig.fund(setup);
    funded.add(key);
  }
  const courier = await stack.restartCourier({ hooked: true });
  const hooks = courier.hooks as HookControl;
  let held: Held | null = null;
  try {
    await hooks.arm('after-reservation');
    const T = await rig.time();
    const order = orderOn(rig, setup, { expiry: T + 30n, riskAmount: 10_000n, positionType: 1, scorer: rig.addresses.spread, lineTicks: -(900_000 + 5 * nextLine++) });
    const posted = await postOrder(courier.url, rig, setup, 'take', order);
    assert.equal(posted.status, 202, `the set-up bet that holds the lane: ${JSON.stringify(posted.body)}`);
    const bet = String(posted.body.orderHash).toLowerCase();
    held = await hooks.reached('after-reservation');
    assert.equal(held.bet, bet, 'the lane holds the set-up bet');
    const { rows } = await pool.query<{ held_bet: string | null }>('SELECT held_bet FROM lanes');
    assert.deepEqual(rows.map((r) => r.held_bet), [bet], 'the lane row names the set-up bet, its reservation committed');
    const hold = held;
    return {
      bet,
      async release() {
        await hooks.go(hold);
        await settled(pool);
        await stack.restartCourier();
      },
    };
  } catch (err) {
    // The hold not made: nothing is left held or armed for the cases that follow.
    await hooks.disarm('after-reservation').catch(() => undefined);
    if (held !== null) await hooks.go(held).catch(() => undefined);
    await settled(pool).catch(() => undefined);
    await stack.restartCourier();
    throw err;
  }
}

/** The lane's work settled: no bet held, and none waiting its turn. */
async function settled(pool: pg.Pool): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const { rows } = await pool.query<{ held: number; waiting: number }>(
      `SELECT (SELECT count(*)::int FROM lanes WHERE held_bet IS NOT NULL) AS held,
              (SELECT count(*)::int FROM orders WHERE role = 'take' AND bet_state = 'waiting' AND ended IS NULL) AS waiting`,
    );
    if (rows[0]?.held === 0 && rows[0]?.waiting === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('the lane did not settle within 30 seconds of its hold being let go');
}
