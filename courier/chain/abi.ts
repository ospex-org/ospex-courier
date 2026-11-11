import { keccak256, parseAbi, toBytes } from 'viem';

// The parts of the set's interface the courier calls, written out. A test
// compares each against the contracts' build at the pinned commit, so a pin
// that moves the interface is seen there and not at a live call.

/** The signpost: the public list of the sets, and the one address the courier is configured with. */
export const SIGNPOST_ABI = parseAbi([
  'function entryCount() view returns (uint256)',
  'function getEntry(uint256 id) view returns ((uint8 kind, address coin, address[] contracts, bytes32[] codeHashes, bytes20 commit, uint64 deployBlock, uint8 status, string reason))',
  'function i_timelock() view returns (address)',
]);

export const SIGNPOST_KIND = { Games: 0, Betting: 1, Both: 2 } as const;
export const SIGNPOST_STATUS = { Building: 0, Live: 1, Retired: 2 } as const;

/** The core of the betting set: the contract a reader starts from. */
export const CORE_ABI = parseAbi([
  'function getModule(bytes32 moduleType) view returns (address)',
  'function isRegisteredModule(address moduleAddress) view returns (bool)',
  'function i_games() view returns (address)',
  'function i_token() view returns (address)',
  'function s_finalized() view returns (bool)',
]);

/** The six module types, as the core names them. */
export const MODULE_TYPES = {
  markets: keccak256(toBytes('MARKET_MODULE')),
  positions: keccak256(toBytes('POSITION_MODULE')),
  matching: keccak256(toBytes('MATCHING_MODULE')),
  moneyline: keccak256(toBytes('MONEYLINE_SCORER_MODULE')),
  spread: keccak256(toBytes('SPREAD_SCORER_MODULE')),
  total: keccak256(toBytes('TOTAL_SCORER_MODULE')),
} as const;

export type ModuleName = keyof typeof MODULE_TYPES;

/** The signed order's struct, as the contract's cross, cancelOrder and getOrderHash take it. */
const ORDER_STRUCT = '(address account, uint256 gameId, address scorer, int32 lineTicks, uint8 positionType, uint16 oddsTick, uint256 riskAmount, uint256 nonce, uint256 expiry, uint256 minFill)';

/**
 * The matching contract: what the courier reads of it (the door's and the
 * book's reads, the constants the door holds to), the registration the rig
 * makes, and the calls the tests make from the chain's side (a cancel, a
 * raised floor, the lift, and one Cross sent by the test from the relay's
 * sender to show the contract's own boundary).
 */
export const MATCHING_ABI = parseAbi([
  'function i_timelock() view returns (address)',
  'function i_ospexCore() view returns (address)',
  'function isCourier(address account, address courier) view returns (bool)',
  'function registerCourier(address courier)',
  'function TAKING_STAKE_CAP() view returns (uint256)',
  'function s_takingStakeCapLifted() view returns (bool)',
  'function getDomainSeparator() view returns (bytes32)',
  `function getOrderHash(${ORDER_STRUCT} order) view returns (bytes32)`,
  'function ORDER_TYPEHASH() view returns (bytes32)',
  'function MIN_ODDS() view returns (uint16)',
  'function MAX_ODDS() view returns (uint16)',
  'function MAX_LINE_TICKS() view returns (int32)',
  'function LOT() view returns (uint256)',
  'function MAX_TAKING_LIFE() view returns (uint256)',
  'function s_cancelledOrders(bytes32 orderHash) view returns (bool)',
  'function s_minNonces(address account, bytes32 marketKey) view returns (uint256)',
  'function s_filledRisk(bytes32 orderHash) view returns (uint256)',
  `function cancelOrder(${ORDER_STRUCT} order)`,
  'function raiseMinNonce(uint256 gameId, address scorer, int32 lineTicks, uint256 newMinNonce)',
  'function liftTakingStakeCap()',
  `function cross((${ORDER_STRUCT} order, bytes signature) taking, (${ORDER_STRUCT} order, bytes signature)[] resting)`,
]);

/** The relay: the courier's address on chain. */
export const RELAY_ABI = parseAbi([
  'function i_matching() view returns (address)',
  'function i_timelock() view returns (address)',
  'function s_sender() view returns (address)',
  `function cross((${ORDER_STRUCT} order, bytes signature) taking, (${ORDER_STRUCT} order, bytes signature)[] resting)`,
]);

/** The games set, for the reads the courier makes of a game. */
export const GAMES_ABI = parseAbi([
  'function gameCount() view returns (uint256)',
  'function getGameStatus(uint256 gameId) view returns (uint8)',
  'function getGameStart(uint256 gameId) view returns (uint64)',
  'function getGameWindow(uint256 gameId) view returns (uint64)',
  'function getGameReporters(uint256 gameId) view returns (address[] reporters, uint8[] kinds)',
]);

/** The coin: the reads the book and the pre-check make of it. */
export const COIN_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

/**
 * The chain's multicall contract, present on Polygon at this address. The
 * courier asks it, in the same call as each read of state, for the block's
 * number, its time and its parent's hash, and compares them with the header
 * of the block it named.
 */
export const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const MULTICALL_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getLastBlockHash() view returns (bytes32 blockHash)',
  'function getBlockHash(uint256 blockNumber) view returns (bytes32 blockHash)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getChainId() view returns (uint256 chainid)',
]);
