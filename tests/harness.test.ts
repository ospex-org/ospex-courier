import assert from 'node:assert/strict';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { bytesToHex, concat, decodeErrorResult, encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MATCHING_ABI, RELAY_ABI } from '../courier/chain/abi';
import { createJsonRpc, handOff, NodeFailure } from '../courier/chain/rpc';
import { testServer } from './support/database';
import { testAccountKey, testKeystoreFor } from './support/keystore';
import { orderOn, sign } from './support/orders';
import { startProxy, type ChainProxy } from './support/proxy';
import { artifact, startRig, type Rig } from './support/rig';
import { startTcpRelay } from './support/tcp';

// The harness the sender's cases stand on, each capability shown by a case of
// its own before anything depends on it: the local chain's trace of a mined
// transaction and its clock, a block every two seconds with its pool open,
// where a transaction of the test's own is placed before another in the same
// block; the chain's proxy, which answers the final block itself, holds, drops,
// refuses or answers a request, passes one on and holds its answer, and keeps a
// raw transaction from the chain while it answers for it; the database's relay,
// which drops a commit's acknowledgement after the commit; the coin that refuses
// by a rule of its own; and the run's test keystore. Nothing here starts a
// courier.

let rig: Rig;
let proxy: ChainProxy;

before(async () => {
  rig = await startRig();
  proxy = await startProxy(rig.url);
});

after(async () => {
  await proxy?.close();
  await rig?.close();
});

/** A raw transaction from `who` to `to`, signed with its key at the given nonce, gas and tip, and not sent. */
async function rawFrom(on: Rig, index: number, to: `0x${string}`, data: Hex, fees: { gas: bigint; tip: bigint; nonce?: number }): Promise<Hex> {
  const who = privateKeyToAccount(testAccountKey(index));
  const nonce = fees.nonce ?? Number(BigInt((await on.rpc('eth_getTransactionCount', [who.address, 'pending'])) as string));
  const block = (await on.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
  const maxFeePerGas = BigInt(block.baseFeePerGas) * 2n + fees.tip;
  return who.signTransaction({ type: 'eip1559', chainId: 31337, to, data, value: 0n, nonce, gas: fees.gas, maxFeePerGas, maxPriorityFeePerGas: fees.tip });
}

/** A Cross of one bet against no quote at all, from the relay's sender: the matching contract refuses it NothingFilled. */
async function refusedCross(on: Rig): Promise<Hex> {
  const T = await on.time();
  const bet = { ...orderOn(on, on.accounts.taker, { expiry: T + 25n, oddsTick: 196, riskAmount: 10_000n }), positionType: 1 as const };
  const signature = await sign(on.accounts.taker, bet, 31337, on.addresses.matching);
  return encodeFunctionData({ abi: RELAY_ABI, functionName: 'cross', args: [{ order: bet, signature }, []] } as never);
}

interface Frame {
  type?: string;
  to?: string;
  output?: Hex;
  error?: string;
  calls?: Frame[];
}

const frames = (f: Frame): Frame[] => [f, ...(f.calls ?? []).flatMap(frames)];

/** A transaction's receipt once the chain has mined it: at once, or a moment after the send's answer, as the local chain's versions differ. Ten seconds at most. */
async function minedReceipt<T>(on: Rig, hash: unknown): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const r = await on.rpc('eth_getTransactionReceipt', [hash]);
    if (r !== null) return r as T;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no receipt within ten seconds');
}

test('the local chain traces a mined transaction with the call tracer: one the contract refused, to its named refusal; one given too little gas, to running out of gas', async () => {
  const data = await refusedCross(rig);
  // Mined with a fixed limit, so nothing estimates it first: the chain takes it, and it reverts.
  const refused = await rig.rpc('eth_sendRawTransaction', [await rawFrom(rig, 4, rig.addresses.relay, data, { gas: 1_000_000n, tip: 1_000_000_000n })]);
  const r1 = await minedReceipt<{ status: Hex }>(rig, refused);
  assert.equal(r1.status, '0x0', 'mined, and failed');
  const t1 = (await rig.rpc('debug_traceTransaction', [refused, { tracer: 'callTracer' }])) as Frame;
  assert.equal(typeof t1.output, 'string', JSON.stringify(t1).slice(0, 400));
  const named = decodeErrorResult({ abi: MATCHING_ABI, data: t1.output as Hex });
  assert.equal(named.errorName, 'OspexMatching__NothingFilled');
  // Given less gas than its work needs: mined, failed, and the trace shows the frame that ran out.
  const starved = await rig.rpc('eth_sendRawTransaction', [await rawFrom(rig, 4, rig.addresses.relay, data, { gas: 40_000n, tip: 1_000_000_000n })]);
  const r2 = await minedReceipt<{ status: Hex }>(rig, starved);
  assert.equal(r2.status, '0x0');
  const t2 = (await rig.rpc('debug_traceTransaction', [starved, { tracer: 'callTracer' }])) as Frame;
  assert.ok(frames(t2).some((f) => /out of gas/i.test(f.error ?? '')), `a frame ran out of gas: ${JSON.stringify(frames(t2).map((f) => f.error))}`);
});

