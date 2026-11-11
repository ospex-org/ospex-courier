import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem';
import { MATCHING_ABI } from '../courier/chain/abi';
import { openPool } from '../courier/records/store';
import { startService, StartupRefused } from '../courier/startup';
import { CourierDidNotStart, get, startCourier } from './support/courier';
import { PURSE, type Rig } from './support/rig';
import { startStack, type Stack } from './support/stack';
import { makeAuthorities, startTlsFront } from './support/tls';

// The chain rig, end to end: the set deployed from the pinned contracts on a
// local chain, two accounts registered, and the courier started as its own
// process against that chain and a real Postgres, reading the set from the
// signpost and the book empty at a named block. Then the start-up refusals,
// each a plain sentence.

let stack: Stack;
let rig: Rig;

const lower = (a: string) => a.toLowerCase();

before(async () => {
  stack = await startStack('rig');
  rig = stack.rig;
});

after(async () => {
  await stack?.close();
});

test('the set is deployed and two accounts hold coin, an allowance to the positions contract, and the relay registered', async () => {
  const { publicClient, addresses, accounts, abis } = rig;
  const coin = abis.TestCoin as Abi;
  for (const who of [accounts.maker, accounts.taker]) {
    assert.equal(await publicClient.readContract({ address: addresses.coin, abi: coin, functionName: 'balanceOf', args: [who.address] }), PURSE);
    assert.equal(await publicClient.readContract({ address: addresses.coin, abi: coin, functionName: 'allowance', args: [who.address, addresses.positions] }), 2n ** 256n - 1n);
    assert.equal(await publicClient.readContract({ address: addresses.matching, abi: MATCHING_ABI, functionName: 'isCourier', args: [who.address, addresses.relay] }), true);
  }
  assert.equal(await publicClient.readContract({ address: addresses.matching, abi: MATCHING_ABI, functionName: 'isCourier', args: [accounts.stranger.address, addresses.relay] }), false);
  assert.equal(await publicClient.readContract({ address: addresses.core, abi: abis.OspexBetting as Abi, functionName: 's_finalized' }), true);
  assert.equal(await publicClient.readContract({ address: addresses.games, abi: abis.OspexGames as Abi, functionName: 'getGameStatus', args: [rig.gameId] }), 2, 'the game is verified: its start is written');
});

test('the courier read the set from the signpost and the status names every address of it', async () => {
  const { status, body } = await get(stack.courier.url, '/v1/status');
  assert.equal(status, 200, JSON.stringify(body));
  const set = body.set as Record<string, string>;
  const a = rig.addresses;
  for (const [name, address] of Object.entries({ core: a.core, markets: a.markets, positions: a.positions, matching: a.matching, moneyline: a.moneyline, spread: a.spread, total: a.total, relay: a.relay, coin: a.coin, games: a.games, timelock: a.timelock, signpost: a.signpost })) {
    assert.equal(lower(set[name] ?? ''), lower(address), name);
  }
  assert.equal(set.chainId, '31337');
  assert.equal(set.entryId, rig.bettingEntryId.toString());
  assert.equal(lower(set.commit ?? ''), '0x0b0a5d79f36ff2d22e42cf09edbe95dde783678e');
  const sender = body.sender as Record<string, string | null>;
  assert.equal(lower(sender.relay ?? ''), lower(rig.accounts.sender.address));
  assert.equal(sender.key, null, 'this build holds no key');
  const node = body.node as Record<string, unknown>;
  assert.equal(node.usable, true, JSON.stringify(node));
  assert.ok(Array.isArray(body.conditions) && body.conditions.length === 0);
  assert.equal(body.lastBlockRead, null, 'nothing read yet: a quiet courier reads no chain');
  assert.ok(typeof (body.run as { id: number }).id === 'number');
  assert.ok((body.database as { sizeBytes: number }).sizeBytes > 0);
  assert.ok(Array.isArray(body.notYetBuilt) && body.notYetBuilt.length > 0);
  assert.equal((body.bounds as { scanRows: number }).scanRows, 2000);
});

