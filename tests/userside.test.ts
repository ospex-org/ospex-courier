import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import pg from 'pg';
import { get as getFrom, type HookControl } from './support/courier';
import { orderOn, postOrder as postOrderFrom, type Order } from './support/orders';
import { closeEach } from './support/close';
import { startStack, type Stack } from './support/stack';
import { outcomes, postStop as postStopFrom, resultsOf, stopMessage } from './support/stops';

// The sender from a user's side, on a chain that mines a block every two
// seconds and whose final block follows its head: one bet end to end, read to
// the unit; each state a bettor can read, beside its control; and what the
// operator sees. Amounts are the coin's units, six to the USDC.

let stack: Stack;
let pool: pg.Pool;
const url = () => stack.courier.url;
const hooks = () => stack.courier.hooks as HookControl;
const handOffs = () => stack.proxy.count('eth_sendRawTransaction');
const signed = () => stack.courier.hooks?.signed.length ?? 0;
/** One transaction's requests: those at the proxy that carried its own bytes. None for a Cross with no transaction. */
const requestsOf = (txHash: string | null | undefined): number =>
  txHash === null || txHash === undefined ? 0 : stack.proxy.counted.filter((r) => r.sent !== undefined && keccak256(r.sent as Hex).toLowerCase() === txHash.toLowerCase()).length;
/** The signatures that carry this account's order: one bet's, where the account is that bet's alone. */
const signedFor = (who: string): number => (stack.courier.hooks?.signed ?? []).filter((raw) => raw.toLowerCase().includes(who.slice(2).toLowerCase())).length;

let from: Record<string, string> = {};
let nextAddress = 0;
beforeEach(() => {
  const n = nextAddress++;
  from = { 'x-forwarded-for': `198.18.${1 + Math.floor(n / 250)}.${1 + (n % 250)}` };
});
const postOrder = (...a: Parameters<typeof postOrderFrom>) => postOrderFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const postStop = (...a: Parameters<typeof postStopFrom>) => postStopFrom(a[0], a[1], a[2], a[3], a[4], a[5] ?? from);
const get = (path: string) => getFrom(url(), path, from);

