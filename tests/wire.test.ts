import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import pg from 'pg';
import type { Hex } from 'viem';
import { VERDICT } from '../courier/check/sentences';
import { ORDER_ACCEPTANCE_UNCERTAIN } from '../courier/http/routes';
import { crossMessage, NEXT, REASON, SENTENCE, wireState, type BetTerms, type LegForRecord } from '../courier/orders/wire';
import type { CrossRow, CrossState } from '../courier/records/crosses';
import { openPool } from '../courier/records/store';
import { get } from './support/courier';
import { startStack } from './support/stack';

// The sender's wire, as a reader of docs/API.md would hold it: every sentence
// the record serves is the page's, word for word, and each answer variant gets
// its one next step. The branches are the record's own: the state, the
// reason and its evidence, the final block's time against the bet's expiry
// (equality being at the expiry), and the bet's total filled at that block
// against its stake: nothing, a part, or all. Last, every one of those rows is
// written as the sender writes it, beside its bet and its quote, and served
// through GET /v1/orders/{hash}: the record's message is the same text.

const API = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');

/** Each template the record serves, its values named as the page names them. */
const TEMPLATES: Record<string, string> = {
  SENDING: SENTENCE.SENDING('{n}'),
  UNKNOWN: SENTENCE.UNKNOWN('{txHash}', '{expiry}'),
  RESTORED: SENTENCE.RESTORED('{expiry}'),
  SENT: SENTENCE.SENT('{txHash}', '{time}', '{expiry}'),
  PENDING: SENTENCE.PENDING('{txHash}', '{n}', '{expiry}'),
  CONFIRMED: SENTENCE.CONFIRMED('{txHash}', '{n}', '{filled}', '{stake}'),
  CONFIRMED_PART: SENTENCE.CONFIRMED_PART('{unfilled}'),
  SKIPPED: SENTENCE.SKIPPED('{k}', '{reasons}'),
  REVERTED: SENTENCE.REVERTED('{txHash}', '{n}', '{reason}'),
  REVERTED_UNAVAILABLE: SENTENCE.REVERTED_UNAVAILABLE('{txHash}', '{n}'),
  REVERTED_EXPIRY: SENTENCE.REVERTED_EXPIRY('{txHash}', '{n}', '{blockTime}', '{expiry}'),
  CHAIN_REASON: SENTENCE.CHAIN_REASON('{reason}'),
  EXPIRED_UNMINED: SENTENCE.EXPIRED_UNMINED('{txHash}', '{n}', '{time}', '{expiry}'),
  EXPIRED_UNMINED_RESTORED: SENTENCE.EXPIRED_UNMINED_RESTORED('{n}', '{time}', '{expiry}'),
  REPLACED: SENTENCE.REPLACED('{txHash}', '{replacedBy}', '{n}'),
  STOPPED_AT_GATE: SENTENCE.STOPPED_AT_GATE,
  COURIER_RESTARTED: SENTENCE.COURIER_RESTARTED,
  NODE_REFUSED: SENTENCE.NODE_REFUSED('{kind}'),
  NOTHING_FILLED: SENTENCE.NOTHING_FILLED('{n}'),
  PART_FILLED: SENTENCE.PART_FILLED('{betFilled}', '{stake}', '{n}'),
  FULL_FILLED: SENTENCE.FULL_FILLED('{stake}', '{n}'),
  N2: NEXT.N2,
  N3: NEXT.N3,
  N4: NEXT.N4,
  N5: NEXT.N5('{rest}'),
  N6: NEXT.N6,
  N7: NEXT.N7,
  N8: NEXT.N8('{reason}'),
  N8_SUFFIX: NEXT.N8_SUFFIX,
  PULL_BETTOR: REASON.PULL_BETTOR('{pull}', '{what}'),
  PULL_UNKNOWN: REASON.PULL_UNKNOWN('{pull}'),
  GRANT_REVOKED: REASON.GRANT_REVOKED('{grant}'),
  GRANT_ENDED: REASON.GRANT_ENDED('{grant}', '{endsAt}'),
  RELAY_DROPPED: REASON.RELAY_DROPPED('{relay}'),
  NO_COURIER: REASON.NO_COURIER,
  CANCELLED: REASON.CANCELLED,
  FILLED: REASON.FILLED,
  EXPIRED: REASON.EXPIRED,
  TOO_LONG: REASON.TOO_LONG,
  NOTHING_FILLED_REASON: REASON.NOTHING_FILLED('{skips}'),
  UNDER_MIN_FILL: REASON.UNDER_MIN_FILL('{minFill}'),
  BETS_CLOSED: REASON.BETS_CLOSED('{gameId}'),
  GAME_ENDED: REASON.GAME_ENDED('{gameId}'),
  MARKET_SETTLED: REASON.MARKET_SETTLED,
  COURIERS_OWN: REASON.COURIERS_OWN('{kind}'),
  WALLET: VERDICT.COURIER_CANNOT_SEND_WALLET('{n}', '{pol}', '{cost}'),
  ORDER_ACCEPTANCE_UNCERTAIN,
};

