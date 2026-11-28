import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { HDAccount } from 'viem/accounts';
import type { HookControl } from './support/courier';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { closeEach } from './support/close';
import { startStack, type Stack } from './support/stack';

// The lane, measured: twenty bets posted at once, each against its own quote
// on a market of its own, through the one lane, on a chain that mines a block
// every two seconds with the final block one behind the head. The accounts are
// funded and the quotes posted with instant mining first, so the set-up's own
// blocks are not the measurement's. Each hop's time is read from the records'
// own times; the figures are this machine's and this rig's, printed for
// docs/COST.md, and none is a figure the courier acts on.

let stack: Stack;
let pool: pg.Pool;
const url = () => stack.courier.url;
const from = { 'x-forwarded-for': '198.18.240.1' };
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);

before(async () => {
  stack = await startStack('lane_measured', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("twenty bets posted at once, each against its own quote on a market of its own: each hop's time from the records, the Crosses a minute through the one lane, and which bets lapsed; behind one lane, not all need fill", async () => {
  const n = 20;
  const rig = stack.rig;
  // The set-up with instant mining: the accounts funded and the quotes posted.
  await rig.rpc('evm_setIntervalMining', [0]);
  await rig.rpc('evm_setAutomine', [true]);
  const prepared: Array<{ B: HDAccount; market: { scorer: `0x${string}`; lineTicks: number } }> = [];
  try {
    for (let i = 0; i < n; i++) {
      const market = { scorer: rig.addresses.spread, lineTicks: -(4_000 + 5 * i) };
      const M = rig.account(40 + 2 * i);
      const B = rig.account(41 + 2 * i);
      await rig.fund(M);
      await rig.fund(B);
      const T = await rig.time();
      const q: Order = { ...orderOn(rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 9_600n, ...market }), positionType: 0 };
      const posted = await postOrder(url(), rig, M, 'rest', q);
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      prepared.push({ B, market });
    }
  } finally {
    // The chain on its clock again: a block every two seconds.
    await rig.rpc('evm_setAutomine', [false]);
    await rig.rpc('evm_setIntervalMining', [2]);
  }
  const hooks = stack.courier.hooks as HookControl;
  const signedBefore = hooks.signed.length;
  const handOffsBefore = stack.proxy.count('eth_sendRawTransaction');
  const T = await rig.time();
  const posted = await Promise.all(prepared.map(({ B, market }) => postOrder(url(), rig, B, 'take', { ...orderOn(rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 })));
  for (const p of posted) assert.equal(p.status, 202, JSON.stringify(p.body));
  const hashes = posted.map((p) => String(p.body.orderHash).toLowerCase());
  interface End { hash: string; bet_state: string; received_at: Date; state: string | null; hand_offs: number | null; intent_at: Date | null; signed_at: Date | null; gate_at: Date | null; answered_at: Date | null; receipt_seen_at: Date | null; outcome_at: Date | null }
  const read = async () =>
    (
      await pool.query<End>(
        `SELECT o.hash, o.bet_state, o.received_at, c.state, c.hand_offs, c.intent_at, c.signed_at, c.gate_at, c.answered_at, c.receipt_seen_at, c.outcome_at
         FROM orders o LEFT JOIN crosses c ON c.bet_hash = o.hash WHERE o.hash = ANY($1::text[])`,
        [hashes],
      )
    ).rows;
  // Each bet to its end: its Cross final, or the bet lapsed or refused at its turn.
  const ends = await until(read, (rows) => rows.length === n && rows.every((r) => (r.state !== null && FINAL.includes(r.state)) || ['lapsed', 'refused'].includes(r.bet_state)), 300_000, 'every bet at its end');
  const order = new Map(hashes.map((h, i) => [h, i + 1]));
  const sent = ends.filter((r) => r.state !== null).sort((a, b) => (a.intent_at as Date).getTime() - (b.intent_at as Date).getTime());
  const lapsed = ends.filter((r) => r.bet_state === 'lapsed').map((r) => order.get(r.hash) as number).sort((a, b) => a - b);
  // Every sent bet handed off once and settled; every bet not sent has no Cross; at least one fills.
  for (const r of sent) assert.equal(r.hand_offs, 1, JSON.stringify(r));
  assert.ok(sent.some((r) => r.state === 'confirmed'), 'at least one fills');
  assert.deepEqual({ signed: hooks.signed.length - signedBefore, handedOff: stack.proxy.count('eth_sendRawTransaction') - handOffsBefore }, { signed: sent.length, handedOff: sent.length }, 'one signature and one hand-off for each bet sent, and none for the others');
  // Each hop's time, from the records' own times (2.6): the queue and the pre-check together, then each step of the send.
  const ms = (a: Date | null, b: Date | null) => (a === null || b === null ? null : b.getTime() - a.getTime());
  const hops = {
    queueAndCheck: sent.map((r) => ms(r.received_at, r.intent_at)),
    signAndRecord: sent.map((r) => ms(r.intent_at, r.signed_at)),
    gate: sent.map((r) => ms(r.signed_at, r.gate_at)),
    handOff: sent.map((r) => ms(r.gate_at, r.answered_at)),
    intoABlock: sent.map((r) => ms(r.answered_at, r.receipt_seen_at)),
    toFinal: sent.map((r) => ms(r.receipt_seen_at, r.outcome_at)),
    laneHeld: sent.map((r) => ms(r.intent_at, r.outcome_at)),
  };
  const stat = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
    return v.length === 0 ? null : { n: v.length, median: v[Math.floor((v.length - 1) / 2)], max: v[v.length - 1] };
  };
  const first = (sent[0]?.intent_at as Date).getTime();
  const last = Math.max(...sent.map((r) => (r.outcome_at as Date).getTime()));
  const perMinute = Math.round((sent.length / ((last - first) / 60_000)) * 10) / 10;
  console.log(`# the lane, measured: ${n} bets posted at once; ${sent.length} sent (${sent.filter((r) => r.state === 'confirmed').length} confirmed), ${lapsed.length} lapsed (by post order: ${lapsed.join(', ') || 'none'}); ${perMinute} Crosses a minute; hops in ms (median, max): ${JSON.stringify(Object.fromEntries(Object.entries(hops).map(([k, v]) => [k, stat(v)])))}`);
});

test("the catch-up after a quiet spell: the lane's watermark and the last bet's receipt more than 256 blocks below the final block; the next bet's send checks read each one's header by its number and then the final block's own height once more, three headers by number and none by hash, counted at the proxy; then the anchor is raised and the bet after reads none", async () => {
  const rig = stack.rig;
  const hooks = stack.courier.hooks as HookControl;
  const market = { scorer: rig.addresses.spread, lineTicks: -6_005 };
  // A bet sent and confirmed: the lane's watermark is anchored at a final block of that check.
  await rig.rpc('evm_setIntervalMining', [0]);
  await rig.rpc('evm_setAutomine', [true]);
  const [M, B1, B2, B3] = [rig.account(90), rig.account(91), rig.account(92), rig.account(93)];
  try {
    for (const who of [M, B1, B2, B3]) await rig.fund(who);
  } finally {
    await rig.rpc('evm_setAutomine', [false]);
    await rig.rpc('evm_setIntervalMining', [2]);
  }
  const quote = async () => {
    const T = await rig.time();
    const q: Order = { ...orderOn(rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 9_600n, ...market }), positionType: 0 };
    assert.equal((await postOrder(url(), rig, M, 'rest', q)).status, 201);
  };
  const betOf = async (B: HDAccount) => {
    const T = await rig.time();
    const p = await postOrder(url(), rig, B, 'take', { ...orderOn(rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, ...market }), positionType: 1 });
    assert.equal(p.status, 202, JSON.stringify(p.body));
    return String(p.body.orderHash).toLowerCase();
  };
  const final = (h: string) => until(async () => (await pool.query<{ state: string }>('SELECT state FROM crosses WHERE bet_hash = $1', [h])).rows[0]?.state, (s) => s !== undefined && FINAL.includes(s), 90_000, `the Cross of ${h}`);
  await quote();
  const first = await betOf(B1);
  assert.equal(await final(first), 'confirmed');
  const anchorOf = async () => (await pool.query<{ n: string | null }>('SELECT verified_block_number::text AS n FROM lanes WHERE sender = $1', [rig.accounts.sender.address.toLowerCase()])).rows[0]?.n ?? null;
  const receiptOf = async (h: string) => (await pool.query<{ n: string | null }>('SELECT receipt_block_number::text AS n FROM crosses WHERE bet_hash = $1', [h])).rows[0]?.n ?? null;
  // The quiet spell: 300 blocks with no bet.
  await rig.mine(300);
  /** The headers the bet's send checks read, from its check's result to its intent: by number (each height named) and by hash. */
  const counted = async (B: HDAccount) => {
    await hooks.arm('before-result', 1);
    await hooks.arm('after-intent', 1);
    await quote();
    const h = await betOf(B);
    const atResult = await hooks.reached('before-result');
    const from = stack.proxy.counted.length;
    await hooks.go(atResult);
    const atIntent = await hooks.reached('after-intent');
    const seen = stack.proxy.counted.slice(from);
    await hooks.go(atIntent);
    assert.equal(await final(h), 'confirmed');
    const numbered = seen.filter((c) => c.method === 'eth_getBlockByNumber' && typeof c.params?.[0] === 'string' && /^0x[0-9a-f]+$/i.test(c.params[0] as string)).map((c) => BigInt(c.params?.[0] as string));
    return { hash: h, numbered, byHash: seen.filter((c) => c.method === 'eth_getBlockByHash').length };
  };
  const anchorBefore = await anchorOf();
  const head = BigInt((await rig.rpc('eth_blockNumber', [])) as string);
  const next = await counted(B2);
  const intentF = (await pool.query<{ f: string }>(`SELECT checked->'send'->'nonce'->'final'->>'number' AS f FROM crosses WHERE bet_hash = $1`, [next.hash])).rows[0]?.f;
  // q = 2 distinct deep heights, the watermark's anchor and the last bet's receipt, then one read of F's own height.
  const heights = [...new Set(next.numbered)];
  const retries = next.numbered.length - heights.length;
  assert.deepEqual(
    { numbered: next.numbered.length - retries, retries, byHash: next.byHash, distinctHeights: heights.length },
    { numbered: 3, retries: 0, byHash: 0, distinctHeights: 3 },
    `the next bet's send checks: ${JSON.stringify({ numbered: next.numbered.map(String), anchorBefore, head: String(head) })}`,
  );
  assert.ok(heights.includes(BigInt(anchorBefore as string)), "the watermark's anchor read by its number");
  assert.ok(heights.includes(BigInt((await receiptOf(first)) as string)), "the last bet's receipt read by its number");
  assert.ok(heights.includes(BigInt(intentF as string)), "the final block's own height read again");
  const after = await counted(B3);
  console.log(`# the catch-up after a quiet spell of 300 blocks: the anchor at block ${anchorBefore}, the head at ${head}; the next bet's send checks read ${next.numbered.length} headers by number (${next.numbered.map(String).join(', ')}; F at ${intentF}), ${retries} of them again, and ${next.byHash} by hash; the bet after it read ${after.numbered.length} by number and ${after.byHash} by hash`);
  assert.deepEqual({ numbered: after.numbered.length, byHash: after.byHash }, { numbered: 0, byHash: 0 }, 'the anchor raised by the bet before: nothing read by number or by hash');
});