before(async () => {
  stack = await startStack('userside', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

let nextAccount = 40;
async function fresh(): Promise<HDAccount> {
  const who = stack.rig.account(nextAccount++);
  await stack.rig.fund(who);
  return who;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)} after ${ms} ms; the courier's last lines: ${stack.courier.lines.slice(-6).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const FINAL = ['confirmed', 'reverted', 'not sent', 'expired unmined', 'replaced'];
const crossOf = async (bet: string) => (await pool.query<{ state: string; tx_hash: string | null; nonce: string | null; max_fee_per_gas: string | null; max_priority_fee: string | null; gas_used: string | null; effective_gas_price: string | null }>('SELECT state, tx_hash, nonce::text AS nonce, max_fee_per_gas::text AS max_fee_per_gas, max_priority_fee::text AS max_priority_fee, gas_used::text AS gas_used, effective_gas_price::text AS effective_gas_price FROM crosses WHERE bet_hash = $1', [bet.toLowerCase()])).rows[0] ?? null;
const final = (bet: string, ms = 90_000) => until(() => crossOf(bet), (c) => c !== null && FINAL.includes(c.state), ms, `the Cross of ${bet}`);
const coin = () => stack.rig.abis.TestCoin as Abi;
const balance = (who: string) => stack.rig.read<bigint>(stack.rig.addresses.coin, coin(), 'balanceOf', [who]);
const pol = async (who: string) => BigInt((await stack.rig.rpc('eth_getBalance', [who, 'latest'])) as string);

async function postQuote(M: HDAccount, fields: Partial<Order> = {}): Promise<{ hash: string; order: Order }> {
  const T = await stack.rig.time();
  const q: Order = { ...orderOn(stack.rig, M, { expiry: T + 600n, oddsTick: 204, riskAmount: 9_600n, minFill: 0n, ...fields }), positionType: 0 };
  const posted = await postOrder(url(), stack.rig, M, 'rest', q);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return { hash: posted.body.orderHash as string, order: q };
}

async function postBet(B: HDAccount, fields: Partial<Order> = {}): Promise<{ status: number; hash: string; body: Record<string, unknown> }> {
  const T = await stack.rig.time();
  const b: Order = { ...orderOn(stack.rig, B, { expiry: T + 30n, oddsTick: 196, riskAmount: 10_000n, ...fields }), positionType: 1 };
  const taken = await postOrder(url(), stack.rig, B, 'take', b);
  return { status: taken.status, hash: taken.body.orderHash as string, body: taken.body };
}

test('one bet end to end, read to the unit: a quote of 500,000 at tick 204 and one cent at 196; the coin moves exactly by the receipt\'s pulls, the key pays exactly the gas used times the price paid, the record is confirmed with its leg, its fees, its cost and its blocks, the quote keeps 490,400 of room on its record and its market\'s page, and a stop of it after is stopped with no handOff', async () => {
  const M = await fresh();
  const B = await fresh();
  const key = stack.rig.accounts.sender.address;
  const quote = await postQuote(M, { riskAmount: 500_000n });
  const before = { m: await balance(M.address), b: await balance(B.address), positions: await balance(stack.rig.addresses.positions), pol: await pol(key), s: signed(), h: handOffs(), commands: stack.dbRelay.commands(), byMethod: { ...stack.proxy.counted.reduce<Record<string, number>>((o, c) => ((o[c.method] = (o[c.method] ?? 0) + 1), o), {}) } };
  const bet = await postBet(B);
  assert.equal(bet.status, 202);
  assert.equal(bet.body.state, 'queued');
  const c = await final(bet.hash);
  assert.equal(c?.state, 'confirmed', JSON.stringify(c));
  assert.equal((await balance(B.address)) - before.b, -9_984n, "the bettor's coin, down 9,984");
  assert.equal((await balance(M.address)) - before.m, -9_600n, "the maker's coin, down 9,600");
  assert.equal((await balance(stack.rig.addresses.positions)) - before.positions, 19_584n, 'the positions contract, up 19,584');
  assert.equal(before.pol - (await pol(key)), BigInt(c?.gas_used as string) * BigInt(c?.effective_gas_price as string), "the key's POL, down by exactly the gas used times the price paid");
  assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 1, h: 1 });
  const record = await get(`/v1/orders/${bet.hash}`);
  const cross = record.body.cross as { legs: Array<{ recorded?: { makerRisk: string; takerRisk: string } }>; fees: { cap: string; tip: string; paid: string }; cost: string; receipt: { block: { number: string } }; final: { number: string; time: string }; betFilled: string };
  assert.equal(record.body.state, 'confirmed');
  assert.deepEqual(cross.legs.map((l) => l.recorded), [{ makerRisk: '9600', takerRisk: '9984' }]);
  assert.equal(cross.fees.cap, c?.max_fee_per_gas);
  assert.equal(cross.fees.paid, c?.effective_gas_price);
  assert.equal(cross.betFilled, '9984');
  assert.ok(BigInt(cross.final.number) >= BigInt(cross.receipt.block.number));
  const q = await get(`/v1/orders/${quote.hash}`);
  assert.equal(q.body.state, 'resting');
  const lines = await pool.query<{ kind: string }>('SELECT kind FROM events WHERE bet_hash = $1 ORDER BY number', [bet.hash.toLowerCase()]);
  // Sent, then confirmed; pending between them where the receipt was first seen above the final block.
  const kinds = lines.rows.map((l) => l.kind).filter((k) => k.startsWith('cross'));
  assert.ok(['cross sent,cross confirmed', 'cross sent,cross pending,cross confirmed'].includes(kinds.join(',')), kinds.join(', '));
  const stop = await postStop(url(), stack.rig, M, stopMessage(M.address, [quote.hash as Hex]));
  assert.deepEqual(outcomes(stop), ['stopped']);
  assert.equal('handOff' in (resultsOf(stop)[0] as object), false, 'the Cross is final: no handOff');
  // What was counted, said for the record.
  const byMethod = stack.proxy.counted.reduce<Record<string, number>>((o, x) => ((o[x.method] = (o[x.method] ?? 0) + 1), o), {});
  const delta = Object.fromEntries(Object.entries(byMethod).map(([m, n]) => [m, n - (before.byMethod[m] ?? 0)]).filter(([, n]) => (n as number) > 0));
  console.log(`# one sent bet, end to end: node requests by method ${JSON.stringify(delta)}; database commands ${stack.dbRelay.commands() - before.commands}`);
});