test('every sentence and every next step the sender serves is docs/API.md\'s, word for word', () => {
  const missing = Object.entries(TEMPLATES).filter(([, text]) => !API.includes(text)).map(([name]) => name);
  assert.deepEqual(missing, [], `not on the page word for word: ${missing.join(', ')}`);
});

test('no sentence the sender adds or replaces asks a user to report, contact, email or submit a hash to anyone', () => {
  for (const [name, text] of Object.entries(TEMPLATES)) {
    assert.doesNotMatch(text, /\bcontact\b|\be-?mail\b|\bsubmit\b|please report|report (it|this|the hash) to/i, name);
  }
});

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const STAKE = 10_000_000n;
const EXPIRY = 1_000n;
const TERMS: BetTerms = { expiry: EXPIRY, riskAmount: STAKE, minFill: 1_000_000n, gameId: 7n, relay: '0x' + '5e'.repeat(20), decimals: 6 };
const LEGS: LegForRecord[] = [{ position: 0, orderHash: h(9), account: '0x' + '0a'.repeat(20), oddsTick: 204, makerRisk: '9600000', takerRisk: '9984000', recordedMakerRisk: null, recordedTakerRisk: null, skip: null }];

/** Every message a case builds, with the row, the legs and the hold it was built from: each is served at the end. */
const BUILT: Array<{ row: CrossRow; legs: readonly LegForRecord[]; restored: boolean }> = [];
const render = crossMessage;
function messageOf(r: CrossRow, terms: BetTerms, legs: readonly LegForRecord[], restored: boolean): string {
  BUILT.push({ row: r, legs, restored });
  return render(r, terms, legs, restored);
}

function row(state: CrossState, over: Partial<CrossRow> = {}): CrossRow {
  return {
    betHash: h(1),
    lane: `0x${'15'.repeat(20)}`,
    epoch: 1n,
    reservation: 1n,
    block: { number: 90n, hash: h(90), time: 900n },
    sender: `0x${'15'.repeat(20)}`,
    nonce: 3n,
    gasLimit: 500_000n,
    maxFeePerGas: 200n,
    maxPriorityFee: 30n,
    txHash: h(2),
    state,
    handOffs: 1,
    nodeAnswer: { kind: 'taken' },
    receipt: { number: 95n, hash: h(95) },
    final: { number: 99n, hash: h(99) },
    replacedBy: null,
    replacedByOurs: null,
    revertReason: null,
    revertEvidence: null,
    revertData: null,
    notSentReason: null,
    gasUsed: 400_000n,
    effectiveGasPrice: 150n,
    checked: {},
    recorded: null,
    times: { intentAt: null, signedAt: null, gateAt: null, answeredAt: new Date('2026-11-25T08:00:00.000Z'), receiptSeenAt: null, outcomeAt: null },
    ...over,
  };
}

