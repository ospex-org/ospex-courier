import assert from 'node:assert/strict';
import type pg from 'pg';
import { encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import type { NamedError } from '../../courier/chain/rpc';
import { SENTENCE } from '../../courier/orders/wire';
import { get as getFrom, type HookControl } from './courier';
import { orderOn, postOrder as postOrderFrom, sign, type Order } from './orders';
import type { Stack } from './stack';

// A node's named error after the one hand-off, from every side, on a sending stack: the steps the witness files share
// (tests/named-*.test.ts). The error is the node's text holding one of the list's matches among text of its own, so
// that what comes out can be held to the list's fixed words alone. Two histories: the node refuses the request before
// it reaches the chain; and the node passes the request on, the chain takes it, and the courier is answered with the
// named error in place of the chain's answer. Each bet is in a market of its own, and is told from every other by its
// own signature's bytes, which its transaction carries.

/** Text of the node's own around the error, none of which may leave the courier: on the record, the row or the line. */
export const PLANTED = ['planted marker', 'node.example.test', '0xdeadbeef', '2.00 ether'] as const;

/** The node's text for a named error: the list's match, in a letter case of its own, with the planted text around it. */
export function nodeText(words: NamedError): string {
  const match = words === "the transaction's fee exceeds the node's configured cap" ? 'tx fee (2.00 ether) EXCEEDS THE CONFIGURED CAP (1.00 ether)' : words.toUpperCase();
  return `Planted Marker: ${match} at https://node.example.test/x 0xdeadbeef`;
}

const BEFORE_ANSWER = ['intent', 'signed', 'handing off'];
const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];

export interface CrossSeen {
  state: string;
  not_sent_reason: string | null;
  outcome_at: Date | null;
  node_answer: Record<string, unknown> | null;
  hand_offs: number;
  tx_hash: Hex | null;
  nonce: string | null;
  reservation: string;
  recorded: Record<string, unknown> | null;
  replaced_by: string | null;
  replaced_by_ours: boolean | null;
  revert_reason: string | null;
}

export interface LaneSeen {
  sender: string;
  reservation: string | null;
  held_bet: string | null;
  open_cross: string | null;
  shut_line: string | null;
}

/** A market of its own: a spread line of the rig's game that no other case uses. */
export interface Market {
  scorer: Hex;
  lineTicks: number;
}

/** A bet as the test made it: its hash, its order, its signature and its expiry. */
export interface Bet {
  hash: string;
  order: Order;
  signature: Hex;
  expiry: bigint;
}

/** A selector of the hand-off of one bet: the raw transaction that carries its signature's bytes. */
export const carries = (signature: Hex) => (params: unknown[]) => typeof params[0] === 'string' && params[0].toLowerCase().includes(signature.slice(2).toLowerCase());