test('the replacement, by the plan\'s own case: Cross 1 kept from the chain until it is expired unmined; Cross 2, the next bet, signed at the same nonce with each fee a quarter higher and kept too; then Cross 1 let through: it mines and reverts, Cross 1 becomes reverted and Cross 2 replaced, by the courier\'s own transaction, each in a transaction of its own', async () => {
  const kept = stack.proxy.withhold();
  try {
    await postQuote(await fresh());
    const first = await postBet(await fresh());
    const c1 = await until(() => crossOf(first.hash), (c) => c?.state === 'sent', 30_000, 'Cross 1 sent');
    const e1 = await final(first.hash, 90_000);
    assert.equal(e1?.state, 'expired unmined');
    await postQuote(await fresh());
    const second = await postBet(await fresh());
    const c2 = await until(() => crossOf(second.hash), (c) => c?.state === 'sent', 60_000, 'Cross 2 sent');
    assert.equal(c2?.nonce, c1?.nonce, 'the same nonce');
    assert.ok(BigInt(c2?.max_fee_per_gas as string) * 100n >= BigInt(c1?.max_fee_per_gas as string) * 125n, 'the cap a quarter higher at least');
    assert.ok(BigInt(c2?.max_priority_fee as string) * 100n >= BigInt(c1?.max_priority_fee as string) * 125n, 'the tip a quarter higher at least');
    // Cross 1 let through, alone.
    await stack.rig.rpc('eth_sendRawTransaction', [kept.kept[0]]);
    const r1 = await until(() => crossOf(first.hash), (c) => c?.state === 'reverted', 90_000, 'Cross 1 reverted');
    assert.equal(r1?.state, 'reverted');
    const r2 = await final(second.hash, 90_000);
    assert.equal(r2?.state, 'replaced', JSON.stringify(r2));
    const by = await pool.query<{ replaced_by: string; replaced_by_ours: boolean }>('SELECT replaced_by, replaced_by_ours FROM crosses WHERE bet_hash = $1', [second.hash.toLowerCase()]);
    assert.deepEqual(by.rows[0], { replaced_by: c1?.tx_hash, replaced_by_ours: true });
  } finally {
    kept.stop();
  }
});

test("the wallet's form of COURIER_CANNOT_SEND: the key's POL set under what the gas limit times the fee cap needs, though above the low-wallet mark; refused, with its ACTION, nothing signed; then topped up, and the next bet is sent", async () => {
  const key = stack.rig.accounts.sender.address;
  const keep = await pol(key);
  await until(async () => (await pool.query<{ held_bet: string | null }>('SELECT held_bet FROM lanes')).rows.every((r) => r.held_bet === null), (v) => v, 60_000, 'the lane free');
  // Below one Cross's need at any price this chain charges, and above 3 POL: the setting's default mark.
  await stack.rig.rpc('anvil_setBalance', [key, `0x${(10n ** 13n).toString(16)}`]);
  try {
    const before = { s: signed(), h: handOffs() };
    await postQuote(await fresh());
    const bet = await postBet(await fresh());
    const refused = await until(async () => (await get(`/v1/orders/${bet.hash}`)).body, (b) => b.state === 'refused', 60_000, 'the wallet refusal');
    const verdict = refused.verdict as { code: string; form: string; action: { case: string } };
    assert.deepEqual([verdict.code, verdict.form, verdict.action.case], ['COURIER_CANNOT_SEND', 'wallet', 'wallet-cannot-send']);
    assert.deepEqual({ s: signed() - before.s, h: handOffs() - before.h }, { s: 0, h: 0 });
  } finally {
    await stack.rig.rpc('anvil_setBalance', [key, `0x${keep.toString(16)}`]);
  }
  await postQuote(await fresh());
  const next = await postBet(await fresh());
  assert.equal((await final(next.hash))?.state, 'confirmed');
});

