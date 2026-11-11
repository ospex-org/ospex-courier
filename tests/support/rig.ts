import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { MULTICALL_ADDRESS } from '../../courier/chain/abi';

// The chain rig: a local chain (anvil) with the set deployed from the
// contracts repository pinned as a submodule, from its build artifacts. A
// six-decimal coin; a stock timelock with a test key as its proposer and a
// 60-second delay; the games set, with a fixture reporter as its first-n
// reporter, so games can be created and their starts written; the betting set,
// bootstrapped and finalized; the relay; a signpost with the set's entry,
// added through the timelock as it will be live; accounts with coin, an
// allowance to the positions contract and the relay registered. Every
// contract of the set is the production contract.

const ARTIFACTS = new URL('../../contracts/out/', import.meta.url);

/** The pinned commit of the contracts repository: what the entry's commit field carries. */
export const CONTRACTS_COMMIT: Hex = '0x0b0a5d79f36ff2d22e42cf09edbe95dde783678e';

/** anvil's own test mnemonic; its accounts hold the local chain's coin and nothing else, anywhere. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

export const CHAIN_ID = 31337;
export const TIMELOCK_DELAY = 60n;
/** The games set's launch terms, written out: n 24 hours, the day-7 and day-30 clocks, 1 USDC. */
export const TERMS = { window: 86_400n, day7Clock: 604_800n, day30Clock: 2_592_000n, fee: 1_000_000n };
/** What each funded account starts with: 1,000,000 USDC in six decimals. */
export const PURSE = 1_000_000_000_000n;

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function artifact(file: string, name: string): Artifact {
  const json = JSON.parse(readFileSync(new URL(`${file}/${name}.json`, ARTIFACTS), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export interface Rig {
  url: string;
  anvil: ChainProcess;
  publicClient: PublicClient;
  accounts: {
    deployer: HDAccount;
    timelockKey: HDAccount;
    maker: HDAccount;
    taker: HDAccount;
    /** The relay's first sender: an address with no key in this build's courier. */
    sender: HDAccount;
    creator: HDAccount;
    stranger: HDAccount;
  };
  addresses: {
    timelock: Address;
    coin: Address;
    reporter: Address;
    games: Address;
    core: Address;
    markets: Address;
    positions: Address;
    matching: Address;
    moneyline: Address;
    spread: Address;
    total: Address;
    relay: Address;
    signpost: Address;
  };
  /** The betting entry's number on the signpost. */
  bettingEntryId: bigint;
  /** The one game created, its start written. */
  gameId: bigint;
  abis: Record<string, Abi>;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  mine(blocks: number): Promise<void>;
  increaseTime(seconds: bigint): Promise<void>;
  setCode(address: Address, code: Hex): Promise<void>;
  /** Runs a call on `target` through the timelock as it runs live: the key schedules it, the delay passes, a stranger executes it. */
  throughTimelock(target: Address, data: Hex): Promise<void>;
  wallet(account: HDAccount): WalletClient;
  close(): Promise<void>;
}

export interface ChainProcess {
  process: ChildProcess;
  port: number;
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startAnvil(): Promise<ChainProcess> {
  const port = await freePort();
  const child = spawn('anvil', ['--port', String(port), '--host', '127.0.0.1', '--chain-id', String(CHAIN_ID), '--silent'], {
    stdio: 'ignore',
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  });
  // The chain never outlives the test process, and never keeps it alive: a test that fails before its rig is
  // closed must not leave a chain running or a runner waiting on it.
  child.unref();
  process.once('exit', () => {
    if (child.exitCode === null) child.kill();
  });
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode} before it listened`);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (res.ok) break;
    } catch {
      // not yet
    }
    if (Date.now() - started > 30_000) throw new Error('anvil did not listen within 30 seconds');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { process: child, port };
}

export async function startRig(): Promise<Rig> {
  const anvil = await startAnvil();
  const url = `http://127.0.0.1:${anvil.port}`;
  const transport = http(url, { retryCount: 0 });
  const chain = { id: CHAIN_ID, name: 'rig', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } } as const;
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 50 });
  const account = (index: number) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index });
  const accounts = {
    deployer: account(0),
    timelockKey: account(1),
    maker: account(2),
    taker: account(3),
    sender: account(4),
    creator: account(5),
    stranger: account(6),
  };
  const wallet = (who: HDAccount) => createWalletClient({ account: who, chain, transport });
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };

  const abis: Record<string, Abi> = {};
  const deploy = async (who: HDAccount, file: string, name: string, args: readonly unknown[] = []): Promise<Address> => {
    const art = artifact(file, name);
    abis[name] = art.abi;
    const hash = await wallet(who).deployContract({ abi: art.abi, bytecode: art.bytecode, args, account: who, chain } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`deploying ${name} failed`);
    return receipt.contractAddress;
  };
  const write = async (who: HDAccount, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<void> => {
    const hash = await wallet(who).sendTransaction({ to, data: encodeFunctionData({ abi, functionName, args } as never), account: who, chain } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} on ${to} reverted`);
  };
  const read = async <T,>(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> =>
    (await publicClient.readContract({ address: to, abi, functionName, args } as never)) as T;

  // The multicall contract, at the address it has on Polygon.
  const multicall = JSON.parse(readFileSync(new URL('../fixtures/multicall3.json', import.meta.url), 'utf8')) as { code: Hex; codeHash: Hex };
  if (keccak256(multicall.code) !== multicall.codeHash) throw new Error('the multicall fixture does not hash as it says');
  await rpc('anvil_setCode', [MULTICALL_ADDRESS, multicall.code]);

  // The stock timelock: the key proposes and cancels, anyone executes, no admin.
  const timelock = await deploy(accounts.deployer, 'TimelockController.sol', 'TimelockController', [TIMELOCK_DELAY, [accounts.timelockKey.address], ['0x0000000000000000000000000000000000000000'], '0x0000000000000000000000000000000000000000']);
  // A six-decimal coin; anyone mints.
  const coin = await deploy(accounts.deployer, 'CoinFixtures.sol', 'TestCoin');
  // The reporter needs the games address at its own deploy, and the games set needs the reporter's: predict the
  // games address from the deployer's nonce, as the deploy script will.
  const nonce = await publicClient.getTransactionCount({ address: accounts.deployer.address });
  const predictedGames = getContractAddress({ from: accounts.deployer.address, nonce: BigInt(nonce + 1) });
  const reporter = await deploy(accounts.deployer, 'GamesBase.sol', 'MockReporter', [predictedGames]);
  const reporterCode = await publicClient.getCode({ address: reporter });
  const games = await deploy(accounts.deployer, 'OspexGames.sol', 'OspexGames', [timelock, coin, TERMS, [reporter], [1], [keccak256(reporterCode ?? '0x')]]);
  if (games.toLowerCase() !== predictedGames.toLowerCase()) throw new Error('the games set did not land at its predicted address');

  // The betting set: the core with the games set and the coin, the six modules on the core, bootstrapped under
  // their types, finalized.
  const coreDeployBlock = await publicClient.getBlockNumber();
  const core = await deploy(accounts.deployer, 'OspexBetting.sol', 'OspexBetting', [games, coin]);
  const markets = await deploy(accounts.deployer, 'OspexMarkets.sol', 'OspexMarkets', [core]);
  const positions = await deploy(accounts.deployer, 'OspexPositions.sol', 'OspexPositions', [core]);
  const matching = await deploy(accounts.deployer, 'OspexMatching.sol', 'OspexMatching', [core]);
  const moneyline = await deploy(accounts.deployer, 'OspexMoneylineScorer.sol', 'OspexMoneylineScorer', [core]);
  const spread = await deploy(accounts.deployer, 'OspexSpreadScorer.sol', 'OspexSpreadScorer', [core]);
  const total = await deploy(accounts.deployer, 'OspexTotalScorer.sol', 'OspexTotalScorer', [core]);
  const coreAbi = abis.OspexBetting as Abi;
  const types = await Promise.all(['MARKET_MODULE', 'POSITION_MODULE', 'MATCHING_MODULE', 'MONEYLINE_SCORER_MODULE', 'SPREAD_SCORER_MODULE', 'TOTAL_SCORER_MODULE'].map((t) => read<Hex>(core, coreAbi, t)));
  await write(accounts.deployer, core, coreAbi, 'bootstrapModules', [types, [markets, positions, matching, moneyline, spread, total]]);
  await write(accounts.deployer, core, coreAbi, 'finalize');

  // The relay, with its first sender.
  const relay = await deploy(accounts.deployer, 'OspexCourierRelay.sol', 'OspexCourierRelay', [matching, accounts.sender.address]);

  // The signpost: the games set is its first entry, written by the constructor; the betting set is added through
  // the timelock, as a set is listed live.
  const signpost = await deploy(accounts.deployer, 'OspexSignpost.sol', 'OspexSignpost', [timelock, 0, '0x0000000000000000000000000000000000000000', [games], CONTRACTS_COMMIT, coreDeployBlock - 1n]);
  const signpostAbi = abis.OspexSignpost as Abi;
  const timelockAbi = abis.TimelockController as Abi;
  let salt = 0;
  const throughTimelock = async (target: Address, data: Hex): Promise<void> => {
    const s: Hex = `0x${(++salt).toString(16).padStart(64, '0')}`;
    const zero: Hex = `0x${'0'.repeat(64)}`;
    await write(accounts.timelockKey, timelock, timelockAbi, 'schedule', [target, 0n, data, zero, s, TIMELOCK_DELAY]);
    await rpc('evm_increaseTime', [Number(TIMELOCK_DELAY)]);
    await rpc('anvil_mine', ['0x1']);
    await write(accounts.stranger, timelock, timelockAbi, 'execute', [target, 0n, data, zero, s]);
  };
  await throughTimelock(
    signpost,
    encodeFunctionData({ abi: signpostAbi, functionName: 'addEntry', args: [1, coin, [core, markets, positions, matching, moneyline, spread, total, relay], CONTRACTS_COMMIT, coreDeployBlock] } as never),
  );
  const bettingEntryId = (await read<bigint>(signpost, signpostAbi, 'entryCount')) - 1n;

  // Two accounts with coin, an allowance to the positions contract and the relay registered; a creator who can
  // pay the creation fee.
  const coinAbi = abis.TestCoin as Abi;
  const matchingAbi = abis.OspexMatching as Abi;
  for (const who of [accounts.maker, accounts.taker]) {
    await write(accounts.deployer, coin, coinAbi, 'mint', [who.address, PURSE]);
    await write(who, coin, coinAbi, 'approve', [positions, 2n ** 256n - 1n]);
    await write(who, matching, matchingAbi, 'registerCourier', [relay]);
  }
  await write(accounts.deployer, coin, coinAbi, 'mint', [accounts.creator.address, PURSE]);
  await write(accounts.creator, coin, coinAbi, 'approve', [games, 2n ** 256n - 1n]);

  // One game, its start written by the first-n reporter: a game the courier carries.
  const gamesAbi = abis.OspexGames as Abi;
  const now = (await publicClient.getBlock()).timestamp;
  const date = now + 86_400n;
  await write(accounts.creator, games, gamesAbi, 'createGame', ['nba', 'Detroit Pistons', 'Washington Wizards', date, [{ seat: 3, id: 'g-77120' }, { seat: 1, id: '18432' }], TERMS.fee]);
  const gameId = await read<bigint>(games, gamesAbi, 'gameCount');
  const readings = [
    { seat: 1, kind: 2, homeScore: 104, awayScore: 97 },
    { seat: 2, kind: 2, homeScore: 104, awayScore: 97 },
    { seat: 3, kind: 1, homeScore: 88, awayScore: 90 },
    { seat: 4, kind: 0, homeScore: 0, awayScore: 0 },
  ];
  await write(accounts.deployer, reporter, abis.MockReporter as Abi, 'send', [{ gameId, kind: 1, start: date + 613n, homeScore: 0, awayScore: 0, readings, payout: '0x0000000000000000000000000000000000000000' }]);

  // Enough blocks behind the head for a read 50 back.
  await rpc('anvil_mine', ['0x3c']);

  return {
    url,
    anvil,
    publicClient,
    accounts,
    addresses: { timelock, coin, reporter, games, core, markets, positions, matching, moneyline, spread, total, relay, signpost },
    bettingEntryId,
    gameId,
    abis,
    rpc,
    async mine(blocks) {
      await rpc('anvil_mine', [`0x${blocks.toString(16)}`]);
    },
    async increaseTime(seconds) {
      await rpc('evm_increaseTime', [Number(seconds)]);
      await rpc('anvil_mine', ['0x1']);
    },
    async setCode(address, code) {
      await rpc('anvil_setCode', [address, code]);
    },
    throughTimelock,
    wallet,
    async close() {
      anvil.process.kill();
      await new Promise<void>((resolve) => {
        if (anvil.process.exitCode !== null) return resolve();
        anvil.process.once('exit', () => resolve());
        setTimeout(resolve, 2_000).unref();
      });
    },
  };
}
