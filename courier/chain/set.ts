import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { COIN_ABI, CORE_ABI, MATCHING_ABI, MODULE_TYPES, RELAY_ABI, SIGNPOST_ABI, SIGNPOST_KIND, SIGNPOST_STATUS, type ModuleName } from './abi';
import { byHash, codeAt, headerByTag, readAt, type Header, type JsonRpc } from './rpc';

// The set, read from the signpost at start. Every address is a setting of the
// chain, not of the repo: the courier is told the signpost and the betting
// entry's number, reads the entry, and takes the set from it. It refuses to
// start unless the entry is a betting entry that is not retired, each address
// answers what the entry says of it, and the code hash at each address is the
// entry's.

export class SetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetRefused';
  }
}

export interface BettingSet {
  chainId: bigint;
  signpost: Address;
  entryId: bigint;
  /** The entry's commit of the set's source, 20 bytes. */
  commit: Hex;
  deployBlock: bigint;
  status: number;
  core: Address;
  markets: Address;
  positions: Address;
  matching: Address;
  moneyline: Address;
  spread: Address;
  total: Address;
  relay: Address;
  coin: Address;
  /** The coin's decimals, read once: how an amount in its smallest unit is said in a sentence. */
  coinDecimals: number;
  games: Address;
  /** The matching contract's timelock, which the relay answers too. */
  timelock: Address;
  /** The relay's sender at the read. */
  sender: Address;
  /** The block the set was read at, by hash. */
  readAt: Header;
}

interface Entry {
  kind: number;
  coin: Address;
  contracts: readonly Address[];
  codeHashes: readonly Hex[];
  commit: Hex;
  deployBlock: bigint;
  status: number;
  reason: string;
}

const MODULES: readonly ModuleName[] = ['markets', 'positions', 'matching', 'moneyline', 'spread', 'total'];

const NO_CODE_HASH = keccak256('0x');