test('the book of the game is empty, at a block named by number, hash and time', async () => {
  const requestsBefore = stack.proxy.count('eth_getBlockByNumber');
  const { status, body } = await get(stack.courier.url, `/v1/book?gameId=${rig.gameId}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.markets, []);
  assert.equal(body.boundReached, false);
  assert.equal(body.bound, 2000);
  assert.equal(body.gameId, rig.gameId.toString());
  const block = body.block as { number: string; hash: Hex; time: string };
  const latest = await rig.publicClient.getBlock();
  assert.equal(block.number, latest.number.toString());
  assert.equal(block.hash, latest.hash);
  assert.equal(block.time, latest.timestamp.toString());
  assert.equal(stack.proxy.count('eth_getBlockByNumber'), requestsBefore + 1, 'one header read, through the proxy');
  const after = await get(stack.courier.url, '/v1/status');
  const last = after.body.lastBlockRead as { number: string; hash: string };
  assert.equal(last.hash, latest.hash);
});

test('the book refuses a game id that is not a number, and a market read this build does not serve', async () => {
  assert.equal((await get(stack.courier.url, '/v1/book?gameId=abc')).body.code, 'INVALID_PARAM');
  assert.equal((await get(stack.courier.url, '/v1/book')).body.code, 'INVALID_PARAM');
  assert.equal((await get(stack.courier.url, `/v1/book?gameId=${rig.gameId}&scorer=${rig.addresses.moneyline}&lineTicks=0`)).body.code, 'INVALID_PARAM');
});

test('/healthz and /readyz answer; an unknown path is refused by code', async () => {
  assert.deepEqual((await get(stack.courier.url, '/healthz')).body, { ok: true });
  assert.deepEqual((await get(stack.courier.url, '/readyz')).body, { ok: true });
  const missing = await get(stack.courier.url, '/v1/orders/0x00');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});

test('https only: a request the router says came plain is refused, one it says came over https is served', async () => {
  const plain = await get(stack.courier.url, '/v1/status', { 'x-forwarded-proto': 'http' });
  assert.equal(plain.status, 403);
  assert.equal(plain.body.code, 'HTTPS_REQUIRED');
  const secure = await get(stack.courier.url, '/readyz', { 'x-forwarded-proto': 'https' });
  assert.equal(secure.status, 200);
  const { body } = await get(stack.courier.url, '/v1/status');
  const refused = (body.refusedBeforeAdmission as { byCode: Record<string, number> }).byCode;
  assert.equal(refused.HTTPS_REQUIRED, 1);
  assert.equal(refused.NOT_FOUND, 1);
});

test('the runs list this run, started and not stopped, and page by number', async () => {
  const { body } = await get(stack.courier.url, '/v1/runs');
  const runs = body.runs as Array<{ id: number; startedAt: string; stoppedAt: string | null; stopReason: string | null }>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.stoppedAt, null);
  assert.equal(runs[0]?.stopReason, null);
  assert.equal(body.more, false);
  const status = await get(stack.courier.url, '/v1/status');
  assert.equal(runs[0]?.id, (status.body.run as { id: number }).id);
  const none = await get(stack.courier.url, `/v1/runs?after=${runs[0]?.id}`);
  assert.deepEqual(none.body.runs, []);
  assert.equal((await get(stack.courier.url, '/v1/runs?limit=0')).body.code, 'INVALID_PARAM');
  assert.equal((await get(stack.courier.url, '/v1/runs?limit=101')).body.code, 'INVALID_PARAM');
});

test('a process that closes writes its run\'s stop, with the two lines of the run', async () => {
  const lines: string[] = [];
  const service = await startService({ ...stack.env, PORT: '0' }, { log: (l) => lines.push(l) });
  const runId = service.run.id;
  const ready = await get(`http://127.0.0.1:${service.port}`, '/readyz');
  assert.equal(ready.status, 200);
  await service.close('close');
  const pool = openPool(stack.databaseUrl, null);
  try {
    const { rows } = await pool.query('SELECT stopped_at, stop_reason FROM runs WHERE id = $1', [runId]);
    assert.ok(rows[0]?.stopped_at instanceof Date);
    assert.equal(rows[0]?.stop_reason, 'close');
    const { rows: events } = await pool.query('SELECT kind FROM events WHERE run = $1 ORDER BY number', [runId]);
    assert.deepEqual(events.map((e) => e.kind), ['run started', 'run stopped']);
  } finally {
    await pool.end();
  }
});

test('SIGTERM: the stopping process writes its stop', { skip: process.platform === 'win32' ? 'Windows delivers no SIGTERM to a child; CI runs this' : false }, async () => {
  const second = await startCourier(stack.env);
  const runId = (await get(second.url, '/v1/status')).body.run as { id: number };
  const code = await second.stop();
  assert.equal(code, 0);
  const pool = openPool(stack.databaseUrl, null);
  try {
    const { rows } = await pool.query('SELECT stop_reason FROM runs WHERE id = $1', [runId.id]);
    assert.equal(rows[0]?.stop_reason, 'sigterm');
  } finally {
    await pool.end();
  }
});

test('a process that dies writes nothing: its run shows started and never stopped', { skip: process.platform !== 'win32' ? 'the kill without a signal is the Windows case' : false }, async () => {
  const second = await startCourier(stack.env);
  const runId = (await get(second.url, '/v1/status')).body.run as { id: number };
  await second.stop();
  const pool = openPool(stack.databaseUrl, null);
  try {
    const { rows } = await pool.query('SELECT stopped_at, stop_reason FROM runs WHERE id = $1', [runId.id]);
    assert.equal(rows[0]?.stopped_at, null);
    assert.equal(rows[0]?.stop_reason, null);
  } finally {
    await pool.end();
  }
});

async function refusedToStart(env: Record<string, string>): Promise<string> {
  try {
    const started = await startCourier({ ...stack.env, ...env });
    await started.stop();
    assert.fail('the courier started');
  } catch (err) {
    if (err instanceof CourierDidNotStart) return err.line;
    throw err;
  }
}

test('start-up refuses an entry that is not a betting entry, and one not on the signpost', async () => {
  assert.match(await refusedToStart({ BETTING_ENTRY_ID: '0' }), /^courier did not start: the set: entry 0 is not a betting entry \(its kind is games\)$/);
  assert.match(await refusedToStart({ BETTING_ENTRY_ID: '7' }), /^courier did not start: the set: BETTING_ENTRY_ID 7 is not on the signpost, which holds 2 entries \(0 to 1\)$/);
});

test('start-up refuses a set whose code is not the entry\'s, and starts again once it is', async () => {
  const original = (await rig.publicClient.getCode({ address: rig.addresses.markets })) as Hex;
  await rig.setCode(rig.addresses.markets, '0x6001600155');
  try {
    assert.match(await refusedToStart({}), new RegExp(`^courier did not start: the set: entry 1: the code at ${getAddress(rig.addresses.markets)} does not hash as the entry says$`));
  } finally {
    await rig.setCode(rig.addresses.markets, original);
  }
  const again = await startCourier(stack.env);
  assert.equal((await get(again.url, '/readyz')).status, 200);
  await again.stop();
});

test('start-up refuses a database without the schema, a node that does not answer, and settings with a problem', async () => {
  const empty = await stack.db.createDatabase('bare');
  assert.match(await refusedToStart({ DATABASE_URL: stack.db.urlFor(empty) }), /^courier did not start: DATABASE_URL: the database answers but does not have the courier's schema \(missing: orders, stops, lanes, crosses, legs, events, conditions, accounts, runs, games\); apply db\/schema\.sql$/);
  assert.match(await refusedToStart({ POLYGON_RPC_URL: 'http://127.0.0.1:1' }), /^courier did not start: POLYGON_RPC_URL: the node did not answer eth_chainId \(unreachable( [A-Z_]+)?\)$/);
  assert.match(await refusedToStart({ SIGNPOST_ADDRESS: 'not-an-address' }), /^courier did not start: settings: SIGNPOST_ADDRESS is not an address$/);
  assert.match(await refusedToStart({ SIGNPOST_ADDRESS: rig.accounts.stranger.address }), /holds no code on the node's chain \(chain id 31337\)/);
});

test('the web process reaches its database through TLS as the release step does: with the right authority it starts, with another it refuses', async () => {
  const authorities = makeAuthorities();
  const direct = new URL(stack.databaseUrl);
  const front = await startTlsFront(Number(direct.port === '' ? 5432 : direct.port), authorities.serverCert, authorities.serverKey);
  try {
    const url = new URL(stack.databaseUrl);
    url.hostname = 'localhost';
    url.port = String(front.port);
    await assert.rejects(
      startService({ ...stack.env, DATABASE_URL: url.toString(), DATABASE_CA_FILE: join(authorities.dir, 'b.pem'), PORT: '0' }, { log: () => undefined }),
      (err: unknown) => err instanceof StartupRefused && /^DATABASE_URL: the database's certificate did not verify \([A-Z_]+\)$/.test(err.message),
    );
    const service = await startService({ ...stack.env, DATABASE_URL: url.toString(), DATABASE_CA_FILE: join(authorities.dir, 'a.pem'), PORT: '0' }, { log: () => undefined });
    assert.ok(front.handshakes >= 1);
    assert.equal((await get(`http://127.0.0.1:${service.port}`, '/readyz')).status, 200);
    await service.close();
  } finally {
    await front.close();
  }
});

test('start-up refuses a retired entry, with its reason', async () => {
  const signpostAbi = rig.abis.OspexSignpost as Abi;
  await rig.throughTimelock(rig.addresses.signpost, encodeFunctionData({ abi: signpostAbi, functionName: 'moveForward', args: [rig.bettingEntryId, 2, 0n, 'retired for the test'] } as never));
  assert.match(await refusedToStart({}), /^courier did not start: the set: entry 1 is retired: retired for the test$/);
});

export type { Address };