test('a quote cancelled on chain in the window, in a Cross of two quotes: the receipt skips its leg Cancelled and fills the other; the record says so, and the cancelled quote is marked at the final block', async () => {
  const M1 = await fresh();
  const M2 = await fresh();
  // A game of its own, so the bet lists these two quotes and no other case's.
  const gameId = await stack.rig.createGame({ startWritten: true });
  const q1 = await postQuote(M1, { riskAmount: 4_800n, gameId });
  await postQuote(M2, { riskAmount: 4_800n, gameId });
  await hooks().arm('after-gate', 1);
  await hooks().arm('after-hand-off', 1);
  const bet = await postBet(await fresh(), { minFill: 0n, gameId });
  const gate = await hooks().reached('after-gate');
  await stack.rig.rpc('evm_setIntervalMining', [0]);
  await hooks().go(gate);
  const handed = await hooks().reached('after-hand-off');
  try {
    const nonce = Number(BigInt((await stack.rig.rpc('eth_getTransactionCount', [M1.address, 'pending'])) as string));
    const block = (await stack.rig.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
    const data = encodeFunctionData({ abi: stack.rig.abis.OspexMatching as Abi, functionName: 'cancelOrder', args: [q1.order] } as never);
    const raw = await M1.signTransaction({ type: 'eip1559', chainId: 31337, to: stack.rig.addresses.matching, data, value: 0n, nonce, gas: 200_000n, maxFeePerGas: BigInt(block.baseFeePerGas) * 3n + 50_000_000_000n, maxPriorityFeePerGas: 50_000_000_000n });
    await stack.rig.rpc('eth_sendRawTransaction', [raw]);
    await stack.rig.rpc('anvil_mine', ['0x1']);
  } finally {
    await stack.rig.rpc('evm_setIntervalMining', [2]);
    await hooks().go(handed);
  }
  const c = await final(bet.hash);
  assert.equal(c?.state, 'confirmed', JSON.stringify(c));
  const legs = await pool.query<{ order_hash: string; skip_reason: string | null; recorded_maker_risk: string | null }>('SELECT order_hash, skip_reason, recorded_maker_risk::text AS recorded_maker_risk FROM legs WHERE bet_hash = $1 ORDER BY position', [bet.hash.toLowerCase()]);
  assert.equal(legs.rows[0]?.order_hash, q1.hash.toLowerCase());
  assert.equal(legs.rows[0]?.skip_reason, 'Cancelled');
  assert.ok(legs.rows[1]?.recorded_maker_risk !== null);
  const mark = await pool.query<{ ended: string; ended_final: boolean }>('SELECT ended, ended_final FROM orders WHERE hash = $1', [q1.hash.toLowerCase()]);
  assert.deepEqual(mark.rows[0], { ended: 'cancelled', ended_final: true });
  const record = await get(`/v1/orders/${bet.hash}`);
  assert.match((record.body.cross as { message: string }).message, /The chain skipped 1 of the quotes listed: Cancelled\./);
});

test('the idle test: with nothing to do, no row is written; with an open Cross being looked at, the looks write no row', async () => {
  const rows = async () => (await pool.query<{ n: string }>(`SELECT (SELECT count(*) FROM events) + (SELECT count(*) FROM crosses) + (SELECT count(*) FROM orders) + (SELECT count(*) FROM conditions) AS n`)).rows[0]?.n;
  await until(async () => (await pool.query<{ held_bet: string | null }>('SELECT held_bet FROM lanes')).rows.every((r) => r.held_bet === null), (v) => v, 90_000, 'the lane free');
  const idle = await rows();
  await new Promise((r) => setTimeout(r, 8_000));
  assert.equal(await rows(), idle, 'nothing to do: no row');
  const kept = stack.proxy.withhold();
  try {
    stack.proxy.finalFollows(null);
    stack.proxy.setFinal(BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string));
    await postQuote(await fresh());
    const bet = await postBet(await fresh());
    await until(() => crossOf(bet.hash), (c) => c?.state === 'sent', 30_000, 'sent');
    const looking = await rows();
    await new Promise((r) => setTimeout(r, 8_000));
    assert.equal(await rows(), looking, 'an open Cross looked at: no row a look');
  } finally {
    kept.stop();
    stack.proxy.setFinal(null);
    stack.proxy.finalFollows(1n);
  }
});

