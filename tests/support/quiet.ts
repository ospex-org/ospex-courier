import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { Abi, Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { closeEach } from './close';
import type { Counted } from './proxy';
import type { HookControl } from './courier';
import { orderOn, postOrder, type Order } from './orders';
import { startStack, type Stack } from './stack';

// The first bet after a quiet spell, and the quiet spell itself, on the rig (tests/quiet*.test.ts).
//
// The chain's schedule, declared:
// - a case's set-up transactions are mined at once, each in a block of its own;
// - the quiet spell is mined in steps, each that many empty blocks at least two seconds apart on the chain's clock
//   (later where the mining took longer in real time), with no bet and nothing of the courier's own to do: the chain's
//   blocks are real, and nothing stands in for them;
// - then a block every two seconds, from a time set for the first of them, to the second;
// - the final block follows the head, one behind it.
//
// The clock, declared: the bet is one cent at 7:12:00 PM Central time on the chain's own clock (UTC-6, the standard
// time of late November), good until 7:12:30. It is posted once the chain's latest block carries 19:12:00, and its
// expiry is 30 seconds on. The courier reads the chain's time and never the wall clock's, so the hour is the chain's;
// what the bet's life takes in real time is measured beside it, from the records' own times.

/** Central time's offset from UTC in late November, in seconds: UTC-6. */
export const CENTRAL = 6n * 3_600n;

/** The first 19:12:00 Central time strictly after `after`, a time on the chain's clock in seconds since the epoch. */
export function next1912(after: bigint): bigint {
  const day = 86_400n;
  const local = after - CENTRAL;
  const today = (local / day) * day + 19n * 3_600n + 12n * 60n;
  return (today > local ? today : today + day) + CENTRAL;
}

/** The time of day a chain time reads in Central time, as hh:mm:ss. */
export function centralClock(t: bigint): string {
  const s = Number((((t - CENTRAL) % 86_400n) + 86_400n) % 86_400n);
  return [Math.floor(s / 3_600), Math.floor((s % 3_600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');
}

/** A height a request names by number, as a hex quantity; null for a tag or anything else. */
export function numbered(c: Counted): bigint | null {
  const p = c.params?.[0];
  return c.method === 'eth_getBlockByNumber' && typeof p === 'string' && /^0x[0-9a-fA-F]+$/.test(p) ? BigInt(p) : null;
}

/** The requests in a slice of the proxy's count, by method. */
export function byMethod(cs: readonly Counted[]): Record<string, number> {
  return cs.reduce<Record<string, number>>((o, c) => ((o[c.method] = (o[c.method] ?? 0) + 1), o), {});
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until<T>(stack: Stack, read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
    await sleep(250);
  }
}

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];

/** Every row the courier's records hold, as a fingerprint: the rows of each table, the newest line, and the lanes' rows whole. */
async function records(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ f: string }>(
    `SELECT json_build_object(
       'events', (SELECT count(*) FROM events), 'newest', (SELECT max(number) FROM events),
       'crosses', (SELECT count(*) FROM crosses), 'crossesChanged', (SELECT max(updated_at) FROM crosses),
       'legs', (SELECT count(*) FROM legs), 'orders', (SELECT count(*) FROM orders), 'ordersChanged', (SELECT count(*) FROM orders WHERE ended IS NOT NULL),
       'lanes', (SELECT json_agg(l ORDER BY l.sender) FROM lanes l)
     )::text AS f`,
  );
  return rows[0]?.f ?? '';
}

export interface Step {
  blocks: number;
  ms: number;
  from: { number: bigint; time: bigint };
  to: { number: bigint; time: bigint };
  requests: Record<string, number>;
  recordsUnchanged: boolean;
}

async function head(stack: Stack): Promise<{ number: bigint; time: bigint }> {
  const b = (await stack.rig.rpc('eth_getBlockByNumber', ['latest', false])) as { number: Hex; timestamp: Hex };
  return { number: BigInt(b.number), time: BigInt(b.timestamp) };
}

/**
 * One step of a quiet spell: `blocks` empty blocks, two seconds apart on the chain's clock, mined in requests of 1,800
 * at most so that no one request outlasts the client's wait. Nothing is posted. What the courier asked of the chain
 * meanwhile, through the proxy, and whether its records changed, are read and returned; the caller holds them to none.
 */
export async function quietStep(stack: Stack, pool: pg.Pool, blocks: number): Promise<Step> {
  await stack.rig.rpc('evm_setAutomine', [false]);
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  const from = await head(stack);
  const before = await records(pool);
  const counted = stack.proxy.counted.length;
  const t0 = Date.now();
  for (let left = blocks; left > 0; ) {
    const n = Math.min(1_800, left);
    await stack.rig.rpc('anvil_mine', [`0x${n.toString(16)}`, '0x2']);
    left -= n;
  }
  const ms = Date.now() - t0;
  const to = await head(stack);
  const requests = byMethod(stack.proxy.counted.slice(counted));
  const after = await records(pool);
  assert.equal(to.number - from.number, BigInt(blocks), 'the step mined its blocks');
  // The chain stamps each block two seconds after the one before it, or later where the mining itself took longer than
  // that in real time: the chain's clock never falls behind its own wall clock.
  assert.ok(to.time - from.time >= 2n * BigInt(blocks), `at least two seconds apart on the chain clock: ${to.time - from.time} s over ${blocks} blocks`);
  return { blocks, ms, from, to, requests, recordsUnchanged: before === after };
}

/** The chain mining at once, for a case's set-up: each transaction in a block of its own, the clock still. */
export async function instant(stack: Stack): Promise<void> {
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await stack.rig.rpc('evm_setAutomine', [true]);
}

/** The chain on its clock again: a block every two seconds, the first at `time` where one is given. */
export async function clockFrom(stack: Stack, time?: bigint): Promise<void> {
  await stack.rig.rpc('evm_setAutomine', [false]);
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  if (time !== undefined) await stack.rig.setNextBlockTime(time);
  await stack.rig.rpc('evm_setIntervalMining', [2]);
}

export interface People {
  M: HDAccount;
  B: HDAccount;
}

/** Two accounts funded at once, with the chain mining at once: a maker and a bettor. */
export async function funded(stack: Stack, first: number): Promise<People> {
  const M = stack.rig.account(first);
  const B = stack.rig.account(first + 1);
  await stack.rig.fund(M);
  await stack.rig.fund(B);
  return { M, B };
}

const from = (n: number) => ({ 'x-forwarded-for': `198.18.247.${1 + (n % 250)}` });
let posts = 0;

/** The maker's quote on a game: 500,000 units at tick 204, minimum 0, expiring 3,000 seconds on the chain's clock. */
export async function quote(stack: Stack, M: HDAccount, gameId: bigint): Promise<string> {
  const T = await stack.rig.time();
  const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 3_000n, oddsTick: 204, riskAmount: 500_000n, minFill: 0n, gameId }), positionType: 0 };
  const posted = await postOrder(stack.courier.url, stack.rig, M, 'rest', q, from(posts++));
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return String(posted.body.orderHash).toLowerCase();
}

