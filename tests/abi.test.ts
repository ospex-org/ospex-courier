import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toBytes, type Abi, type AbiFunction, type AbiParameter } from 'viem';
import { COIN_ABI, CORE_ABI, GAMES_ABI, MATCHING_ABI, MODULE_TYPES, MULTICALL_ABI, RELAY_ABI, SIGNPOST_ABI } from '../courier/chain/abi';
import { artifact } from './support/rig';

// The courier's written-out interface against the contracts' build at the
// pinned commit: every function the courier calls is in the artifact's ABI
// with the same inputs and outputs, so a pin that moves the interface turns
// this red and not a live call.

function typeOf(p: AbiParameter): string {
  const components = 'components' in p && p.components ? `(${p.components.map(typeOf).join(',')})` : '';
  return components === '' ? p.type : p.type.replace(/^tuple/, components);
}

/** A read (view or pure) or a write (nonpayable or payable): what a caller depends on; the finer word is the compiler's. */
const kind = (f: AbiFunction) => (f.stateMutability === 'view' || f.stateMutability === 'pure' ? 'read' : 'write');

function signatures(abi: Abi): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of abi) {
    if (entry.type !== 'function') continue;
    const f = entry as AbiFunction;
    out.set(`${f.name}(${f.inputs.map(typeOf).join(',')})`, `${f.outputs.map(typeOf).join(',')}|${kind(f)}`);
  }
  return out;
}

function assertSubset(ours: Abi, theirs: Abi, what: string): void {
  const have = signatures(theirs);
  for (const [sig, outputs] of signatures(ours)) {
    assert.ok(have.has(sig), `${what}: ${sig} is not in the build`);
    assert.equal(have.get(sig), outputs, `${what}: ${sig} answers otherwise in the build`);
  }
}

test('the signpost, as built', () => {
  assertSubset(SIGNPOST_ABI, artifact('OspexSignpost.sol', 'OspexSignpost').abi, 'the signpost');
});

test('the core, as built, and its six module types', () => {
  const built = artifact('OspexBetting.sol', 'OspexBetting').abi;
  assertSubset(CORE_ABI, built, 'the core');
  for (const name of ['MARKET_MODULE', 'POSITION_MODULE', 'MATCHING_MODULE', 'MONEYLINE_SCORER_MODULE', 'SPREAD_SCORER_MODULE', 'TOTAL_SCORER_MODULE']) {
    assert.ok(built.some((e) => e.type === 'function' && (e as AbiFunction).name === name), `the core has no ${name}`);
  }
  assert.deepEqual(Object.values(MODULE_TYPES), ['MARKET_MODULE', 'POSITION_MODULE', 'MATCHING_MODULE', 'MONEYLINE_SCORER_MODULE', 'SPREAD_SCORER_MODULE', 'TOTAL_SCORER_MODULE'].map((n) => keccak256(toBytes(n))));
});

test('the matching contract, as built', () => {
  assertSubset(MATCHING_ABI, artifact('OspexMatching.sol', 'OspexMatching').abi, 'the matching contract');
});

test('the relay, as built', () => {
  assertSubset(RELAY_ABI, artifact('OspexCourierRelay.sol', 'OspexCourierRelay').abi, 'the relay');
});

test('the games set, as built', () => {
  assertSubset(GAMES_ABI, artifact('OspexGames.sol', 'OspexGames').abi, 'the games set');
});

test('the coin, as a six-decimal ERC-20 is built', () => {
  assertSubset(COIN_ABI, artifact('CoinFixtures.sol', 'TestCoin').abi, 'the coin');
});

test('the multicall contract, as forge-std declares it', () => {
  assertSubset(MULTICALL_ABI, artifact('IMulticall3.sol', 'IMulticall3').abi, 'the multicall contract');
});