test('on its clock the chain mines a block every two seconds with its pool open: a transaction waits for the next block, and one sent after it at a higher tip is placed before it in that block', async () => {
  const clocked = await startRig({ blockTime: 2 });
  try {
    const coin = clocked.abis.TestCoin as Abi;
    const transfer = (to: `0x${string}`) => encodeFunctionData({ abi: coin, functionName: 'transfer', args: [to, 1n] });
    // Two transactions of two accounts, the lower tip first.
    const low = await clocked.rpc('eth_sendRawTransaction', [await rawFrom(clocked, 2, clocked.addresses.coin, transfer(clocked.accounts.stranger.address), { gas: 100_000n, tip: 1_000_000_000n })]);
    const high = await clocked.rpc('eth_sendRawTransaction', [await rawFrom(clocked, 3, clocked.addresses.coin, transfer(clocked.accounts.stranger.address), { gas: 100_000n, tip: 5_000_000_000n })]);
    assert.equal(await clocked.rpc('eth_getTransactionReceipt', [low]), null, 'in the pool, not yet in a block');
    const receipt = async (hash: unknown) => {
      for (let i = 0; i < 100; i++) {
        const r = (await clocked.rpc('eth_getTransactionReceipt', [hash])) as { blockNumber: Hex; transactionIndex: Hex } | null;
        if (r !== null) return r;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('no receipt within ten seconds');
    };
    const [a, b] = [await receipt(low), await receipt(high)];
    assert.equal(a.blockNumber, b.blockNumber, 'one block');
    assert.ok(Number(b.transactionIndex) < Number(a.transactionIndex), 'the higher tip first');
    // The clock: the blocks after it come on the clock, not on a transaction, each seen as it appears by the wall
    // clock. A block's own time is the chain's, which an anvil may advance by its own rule, so it is held only to rise.
    // From the block after the head as it stands now, so each block is seen as it appears and none is found already made.
    const n = BigInt((await clocked.rpc('eth_blockNumber', [])) as string);
    const next = async (number: bigint) => {
      for (let i = 0; i < 200; i++) {
        const blk = (await clocked.rpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])) as { timestamp: Hex } | null;
        if (blk !== null) return { time: BigInt(blk.timestamp), seen: Date.now() };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no block ${number} within ten seconds`);
    };
    const blocks = [await next(n + 1n), await next(n + 2n), await next(n + 3n), await next(n + 4n)];
    for (let i = 1; i < blocks.length; i++) assert.ok((blocks[i] as { time: bigint }).time > (blocks[i - 1] as { time: bigint }).time, `block ${n + BigInt(i + 1)} after the one before it`);
    const span = (blocks[3] as { seen: number }).seen - (blocks[0] as { seen: number }).seen;
    assert.ok(span >= 4_500 && span <= 7_500, `three gaps of about two seconds by the wall clock: ${span} ms`);
  } finally {
    await clocked.close();
  }
});

test("the chain's proxy: it answers the finalized tag itself; it refuses, drops, or answers a request itself; it passes one on and holds its answer; it keeps a raw transaction from the chain while it answers it taken; and it counts every request by method as it arrives", async () => {
  const client = createJsonRpc(proxy.url, 2_000);
  const before = proxy.count('eth_blockNumber');
  // The final block, named by the test.
  proxy.setFinal(5n);
  try {
    const f = (await client.request<{ number: Hex }>('eth_getBlockByNumber', ['finalized', false])).number;
    assert.equal(BigInt(f), 5n);
  } finally {
    proxy.setFinal(null);
  }
  // Refused, dropped, answered.
  proxy.rule('eth_blockNumber', { kind: 'refuse', code: -32000, message: 'refused by the test' });
  await assert.rejects(client.request('eth_blockNumber', []), (e: unknown) => e instanceof NodeFailure && e.kind === 'refused');
  proxy.drop('eth_blockNumber');
  await assert.rejects(client.request('eth_blockNumber', []), (e: unknown) => e instanceof NodeFailure && e.kind === 'unreachable');
  proxy.rule('eth_blockNumber', { kind: 'answer', result: () => '0x7' });
  assert.equal(await client.request('eth_blockNumber', []), '0x7');
  proxy.rule('eth_blockNumber', null);
  assert.equal(proxy.count('eth_blockNumber') - before, 3, 'each counted as it arrived, refused and dropped ones included');

  // Passed on and its answer held: the chain has the transaction, and the client has heard nothing.
  const coin = rig.abis.TestCoin as Abi;
  const data = encodeFunctionData({ abi: coin, functionName: 'transfer', args: [rig.accounts.stranger.address, 1n] });
  const raw = await rawFrom(rig, 2, rig.addresses.coin, data, { gas: 100_000n, tip: 1_000_000_000n });
  const held = proxy.passAndHold('eth_sendRawTransaction');
  const asked = client.request('eth_sendRawTransaction', [raw]).then(
    () => 'answered',
    (e: unknown) => (e instanceof NodeFailure ? e.kind : 'other'),
  );
  await held.passed;
  assert.notEqual(await minedReceipt(rig, keccak256(raw)), null, 'the chain has it, mined');
  held.release({ drop: true });
  assert.equal(await asked, 'unreachable', 'and the client never heard');

  // Kept from the chain, answered taken with its own hash; handed on later by the test.
  const kept = proxy.withhold();
  try {
    const raw2 = await rawFrom(rig, 2, rig.addresses.coin, data, { gas: 100_000n, tip: 1_000_000_000n });
    assert.equal(await client.request('eth_sendRawTransaction', [raw2]), keccak256(raw2), 'answered taken, its own hash');
    assert.equal(await rig.rpc('eth_getTransactionReceipt', [keccak256(raw2)]), null, 'the chain never saw it');
    assert.deepEqual(kept.kept, [raw2]);
    await kept.forward();
    assert.notEqual(await minedReceipt(rig, keccak256(raw2)), null, 'handed on, and mined');
  } finally {
    kept.stop();
  }
});

test("the database's relay drops a commit's acknowledgement after the commit: the transaction's row is there, and its client never heard that it committed", async () => {
  const db = testServer();
  const { url } = await db.createWithSchema('harness_commit');
  const direct = new URL(url);
  const relay = await startTcpRelay(Number(direct.port === '' ? 5432 : direct.port));
  const relayed = new URL(url);
  relayed.hostname = '127.0.0.1';
  relayed.port = String(relay.port);
  const through = new pg.Client({ connectionString: relayed.toString() });
  through.on('error', () => undefined);
  const plain = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await through.connect();
    await through.query('BEGIN');
    const cut = relay.dropCommitAfter('the lost acknowledgement');
    await through.query(`INSERT INTO runs (stop_reason, stopped_at) VALUES ('the lost acknowledgement', now())`);
    await assert.rejects(through.query('COMMIT'), 'the client hears no answer');
    await cut;
    const { rows } = await plain.query(`SELECT count(*)::int AS n FROM runs WHERE stop_reason = 'the lost acknowledgement'`);
    assert.equal(rows[0]?.n, 1, 'and the commit stands');
  } finally {
    await through.end().catch(() => undefined);
    await plain.end();
    await relay.close();
    await db.end();
  }
});

test("the chain's proxy passes a raw transaction on and answers it with a named error: the chain has these exact bytes, by their own hash, before the client hears the error; a transaction the rule does not pick passes as usual", async () => {
  const client = createJsonRpc(proxy.url, 2_000);
  const coin = rig.abis.TestCoin as Abi;
  const data = encodeFunctionData({ abi: coin, functionName: 'transfer', args: [rig.accounts.stranger.address, 1n] });
  const raw = await rawFrom(rig, 2, rig.addresses.coin, data, { gas: 100_000n, tip: 1_000_000_000n });
  const rule = proxy.passThenError('eth_sendRawTransaction', { code: -32000, message: 'nonce too low' }, (params) => params[0] === raw);
  try {
    assert.deepEqual(await handOff(client, raw), { kind: 'unknown', words: 'nonce too low' }, 'the client hears the named error');
    // By the time the client hears it, the chain has answered these bytes with their own hash.
    assert.deepEqual(rule.forwarded.map((a) => (a as { result?: unknown }).result), [keccak256(raw)], "the chain's own answer, recorded before the error");
    assert.notEqual(await minedReceipt(rig, keccak256(raw)), null, 'the chain has it, mined');
    const other = await rawFrom(rig, 2, rig.addresses.coin, data, { gas: 100_000n, tip: 1_000_000_000n });
    assert.deepEqual(await handOff(client, other), { kind: 'taken' }, 'one the rule does not pick passes as usual');
    assert.equal(rule.forwarded.length, 1);
  } finally {
    rule.stop();
  }
});

test('the refusing coin refuses by a rule of its own while the balance and the allowance are enough: paused, Paused(); a blocked account, Blocked(account)', async () => {
  const fixture = artifact('CoinFixtures.sol', 'RefusingCoin');
  const deployer = rig.wallet(rig.accounts.deployer);
  const hash = await deployer.deployContract({ abi: fixture.abi, bytecode: fixture.bytecode, account: rig.accounts.deployer, chain: deployer.chain } as never);
  const receipt = await rig.publicClient.waitForTransactionReceipt({ hash });
  const coin = receipt.contractAddress as `0x${string}`;
  const [owner, spender] = [rig.accounts.maker, rig.accounts.taker];
  await rig.write(rig.accounts.deployer, coin, fixture.abi, 'mint', [owner.address, 1_000_000n]);
  await rig.write(owner, coin, fixture.abi, 'approve', [spender.address, 1_000_000n]);
  const refusal = async () => {
    const res = await fetch(rig.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: spender.address, to: coin, data: encodeFunctionData({ abi: fixture.abi, functionName: 'transferFrom', args: [owner.address, spender.address, 10n] }) }, 'latest'] }) });
    const body = (await res.json()) as { result?: unknown; error?: { data?: Hex } };
    return body.error?.data === undefined ? null : decodeErrorResult({ abi: fixture.abi, data: body.error.data });
  };
  assert.equal(await refusal(), null, 'the control: enough balance and allowance, and the transfer goes');
  await rig.write(rig.accounts.deployer, coin, fixture.abi, 'setPaused', [true]);
  assert.equal((await refusal())?.errorName, 'Paused');
  await rig.write(rig.accounts.deployer, coin, fixture.abi, 'setPaused', [false]);
  await rig.write(rig.accounts.deployer, coin, fixture.abi, 'setBlocked', [owner.address, true]);
  const blocked = await refusal();
  assert.equal(blocked?.errorName, 'Blocked');
  assert.equal(String((blocked?.args as unknown[] | undefined)?.[0]).toLowerCase(), owner.address.toLowerCase());
});

test("the run's test keystore: written from the local chain's published test account, under a password the run makes, it opens to that account's address and holds no byte of the key in the clear", () => {
  const address = rig.accounts.sender.address;
  const store = testKeystoreFor(address);
  assert.ok(store !== null);
  const key = testAccountKey(4);
  assert.ok(!store.json.toLowerCase().includes(key.slice(2).toLowerCase()), 'no byte of the key in the clear');
  // Opened here by the test's own reading of the format, apart from the courier's: scrypt, then AES-128-CTR, with the MAC checked.
  const ks = JSON.parse(store.json) as { crypto: { kdfparams: { n: number; r: number; p: number; salt: string }; cipherparams: { iv: string }; ciphertext: string; mac: string } };
  const c = ks.crypto;
  const derived = scryptSync(Buffer.from(store.password, 'utf8'), Buffer.from(c.kdfparams.salt, 'hex'), 32, { N: c.kdfparams.n, r: c.kdfparams.r, p: c.kdfparams.p });
  const mac = keccak256(concat([bytesToHex(derived.subarray(16, 32)), `0x${c.ciphertext}`])).slice(2);
  assert.equal(mac, c.mac, 'the MAC');
  const opened = Buffer.concat([createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex')).update(Buffer.from(c.ciphertext, 'hex'))]);
  assert.equal(privateKeyToAccount(bytesToHex(opened)).address, address);
  // Another address of the chain's test accounts has its own; an address that is none of them has none.
  assert.ok(testKeystoreFor(rig.accounts.maker.address) !== null);
  assert.equal(testKeystoreFor('0x000000000000000000000000000000000000dEaD'), null);
});
