import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { MULTICALL_ABI, MULTICALL_ADDRESS, RELAY_ABI } from './abi';
import {
  byHash,
  callAt,
  describeNodeFailure,
  estimateGasAt,
  headerByNumber,
  headerByTag,
  multicallAt,
  NodeFailure,
  transactionCountAt,
  type Header,
  type JsonRpc,
  type StateOverride,
} from './rpc';

// What the node can do is proved, not assumed. At every start, and as a
// command of its own (check:node), the courier makes each request the
// pre-check will make three ways: at the latest block's hash; at the hash of a
// block 50 back, where the multicall contract's answer must be that older
// block's number; and at a hash no block has, which must come back as an
// error. It also overrides one balance and reads it back, to learn whether an
// override is taken. The verdicts are on the status address.

export interface Outcome {
  ok: boolean;
  /** What was seen: an answer in the shape expected, or the failure by its class and code. */
  saw: string;
}

export interface Verdict {
  request: string;
  atLatest: Outcome;
  atBlockBack: Outcome;
  /** ok when the node refused the request, as it must for a hash no block has. */
  atUnknownHash: Outcome;
}

export interface NodeCheck {
  checkedAt: string;
  latest: { number: string; hash: Hex } | null;
  back: { number: string; hash: Hex } | null;
  verdicts: Verdict[];
  /** Whether the node took a balance override on eth_call, read back at the latest block's hash. */
  overrideTaken: Outcome;
  /** Whether the node answers the finalized tag with a block at or under the latest. */
  finalized: Outcome;
  /** Every request the pre-check needs held, at both hashes and refused at the unknown one, and finalized answered. */
  usable: boolean;
}

/** How far back the older block is. */
export const BLOCKS_BACK = 50n;

/** A hash no block has: the hash of a sentence, which no header is. */
export const UNKNOWN_HASH: Hex = keccak256(toBytes('ospex courier: a hash no block has'));

const OVERRIDDEN_BALANCE = 0x1234_5678_9abc_def0n;

function failed(err: unknown): Outcome {
  const d = describeNodeFailure(err);
  return { ok: false, saw: `${d.kind}${d.code === null ? '' : ` (${d.code})`}` };
}

/** The outcome of a request that must succeed, judged by `check` on its answer. */
async function expectAnswer<T>(work: () => Promise<T>, check: (answer: T) => string | null): Promise<Outcome> {
  try {
    const answer = await work();
    const problem = check(answer);
    return problem === null ? { ok: true, saw: 'answered as expected' } : { ok: false, saw: problem };
  } catch (err) {
    return failed(err);
  }
}

/** The outcome of a request that must be refused: ok when the node answered with an error, not ok when it answered at all. */
async function expectRefusal(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    await work();
    return { ok: false, saw: 'answered for a hash no block has' };
  } catch (err) {
    if (err instanceof NodeFailure && err.kind === 'refused') return { ok: true, saw: `refused${err.code === null ? '' : ` (${err.code})`}` };
    return { ok: false, saw: `failed, but not as a refusal: ${failed(err).saw}` };
  }
}

export interface NodeCheckTargets {
  /** The relay: the address the exact call goes to. */
  relay: Address;
  /** The address whose transaction count is read: the sender key's, once there is one; the relay's sender until then. */
  sender: Address;
}

