import { decodeErrorResult, decodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { COIN_REFUSALS_ABI } from '../chain/abi';
import { traceOf, type JsonRpc, type Receipt, type TraceFrame } from '../chain/rpc';
import type { BettingSet } from '../chain/set';
import { decodeRevert, type Decoded, type SkipReason } from '../check/decode';
import { CROSS_SELECTOR } from './signer';

// The reason a mined Cross reverted, and whose act it was. `reverted`
// rests on the failed receipt alone; the reason comes from one trace of the
// transaction with the call tracer and from nothing else: no replay is made.
// The top call's output is decoded with the pinned interface, by the same
// decoder as the pre-check's simulation. Where the error names a pull, the
// coin's own frame is read for whether it refused, and by which rule, or ran
// out of gas. A trace the node refuses, one with no output, one that does not
// bind to this transaction, or one that stops short of the frame, gives the
// reason "unavailable". An account is named only where the decoded refusal,
// from a trace bound to this transaction, shows that account's own act.

/** One account an act is pinned on: its role in the Cross, and the act the chain shows. */
export interface Pinned {
  account: Address;
  role: 'bettor' | 'maker';
  act: string;
}

/** The coin's own refusal of a pull, as its frame shows it. */
export type CoinRefusal = 'balance' | 'allowance' | 'paused' | 'blocked' | 'out of gas' | 'other';

export interface Reason {
  evidence: 'trace' | 'unavailable';
  /** The top call's output decoded, or null with no trace. */
  decoded: Decoded | null;
  /** The top call's output, whole, as hex; null with no trace. */
  data: Hex | null;
  /** The reason's name for the record: the error's short name, "out of gas", "empty", an unknown selector, or "unavailable". */
  name: string;
  /** Whose act: accounts with their roles, nobody (an empty list), or "unknown". */
  pinnedOn: Pinned[] | 'unknown';
  /** What kind of cause where no account is named: the clock, the depth, the game, the courier's own (a chain or gas failure), or none. */
  cause: 'accounts' | 'clock' | 'depth' | 'game' | 'courier' | 'unknown';
  /** For a pull: the affected account and its role, recorded apart from `pinnedOn`, and the coin's refusal as its frame shows it. */
  affected: Array<{ account: Address; role: 'bettor' | 'maker'; pull: string; coin: CoinRefusal | 'absent' }>;
  /** Whether the refusal selects the fallback that needs a person's look: an unknown reason, an empty one with no proved out of gas, or a known one the table does not list. */
  needsLook: boolean;
}

const TRANSFER_FROM: Hex = '0x23b872dd';

/** The listed quotes' accounts, in list order, and the bettor's: what a reason can name. */
export interface Named {
  bettor: Address;
  positions: Address;
  legs: ReadonlyArray<{ orderHash: Hex; account: Address }>;
  /** The hash of the calldata the Cross was signed with: what binds a trace to this transaction. */
  calldataHash: Hex | null;
}

const unavailable = (why: string): Reason & { why: string } => ({ evidence: 'unavailable', decoded: null, data: null, name: 'unavailable', pinnedOn: 'unknown', cause: 'unknown', affected: [], needsLook: false, why });

function* frames(f: TraceFrame): Generator<TraceFrame> {
  yield f;
  for (const c of f.calls) yield* frames(c);
}

/** The coin's frame of a pull from `account` of `amount` to the positions contract, where the trace holds it. */
function pullFrame(top: TraceFrame, coin: Address, positions: Address, account: Address, amount: bigint): TraceFrame | null {
  for (const f of frames(top)) {
    if (f.to === null || f.to.toLowerCase() !== coin.toLowerCase() || !f.input.startsWith(TRANSFER_FROM)) continue;
    try {
      const { args } = decodeFunctionData({ abi: COIN_REFUSALS_ABI, data: f.input });
      const [from, to, value] = args as [Address, Address, bigint];
      if (from.toLowerCase() === account.toLowerCase() && to.toLowerCase() === positions.toLowerCase() && value === amount) return f;
    } catch {
      continue;
    }
  }
  return null;
}

/** The coin's refusal, from its frame: a rule of the coin's own (a pause, a block), or a balance or an allowance too low, or out of gas. */
export function coinRefusal(f: TraceFrame): CoinRefusal {
  if (f.error !== null && /out of gas/i.test(f.error)) return 'out of gas';
  const out = f.output;
  if (out === null || out === '0x') return 'other';
  try {
    const e = decodeErrorResult({ abi: COIN_REFUSALS_ABI, data: out });
    if (e.errorName === 'ERC20InsufficientBalance') return 'balance';
    if (e.errorName === 'ERC20InsufficientAllowance') return 'allowance';
    if (e.errorName === 'Paused') return 'paused';
    if (e.errorName === 'Blocked') return 'blocked';
  } catch {
    // Not one of the custom errors: a string reason, as the deployed coin gives.
  }
  try {
    const e = decodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] }], data: out });
    const text = String((e.args as readonly unknown[])[0]);
    if (/exceeds balance/i.test(text)) return 'balance';
    if (/exceeds allowance|insufficient allowance/i.test(text)) return 'allowance';
    if (/paused/i.test(text)) return 'paused';
    if (/blacklist|blocked/i.test(text)) return 'blocked';
  } catch {
    // An output the coin's interface does not decode.
  }
  return 'other';
}