/** A terminal outcome's recorded figures: the final block's time and the total filled there. */
const at = (time: bigint, betFilled: bigint, extra: Record<string, unknown> = {}) => ({ final: { number: '99', hash: h(99), time: time.toString() }, betFilled: betFilled.toString(), ...extra });

const TOTALS: Array<[string, bigint]> = [
  ['nothing', 0n],
  ['a part', 4_000_000n],
  ['all', STAKE],
];
const TIMES: Array<[string, bigint]> = [
  ['before the expiry', EXPIRY - 1n],
  ['at the expiry', EXPIRY],
  ['past the expiry', EXPIRY + 5n],
];

/** The bet's line the record must end with, from the page's own sentences: the total, then one step. */
function expectedLine(total: bigint, time: bigint, opts: { game?: boolean; n8?: boolean } = {}): string {
  const past = time >= EXPIRY;
  if (total === STAKE) return SENTENCE.FULL_FILLED('10.00', '99');
  const first = total === 0n ? SENTENCE.NOTHING_FILLED('99') : SENTENCE.PART_FILLED('4.00', '10.00', '99');
  if (opts.game === true) return total === 0n ? `${first} ${NEXT.N6}` : `${first} The filled part stands. ${NEXT.N6}`;
  const step = total === 0n ? (past ? NEXT.N4 : NEXT.N2) : past ? NEXT.N5('6.00') : NEXT.N3;
  return opts.n8 === true ? `${first} ${step} ${NEXT.N8_SUFFIX}` : `${first} ${step}`;
}

for (const [totalName, total] of TOTALS) {
  for (const [timeName, time] of TIMES) {
    test(`the bet's line: ${totalName} filled at a final block ${timeName}, after confirmed, reverted, expired unmined and replaced, takes ${total === STAKE ? 'no next step' : 'its one next step'}`, () => {
      const line = expectedLine(total, time);
      const confirmed = messageOf(row('confirmed', { recorded: at(time, total, { totals: { taker: total === 0n ? '1000000' : total.toString() } }) }), TERMS, LEGS, false);
      assert.ok(confirmed.endsWith(line), confirmed);
      const reverted = messageOf(row('reverted', { revertReason: 'TakingOrderFilled', revertEvidence: 'trace', recorded: at(time, total, { reason: { reason: 'TakingOrderFilled', args: [h(1)] } }) }), TERMS, LEGS, false);
      assert.equal(reverted, `${SENTENCE.REVERTED(h(2), '95', REASON.FILLED)} ${line}`);
      const expired = messageOf(row('expired unmined', { receipt: null, recorded: at(time, total) }), TERMS, LEGS, false);
      assert.equal(expired, `${SENTENCE.EXPIRED_UNMINED(h(2), '99', time.toString(), EXPIRY.toString())} ${line}`);
      const replaced = messageOf(row('replaced', { receipt: null, replacedBy: h(3), replacedByOurs: false, recorded: at(time, total, { replacedByBlock: { number: '97', hash: h(97) } }) }), TERMS, LEGS, false);
      assert.equal(replaced, `${SENTENCE.REPLACED(h(2), h(3), '97')} ${line}`);
      if (total === STAKE) for (const t of [confirmed, reverted, expired, replaced]) assert.doesNotMatch(t, /Next:/, 'a full fill has no next step');
    });
  }
}

for (const reason of ['BetsClosed', 'GameEnded', 'MarketSettled'] as const) {
  test(`the game's reason, ${reason}: N6 at nothing and at a part, the part's line keeping "The filled part stands."; none at all`, () => {
    const words = reason === 'BetsClosed' ? REASON.BETS_CLOSED('7') : reason === 'GameEnded' ? REASON.GAME_ENDED('7') : REASON.MARKET_SETTLED;
    for (const [, total] of TOTALS) {
      const t = messageOf(row('reverted', { revertReason: reason, revertEvidence: 'trace', recorded: at(EXPIRY - 1n, total, { reason: { reason } }) }), TERMS, LEGS, false);
      assert.equal(t, `${SENTENCE.REVERTED(h(2), '95', words)} ${expectedLine(total, EXPIRY - 1n, { game: true })}`);
    }
  });
}

