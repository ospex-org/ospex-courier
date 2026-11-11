import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LOW_POL, readCourierConfig } from '../courier/config';

// The settings reader: every problem at once, no value echoed.

const GOOD = {
  DATABASE_URL: 'postgres://courier:hunter2-the-password@127.0.0.1:5440/courier',
  POLYGON_RPC_URL: 'https://node.example/v1/provider-key-abc',
  SIGNPOST_ADDRESS: '0x9A676e781A523b5d0C0e43731313A708CB607508',
  BETTING_ENTRY_ID: '1',
  PORT: '3000',
};

test('a good environment is read, with the low-wallet mark at its default', () => {
  const read = readCourierConfig(GOOD);
  assert.ok(read.ok, read.ok ? '' : read.problems.join('; '));
  assert.equal(read.config.databaseUrl, GOOD.DATABASE_URL);
  assert.equal(read.config.rpcUrl, GOOD.POLYGON_RPC_URL);
  assert.equal(read.config.signpostAddress, GOOD.SIGNPOST_ADDRESS);
  assert.equal(read.config.bettingEntryId, 1n);
  assert.equal(read.config.port, 3000);
  assert.equal(read.config.lowPol, DEFAULT_LOW_POL);
  assert.equal(read.config.databaseCaFile, undefined);
});

test('an empty environment names every missing setting, once each, at once', () => {
  const read = readCourierConfig({});
  assert.ok(!read.ok);
  const named = read.problems.map((p) => p.split(' ')[0]).sort();
  assert.deepEqual(named, ['BETTING_ENTRY_ID', 'DATABASE_URL', 'POLYGON_RPC_URL', 'PORT', 'SIGNPOST_ADDRESS']);
});

test('a wrong value is named by its setting, and the value itself is never echoed', () => {
  const read = readCourierConfig({
    DATABASE_URL: 'mysql://courier:hunter2-the-password@db.example/courier',
    POLYGON_RPC_URL: 'http://node.example/provider-key-abc',
    SIGNPOST_ADDRESS: '0x1234',
    BETTING_ENTRY_ID: 'one',
    COURIER_LOW_POL: 'three',
    PORT: '70000',
  });
  assert.ok(!read.ok);
  const text = read.problems.join('\n');
  for (const setting of ['DATABASE_URL', 'POLYGON_RPC_URL', 'SIGNPOST_ADDRESS', 'BETTING_ENTRY_ID', 'COURIER_LOW_POL', 'PORT']) {
    assert.equal(read.problems.filter((p) => p.startsWith(setting)).length, 1, `one problem for ${setting}: ${text}`);
  }
  for (const secret of ['hunter2-the-password', 'provider-key-abc', 'db.example', 'node.example', '0x1234', 'one', 'three', '70000']) {
    assert.ok(!text.includes(secret), `the value ${secret} was echoed: ${text}`);
  }
});

test('the node: https anywhere, plain http only to this machine', () => {
  assert.ok(readCourierConfig({ ...GOOD, POLYGON_RPC_URL: 'http://127.0.0.1:8545' }).ok);
  assert.ok(readCourierConfig({ ...GOOD, POLYGON_RPC_URL: 'http://localhost:8545' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, POLYGON_RPC_URL: 'http://10.0.0.5:8545' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, POLYGON_RPC_URL: 'ws://127.0.0.1:8545' }).ok);
});

test('the low-wallet mark and the authority file are read when set', () => {
  const read = readCourierConfig({ ...GOOD, COURIER_LOW_POL: '2.5', DATABASE_CA_FILE: '/tmp/authority.pem' });
  assert.ok(read.ok);
  assert.equal(read.config.lowPol, 2.5);
  assert.equal(read.config.databaseCaFile, '/tmp/authority.pem');
  assert.ok(!readCourierConfig({ ...GOOD, COURIER_LOW_POL: '-1' }).ok);
  assert.ok(readCourierConfig({ ...GOOD, COURIER_LOW_POL: '0' }).ok);
});

test('the port is a whole number up to 65535, 0 for any free port', () => {
  assert.ok(readCourierConfig({ ...GOOD, PORT: '0' }).ok);
  assert.ok(readCourierConfig({ ...GOOD, PORT: '65535' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, PORT: '65536' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, PORT: '-1' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, PORT: '80a' }).ok);
});

test('the entry number is a whole number', () => {
  assert.ok(readCourierConfig({ ...GOOD, BETTING_ENTRY_ID: '0' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, BETTING_ENTRY_ID: '-1' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, BETTING_ENTRY_ID: '1.5' }).ok);
  assert.ok(!readCourierConfig({ ...GOOD, BETTING_ENTRY_ID: '0x1' }).ok);
});