test("the pause's carries: the reserved code is on the page and issued by no path of the program; and a bet refused at check 16's place, the account's bound on bets waiting, is refused there, with no request of the pre-check made for it", async () => {
  const api = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');
  assert.match(api, /\| `ACCOUNT_PAUSED` \| — \| reserved \| Kept for the build that issues it, at the door, for a bet; this build never issues it\. \|/);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(new URL('../courier', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(files.length > 10);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /ACCOUNT_PAUSED/, `${f} issues the reserved code`);
  // Check 16: the lane held, two of one account's bets waiting; its third is refused at the door.
  await until(async () => (await pool.query<{ held_bet: string | null }>('SELECT held_bet FROM lanes')).rows.every((r) => r.held_bet === null), (v) => v, 90_000, 'the lane free');
  await hooks().arm('after-reservation', 1);
  await postQuote(await fresh());
  const first = await postBet(await fresh());
  const held = await hooks().reached('after-reservation');
  try {
    const A = await fresh();
    // Three distinct bets of the account, by their expiry: the third is over its bound of two waiting.
    const T = await stack.rig.time();
    assert.equal((await postBet(A, { expiry: T + 30n })).status, 202);
    assert.equal((await postBet(A, { expiry: T + 29n })).status, 202);
    const estimates = stack.proxy.count('eth_estimateGas');
    const third = await postBet(A, { expiry: T + 28n });
    assert.equal(third.status, 503, JSON.stringify(third.body));
    assert.equal(third.body.code, 'QUEUE_FULL');
    assert.equal(stack.proxy.count('eth_estimateGas'), estimates, 'no request of the pre-check for it');
  } finally {
    await hooks().go(held);
  }
  await final(first.hash);
});

test("the bettor's record of not sent's third reason: the node refuses the one hand-off by name, and the record reads not sent NODE_REFUSED with the refusal's words, handed once and never again, and nothing of the bet filled; the next bet is sent and fills the same quote", async () => {
  // A game of its own, so the bet lists this quote and no other case's.
  const gameId = await stack.rig.createGame({ startWritten: true });
  const quote = await postQuote(await fresh(), { gameId });
  const B = await fresh();
  const paid = await balance(B.address);
  // The node refuses, by one of the named refusals, the hand-off of the one transaction that carries B's order.
  const ofB = B.address.slice(2).toLowerCase();
  stack.proxy.rule('eth_sendRawTransaction', { kind: 'refuseIf', refuse: (params) => typeof params[0] === 'string' && params[0].toLowerCase().includes(ofB), code: -32000, message: 'txpool is full' });
  let hash: string;
  try {
    const bet = await postBet(B, { gameId });
    assert.equal(bet.status, 202, JSON.stringify(bet.body));
    hash = bet.hash;
    await final(hash);
  } finally {
    stack.proxy.rule('eth_sendRawTransaction', null);
  }
  const record = await get(`/v1/orders/${hash}`);
  assert.equal(record.status, 200);
  assert.equal(record.body.state, 'not sent', JSON.stringify(record.body));
  const cross = record.body.cross as { state: string; reason: string | null; handOffs: number; answer: unknown; message: string; txHash: string };
  assert.deepEqual([cross.state, cross.reason, cross.handOffs], ['not sent', 'NODE_REFUSED', 1]);
  assert.deepEqual(cross.answer, { kind: 'refused', words: 'txpool is full' });
  assert.match(cross.message, /^The courier handed this bet's fill to the chain once, and the node refused it: txpool is full\. It was not handed again, and this courier filled nothing of it\./);
  // What the record says, held to: one signature of B's order, one request carrying its bytes, nothing of the bet filled.
  assert.deepEqual({ signed: signedFor(B.address), requests: requestsOf(cross.txHash) }, { signed: 1, requests: 1 });
  assert.equal(await balance(B.address), paid, 'the bettor paid nothing in');
  // The lane goes on: the next bet is sent and fills the quote the refused one listed, and the refused transaction is not handed again.
  const next = await postBet(await fresh(), { gameId });
  const filled = await final(next.hash);
  assert.equal(filled?.state, 'confirmed', JSON.stringify(filled));
  const legs = await pool.query<{ order_hash: string }>('SELECT order_hash FROM legs WHERE bet_hash = $1 ORDER BY position', [next.hash.toLowerCase()]);
  assert.deepEqual(legs.rows.map((l) => l.order_hash), [quote.hash.toLowerCase()]);
  assert.equal(requestsOf(cross.txHash), 1, 'the refused transaction, never handed again');
});

test("the maker's side: a quote stopped while no Cross lists it reads stopped with no handOff; the replacement posted at once is filled by the next bet, and the stopped quote fills nothing", async () => {
  // A game of its own, so the bet lists this maker's quotes and no other case's.
  const gameId = await stack.rig.createGame({ startWritten: true });
  const M = await fresh();
  const old = await postQuote(M, { gameId });
  const stop = await postStop(url(), stack.rig, M, stopMessage(M.address, [old.hash as Hex]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.deepEqual(outcomes(stop), ['stopped']);
  assert.equal('handOff' in (resultsOf(stop)[0] as object), false, 'stopped, with no handOff');
  // At once, on that answer: the replacement, at the same price and size.
  const replacement = await postQuote(M, { gameId });
  const bet = await postBet(await fresh(), { gameId });
  const c = await final(bet.hash);
  assert.equal(c?.state, 'confirmed', JSON.stringify(c));
  const legs = await pool.query<{ order_hash: string }>('SELECT order_hash FROM legs WHERE bet_hash = $1 ORDER BY position', [bet.hash.toLowerCase()]);
  assert.deepEqual(legs.rows.map((l) => l.order_hash), [replacement.hash.toLowerCase()], 'the next bet lists the replacement, and not the stopped quote');
  const filledRisk = (h: string) => stack.rig.read<bigint>(stack.rig.addresses.matching, stack.rig.abis.OspexMatching as Abi, 's_filledRisk', [h]);
  assert.ok((await filledRisk(replacement.hash)) > 0n, 'the replacement filled');
  assert.equal(await filledRisk(old.hash), 0n, 'the stopped quote filled nothing');
});