/** A pull's act, by the coin's refusal: the account's own where the coin says its balance or its allowance was too low; otherwise not shown. */
const pullAct = (c: CoinRefusal | 'absent'): string | null => (c === 'balance' ? 'its USDC balance was too low' : c === 'allowance' ? 'its approval to the positions contract was too low' : null);

/** The reason and whose act it was, from one trace. The trace is asked once; any failure of it is "unavailable". */
export async function reasonOf(rpc: JsonRpc, set: BettingSet, key: Address, receipt: Receipt, named: Named): Promise<Reason & { why?: string }> {
  let top: TraceFrame;
  try {
    top = await traceOf(rpc, receipt.transactionHash);
  } catch {
    return unavailable('the node did not trace the transaction');
  }
  // The trace binds to this transaction: the top call from the key to the relay, the Cross's selector, the calldata signed.
  if (top.from === null || top.from.toLowerCase() !== key.toLowerCase() || top.to === null || top.to.toLowerCase() !== set.relay.toLowerCase() || !top.input.startsWith(CROSS_SELECTOR)) {
    return unavailable('the trace is not of this transaction: its top call is not from the key to the relay with the Cross');
  }
  if (named.calldataHash !== null && keccak256(top.input).toLowerCase() !== named.calldataHash.toLowerCase()) return unavailable('the trace is not of this transaction: its calldata is not the one signed');
  if (top.error === null) return unavailable('the trace shows the top call succeeding, and the receipt says it failed');
  const outOfGas = [...frames(top)].some((f) => f.error !== null && /out of gas/i.test(f.error));
  if (top.output === null) {
    if (/out of gas/i.test(top.error)) return { evidence: 'trace', decoded: { kind: 'empty' }, data: null, name: 'out of gas', pinnedOn: [], cause: 'courier', affected: [], needsLook: false };
    return unavailable('the trace has no output');
  }
  const decoded = decodeRevert(top.output);
  const base = { evidence: 'trace' as const, decoded, data: top.output };
  if (decoded.kind === 'empty') {
    if (outOfGas) return { ...base, name: 'out of gas', pinnedOn: [], cause: 'courier', affected: [] , needsLook: false };
    return { ...base, name: 'empty', pinnedOn: 'unknown', cause: 'unknown', affected: [], needsLook: true };
  }
  if (decoded.kind === 'unknown') return { ...base, name: decoded.selector, pinnedOn: 'unknown', cause: 'unknown', affected: [], needsLook: true };
  const short = decoded.name.replace(/^Ospex[A-Za-z]+__/, '');
  const args = decoded.args;
  const bettor = named.bettor;
  switch (short) {
    case 'TakingOrderCancelled':
      return { ...base, name: short, pinnedOn: [{ account: bettor, role: 'bettor', act: 'cancelled on chain' }], cause: 'accounts', affected: [], needsLook: false };
    case 'TakingOrderFilled':
      return { ...base, name: short, pinnedOn: [{ account: bettor, role: 'bettor', act: 'filled first by another transaction' }], cause: 'accounts', affected: [], needsLook: false };
    case 'TakingOrderExpired':
    case 'TakingOrderTooLong':
      return { ...base, name: short, pinnedOn: [], cause: 'clock', affected: [], needsLook: false };
    case 'TakingOrderGrantGone': {
      const [, grant, current] = args as [string, number | string, number | string];
      const revoked = String(grant) !== String(current);
      return { ...base, name: short, pinnedOn: revoked ? [{ account: bettor, role: 'bettor', act: 'revoked or replaced its grant' }] : [], cause: revoked ? 'accounts' : 'clock', affected: [], needsLook: false };
    }
    case 'SenderNotCourier': {
      const [account] = args as [Address];
      const role = account.toLowerCase() === bettor.toLowerCase() ? 'bettor' : 'maker';
      return { ...base, name: short, pinnedOn: [{ account, role, act: "took the courier's relay off its couriers" }], cause: 'accounts', affected: [], needsLook: false };
    }
    case 'TakerPullRefused': {
      const [taker, pull] = args as [Address, string];
      const frame = pullFrame(top, set.coin, set.positions, taker, BigInt(pull));
      if (frame === null) return unavailable('the trace stops short of the coin\'s frame of the pull');
      const coin = coinRefusal(frame);
      const act = pullAct(coin);
      return { ...base, name: short, pinnedOn: act === null ? 'unknown' : [{ account: taker, role: 'bettor', act }], cause: act === null ? 'unknown' : 'accounts', affected: [{ account: taker, role: 'bettor', pull: String(pull), coin }], needsLook: false };
    }
    case 'NothingFilled': {
      const reasons = decoded.reasons as SkipReason[];
      const pinned: Pinned[] = [];
      const affected: Reason['affected'] = [];
      let unknown = false;
      for (let i = 0; i < reasons.length; i++) {
        const leg = named.legs[i];
        const r = reasons[i];
        if (leg === undefined) return unavailable('the refusal lists more skips than the Cross listed quotes');
        if (r === 'Cancelled') pinned.push({ account: leg.account, role: 'maker', act: 'cancelled on chain' });
        else if (r === 'NoCourier') pinned.push({ account: leg.account, role: 'maker', act: "had not registered the courier's relay" });
        else if (r === 'GrantGone') unknown = true;
        else if (r === 'PullRefused') {
          // The maker's pull: its frame, by its account, to the positions contract; the amount is the frame's own.
          const frame = [...frames(top)].find((f) => {
            if (f.to === null || f.to.toLowerCase() !== set.coin.toLowerCase() || !f.input.startsWith(TRANSFER_FROM) || f.error === null) return false;
            try {
              const [from, to] = decodeFunctionData({ abi: COIN_REFUSALS_ABI, data: f.input }).args as [Address, Address, bigint];
              return from.toLowerCase() === leg.account.toLowerCase() && to.toLowerCase() === set.positions.toLowerCase();
            } catch {
              return false;
            }
          });
          if (frame === undefined) return unavailable("the trace stops short of the coin's frame of a maker's pull");
          const amount = (decodeFunctionData({ abi: COIN_REFUSALS_ABI, data: frame.input }).args as [Address, Address, bigint])[2];
          const coin = coinRefusal(frame);
          affected.push({ account: leg.account, role: 'maker', pull: amount.toString(), coin });
          const act = pullAct(coin);
          if (act === null) unknown = true;
          else pinned.push({ account: leg.account, role: 'maker', act });
        }
      }
      return { ...base, name: short, pinnedOn: unknown ? 'unknown' : pinned, cause: unknown ? 'unknown' : pinned.length > 0 ? 'accounts' : 'depth', affected, needsLook: false };
    }
    case 'TakingOrderUnderMinFill':
      return { ...base, name: short, pinnedOn: [], cause: 'depth', affected: [], needsLook: false };
    case 'BetsClosed':
    case 'GameEnded':
    case 'MarketSettled':
      return { ...base, name: short, pinnedOn: [], cause: 'game', affected: [], needsLook: false };
    case 'NotTheSender':
      return { ...base, name: short, pinnedOn: [], cause: 'courier', affected: [], needsLook: false };
    default:
      // Known to the decoder, and not one the table lists: the pre-check's own refusals, met at the landing block.
      return { ...base, name: short, pinnedOn: 'unknown', cause: 'unknown', affected: [], needsLook: true };
  }
}

/** The reason as the record keeps it, for a line a count can read: the name and its values, the evidence, whose act, and for a pull the affected account apart. */
export function reasonFacts(r: Reason & { why?: string }): Record<string, unknown> {
  return {
    reason: r.name,
    evidence: r.evidence,
    ...(r.decoded !== null && r.decoded.kind === 'named' ? { args: r.decoded.args } : {}),
    pinnedOn: r.pinnedOn,
    cause: r.cause,
    affected: r.affected,
    ...(r.why === undefined ? {} : { why: r.why }),
  };
}