export async function readSet(rpc: JsonRpc, where: { signpostAddress: Address; bettingEntryId: bigint }, chainId: bigint): Promise<BettingSet> {
  const header = await headerByTag(rpc, 'latest');
  const at = byHash(header.hash);
  const signpost = getAddress(where.signpostAddress);

  if ((await codeAt(rpc, signpost, at)) === '0x') {
    throw new SetRefused(`SIGNPOST_ADDRESS holds no code on the node's chain (chain id ${chainId}): ${signpost}`);
  }
  const count = await readAt<bigint>(rpc, SIGNPOST_ABI, signpost, 'entryCount', [], at);
  if (where.bettingEntryId >= count) {
    throw new SetRefused(`BETTING_ENTRY_ID ${where.bettingEntryId} is not on the signpost, which holds ${count} entr${count === 1n ? 'y' : 'ies'} (0 to ${count - 1n})`);
  }
  const entry = await readAt<Entry>(rpc, SIGNPOST_ABI, signpost, 'getEntry', [where.bettingEntryId], at);
  if (entry.kind !== SIGNPOST_KIND.Betting) {
    throw new SetRefused(`entry ${where.bettingEntryId} is not a betting entry (its kind is ${kindName(entry.kind)})`);
  }
  if (entry.status === SIGNPOST_STATUS.Retired) {
    throw new SetRefused(`entry ${where.bettingEntryId} is retired${entry.reason === '' ? '' : `: ${entry.reason}`}`);
  }
  if (entry.contracts.length !== 8) {
    throw new SetRefused(`entry ${where.bettingEntryId} lists ${entry.contracts.length} contracts; a betting set is eight: the core, six modules and the relay`);
  }
  if (entry.codeHashes.length !== entry.contracts.length) {
    throw new SetRefused(`entry ${where.bettingEntryId} lists ${entry.codeHashes.length} code hashes for ${entry.contracts.length} contracts`);
  }

  // The code at each address is the entry's, now and not only when the entry was written.
  for (let i = 0; i < entry.contracts.length; i++) {
    const address = entry.contracts[i] as Address;
    const code = await codeAt(rpc, address, at);
    const hash = keccak256(code);
    if (hash === NO_CODE_HASH) throw new SetRefused(`entry ${where.bettingEntryId}: ${address} holds no code`);
    if (hash.toLowerCase() !== (entry.codeHashes[i] as string).toLowerCase()) {
      throw new SetRefused(`entry ${where.bettingEntryId}: the code at ${address} does not hash as the entry says`);
    }
  }
  const coin = getAddress(entry.coin);
  if ((await codeAt(rpc, coin, at)) === '0x') throw new SetRefused(`entry ${where.bettingEntryId}: its coin ${coin} holds no code`);
  const coinDecimals = Number(await readAt<number>(rpc, COIN_ABI, coin, 'decimals', [], at));

  // The core is the one a reader starts from; its registry names the modules.
  const core = getAddress(entry.contracts[0] as Address);
  const listed = new Set(entry.contracts.map((a) => getAddress(a)));
  if (!(await readAt<boolean>(rpc, CORE_ABI, core, 's_finalized', [], at))) throw new SetRefused(`entry ${where.bettingEntryId}: the core ${core} is not finalized`);
  const coreCoin = getAddress(await readAt<Address>(rpc, CORE_ABI, core, 'i_token', [], at));
  if (coreCoin !== coin) throw new SetRefused(`entry ${where.bettingEntryId}: the core's coin is ${coreCoin}, the entry's is ${coin}`);
  const games = getAddress(await readAt<Address>(rpc, CORE_ABI, core, 'i_games', [], at));
  if ((await codeAt(rpc, games, at)) === '0x') throw new SetRefused(`entry ${where.bettingEntryId}: the core's games set ${games} holds no code`);

  const modules = {} as Record<ModuleName, Address>;
  for (const name of MODULES) {
    const address = getAddress(await readAt<Address>(rpc, CORE_ABI, core, 'getModule', [MODULE_TYPES[name]], at));
    if (!listed.has(address)) throw new SetRefused(`entry ${where.bettingEntryId}: the core's ${name} module ${address} is not among the entry's contracts`);
    modules[name] = address;
  }
  const rest = [...listed].filter((a) => a !== core && !MODULES.some((m) => modules[m] === a));
  if (rest.length !== 1) throw new SetRefused(`entry ${where.bettingEntryId}: ${rest.length} contracts are neither the core nor a module; one, the relay, was expected`);
  const relay = rest[0] as Address;

  const relayMatching = getAddress(await readAt<Address>(rpc, RELAY_ABI, relay, 'i_matching', [], at));
  if (relayMatching !== modules.matching) throw new SetRefused(`entry ${where.bettingEntryId}: the relay ${relay} passes to ${relayMatching}, not the set's matching contract ${modules.matching}`);
  const timelock = getAddress(await readAt<Address>(rpc, MATCHING_ABI, modules.matching, 'i_timelock', [], at));
  const relayTimelock = getAddress(await readAt<Address>(rpc, RELAY_ABI, relay, 'i_timelock', [], at));
  if (relayTimelock !== timelock) throw new SetRefused(`entry ${where.bettingEntryId}: the relay's timelock ${relayTimelock} is not the matching contract's ${timelock}`);
  const sender = getAddress(await readAt<Address>(rpc, RELAY_ABI, relay, 's_sender', [], at));

  return {
    chainId,
    signpost,
    entryId: where.bettingEntryId,
    commit: entry.commit,
    deployBlock: entry.deployBlock,
    status: entry.status,
    core,
    ...modules,
    relay,
    coin,
    coinDecimals,
    games,
    timelock,
    sender,
    readAt: header,
  };
}

function kindName(kind: number): string {
  return (Object.entries(SIGNPOST_KIND).find(([, v]) => v === kind)?.[0] ?? `kind ${kind}`).toLowerCase();
}

export function statusName(status: number): string {
  return (Object.entries(SIGNPOST_STATUS).find(([, v]) => v === status)?.[0] ?? `status ${status}`).toLowerCase();
}