interface CrossTimes {
  state: string;
  hand_offs: number;
  tx_hash: string | null;
  nonce: string | null;
  receipt_block_number: string | null;
  receipt_block_hash: string | null;
  final_block_number: string | null;
  gas_used: string | null;
  effective_gas_price: string | null;
  received_at: Date;
  intent_at: Date | null;
  signed_at: Date | null;
  gate_at: Date | null;
  answered_at: Date | null;
  receipt_seen_at: Date | null;
  outcome_at: Date | null;
  proofF: string | null;
}

export async function crossOf(pool: pg.Pool, bet: string): Promise<CrossTimes | null> {
  const { rows } = await pool.query<CrossTimes>(
    `SELECT c.state, c.hand_offs, c.tx_hash, c.nonce::text AS nonce, c.receipt_block_number::text AS receipt_block_number, c.receipt_block_hash,
            c.final_block_number::text AS final_block_number, c.gas_used::text AS gas_used, c.effective_gas_price::text AS effective_gas_price,
            o.received_at, c.intent_at, c.signed_at, c.gate_at, c.answered_at, c.receipt_seen_at, c.outcome_at,
            c.checked->'send'->'nonce'->'final'->>'number' AS "proofF"
     FROM orders o LEFT JOIN crosses c ON c.bet_hash = o.hash WHERE o.hash = $1`,
    [bet.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function finalOf(stack: Stack, pool: pg.Pool, bet: string, ms = 120_000): Promise<CrossTimes> {
  return (await until(stack, () => crossOf(pool, bet), (c) => c !== null && FINAL.includes(String(c.state)), ms, `the Cross of ${bet}`)) as CrossTimes;
}

export interface Lane {
  to: bigint;
  anchor: { number: bigint; hash: Hex } | null;
}

export async function laneOf(stack: Stack, pool: pg.Pool): Promise<Lane> {
  const { rows } = await pool.query<{ to: string; n: string | null; h: Hex | null }>(
    'SELECT verified_nonce_to::text AS to, verified_block_number::text AS n, verified_block_hash AS h FROM lanes WHERE sender = $1',
    [stack.rig.accounts.sender.address.toLowerCase()],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('the lane has no row');
  return { to: BigInt(r.to), anchor: r.n === null || r.h === null ? null : { number: BigInt(r.n), hash: r.h } };
}

const coinAbi = (stack: Stack) => stack.rig.abis.TestCoin as Abi;
const balance = (stack: Stack, who: string) => stack.rig.read<bigint>(stack.rig.addresses.coin, coinAbi(stack), 'balanceOf', [who]);
const pol = async (stack: Stack, who: string) => BigInt((await stack.rig.rpc('eth_getBalance', [who, 'latest'])) as string);

export interface Sent {
  bet: string;
  cross: CrossTimes;
  /** Each request the courier made from the bet's post to its outcome, in order. */
  requests: Counted[];
  /** Wall time from the moment before the post to the bet's hand-off, its receipt first seen, and its outcome, in ms. */
  wall: { toHandOff: number; toReceiptSeen: number; toOutcome: number };
  chain: { postedAt: { number: bigint; time: bigint }; fillBlock: { number: bigint; time: bigint }; expiry: bigint };
  coins: { bettor: bigint; maker: bigint; positions: bigint; keyPol: bigint };
  signed: number;
  handOffs: number;
  commands: number;
  rows: { events: number; legs: number; bytes: number };
}

/**
 * One cent on the away side at tick 196 against the maker's quote, posted when it is called, good until `expiry` on
 * the chain's clock (30 seconds past the chain's latest block time at the post, where none is given), and followed to
 * its outcome: what the courier asked of the chain meanwhile, the bet's times by the records and by the chain, the
 * coins, the signatures and hand-offs, the database's commands and the rows it wrote for the bet.
 */
export async function oneCent(stack: Stack, pool: pg.Pool, B: HDAccount, gameId: bigint, expiry?: bigint): Promise<Sent> {
  const hooks = stack.courier.hooks as HookControl;
  const key = stack.rig.accounts.sender.address;
  const at = await head(stack);
  const until = expiry ?? at.time + 30n;
  const before = {
    bettor: await balance(stack, B.address),
    positions: await balance(stack, stack.rig.addresses.positions),
    keyPol: await pol(stack, key),
    signed: hooks.signed.length,
    handOffs: stack.proxy.count('eth_sendRawTransaction'),
    commands: stack.dbRelay.commands(),
    counted: stack.proxy.counted.length,
  };
  const b: Order = { ...orderOn(stack.rig, B, { expiry: until, oddsTick: 196, riskAmount: 10_000n, gameId }), positionType: 1 };
  const t0 = Date.now();
  const taken = await postOrder(stack.courier.url, stack.rig, B, 'take', b, from(posts++));
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  assert.equal(taken.body.state, 'queued', JSON.stringify(taken.body));
  const bet = String(taken.body.orderHash).toLowerCase();
  const cross = await finalOf(stack, pool, bet);
  const requests = stack.proxy.counted.slice(before.counted);
  const receipt = cross.tx_hash === null ? null : ((await stack.rig.rpc('eth_getTransactionReceipt', [cross.tx_hash])) as { blockNumber: Hex } | null);
  const fill = receipt === null ? null : ((await stack.rig.rpc('eth_getBlockByNumber', [receipt.blockNumber, false])) as { number: Hex; timestamp: Hex });
  const rows = await pool.query<{ events: number; legs: number; bytes: number }>(
    `SELECT (SELECT count(*)::int FROM events WHERE bet_hash = $1) AS events, (SELECT count(*)::int FROM legs WHERE bet_hash = $1) AS legs,
            ((SELECT coalesce(sum(pg_column_size(e.*)), 0) FROM events e WHERE e.bet_hash = $1) + (SELECT coalesce(sum(pg_column_size(c.*)), 0) FROM crosses c WHERE c.bet_hash = $1)
             + (SELECT coalesce(sum(pg_column_size(l.*)), 0) FROM legs l WHERE l.bet_hash = $1))::int AS bytes`,
    [bet],
  );
  const ms = (d: Date | null) => (d === null ? -1 : d.getTime() - t0);
  return {
    bet,
    cross,
    requests,
    wall: { toHandOff: ms(cross.answered_at), toReceiptSeen: ms(cross.receipt_seen_at), toOutcome: ms(cross.outcome_at) },
    chain: { postedAt: at, fillBlock: fill === null ? { number: -1n, time: -1n } : { number: BigInt(fill.number), time: BigInt(fill.timestamp) }, expiry: until },
    coins: {
      bettor: (await balance(stack, B.address)) - before.bettor,
      maker: 0n,
      positions: (await balance(stack, stack.rig.addresses.positions)) - before.positions,
      keyPol: before.keyPol - (await pol(stack, key)),
    },
    signed: hooks.signed.length - before.signed,
    handOffs: stack.proxy.count('eth_sendRawTransaction') - before.handOffs,
    commands: stack.dbRelay.commands() - before.commands,
    rows: rows.rows[0] ?? { events: 0, legs: 0, bytes: 0 },
  };
}

/** Holds a sent bet to the one-cent fill, to the unit: the coins, the key's gas, one signature and one hand-off. */
export function filledOnce(s: Sent, makerDelta: bigint): void {
  assert.equal(s.cross.state, 'confirmed', JSON.stringify(s.cross));
  assert.deepEqual({ signed: s.signed, handOffs: s.handOffs, recordHandOffs: s.cross.hand_offs }, { signed: 1, handOffs: 1, recordHandOffs: 1 }, 'one signature and one hand-off');
  assert.equal(s.coins.bettor, -9_984n, "the bettor's coin, down 9,984");
  assert.equal(makerDelta, -9_600n, "the maker's coin, down 9,600");
  assert.equal(s.coins.positions, 19_584n, 'the positions contract, up 19,584');
  assert.equal(s.coins.keyPol, BigInt(s.cross.gas_used as string) * BigInt(s.cross.effective_gas_price as string), "the key's POL, down by the gas used times the price paid");
}

/** The reads of a block's header in a bet's path, from its post to its outcome, sorted by what they are for. */
export interface Ancestry {
  /** Headers read by number more than 256 blocks below the final block of the bet's check, in the order read. */
  deep: bigint[];
  /** Headers read by number at the final block of the bet's check: its last check of F. */
  atF: number;
  /** Every other header read by number: the check's own last read of its latest block, H. */
  other: bigint[];
  /** Headers read by hash: the hashes named. */
  byHash: string[];
}

export function ancestryOf(s: Sent): Ancestry {
  const F = s.cross.proofF === null ? null : BigInt(s.cross.proofF);
  const nums = s.requests.map(numbered).filter((n): n is bigint => n !== null);
  return {
    deep: nums.filter((n) => F !== null && n + 256n < F),
    atF: nums.filter((n) => F !== null && n === F).length,
    other: nums.filter((n) => F === null || (n + 256n >= F && n !== F)),
    byHash: s.requests.filter((c) => c.method === 'eth_getBlockByHash').map((c) => String(c.params?.[0]).toLowerCase()),
  };
}

export interface Earlier {
  bet: string;
  anchor: { number: bigint; hash: Hex };
  receipt: { number: bigint; hash: Hex };
}

/** After the earlier Cross: the lane's watermark anchor and that Cross's receipt, as the records hold them. */
export async function earlierOf(stack: Stack, pool: pg.Pool, bet: string): Promise<Earlier> {
  const lane = await laneOf(stack, pool);
  const c = await crossOf(pool, bet);
  if (lane.anchor === null || c?.receipt_block_number == null || c.receipt_block_hash == null) throw new Error(`no anchor or no receipt after the earlier Cross: ${JSON.stringify({ lane, c }, (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`);
  return { bet, anchor: lane.anchor, receipt: { number: BigInt(c.receipt_block_number), hash: c.receipt_block_hash as Hex } };
}

/**
 * The one-cent bet at 7:12:00 PM Central time on the chain's clock, good until 7:12:30, after whatever came before:
 * a new game, a maker and a bettor funded, the clock set so that its block of 19:11:50 opens a block every two
 * seconds, the maker's quote posted, and the bet posted once the latest block carries 19:12:00.
 */
export async function at1912(stack: Stack, pool: pg.Pool, first: number): Promise<{ sent: Sent; target: bigint; makerDelta: bigint; ancestry: Ancestry }> {
  await instant(stack);
  const game = await stack.rig.createGame();
  const { M, B } = await funded(stack, first);
  const target = next1912((await stack.rig.time()) + 120n);
  await clockFrom(stack, target - 10n);
  const chainTime = async () => (await head(stack)).time;
  await until(stack, chainTime, (t) => t >= target - 10n, 30_000, 'the chain at 19:11:50');
  const makerBefore = await balance(stack, M.address);
  await quote(stack, M, game);
  await until(stack, chainTime, (t) => t >= target, 30_000, 'the chain at 19:12:00');
  const sent = await oneCent(stack, pool, B, game, target + 30n);
  return { sent, target, makerDelta: (await balance(stack, M.address)) - makerBefore, ancestry: ancestryOf(sent) };
}

/**
 * The bet after a quiet spell held to what the method promises: filled once inside its life, the fill block before
 * 7:12:30; its send checks read the earlier anchor's and the earlier receipt's headers by number, once each, and the
 * final block's own height once more; nothing read by hash but the new receipt's own block; and no other header read
 * below the window.
 */
export function heldAfterQuiet(r: { sent: Sent; target: bigint; makerDelta: bigint; ancestry: Ancestry }, earlier: Earlier): void {
  const { sent, target, ancestry } = r;
  filledOnce(sent, r.makerDelta);
  assert.ok(sent.chain.postedAt.time >= target && sent.chain.postedAt.time <= target + 2n, `posted at the block of 19:12:00, or the next: ${centralClock(sent.chain.postedAt.time)}`);
  assert.equal(sent.chain.expiry, target + 30n, 'good until 19:12:30');
  assert.ok(sent.chain.fillBlock.time < sent.chain.expiry, `the fill block's time, ${centralClock(sent.chain.fillBlock.time)}, before 19:12:30`);
  assert.deepEqual(
    { deep: ancestry.deep.map(String), atF: ancestry.atF },
    { deep: [earlier.anchor.number, earlier.receipt.number].sort((a, b) => (a < b ? -1 : 1)).map(String), atF: 1 },
    `the anchor's and the earlier receipt's headers by number, once each, and F's own height once: ${JSON.stringify({ deep: ancestry.deep.map(String), atF: ancestry.atF, other: ancestry.other.map(String) })}`,
  );
  const newReceipt = String(sent.cross.receipt_block_hash).toLowerCase();
  assert.ok(ancestry.byHash.every((h) => h === newReceipt), `by hash, only the new receipt's own block: ${JSON.stringify(ancestry.byHash)}`);
}

/** The record of a bet's path, for the run's log: its times by the records and the chain, its reads, and its costs. */
export function said(what: string, r: { sent: Sent; target: bigint; ancestry: Ancestry }, extra: Record<string, unknown> = {}): string {
  const s = r.sent;
  return `# ${what}: ${JSON.stringify(
    {
      ...extra,
      chain: { postedAt: { number: String(s.chain.postedAt.number), clock: centralClock(s.chain.postedAt.time) }, fillBlock: { number: String(s.chain.fillBlock.number), clock: centralClock(s.chain.fillBlock.time) }, expiry: centralClock(s.chain.expiry), proofF: s.cross.proofF },
      wallMs: s.wall,
      ancestry: { deep: r.ancestry.deep.map(String), atF: r.ancestry.atF, otherByNumber: r.ancestry.other.map(String), byHash: r.ancestry.byHash.length },
      requests: byMethod(s.requests),
      databaseCommands: s.commands,
      rows: s.rows,
      gas: { used: s.cross.gas_used, price: s.cross.effective_gas_price },
    },
  )}`;
}

/**
 * A file's cases for one long quiet spell (tests/quiet-41000.test.ts, tests/quiet-day.test.ts): a real earlier Cross;
 * then the spell, `total` empty blocks, mined in steps of `step` blocks, each a case of its own under the ten-minute
 * time-out, in each of which the courier asks the chain nothing and writes nothing; then the bet at 7:12:00 PM. The
 * chain keeps the state at only its latest 1,024 blocks, so that it can grow by a day of blocks inside the cases' time;
 * its blocks and receipts are all kept (tests/support/rig.ts).
 */
export function quietSpellCases(prefix: string, what: string, total: number, step: number): void {
  let stack: Stack;
  let pool: pg.Pool;
  let earlier: Earlier | null = null;
  const steps: Step[] = [];
  before(async () => {
    stack = await startStack(prefix, { hooked: true, blockTime: 2, sending: true, keptStates: 1_024 });
    stack.proxy.finalFollows(1n);
    pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  });
  after(() => closeEach(() => pool?.end(), () => stack?.close()));

  test(`${what}, its earlier Cross: a real bet of one cent sent and filled once, the lane's watermark anchored at its check's final block, below the bet's own receipt`, async () => {
    await instant(stack);
    const game = await stack.rig.createGame();
    const { M, B } = await funded(stack, 40);
    const makerBefore = await balance(stack, M.address);
    await quote(stack, M, game);
    await clockFrom(stack);
    const sent = await oneCent(stack, pool, B, game);
    filledOnce(sent, (await balance(stack, M.address)) - makerBefore);
    earlier = await earlierOf(stack, pool, sent.bet);
    assert.ok(earlier.anchor.number < earlier.receipt.number, 'the anchor below the receipt');
  });

  const n = Math.ceil(total / step);
  for (let i = 0; i < n; i++) {
    const blocks = Math.min(step, total - i * step);
    test(`${what}, its quiet spell, step ${i + 1} of ${n}: ${blocks.toLocaleString('en-US')} empty blocks with no bet and nothing of the courier's to do; the courier asks the chain nothing and writes nothing`, async () => {
      assert.ok(earlier !== null, 'the earlier Cross');
      const s = await quietStep(stack, pool, blocks);
      steps.push(s);
      assert.deepEqual({ requests: s.requests, recordsUnchanged: s.recordsUnchanged }, { requests: {}, recordsUnchanged: true }, 'nothing asked of the chain, nothing written');
      console.log(`# ${what}, step ${i + 1} of ${n}, measured: ${JSON.stringify({ blocks, minedMs: s.ms, from: String(s.from.number), to: String(s.to.number), chainSeconds: String(s.to.time - s.from.time) })}`);
    });
  }

  test(`${what}, then the bet: one cent at 7:12:00 PM on the chain's clock, good until 7:12:30, handed off and filled before 7:12:30 with one signature and one hand-off, the coins to the unit; its send checks read the earlier anchor's and the earlier receipt's headers by number, once each, and the final block's own height once more, and no header by hash but the new receipt's own`, async () => {
    assert.ok(earlier !== null, 'the earlier Cross');
    const mined = steps.reduce((sum, s) => sum + s.blocks, 0);
    assert.equal(mined, total, `the whole spell mined: ${mined} of ${total} blocks`);
    const r = await at1912(stack, pool, 42);
    assert.ok(BigInt(r.sent.cross.proofF as string) - earlier.receipt.number >= BigInt(total), "the earlier receipt the spell's blocks below the final block of the check");
    heldAfterQuiet(r, earlier);
    console.log(`# ${what}, the spell measured: ${JSON.stringify({ blocks: mined, minedMs: steps.reduce((sum, s) => sum + s.ms, 0), chainSeconds: String(steps.reduce((sum, s) => sum + (s.to.time - s.from.time), 0n)) })}`);
    console.log(said(`${what}, the first bet after it`, r, { earlier: { anchor: String(earlier.anchor.number), receipt: String(earlier.receipt.number) } }));
  });
}

export { balance };