for (const [label, reason] of [
  ['a known reason the page does not list', 'BadSignature'],
  ['a reason the courier does not know', '0xdeadbeef'],
  ['an empty reason not shown to be out of gas', 'empty'],
] as const) {
  test(`N8 for ${label}: the recorded reason, the applicable step and the repeat-refusal suffix; at all filled, no step and no suffix`, () => {
    for (const [, total] of TOTALS) {
      for (const [, time] of TIMES) {
        const t = messageOf(row('reverted', { revertReason: reason, revertEvidence: 'trace', recorded: at(time, total, { reason: { reason } }) }), TERMS, LEGS, false);
        assert.equal(t, `${SENTENCE.REVERTED(h(2), '95', NEXT.N8(reason))} ${expectedLine(total, time, { n8: true })}`);
        if (total === STAKE) assert.ok(!t.includes(NEXT.N8_SUFFIX));
      }
    }
  });
}

test('the two pull branches: the bettor\'s own act shown by the coin\'s frame names what was too low; none shown says the courier cannot tell why', () => {
  const pinned = messageOf(row('reverted', { revertReason: 'TakerPullRefused', revertEvidence: 'trace', recorded: at(EXPIRY - 1n, 0n, { reason: { reason: 'TakerPullRefused', args: ['0x' + '0b'.repeat(20), '9984000'], pinnedOn: [{ account: '0x' + '0b'.repeat(20), role: 'bettor', act: 'x' }], affected: [{ pull: '9984000', coin: 'allowance' }] } }) }), TERMS, LEGS, false);
  assert.ok(pinned.includes(REASON.PULL_BETTOR('9.984', 'approval to the positions contract')), pinned);
  const unknown = messageOf(row('reverted', { revertReason: 'TakerPullRefused', revertEvidence: 'trace', recorded: at(EXPIRY - 1n, 0n, { reason: { reason: 'TakerPullRefused', args: ['0x' + '0b'.repeat(20), '9984000'], pinnedOn: 'unknown', affected: [{ pull: '9984000', coin: 'paused' }] } }) }), TERMS, LEGS, false);
  assert.ok(unknown.includes(REASON.PULL_UNKNOWN('9.984')), unknown);
});

test('the other states: sending, unknown, sent and pending wait with N1; the three not-sent reasons with N2; a revert with no trace and one past the expiry; a restored attempt is uncertain, never one now being signed', () => {
  assert.equal(messageOf(row('signed'), TERMS, LEGS, false), SENTENCE.SENDING('90'));
  assert.deepEqual(wireState(row('signed'), false), { state: 'queued', turn: 'sending' });
  assert.deepEqual(wireState(row('handing off'), false), { state: 'unknown' });
  assert.deepEqual(wireState(row('signed'), true), { state: 'unknown' });
  assert.equal(messageOf(row('handing off'), TERMS, LEGS, false), SENTENCE.UNKNOWN(h(2), '1000'));
  assert.equal(messageOf(row('unknown'), TERMS, LEGS, false), SENTENCE.UNKNOWN(h(2), '1000'));
  assert.equal(messageOf(row('sent'), TERMS, LEGS, false), SENTENCE.SENT(h(2), '2026-11-25T08:00:00.000Z', '1000'));
  assert.equal(messageOf(row('pending'), TERMS, LEGS, false), SENTENCE.PENDING(h(2), '95', '1000'));
  assert.equal(messageOf(row('intent', { txHash: null }), TERMS, LEGS, true), SENTENCE.RESTORED('1000'));
  assert.equal(messageOf(row('not sent', { notSentReason: 'STOPPED_AT_GATE' }), TERMS, LEGS, false), SENTENCE.STOPPED_AT_GATE);
  assert.equal(messageOf(row('not sent', { notSentReason: 'COURIER_RESTARTED' }), TERMS, LEGS, false), SENTENCE.COURIER_RESTARTED);
  assert.equal(messageOf(row('not sent', { notSentReason: 'NODE_REFUSED', nodeAnswer: { kind: 'refused', words: 'nonce too low' } }), TERMS, LEGS, false), SENTENCE.NODE_REFUSED('nonce too low'));
  const unavailable = messageOf(row('reverted', { revertReason: 'unavailable', revertEvidence: 'unavailable', recorded: at(EXPIRY - 1n, 0n, { reason: { reason: 'unavailable', evidence: 'unavailable' } }) }), TERMS, LEGS, false);
  assert.equal(unavailable, `${SENTENCE.REVERTED_UNAVAILABLE(h(2), '95')} ${expectedLine(0n, EXPIRY - 1n)}`);
  const late = messageOf(row('reverted', { revertReason: 'TakingOrderExpired', revertEvidence: 'trace', recorded: at(EXPIRY + 2n, 0n, { reason: { reason: 'TakingOrderExpired', expired: { expiry: '1000', blockTime: '1001' } } }) }), TERMS, LEGS, false);
  assert.equal(late, `${SENTENCE.REVERTED_EXPIRY(h(2), '95', '1001', '1000')} ${SENTENCE.CHAIN_REASON(REASON.EXPIRED)} ${expectedLine(0n, EXPIRY + 2n)}`);
  for (const t of [SENTENCE.UNKNOWN(h(2), '1000'), SENTENCE.SENT(h(2), 't', '1000'), SENTENCE.PENDING(h(2), '95', '1000')]) assert.ok(t.endsWith(NEXT.N1('1000')));
  for (const t of [SENTENCE.STOPPED_AT_GATE, SENTENCE.COURIER_RESTARTED, SENTENCE.NODE_REFUSED('x')]) assert.ok(t.endsWith(NEXT.N2));
});

