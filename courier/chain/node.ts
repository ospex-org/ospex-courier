import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { MULTICALL_ABI, MULTICALL_ADDRESS, RELAY_ABI, RELAY_SENDER_SLOT } from './abi';
import {
  byHash,
  callAt,
  describeNodeFailure,
  estimateGasAt,
  ExecutionReverted,
  headerByNumber,
  headerByTag,
  multicallAt,
  NodeFailure,
  storageAt,
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
// error. It reads the relay's storage slot 0 at the latest hash and holds it to
// the relay's sender. It overrides that slot for one call, setting it to the
// multicall contract, and reads the sender back, to learn whether an override
// is taken. And it makes a call whose answer depends on the block's time at two
// hashes of two different times, a call that succeeds while the block's time is
// under the later block's and is refused from that second on: the call, its
// estimate and the call at the estimated limit, each at the same hash, so a
// node that runs a call named by a hash at another block's time is seen. The
// verdicts are on the status address; while one the pre-check needs fails, the
// door takes no order.

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
  /** Whether the relay's storage slot 0 at the latest block's hash holds the relay's sender, as the relay's own read answers it at that hash. */
  relaySenderSlot: Outcome;
  /** Whether the node took an override on eth_call: the relay's slot 0 set to the multicall contract for one call, and the relay's sender read back as that, at the latest block's hash. */
  overrideTaken: Outcome;
  /** Whether a call whose answer depends on the block's time ran at each named block's own time: at the older hash it, its estimate and the call at the estimated limit succeed; at the later hash the call and the estimate are refused. */
  timedCall: Outcome;
  /** Whether the node answers the finalized tag with a block at or under the latest. */
  finalized: Outcome;
  /** Every request the pre-check needs held, at both hashes and refused at the unknown one; the relay's slot is its sender; the timed call ran at each block's time; and finalized answered. An override is not needed: without one the comparison is skipped. */
  usable: boolean;
}

/** How far back the older block is. */
export const BLOCKS_BACK = 50n;

/** A hash no block has: the hash of a sentence, which no header is. */
export const UNKNOWN_HASH: Hex = keccak256(toBytes('ospex courier: a hash no block has'));


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
  /** The address the calls are made from and whose transaction count is read: COURIER_ADDRESS, the key's address. */
  sender: Address;
}

/**
 * The creation code of the timed call: it returns nothing while the block's time is under `before`, and reverts with
 * no data from that second on. A call with no target runs it as a creation, so no contract need be on the chain:
 * PUSH8 before, TIMESTAMP, LT, PUSH1 19, JUMPI, (REVERT 0 0), JUMPDEST at 19, (RETURN 0 0).
 */
export function timedCode(before: bigint): Hex {
  return `0x67${before.toString(16).padStart(16, '0')}421060135760006000fd5b60006000f3`;
}

/** The word the relay's slot 0 holds for an address: twelve zero bytes and the address. */
const slotWord = (address: Address): Hex => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