export async function checkNode(rpc: JsonRpc, targets: NodeCheckTargets, now: () => Date = () => new Date()): Promise<NodeCheck> {
  const checkedAt = now().toISOString();
  let latest: Header;
  try {
    latest = await headerByTag(rpc, 'latest');
  } catch (err) {
    const saw = failed(err);
    return { checkedAt, latest: null, back: null, verdicts: [], overrideTaken: saw, finalized: saw, usable: false };
  }
  const backNumber = latest.number >= BLOCKS_BACK ? latest.number - BLOCKS_BACK : 0n;
  let back: Header | null = null;
  try {
    back = await headerByNumber(rpc, backNumber);
  } catch {
    back = null;
  }
  const relayRead = encodeFunctionData({ abi: RELAY_ABI, functionName: 's_sender' });
  const blockNumberRead = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getBlockNumber' });

  const three = async (
    request: string,
    atHeader: (h: Header) => Promise<Outcome>,
    atUnknown: () => Promise<unknown>,
  ): Promise<Verdict> => ({
    request,
    atLatest: await atHeader(latest),
    atBlockBack: back === null ? { ok: false, saw: `no header for block ${backNumber}` } : await atHeader(back),
    atUnknownHash: await expectRefusal(atUnknown),
  });

  const verdicts: Verdict[] = [];

  // The reads of state: one call to the multicall contract, whose answer must be the named block's number, time and parent.
  verdicts.push(
    await three(
      'eth_call to the multicall contract, the block checked by number, time and parent hash',
      (h) => expectAnswer(() => multicallAt(rpc, h, []), () => null),
      () => callAt(rpc, { to: MULTICALL_ADDRESS, data: blockNumberRead }, byHash(UNKNOWN_HASH)),
    ),
  );

  // The key's transaction count.
  verdicts.push(
    await three(
      'eth_getTransactionCount of the sender',
      (h) => expectAnswer(() => transactionCountAt(rpc, targets.sender, byHash(h.hash)), () => null),
      () => transactionCountAt(rpc, targets.sender, byHash(UNKNOWN_HASH)),
    ),
  );

  // The exact call, from the sender to the relay. This build holds no key and signs nothing, so the call is the
  // relay's own read of its sender: the method and the block parameter are the same ones the Cross's call uses.
  verdicts.push(
    await three(
      'eth_call from the sender to the relay',
      (h) =>
        expectAnswer(
          () => callAt(rpc, { from: targets.sender, to: targets.relay, data: relayRead }, byHash(h.hash)),
          (out) => (out.length === 66 ? null : `the relay answered ${out.length} characters, not one word`),
        ),
      () => callAt(rpc, { from: targets.sender, to: targets.relay, data: relayRead }, byHash(UNKNOWN_HASH)),
    ),
  );

  // The gas estimate of the same call.
  verdicts.push(
    await three(
      'eth_estimateGas from the sender to the relay',
      (h) => expectAnswer(() => estimateGasAt(rpc, { from: targets.sender, to: targets.relay, data: relayRead }, byHash(h.hash)), (gas) => (gas > 0n ? null : 'an estimate of zero')),
      () => estimateGasAt(rpc, { from: targets.sender, to: targets.relay, data: relayRead }, byHash(UNKNOWN_HASH)),
    ),
  );

  // One balance overridden and read back, at the latest block's hash.
  const probe = targets.sender;
  const override: StateOverride = { [probe]: { balance: `0x${OVERRIDDEN_BALANCE.toString(16)}` } };
  const overrideTaken = await expectAnswer(
    () => callAt(rpc, { to: MULTICALL_ADDRESS, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getEthBalance', args: [probe] }) }, byHash(latest.hash), override),
    (out) => {
      const balance = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'getEthBalance', data: out }) as bigint;
      return balance === OVERRIDDEN_BALANCE ? null : 'the balance read back was not the one overridden';
    },
  );

  // The finalized tag: a block at or under the latest.
  const finalized = await expectAnswer(
    () => headerByTag(rpc, 'finalized'),
    (h) => (h.number <= latest.number ? null : `finalized (${h.number}) is above latest (${latest.number})`),
  );

  const usable = verdicts.every((v) => v.atLatest.ok && v.atBlockBack.ok && v.atUnknownHash.ok) && finalized.ok;
  return {
    checkedAt,
    latest: { number: latest.number.toString(), hash: latest.hash },
    back: back === null ? null : { number: back.number.toString(), hash: back.hash },
    verdicts,
    overrideTaken,
    finalized,
    usable,
  };
}