export function namedWitnesses(stack: Stack, pool: pg.Pool, opts: { firstAccount: number; firstLine: number }) {
  const rig = stack.rig;
  const url = () => stack.courier.url;
  let nextAddress = 0;
  const from = () => {
    const n = nextAddress++;
    return { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
  };
  let nextAccount = opts.firstAccount;
  let nextLine = 0;
  const hooks = () => stack.courier.hooks as HookControl;
  /**
   * The final block the rig holds at a height keeps its hash (tests/support/proxy.ts): at every block the proxy answers
   * at that height, and at the release. A change seen and not yet said fails the case where the rig holds, moves or
   * lets go of the block, saying what changed; one seen later fails it at its end (tests/support/journal.ts).
   */
  const heldUnchanged = (): void => {
    const changes = stack.proxy.heldFinalChanged();
    if (changes.length > 0) assert.fail(`the final block the rig held changed: ${changes.join('; ')}`);
  };
  /** The file's accounts, funded once: the maker, the bettor whose bet meets the named error, one who waits, and one who comes next. */
  let people: { maker: HDAccount; bettor: HDAccount; waiter: HDAccount; next: HDAccount } | null = null;
  const who = () => {
    if (people === null) throw new Error('prepare() first');
    return people;
  };

  const w = {
    async fresh(): Promise<HDAccount> {
      const account = rig.account(nextAccount++);
      await rig.fund(account);
      return account;
    },

    /** The file's accounts, funded once, before its cases. */
    async prepare(): Promise<void> {
      people = { maker: await w.fresh(), bettor: await w.fresh(), waiter: await w.fresh(), next: await w.fresh() };
    },

    people: who,

    market(): Market {
      return { scorer: rig.addresses.spread as Hex, lineTicks: -(opts.firstLine + 5 * nextLine++) };
    },

    async until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
      const end = Date.now() + ms;
      for (;;) {
        // A held final block whose hash changed fails the case while it waits.
        heldUnchanged();
        const v = await read();
        if (done(v)) return v;
        if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },

    /** One live quote of 9,600 at tick 204, in the market, by the file's maker, posted through the door. */
    async quoteIn(market: Market): Promise<string> {
      const T = await rig.time();
      const q: Order = { ...orderOn(rig, who().maker, { expiry: T + 3_600n, oddsTick: 204, riskAmount: 9_600n, minFill: 0n, ...market }), positionType: 0 };
      const posted = await postOrderFrom(url(), rig, who().maker, 'rest', q, from());
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      return (posted.body.orderHash as string).toLowerCase();
    },

    /** A bet of 10,000 at tick 196 in the market, to expire 30 seconds after the latest block: made and signed, not yet posted. */
    async betOf(B: HDAccount, market: Market): Promise<{ order: Order; signature: Hex }> {
      const T = await rig.time();
      const order: Order = { ...orderOn(rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 };
      return { order, signature: await sign(B, order, 31337, rig.addresses.matching) };
    },

    /** The bet posted through the door. Its signature is the one signed for it beforehand: the same bytes. */
    async post(B: HDAccount, made: { order: Order; signature: Hex }): Promise<Bet> {
      const taken = await postOrderFrom(url(), rig, B, 'take', made.order, from());
      assert.equal(taken.status, 202, JSON.stringify(taken.body));
      assert.equal(taken.signature.toLowerCase(), made.signature.toLowerCase(), 'the bytes the rule picks');
      return { hash: (taken.body.orderHash as string).toLowerCase(), order: made.order, signature: made.signature, expiry: made.order.expiry };
    },

    async cross(bet: string): Promise<CrossSeen | null> {
      const { rows } = await pool.query<CrossSeen>(
        `SELECT state, not_sent_reason, outcome_at, node_answer, hand_offs, tx_hash, nonce::text AS nonce, reservation::text AS reservation, recorded, replaced_by, replaced_by_ours, revert_reason
         FROM crosses WHERE bet_hash = $1`,
        [bet.toLowerCase()],
      );
      return rows[0] ?? null;
    },

    async lane(): Promise<LaneSeen> {
      const { rows } = await pool.query<LaneSeen>(
        `SELECT sender, reservation::text AS reservation, held_bet, open_cross, shut_line::text AS shut_line FROM lanes WHERE sender = $1`,
        [rig.accounts.sender.address.toLowerCase()],
      );
      return rows[0] as LaneSeen;
    },

    async lines(bet: string): Promise<Array<{ kind: string; reason: string | null; facts: Record<string, unknown> }>> {
      const { rows } = await pool.query<{ kind: string; reason: string | null; facts: Record<string, unknown> }>(`SELECT kind, reason, facts FROM events WHERE bet_hash = $1 ORDER BY number`, [bet.toLowerCase()]);
      return rows;
    },

    async openConditions(): Promise<string[]> {
      const { rows } = await pool.query<{ key: string }>(`SELECT key FROM conditions WHERE cleared_at IS NULL ORDER BY id`);
      return rows.map((r) => r.key);
    },

    async record(bet: string): Promise<Record<string, unknown>> {
      const got = await getFrom(url(), `/v1/orders/${bet}`, from());
      assert.equal(got.status, 200, JSON.stringify(got.body));
      return got.body;
    },

    /** The Cross once the node's answer is written: the wait ends at any state past the hand-off, so a wrong one fails at once. */
    answered: (bet: string) => w.until(() => w.cross(bet), (c) => c !== null && !BEFORE_ANSWER.includes(c.state), 60_000, `the answer to ${bet}`) as Promise<CrossSeen>,

    final: (bet: string, ms = 90_000) => w.until(() => w.cross(bet), (c) => c !== null && FINAL.includes(c.state), ms, `the end of ${bet}`) as Promise<CrossSeen>,

    /** A bet at its end: lapsed or refused at its turn, with no Cross, or its Cross final. */
    betDone: (bet: string, ms = 120_000) =>
      w.until(
        async () => {
          const { rows } = await pool.query<{ bet_state: string | null }>('SELECT bet_state FROM orders WHERE hash = $1', [bet.toLowerCase()]);
          return { bet: rows[0]?.bet_state ?? null, cross: (await w.cross(bet))?.state ?? null };
        },
        (v) => v.bet === 'lapsed' || v.bet === 'refused' || (v.cross !== null && FINAL.includes(v.cross)),
        ms,
        `the end of ${bet}`,
      ),

    /** The signatures the courier made that carry this bet's signature: one bet's own. */
    signedCarrying: (signature: Hex): number => (hooks().signed ?? []).filter((raw) => raw.toLowerCase().includes(signature.slice(2).toLowerCase())).length,

    /** The requests at the proxy that carried this transaction's own bytes. */
    requestsOf: (txHash: string): number => stack.proxy.counted.filter((r) => r.sent !== undefined && keccak256(r.sent as Hex).toLowerCase() === txHash.toLowerCase()).length,

    chainHas: async (txHash: string): Promise<boolean> => (await rig.rpc('eth_getTransactionByHash', [txHash])) !== null,

    balance: (account: string) => rig.read<bigint>(rig.addresses.coin, rig.abis.TestCoin as Abi, 'balanceOf', [account]),

    /** The final block held at the head, before the bet comes: it stays there until it is let go or moved. */
    async holdFinal(): Promise<void> {
      await stack.proxy.heldFinalChecked();
      heldUnchanged();
      const head = BigInt((await rig.rpc('eth_blockNumber', [])) as string);
      stack.proxy.finalFollows(null);
      stack.proxy.setFinal(head);
      // Its hash kept before the bet comes.
      await stack.proxy.heldFinalChecked();
    },

    /** The hold let go: the final block follows the head again. A held block whose hash changed fails the case here. */
    followFinal(): void {
      stack.proxy.setFinal(null);
      stack.proxy.finalFollows(1n);
      heldUnchanged();
    },

    /** A block mined at exactly `time`, and the final block held there: the bet's expiry, to the second. */
    async finalAt(time: bigint): Promise<bigint> {
      await stack.proxy.heldFinalChecked();
      heldUnchanged();
      await rig.setNextBlockTime(time);
      await rig.rpc('anvil_mine', ['0x1']);
      // A block of the chain's own clock may have come first and taken the time: the one at exactly `time` is held.
      let n = BigInt((await rig.rpc('eth_blockNumber', [])) as string);
      for (let k = 0; k < 4; k++, n--) {
        const b = (await rig.rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false])) as { timestamp: Hex };
        if (BigInt(b.timestamp) === time) {
          stack.proxy.finalFollows(null);
          stack.proxy.setFinal(n);
          await stack.proxy.heldFinalChecked();
          heldUnchanged();
          return n;
        }
      }
      throw new Error(`no block at exactly ${time}`);
    },

    /**
     * The Cross as the named error leaves it, read every way: unknown, the reason absent, the error's fixed words on the
     * answer and on the line and nothing of the node's own text, no outcome's time, the lane holding the bet, its
     * reservation and its open Cross, one signature and one request of its bytes, and the bettor told the unknown
     * sentence whole.
     */
    async heldUnknown(bet: Bet, words: NamedError): Promise<CrossSeen> {
      const c = await w.answered(bet.hash);
      assert.equal(c.state, 'unknown', `the answer is not known: ${JSON.stringify(c)}`);
      assert.equal(c.not_sent_reason, null, 'no not-sent reason');
      assert.equal(c.outcome_at, null, "no outcome's time");
      assert.equal(c.hand_offs, 1, 'one hand-off');
      assert.deepEqual(c.node_answer, { kind: 'unknown', words }, 'the answer: not known, with the fixed words alone');
      assert.ok(c.tx_hash !== null && c.nonce !== null, 'the transaction and its nonce kept');
      const lane = await w.lane();
      assert.deepEqual([lane.held_bet, lane.open_cross, lane.reservation], [bet.hash, bet.hash, c.reservation], 'the lane holds the bet, its reservation and its open Cross');
      assert.equal(lane.shut_line, null, 'the lane is not shut');
      const lines = await w.lines(bet.hash);
      const handed = lines.filter((l) => l.kind === 'cross unknown' || l.kind === 'cross sent' || l.kind === 'cross not sent');
      assert.equal(handed.length, 1, `one line of the hand-off: ${JSON.stringify(handed)}`);
      assert.deepEqual([handed[0]?.kind, handed[0]?.reason], ['cross unknown', 'ANSWER_UNKNOWN']);
      assert.deepEqual(handed[0]?.facts.answer, { kind: 'unknown', words });
      assert.deepEqual([handed[0]?.facts.txHash, handed[0]?.facts.handOffs], [c.tx_hash, 1]);
      assert.ok(!lines.some((l) => l.reason === 'NODE_REFUSED'), 'no line names the reserved reason');
      const record = await w.record(bet.hash);
      const cross = record.cross as Record<string, unknown>;
      assert.equal(record.state, 'unknown');
      assert.equal(cross.message, SENTENCE.UNKNOWN(c.tx_hash as string, bet.expiry.toString()), 'the unknown sentence, whole');
      assert.equal('reason' in cross, false, 'no reason: the property is absent');
      assert.deepEqual(cross.answer, { kind: 'unknown', words });
      // Nothing of the node's own text on the record, the row, the lines or anything the courier printed.
      for (const where of [JSON.stringify(record), JSON.stringify(c.node_answer), JSON.stringify(lines), JSON.stringify(stack.courier.lines)]) {
        for (const needle of PLANTED) assert.ok(!where.toLowerCase().includes(needle), `${needle} does not leave the courier`);
      }
      assert.equal(w.signedCarrying(bet.signature), 1, 'one signature');
      assert.equal(w.requestsOf(c.tx_hash as string), 1, 'one request of its bytes');
      return c;
    },

    /**
     * The node refuses the request before it reaches the chain, by the named error. The answer is not known; a later
     * bet does not reserve first; at a final block whose time is the bet's expiry, to the second, the Cross ends expired
     * unmined with its total at that block, with no hold of the key; and the next bet is sent and fills.
     */
    async refusedBeforeForwarding(words: NamedError): Promise<void> {
      const market = w.market();
      await w.quoteIn(market);
      const made = await w.betOf(who().bettor, market);
      await w.holdFinal();
      stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuseIf', refuse: carries(made.signature), code: -32000, message: nodeText(words) });
      let waited: Bet | null = null;
      try {
        const bet = await w.post(who().bettor, made);
        const c = await w.heldUnknown(bet, words);
        assert.equal(await w.chainHas(c.tx_hash as string), false, 'the chain never had it');
        // A later bet does not reserve first: the lane stays the first bet's.
        const later = w.market();
        await w.quoteIn(later);
        waited = await w.post(who().waiter, await w.betOf(who().waiter, later));
        await new Promise((r) => setTimeout(r, 1_500));
        const lane = await w.lane();
        assert.deepEqual([lane.held_bet, lane.open_cross], [bet.hash, bet.hash], 'the later bet does not reserve first');
        assert.equal(await w.cross(waited.hash), null, 'and has no Cross');
        // The final block at the bet's expiry, to the second: the nonce unused there, and its total read at that block.
        const at = await w.finalAt(bet.expiry);
        const end = await w.final(bet.hash);
        assert.equal(end.state, 'expired unmined', JSON.stringify(end));
        const fin = (end.recorded ?? {}).final as { number?: string; time?: string } | undefined;
        assert.deepEqual([fin?.number, fin?.time, (end.recorded ?? {}).betFilled], [at.toString(), bet.expiry.toString(), '0'], 'ended at the block of its expiry, with its total there');
        assert.deepEqual([end.tx_hash, end.nonce, end.reservation], [c.tx_hash, c.nonce, c.reservation], 'its own transaction, nonce and reservation');
        assert.equal((await w.lane()).shut_line, null, 'no hold of the key');
        assert.ok(!(await w.openConditions()).includes('cross-unreconciled'), 'no condition of the key');
        assert.equal(w.requestsOf(c.tx_hash as string), 1, 'never handed again');
      } finally {
        stack.proxy.rule('eth_sendRawTransaction', null);
        w.followFinal();
      }
      // The lane goes on: the bet that waited comes to its end, and the next bet is sent and fills.
      if (waited !== null) await w.betDone(waited.hash);
      const next = w.market();
      await w.quoteIn(next);
      const bet3 = await w.post(who().next, await w.betOf(who().next, next));
      assert.equal((await w.final(bet3.hash)).state, 'confirmed', 'the next bet is sent and fills');
    },

    /**
     * The node passes the request on and the chain takes it, and the courier is answered with the named error in place
     * of the chain's answer. While the receipt is not given and the final block is held before the expiry, the answer
     * is not known and the lane is held; then, with the evidence given, the Cross ends confirmed from its own receipt,
     * with what it filled, one signature and one request, and no hold of the key.
     */
    async acceptedThenNamed(words: NamedError): Promise<void> {
      const market = w.market();
      await w.quoteIn(market);
      const B = who().bettor;
      const made = await w.betOf(B, market);
      const paidBefore = await w.balance(B.address);
      await w.holdFinal();
      stack.proxy.rule('eth_getTransactionReceipt', { kind: 'answer', result: () => null });
      const passed = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText(words) }, carries(made.signature));
      let bet!: Bet;
      let c!: CrossSeen;
      try {
        bet = await w.post(B, made);
        c = await w.heldUnknown(bet, words);
        assert.deepEqual(passed.forwarded.map((a) => (a as { result?: unknown }).result), [c.tx_hash], 'the chain took these bytes, by their own hash');
        assert.equal(await w.chainHas(c.tx_hash as string), true, 'and has them');
      } finally {
        passed.stop();
        stack.proxy.rule('eth_getTransactionReceipt', null);
        w.followFinal();
      }
      const end = await w.final(bet.hash);
      assert.equal(end.state, 'confirmed', `the named error is no outcome: ${JSON.stringify(end)}`);
      assert.deepEqual([end.tx_hash, end.nonce, end.reservation], [c.tx_hash, c.nonce, c.reservation], 'its own transaction, nonce and reservation');
      const totals = (end.recorded ?? {}).totals as { taker?: string } | undefined;
      assert.equal(totals?.taker, '9984', 'what it filled, from its receipt');
      assert.equal(paidBefore - (await w.balance(B.address)), 9_984n, 'and the bettor paid that');
      assert.equal(w.signedCarrying(bet.signature), 1, 'one signature');
      assert.equal(w.requestsOf(c.tx_hash as string), 1, 'one request of its bytes');
      assert.equal((await w.lane()).shut_line, null, 'no hold of the key');
      assert.ok(!(await w.openConditions()).includes('cross-unreconciled'));
    },

    /**
     * The same history, where the Cross's own transaction reverts: the node passes it on and the courier hears the named
     * error; the bettor takes back its approval to the positions contract at a higher tip, in the Cross's block and
     * before it. While the receipt is not given and the final block is held, the answer is not known; with the evidence
     * given, the Cross ends reverted, TakerPullRefused, by its own hash: the named error is not an outcome here either.
     */
    async acceptedThenNamedReverted(words: NamedError): Promise<void> {
      const market = w.market();
      await w.quoteIn(market);
      // An account of this case alone: its approval is taken back.
      const B = await w.fresh();
      const made = await w.betOf(B, market);
      await w.holdFinal();
      stack.proxy.rule('eth_getTransactionReceipt', { kind: 'answer', result: () => null });
      const passed = stack.proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: nodeText(words) }, carries(made.signature));
      await hooks().arm('after-gate', 1);
      await hooks().arm('after-hand-off', 1);
      let bet!: Bet;
      let c!: CrossSeen;
      try {
        bet = await w.post(B, made);
        const gate = await hooks().reached('after-gate');
        await rig.rpc('evm_setIntervalMining', [0]);
        await hooks().go(gate);
        const handed = await hooks().reached('after-hand-off');
        try {
          const nonce = Number(BigInt((await rig.rpc('eth_getTransactionCount', [B.address, 'pending'])) as string));
          const block = (await rig.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
          const tip = 50_000_000_000n;
          const data = encodeFunctionData({ abi: rig.abis.TestCoin as Abi, functionName: 'approve', args: [rig.addresses.positions, 0n] });
          const raw = await B.signTransaction({ type: 'eip1559', chainId: 31337, to: rig.addresses.coin, data, value: 0n, nonce, gas: 200_000n, maxFeePerGas: BigInt(block.baseFeePerGas) * 3n + tip, maxPriorityFeePerGas: tip });
          await rig.rpc('eth_sendRawTransaction', [raw]);
          await rig.rpc('anvil_mine', ['0x1']);
        } finally {
          await rig.rpc('evm_setIntervalMining', [2]);
          await hooks().go(handed);
        }
        c = await w.heldUnknown(bet, words);
        assert.deepEqual(passed.forwarded.map((a) => (a as { result?: unknown }).result), [c.tx_hash], 'the chain took these bytes, by their own hash');
        assert.equal(await w.chainHas(c.tx_hash as string), true, 'and has them');
      } finally {
        passed.stop();
        stack.proxy.rule('eth_getTransactionReceipt', null);
        w.followFinal();
      }
      const end = await w.final(bet.hash);
      assert.deepEqual([end.state, end.revert_reason], ['reverted', 'TakerPullRefused'], `the named error is no outcome: ${JSON.stringify(end)}`);
      assert.deepEqual([end.tx_hash, end.nonce, end.reservation], [c.tx_hash, c.nonce, c.reservation], 'its own transaction, nonce and reservation');
      assert.equal(w.signedCarrying(bet.signature), 1, 'one signature');
      assert.equal(w.requestsOf(c.tx_hash as string), 1, 'one request of its bytes');
      assert.equal((await w.lane()).shut_line, null, 'no hold of the key');
      assert.ok(!(await w.openConditions()).includes('cross-unreconciled'));
    },

    /** No row and no line holds the reserved reason: nothing produced it. */
    async noneReserved(): Promise<void> {
      const crosses = await pool.query(`SELECT 1 FROM crosses WHERE not_sent_reason = 'NODE_REFUSED'`);
      const events = await pool.query(`SELECT 1 FROM events WHERE reason = 'NODE_REFUSED'`);
      assert.deepEqual([crosses.rowCount, events.rowCount], [0, 0], 'NODE_REFUSED produced by nothing');
    },
  };
  return w;
}