export async function checkNode(rpc: JsonRpc, targets: NodeCheckTargets, now: () => Date = () => new Date()): Promise<NodeCheck> {
  const checkedAt = now().toISOString();
  let latest: Header;
  try {
    latest = await headerByTag(rpc, 'latest');
  } catch (err) {
    const saw = failed(err);
    return { checkedAt, latest: null, back: null, verdicts: [], relaySenderSlot: saw, overrideTaken: saw, timedCall: saw, finalized: saw, usable: false };
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

  // The relay's slot 0 at the latest hash, held to the relay's sender as its own read answers it at that hash: the
  // slot the comparison's override writes is the sender's.
  const relaySenderSlot = await expectAnswer(
    async () => ({
      slot: await storageAt(rpc, targets.relay, RELAY_SENDER_SLOT, byHash(latest.hash)),
      sender: decodeFunctionResult({ abi: RELAY_ABI, functionName: 's_sender', data: await callAt(rpc, { to: targets.relay, data: relayRead }, byHash(latest.hash)) }) as Address,
    }),
    ({ slot, sender }) => (slot === slotWord(sender) ? null : `the relay's slot 0 does not hold its sender ${sender}`),
  );

  // The override: the relay's slot 0 set to the multicall contract for one call, and the sender read back as that.
  const override: StateOverride = { [targets.relay]: { stateDiff: { [`0x${'0'.repeat(64)}`]: slotWord(MULTICALL_ADDRESS) } } };
  const overrideTaken = await expectAnswer(
    () => callAt(rpc, { to: targets.relay, data: relayRead }, byHash(latest.hash), override),
    (out) => {
      const sender = decodeFunctionResult({ abi: RELAY_ABI, functionName: 's_sender', data: out }) as Address;
      return sender.toLowerCase() === MULTICALL_ADDRESS.toLowerCase() ? null : 'the sender read back was not the one the override wrote';
    },
  );

  // The timed call, at two hashes of two times: at the older block it, its estimate and the call at the estimated
  // limit succeed, each at that block's hash; at the later block the call and the estimate are refused, each at the
  // later block's hash. The limit is the courier's own, the estimate and a fifth of it.
  const timedCall = await (async (): Promise<Outcome> => {
    if (back === null) return { ok: false, saw: `no header for block ${backNumber}` };
    if (back.timestamp >= latest.timestamp) return { ok: false, saw: `the two blocks have one time (${latest.timestamp}): a call at each cannot show which time it ran at` };
    const call = { from: targets.sender, data: timedCode(latest.timestamp) };
    const older = byHash(back.hash);
    const later = byHash(latest.hash);
    const run = async (work: () => Promise<unknown>): Promise<'answered' | 'refused'> => {
      try {
        await work();
        return 'answered';
      } catch (err) {
        if (err instanceof ExecutionReverted) return 'refused';
        throw err;
      }
    };
    try {
      const callOlder = await run(() => rpc.request('eth_call', [call, older]));
      const g = await estimateCreation(rpc, call, older);
      const limited = await run(() => rpc.request('eth_call', [{ ...call, gas: `0x${(g + g / 5n).toString(16)}` }, older]));
      const callLater = await run(() => rpc.request('eth_call', [call, later]));
      const estimateLater = await run(() => rpc.request('eth_estimateGas', [call, later]));
      const seen = { callOlder, limited, callLater, estimateLater };
      return callOlder === 'answered' && limited === 'answered' && callLater === 'refused' && estimateLater === 'refused'
        ? { ok: true, saw: 'answered as expected' }
        : { ok: false, saw: `the call did not run at each block's own time: ${JSON.stringify(seen)}` };
    } catch (err) {
      return failed(err);
    }
  })();

  // The finalized tag: a block at or under the latest.
  const finalized = await expectAnswer(
    () => headerByTag(rpc, 'finalized'),
    (h) => (h.number <= latest.number ? null : `finalized (${h.number}) is above latest (${latest.number})`),
  );

  const usable = verdicts.every((v) => v.atLatest.ok && v.atBlockBack.ok && v.atUnknownHash.ok) && relaySenderSlot.ok && timedCall.ok && finalized.ok;
  return {
    checkedAt,
    latest: { number: latest.number.toString(), hash: latest.hash },
    back: back === null ? null : { number: back.number.toString(), hash: back.hash },
    verdicts,
    relaySenderSlot,
    overrideTaken,
    timedCall,
    finalized,
    usable,
  };
}

/** eth_estimateGas of a call with no target (a creation), at a named block. */
async function estimateCreation(rpc: JsonRpc, call: { from: Address; data: Hex }, ref: ReturnType<typeof byHash>): Promise<bigint> {
  const answer = await rpc.request<unknown>('eth_estimateGas', [call, ref]);
  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(answer)) throw new NodeFailure('malformed', 'eth_estimateGas', null, 'the estimate is not a hex quantity');
  return BigInt(answer);
}
