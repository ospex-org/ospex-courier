import assert from 'node:assert/strict';
import { keccak256, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import type pg from 'pg';
import { get as getFrom, type HookControl } from './courier';
import { nodeText } from './named';
import { orderOn, postOrder as postOrderFrom, type Order } from './orders';
import type { Stack } from './stack';

// Send once across the lives of the process, where the node's answer to the one hand-off is a named error: the node
// refuses before the chain has the request, or passes it on and answers with the error. The steps the two files share
// (tests/sendonce-named.test.ts and tests/sendonce-named-two.test.ts). Signatures are counted at the signer in test
// memory across every process's life; requests at the proxy, which outlives the courier. The final block is held at
// the head while a process dies, so no life can settle the Cross before the next one starts.

export type History = 'refused' | 'accepted';
export const WORDS = 'nonce too low';
/** The Cross each history ends at: never on the chain, expired unmined; on it, confirmed from its own receipt. */
export const ENDS: Record<History, string> = { refused: 'expired unmined', accepted: 'confirmed' };
/** A bet's life in each history: the refused one ends at its expiry, so it is short. */
const LIFE: Record<History, bigint> = { refused: 14n, accepted: 30n };
export const WHERE: Record<History, string> = { refused: 'before the chain had the request', accepted: 'after the chain took the request' };

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];
const BEFORE_ANSWER = ['intent', 'signed', 'handing off'];

interface Row {
  state: string;
  hand_offs: number;
  tx_hash: string | null;
  nonce: string | null;
  node_answer: unknown;
}

type Bet = { M: HDAccount; B: HDAccount; quote: Order; betHash: string; quoteHash: string };