test("the wallet's form of COURIER_CANNOT_SEND takes N7, and it is told from the relay's sender form by its fields, not its sentence", () => {
  assert.ok(VERDICT.COURIER_CANNOT_SEND_WALLET('5', '0.01', '0.02').endsWith(NEXT.N7));
  assert.doesNotMatch(VERDICT.COURIER_CANNOT_SEND('5'), /Next:/, "the relay's sender form is C4's, unchanged");
});

test("every row above, served: written as the sender writes a Cross's row, beside its bet and its quote, and read back through GET /v1/orders/{hash}; the record's message is the same text, word for word, the database's restore hold read for the restored ones", async () => {
  // A sending stack: its close counts no sends against these rows, which no courier handed off.
  const stack = await startStack('wire_served', { sending: true });
  const pool = openPool(stack.databaseUrl, null) as pg.Pool;
  const headers = { 'x-forwarded-for': '198.18.250.1' };
  const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const terms = { ...TERMS, relay: stack.rig.addresses.relay };
  try {
    const run = Number((await pool.query<{ id: string }>('SELECT max(id)::text AS id FROM runs')).rows[0]?.id);
    const cases = [...BUILT.filter((c) => !c.restored), ...BUILT.filter((c) => c.restored)];
    let held = false;
    for (const [i, c] of cases.entries()) {
      if (c.restored && !held) {
        // The database's hold, as the operator's shut writes it: the restore's incident, and no lane needed.
        await pool.query(`INSERT INTO events (run, kind, reason, facts) VALUES ($1, 'incident', 'RESTORE_SHUT', '{}')`, [run]);
        held = true;
      }
      // A lane of its own for each row: a lane holds one open Cross at most.
      const lane = `0x${(0x170000 + i).toString(16).padStart(40, '0')}` as `0x${string}`;
      await pool.query('INSERT INTO lanes (sender, epoch) VALUES ($1, 1)', [lane]);
      const bet = hex(1_000_000 + i);
      const quote = hex(2_000_000 + i);
      const state = c.row.state;
      const handOffs = state === 'intent' || state === 'signed' ? 0 : state === 'not sent' ? (c.row.notSentReason === 'NODE_REFUSED' ? 1 : 0) : 1;
      const r: CrossRow = { ...c.row, betHash: bet as `0x${string}`, lane, txHash: state === 'intent' || c.row.txHash === null ? null : (hex(3_000_000 + i) as `0x${string}`), handOffs };
      const legs = c.legs.map((l) => ({ ...l, orderHash: quote as `0x${string}` }));
      const orderCols = 'hash, role, account, game_id, scorer, line_ticks, position_type, odds_tick, risk_amount, nonce, expiry, min_fill, signature, market_key, side, received_block, received_hash, received_time';
      await pool.query(
        `INSERT INTO orders (${orderCols}) VALUES ($1, 'rest', $2, $3, $4, 0, 0, $5, 9600000, $6, 2000000000, 0, $7, $8, 0, 1, $9, 1)`,
        [quote, (legs[0] as LegForRecord).account, TERMS.gameId.toString(), `0x${'0c'.repeat(20)}`, (legs[0] as LegForRecord).oddsTick, String(i + 1), `0x${'11'.repeat(65)}`, hex(1), hex(2)],
      );
      await pool.query(
        `INSERT INTO orders (${orderCols}, bet_state) VALUES ($1, 'take', $2, $3, $4, 0, 1, 196, $5, $6, $7, $8, $9, $10, 1, 1, $11, 1, 'sent')`,
        [bet, `0x${'0b'.repeat(20)}`, TERMS.gameId.toString(), `0x${'0c'.repeat(20)}`, TERMS.riskAmount.toString(), String(i + 1), TERMS.expiry.toString(), TERMS.minFill.toString(), `0x${'11'.repeat(65)}`, hex(1), hex(2)],
      );
      await pool.query(
        `INSERT INTO crosses (bet_hash, lane, epoch, reservation, block_number, block_hash, block_time, sender, nonce, gas_limit, max_fee_per_gas, max_priority_fee, tx_hash, state, hand_offs, node_answer,
                              receipt_block_number, receipt_block_hash, final_block_number, final_block_hash, replaced_by, replaced_by_ours, revert_reason, revert_evidence, revert_data, not_sent_reason,
                              gas_used, effective_gas_price, checked, recorded, answered_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)`,
        [
          bet, lane, String(i + 1), r.block.number.toString(), r.block.hash, r.block.time.toString(), r.sender, r.nonce?.toString() ?? null, r.gasLimit?.toString() ?? null, r.maxFeePerGas?.toString() ?? null,
          r.maxPriorityFee?.toString() ?? null, r.txHash, state, handOffs, r.nodeAnswer === null ? null : JSON.stringify(r.nodeAnswer),
          r.receipt?.number.toString() ?? null, r.receipt?.hash ?? null, r.final?.number.toString() ?? null, r.final?.hash ?? null, r.replacedBy, r.replacedByOurs, r.revertReason, r.revertEvidence, r.revertData,
          r.notSentReason, r.gasUsed?.toString() ?? null, r.effectiveGasPrice?.toString() ?? null, JSON.stringify(r.checked), r.recorded === null ? null : JSON.stringify(r.recorded), r.times.answeredAt,
        ],
      );
      for (const l of legs) {
        await pool.query(
          'INSERT INTO legs (bet_hash, position, order_hash, expected_maker_risk, expected_taker_risk, recorded_maker_risk, recorded_taker_risk, skip_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [bet, l.position, quote, l.makerRisk, l.takerRisk, l.recordedMakerRisk, l.recordedTakerRisk, l.skip],
        );
      }
      const served = await get(stack.courier.url, `/v1/orders/${bet}`, headers);
      assert.equal(served.status, 200, JSON.stringify(served.body));
      const message = (served.body.cross as { message?: string } | null)?.message;
      assert.equal(message, render(r, terms, legs, c.restored), `row ${i + 1}, ${state}${c.restored ? ', restored' : ''}: ${JSON.stringify(served.body.cross)}`);
    }
    console.log(`# every row served: ${cases.length} records read back, ${cases.filter((c) => c.restored).length} of them under the restore's hold`);
  } finally {
    await pool.end();
    await stack.close();
  }
});