export function namedLives(stack: Stack, pool: pg.Pool) {
  const url = () => stack.courier.url;
  let nextAddress = 0;
  const from = () => {
    const n = nextAddress++;
    return { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
  };
  /** Signatures of processes that have ended: their counts, kept when each was killed. */
  let pastSigned = 0;
  const signed = () => pastSigned + (stack.courier.hooks?.signed.length ?? 0);
  const hooks = () => stack.courier.hooks as HookControl;
  /** One bet's requests: those at the proxy, across every life, that carried its transaction's own bytes. */
  const requestsOf = (txHash: string | null | undefined): number =>
    txHash === null || txHash === undefined ? 0 : stack.proxy.counted.filter((r) => r.sent !== undefined && keccak256(r.sent as Hex).toLowerCase() === txHash.toLowerCase()).length;
  const requests = () => stack.proxy.count('eth_sendRawTransaction');
  let nextAccount = 40;

  async function fresh(): Promise<HDAccount> {
    const who = stack.rig.account(nextAccount++);
    await stack.rig.fund(who);
    return who;
  }

  /** The lane of the courier's key, as its row stands: the bet it holds, its reservation and its open Cross. */
  async function laneRow(): Promise<{ held_bet: string | null; reservation: string | null; open_cross: string | null }> {
    const { rows } = await pool.query<{ held_bet: string | null; reservation: string | null; open_cross: string | null }>(
      'SELECT held_bet, reservation::text AS reservation, open_cross FROM lanes WHERE sender = $1',
      [stack.rig.accounts.sender.address.toLowerCase()],
    );
    return rows[0] ?? { held_bet: null, reservation: null, open_cross: null };
  }

  /**
   * The lane's committed history, watched in the test's own database: a trigger on the lane's row writes each change
   * of it, with what the row held before and the state of the Cross it had open, to a table of the test's, in the
   * change's own transaction. A change that aborts writes nothing there, so only reservations that committed are read,
   * and never the sequence: an attempt that aborted took a number and is not a reservation. The lane's row is changed
   * under its lock, so the history's order is the order its changes committed in. No line of the courier's code changes
   * for it. Made once in the file's database; each history reads the rows after its own start.
   */
  let watching: Promise<void> | null = null;
  function watchLane(): Promise<void> {
    watching ??= (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS test_lane_watch (
        n bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(), sender text NOT NULL, epoch bigint,
        held_bet text, reservation bigint, open_cross text, was_held text, was_reservation bigint, was_open_cross text, was_open_state text)`);
      await pool.query(`CREATE OR REPLACE FUNCTION test_lane_watch() RETURNS trigger LANGUAGE plpgsql AS $w$
        BEGIN
          INSERT INTO test_lane_watch (sender, epoch, held_bet, reservation, open_cross, was_held, was_reservation, was_open_cross, was_open_state)
          VALUES (NEW.sender, NEW.epoch, NEW.held_bet, NEW.reservation, NEW.open_cross,
                  CASE WHEN TG_OP = 'UPDATE' THEN OLD.held_bet END, CASE WHEN TG_OP = 'UPDATE' THEN OLD.reservation END,
                  CASE WHEN TG_OP = 'UPDATE' THEN OLD.open_cross END,
                  CASE WHEN TG_OP = 'UPDATE' THEN (SELECT c.state FROM crosses c WHERE c.bet_hash = OLD.open_cross) END);
          RETURN NEW;
        END $w$`);
      await pool.query('DROP TRIGGER IF EXISTS test_lane_watch ON lanes');
      await pool.query('CREATE TRIGGER test_lane_watch AFTER INSERT OR UPDATE ON lanes FOR EACH ROW EXECUTE FUNCTION test_lane_watch()');
    })();
    return watching;
  }

  interface Watched {
    n: string;
    held_bet: string | null;
    reservation: string | null;
    open_cross: string | null;
    was_open_cross: string | null;
    was_open_state: string | null;
  }

  /** Where the lane's watched history stands now: a history reads the rows after it. */
  async function watchMark(): Promise<bigint> {
    await watchLane();
    const { rows } = await pool.query<{ last: string | null }>('SELECT max(n)::text AS last FROM test_lane_watch');
    return BigInt(rows[0]?.last ?? '0');
  }

  /** The lane's committed changes after `from`, in the order they committed. */
  async function watched(from: bigint): Promise<Watched[]> {
    const { rows } = await pool.query<Watched>(
      'SELECT n, held_bet, reservation, open_cross, was_open_cross, was_open_state FROM test_lane_watch WHERE n > $1 AND sender = $2 ORDER BY n',
      [from.toString(), stack.rig.accounts.sender.address.toLowerCase()],
    );
    return rows.map((r) => ({ ...r, n: String(r.n), reservation: r.reservation === null ? null : String(r.reservation) }));
  }

  /** The first bet's reservation, read from the committed change that made the lane hold it. */
  async function firstReservation(from: bigint, first: string): Promise<string> {
    const took = (await watched(from)).find((w) => w.held_bet === first);
    assert.ok(took !== undefined && took.reservation !== null, `the lane's committed change that took the first bet: ${JSON.stringify(await watched(from))}`);
    return took.reservation as string;
  }

  /**
   * The whole interval, in both lives, from the lane's committed history: while the lane holds the first bet, its
   * reservation is the first's own; and after it, no reservation commits, for any bet, before the first Cross's outcome
   * does. The change that ends the first bet's hold is the one that frees the lane, in the transaction that wrote its
   * Cross's outcome; only then is the second bet reserved.
   */
  async function wholeInterval(from: bigint, first: string, second: string, reservation: string): Promise<void> {
    const history = await watched(from);
    const shown = JSON.stringify(history);
    const i0 = history.findIndex((w) => w.held_bet === first);
    assert.ok(i0 >= 0, `the lane took the first bet: ${shown}`);
    for (const w of history) if (w.held_bet === first) assert.equal(w.reservation, reservation, `the lane holds the first bet under its own reservation at every committed change, in both lives: ${shown}`);
    const i1 = history.findIndex((w, i) => i > i0 && w.held_bet !== first);
    assert.ok(i1 > i0, `the first bet's hold ends: ${shown}`);
    const freed = history[i1] as Watched;
    assert.deepEqual(
      [freed.held_bet, freed.reservation, freed.open_cross, freed.was_open_cross],
      [null, null, null, first],
      `no reservation committed before the first Cross's outcome: the change after the first bet's hold frees the lane: ${shown}`,
    );
    assert.ok(freed.was_open_state !== null && FINAL.includes(freed.was_open_state), `and frees it in the transaction of the first Cross's outcome: ${shown}`);
    const i2 = history.findIndex((w) => w.held_bet === second);
    assert.ok(i2 > i1, `the second bet is reserved only after: ${shown}`);
  }

  async function crossRow(bet: string): Promise<Row | null> {
    const { rows } = await pool.query<Row>('SELECT state, hand_offs, tx_hash, nonce::text AS nonce, node_answer FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()]);
    return rows[0] ?? null;
  }

  async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (done(v)) return v;
      if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-10).join(' | ')}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const final = (bet: string, ms = 90_000) => until(() => crossRow(bet), (r) => r !== null && FINAL.includes(r.state), ms, `the Cross of ${bet}`);

  /** Where the door refused a post: the status and the courier's last lines. */
  const whyRefused = async (): Promise<string> => `${JSON.stringify((await getFrom(url(), '/v1/status').catch(() => null))?.body ?? null)}; ${stack.courier.lines.slice(-6).join(' | ')}`;

  /** A quote of 9,600 that one bet fills whole, and a bet of 10,000 against it, to expire in `life` seconds. */
  async function quoteAndBet(life = 30n): Promise<Bet> {
    const M = await fresh();
    const B = await fresh();
    const T = await stack.rig.time();
    const quote: Order = { ...orderOn(stack.rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 9_600n }), positionType: 0 };
    const posted = await postOrderFrom(url(), stack.rig, M, 'rest', quote, from());
    if (posted.status !== 201) assert.fail(`${JSON.stringify(posted.body)}; ${await whyRefused()}`);
    const bet: Order = { ...orderOn(stack.rig, B, { expiry: T + life, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 };
    const taken = await postOrderFrom(url(), stack.rig, B, 'take', bet, from());
    if (taken.status !== 202) assert.fail(`${JSON.stringify(taken.body)}; ${await whyRefused()}`);
    return { M, B, quote, betHash: (taken.body.orderHash as string).toLowerCase(), quoteHash: posted.body.orderHash as string };
  }

  async function keyCount(): Promise<bigint> {
    return BigInt((await stack.rig.rpc('eth_getTransactionCount', [stack.rig.accounts.sender.address, 'latest'])) as string);
  }

  /** The process killed by the operating system, with no chance to clean up, then a new one started through the tests' start file. */
  async function killAndRestart(): Promise<void> {
    pastSigned += stack.courier.hooks?.signed.length ?? 0;
    stack.courier.process.kill('SIGKILL');
    await stack.courier.exited;
    await stack.restartCourier({ hooked: true });
  }

  /** No transaction of the key the records do not hold: every nonce the key used is a Cross the chain ran. */
  async function noForeignTransactions(): Promise<void> {
    const ran = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM crosses WHERE state IN ('confirmed', 'reverted')`);
    assert.equal(await keyCount(), BigInt((ran.rows[0] as { n: string }).n), "the key's transactions on the chain are the Crosses the records hold as run");
  }

  async function holdFinal(): Promise<void> {
    const head = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
    stack.proxy.finalFollows(null);
    stack.proxy.setFinal(head);
  }

  function followFinal(): void {
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
  }

  /**
   * The node's named error for the next hand-off: refused before the chain has the request, or passed on to the chain
   * and answered with the error in place of the chain's answer. Lifted by the returned function.
   */
  function named(history: History): () => void {
    if (history === 'refused') {
      stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuse', code: -32000, message: nodeText(WORDS) });
      return () => stack.proxy.rule('eth_sendRawTransaction', null);
    }
    const rule = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText(WORDS) });
    return () => rule.stop();
  }

  /**
   * After the restart, the bet that waited is reserved only once the first is settled, and both are sent once: the
   * first's Cross the same, at the same nonce, as before the process died.
   */
  async function afterTheRestart(first: string, second: string, held: Row, history: History, s0: number, handOffLines: 0 | 1, from: bigint, reservation: string): Promise<void> {
    // F held a while longer: the new life settles nothing and reserves nothing while the outcome cannot be proved.
    await new Promise((r) => setTimeout(r, 4_000));
    const waiting = await crossRow(first);
    assert.ok(waiting !== null && !FINAL.includes(waiting.state), `no outcome while the final block is held: ${JSON.stringify(waiting)}`);
    assert.equal(await crossRow(second), null, 'nothing reserved before the outcome');
    const lane = await laneRow();
    assert.deepEqual([lane.held_bet, lane.open_cross], [first, first], `the lane still holds the first bet and its Cross, and no other is reserved: ${JSON.stringify(lane)}`);
    assert.equal(lane.reservation, reservation, `in the new life, the lane holds the first bet under its own reservation: ${JSON.stringify(lane)}`);
    followFinal();
    const row = await final(first);
    const row2 = await final(second);
    assert.equal(row?.state, ENDS[history], JSON.stringify(row));
    assert.deepEqual([row?.tx_hash, row?.nonce, row?.hand_offs], [held.tx_hash, held.nonce, 1], 'the same Cross, nonce and hand-off');
    assert.deepEqual({ first: requestsOf(row?.tx_hash), second: requestsOf(row2?.tx_hash) }, { first: 1, second: 1 }, 'one request for each bet: the first never sent again');
    assert.equal(signed() - s0, 2, 'one signature for each bet, across both lives');
    // The reservation's identity and the whole interval, from the reservations that committed, in both lives.
    await wholeInterval(from, first, second, reservation);
    assert.equal(row2?.state, 'confirmed', JSON.stringify(row2));
    // The hand-off's line, written once where the answer was recorded before the process died, and never again: the
    // new life's looks and its outcome add none. Nothing names the reserved reason.
    const lines = await pool.query<{ kind: string; reason: string | null }>(
      `SELECT kind, reason FROM events WHERE bet_hash = $1 AND kind IN ('cross sent', 'cross unknown', 'cross not sent') ORDER BY number`,
      [first],
    );
    assert.deepEqual(lines.rows, handOffLines === 1 ? [{ kind: 'cross unknown', reason: 'ANSWER_UNKNOWN' }] : [], 'the hand-off line, once at most');
    const reserved = await pool.query(`SELECT 1 FROM crosses WHERE not_sent_reason = 'NODE_REFUSED' UNION ALL SELECT 1 FROM events WHERE reason = 'NODE_REFUSED'`);
    assert.equal(reserved.rowCount, 0, 'NODE_REFUSED produced by nothing');
    await noForeignTransactions();
  }

  return {
    /** The answer recorded, then a restart with F held. */
    async recordedThenRestart(history: History): Promise<void> {
      const from = await watchMark();
      const s0 = signed();
      await holdFinal();
      const lift = named(history);
      let c: Bet;
      let held: Row;
      try {
        c = await quoteAndBet(LIFE[history]);
        held = (await until(() => crossRow(c.betHash), (r) => r !== null && !BEFORE_ANSWER.includes(r.state), 30_000, 'the answer recorded')) as Row;
      } finally {
        lift();
      }
      assert.ok(['unknown', 'pending'].includes(held.state), JSON.stringify(held));
      assert.deepEqual(held.node_answer, { kind: 'unknown', words: WORDS }, 'not known, with the fixed words alone');
      const reservation = await firstReservation(from, c.betHash);
      // A second bet waits behind it, and is reserved only after the first is settled.
      const second = await quoteAndBet();
      assert.equal((await laneRow()).reservation, reservation, 'in the old life, the lane holds the first bet under its own reservation');
      await killAndRestart();
      await afterTheRestart(c.betHash, second.betHash, held, history, s0, 1, from, reservation);
    },

    /** Killed after the hand-off was answered and before the answer's record, with F held. */
    async killedBeforeRecord(history: History): Promise<void> {
      const from = await watchMark();
      const s0 = signed();
      await holdFinal();
      const lift = named(history);
      await hooks().arm('after-hand-off', 1);
      let c: Bet;
      try {
        c = await quoteAndBet(LIFE[history]);
        await hooks().reached('after-hand-off');
      } finally {
        lift();
      }
      const held = (await crossRow(c.betHash)) as Row;
      assert.deepEqual([held.state, held.hand_offs, held.node_answer], ['handing off', 1, null], 'handed once, its answer not recorded');
      const reservation = await firstReservation(from, c.betHash);
      const second = await quoteAndBet();
      assert.equal((await laneRow()).reservation, reservation, 'in the old life, the lane holds the first bet under its own reservation');
      await killAndRestart();
      await afterTheRestart(c.betHash, second.betHash, held, history, s0, 0, from, reservation);
    },

    /** Killed at once after the answer was committed, with F held. */
    async killedAfterCommit(history: History): Promise<void> {
      const from = await watchMark();
      const s0 = signed();
      await holdFinal();
      const lift = named(history);
      let c: Bet;
      let held: Row;
      try {
        c = await quoteAndBet(LIFE[history]);
        held = (await until(() => crossRow(c.betHash), (r) => r !== null && !BEFORE_ANSWER.includes(r.state), 30_000, 'the answer committed')) as Row;
      } finally {
        lift();
      }
      assert.deepEqual(held.node_answer, { kind: 'unknown', words: WORDS });
      const reservation = await firstReservation(from, c.betHash);
      const second = await quoteAndBet();
      assert.equal((await laneRow()).reservation, reservation, 'in the old life, the lane holds the first bet under its own reservation');
      // Killed at once, with the answer committed and nothing yet settled.
      await killAndRestart();
      await afterTheRestart(c.betHash, second.betHash, held, history, s0, 1, from, reservation);
    },

    /** The answer's record: its commit acknowledged to nobody, committed; or cut before its commit, not committed. */
    async answerCut(committed: boolean, history: History): Promise<void> {
      const from = await watchMark();
      const s0 = signed();
      await holdFinal();
      const lift = named(history);
      // The answer's statement inside its transaction: its commit's acknowledgement dropped, or the statement's own.
      const cut = committed ? stack.dbRelay.dropCommitAfter('node_answer = $3') : stack.dbRelay.dropAnswerAfter('node_answer = $3');
      await hooks().arm('after-gate', 1);
      let c: Bet;
      let second: Bet;
      try {
        c = await quoteAndBet(LIFE[history]);
        const gate = await hooks().reached('after-gate');
        // A second bet waits behind it, posted while the first is held at its gate.
        second = await quoteAndBet();
        await hooks().go(gate);
        await cut;
      } finally {
        lift();
      }
      const held = (await until(() => crossRow(c.betHash), (r) => r !== null && r.hand_offs === 1, 10_000, 'handed once')) as Row;
      if (committed) assert.deepEqual([held.state, held.node_answer], ['unknown', { kind: 'unknown', words: WORDS }], 'the record committed');
      else assert.deepEqual([held.state, held.node_answer], ['handing off', null], 'the record not committed');
      const reservation = await firstReservation(from, c.betHash);
      // The process that lost its answer's record sends nothing more: the bet that waits is not reserved, signed or handed off.
      const r0 = requests();
      const s1 = signed();
      await new Promise((r) => setTimeout(r, 4_000));
      assert.deepEqual({ signed: signed() - s1, requests: requests() - r0, second: await crossRow(second.betHash) }, { signed: 0, requests: 0, second: null }, 'no new sending right');
      const lane = await laneRow();
      assert.deepEqual([lane.held_bet, lane.open_cross], [c.betHash, c.betHash], `the lane still holds the first bet and its Cross, and the bet that waits is not reserved: ${JSON.stringify(lane)}`);
      assert.equal(lane.reservation, reservation, `in the old life, the lane holds the first bet under its own reservation: ${JSON.stringify(lane)}`);
      await killAndRestart();
      await afterTheRestart(c.betHash, second.betHash, held, history, s0, committed ? 1 : 0, from, reservation);
    },
  };
}
