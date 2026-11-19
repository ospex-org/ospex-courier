import type { Address, Hex } from 'viem';
import { readForStop, type StopRead } from '../chain/reads';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import { BOUNDS, type Counters } from '../http/limits';
import type { HttpAnswer } from '../http/routes';
import type { Run } from '../records/runs';
import type { NewStop } from '../records/stops';
import type { Store } from '../records/store';
import { budgetRefusal, takeBudgets } from './budgets';
import { lockKey } from './door';
import { checkOrderRules, coinAmount, isChainSignature, orderHash, orderSigner, orderToJson, splitNonce } from './order';
import { grantGone } from './standing';
import { readStopShape, stopSigner, type Original } from './stop';

// The stop: POST /v1/stops. An account, or the agent of its current grant,
// signs one message naming orders of the account by hash, and from the moment
// the courier writes it down those orders are carried for no fill: a quote is
// listed for no bet, and a bet waiting its turn is not sent. No transaction is
// made and nothing is signed here: the route recovers a signer and holds no
// key. With an order's signed original beside its hash, the message stops an
// order the courier has never seen, so a post still on its way is refused when
// it arrives. A stop is permanent for its hash: written once, never removed,
// and a message whose every hash is stopped already writes nothing.
//
// The decision, in this order. The body's shape. The signer, recovered under
// the courier's own domain in the form the chain takes. The hashes looked up,
// with no lock. Then who the signer is: the account itself, or, by one read of
// the chain at the latest block, the account's live agent; anyone else is
// refused whole. A message whose every hash the account has stopped already is
// answered from the records there and then. A message naming only carried
// orders its signer may stop, with no original, is free of the budgets; any
// other is under them, which needs the account registered and takes one from
// each budget inside the transaction. Every original is judged in full before
// the transaction, holding nothing. Then one transaction: the hash locks, of
// the hashes this signer may decide and of no other, ascending by their keys as
// numbers; the records read again under the locks, each hash judged on what
// stands then; the budgets, where the message is under them; the count of the
// account's stops ahead; the message's row, the lines, the stops, the marks.
//
// No lock and no row is held across a read of the chain: every read is made
// before the transaction, at a block named by its hash, and the message is
// judged at that block. A signer who was the account's agent at that block may
// have its stop recorded after the grant has since ended: a stop that stands
// where the chain would have refused the signer a block later, which withdraws
// a quote and never fills one.

export interface StopDeps {
  store: Store;
  chain: ChainReader;
  set: BettingSet;
  run: Run;
  counters: Counters;
  coinDecimals: number;
  log(line: string): void;
}

/**
 * What the three whole-message refusals a stop of carried orders signed by the account's own key never receives
 * end with: the budgets' refusal, the registration's, and the chain's.
 */
export const STOP_RECIPE =
  "Send the stop of your own carried orders as a message of its own, with no other hash and no original: it takes none of your budgets, and signed by the account's key it reads no chain; the only limit on it is this route's count for your network address (its `retry-after`, when it refuses, names the next free slot and promises nothing), and the on-chain cancel does not go through this courier.";

const refusal = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): HttpAnswer => ({ status, body: { error, code, ...extra } });

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** One hash's result, as the answer carries it. */
export type StopResult = { orderHash: Hex; status: 'stopped' | 'already stopped' | 'stopped ahead' } | { orderHash: Hex; status: 'refused'; code: string; error: string };

const refused = (orderHash: Hex, code: string, error: string): StopResult => ({ orderHash, status: 'refused', code, error });

/** What the records hold for one hash of the message, as this account sees it. */
interface Standing {
  hash: Hex;
  /** The hash is another account's: its carried order, or its stop. */
  foreign: boolean;
  /** This account holds a stop for the hash, carried or ahead. */
  stopped: boolean;
  /** The grant number in the nonce of this account's carried order of the hash; null where it carries none. */
  carriedGrant: number | null;
}

/** An original that passed: the grant it was signed under, 0 for the account's own signature, and the second it can fill no more from. */
interface Passed {
  grantNumber: number;
  originalExpiry: bigint;
}

type Judged = { ok: true; passed: Passed } | { ok: false; code: string; error: string };

/**
 * An original judged in full, before any transaction and holding nothing: its ten fields hash to the hash it names;
 * it is an order of the stop's account; it passes the order's own rules; its signature, in the form the chain takes,
 * is its resolved signer's, the account's for grant number 0 and else the agent's of the grant its nonce names;
 * under a grant, its stake is within the grant's cap, its line is on the grant's list or the list is empty, and the
 * grant stands (the account's current one, not ending at or before the chain's time plus one): the door's four
 * checks of an order under a grant, in the door's order, under the door's four codes; its expiry is above the
 * chain's time plus one; and the stop's signer may stop it, by the rule that decides it for a carried order. The first
 * that fails is the answer for its hash.
 */
async function judgeOriginal(deps: StopDeps, original: Original, account: Address, mayStop: (grantNumber: number) => boolean, read: StopRead): Promise<Judged> {
  const no = (code: string, error: string): Judged => ({ ok: false, code, error });
  const order = original.order;
  const T = read.header.timestamp;
  if (orderHash(order, deps.set.chainId, deps.set.matching).toLowerCase() !== original.orderHash) {
    return no('ORIGINAL_NOT_THE_HASH', "The original's ten fields do not hash to this order hash under the matching contract's domain.");
  }
  if (order.account.toLowerCase() !== account.toLowerCase()) return no('NOT_YOUR_ORDER', "The original is an order of another account than the stop's.");
  const rules = checkOrderRules(order, deps.set);
  if (!rules.ok) return no(rules.code, rules.error);
  const nonce = splitNonce(order.nonce);
  const g = nonce.grantNumber;
  const signer = await orderSigner(order, original.signature, deps.set.chainId, deps.set.matching);
  if (signer === null) {
    return no(
      'BAD_SIGNATURE',
      isChainSignature(original.signature)
        ? "No signer recovers from the original's signature over its hash under the matching contract's domain."
        : "The original's signature is in a form the matching contract refuses: its last byte, v, must be 27 or 28, and its s must be in the lower half of the curve's order. No fill could take an order so signed.",
    );
  }
  let originalExpiry = order.expiry;
  if (g === 0) {
    if (signer.toLowerCase() !== account.toLowerCase()) return no('BAD_SIGNATURE', "The original's signature is not the account's over its hash under the matching contract's domain.");
  } else {
    const grant = read.grants.get(g);
    if (grant === undefined) throw new Error(`the stop's read holds no record of grant ${g} for an original under it`);
    if (grant.agent.toLowerCase() === ZERO_ADDRESS) {
      return no('BAD_SIGNATURE', `The original's nonce names grant ${g}, and its account has made no grant of that number: there is no agent whose signature it could carry.`);
    }
    if (grant.agent.toLowerCase() !== signer.toLowerCase()) {
      return no('BAD_SIGNATURE', `The original's signature is not the agent's of grant ${g}, the grant its nonce names: an order under a grant is signed by that grant's agent, not by its account and not by another key.`);
    }
    if (order.riskAmount > grant.stakeCap) {
      return no('AGENT_STAKE_ABOVE_CAP', `Grant ${g} lets its agent sign an order for ${coinAmount(grant.stakeCap, deps.coinDecimals)} USDC at most. The original is signed for ${coinAmount(order.riskAmount, deps.coinDecimals)} USDC.`);
    }
    if (grant.lineCount !== 0 && read.lineNamed.get(original.orderHash) !== true) {
      return no('LINE_NOT_IN_GRANT', `Grant ${g} names the lines its agent may sign on, and the original's line is not one of them.`);
    }
    if (grantGone(nonce, { currentGrant: read.currentGrant, endsAt: grant.endsAt }, T)) {
      const why =
        g !== read.currentGrant
          ? read.currentGrant === 0
            ? 'its account has no grant standing now'
            : `its account's current grant is ${read.currentGrant}`
          : `it ends at ${grant.endsAt}, at or under the chain's time plus one, ${T + 1n}`;
      return no('GRANT_GONE', `The original is signed under grant ${g}, and that grant is gone: ${why}. It can fill in no later block, so there is nothing to stop.`);
    }
    if (grant.endsAt < originalExpiry) originalExpiry = grant.endsAt;
  }
  if (order.expiry <= T + 1n) {
    return no('EXPIRED', `The original's expiry, ${order.expiry}, is at or under the chain's time plus one, ${T + 1n}: it can fill in no later block, so there is nothing to stop.`);
  }
  if (!mayStop(g)) {
    return no('NOT_THE_GRANTS_AGENT', `The original is not signed under grant ${read.currentGrant}, the signer's own: an agent stops only the orders signed under its current grant; the account's own key stops any of them.`);
  }
  return { ok: true, passed: { grantNumber: g, originalExpiry } };
}

/** The hashes in the order their locks are taken: ascending by the 64-bit key, compared as numbers and never as text. */
function inLockOrder(hashes: readonly Hex[]): Hex[] {
  return [...hashes].sort((a, b) => {
    const ka = BigInt(lockKey(a));
    const kb = BigInt(lockKey(b));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export async function postStop(deps: StopDeps, raw: unknown): Promise<HttpAnswer> {
  // A refusal before admission: answered, counted and logged by its code, never with the caller's address or a value.
  const counted = (answer: HttpAnswer): HttpAnswer => {
    deps.counters.count(String(answer.body.code));
    deps.log(`refused before admission: POST /v1/stops ${String(answer.body.code)}`);
    return answer;
  };

  // 1. The body's shape.
  const shape = readStopShape(raw);
  if (!shape.ok) return counted(refusal(400, 'INVALID_PARAM', `${shape.problem}.`));
  const { message, signature, originals } = shape.stop;
  const account = message.account;
  const accountKey = account.toLowerCase();

  // 2. The signer, over the message's digest under the courier's own domain, in the form the chain takes.
  const signer = await stopSigner(message, signature, deps.set.chainId, deps.set.relay);
  if (signer === null) {
    return counted(
      refusal(
        422,
        'BAD_SIGNATURE',
        isChainSignature(signature)
          ? "No signer recovers from this signature over this stop message under the courier's domain."
          : "The signature is in a form the chain refuses: its last byte, v, must be 27 or 28, and its s must be in the lower half of the curve's order. The courier takes a stop on no signature the matching contract would not take.",
      ),
    );
  }
  const byKey = signer.toLowerCase() === accountKey;

  // 3. The hashes on record, looked up with no lock: whose each is, whether it is stopped, and under which grant.
  const looked = await deps.store.stops.lookup(deps.store.pool, message.orderHashes);
  const standing: Standing[] = message.orderHashes.map((hash) => {
    const stop = looked.stops.get(hash);
    const order = looked.orders.get(hash);
    return {
      hash,
      foreign: (stop !== undefined && stop.account !== accountKey) || (order !== undefined && order.account !== accountKey),
      stopped: stop !== undefined && stop.account === accountKey,
      carriedGrant: order !== undefined && order.account === accountKey ? splitNonce(order.nonce).grantNumber : null,
    };
  });
  const originalOf = new Map(originals.map((o) => [o.orderHash, o]));

  // One read of the chain at the latest block, named by its hash: made at most once for a message, before any
  // transaction, holding nothing.
  let read: StopRead | null = null;
  const readChain = async (agent: Address | null): Promise<StopRead | null> => {
    const named = [
      // An agent's message: the grants its carried orders name, to tell a former agent of one of them from a stranger.
      ...(agent === null ? [] : standing.flatMap((s) => (s.carriedGrant === null ? [] : [s.carriedGrant]))),
      ...originals.map((o) => splitNonce(o.order.nonce).grantNumber),
    ];
    try {
      const header = await deps.chain.latestHeader();
      return await readForStop(deps.chain, deps.set, header, { account, signer: agent, grantNumbers: named, originals: originals.map((o) => ({ hash: o.orderHash, order: o.order })), registration: true });
    } catch (err) {
      if (err instanceof ChainUnreachable) return null;
      throw err;
    }
  };
  const chainUnreachable = (): HttpAnswer => counted(refusal(503, 'CHAIN_UNREACHABLE', `The chain could not be read, twice; nothing is decided without one block to decide at. ${STOP_RECIPE}`));

  // Which orders of the account this signer may stop: the account's own key any of them; its agent only the ones
  // signed under its own grant, the account's current one.
  const mayStop = (grantNumber: number): boolean => byKey || grantNumber === (read as StopRead).currentGrant;
  // A hash the account has stopped already is answered from its row, whatever grant its order was under: judged
  // before the agent's grant is compared, and nothing is written for it.
  const answeredFromItsRow = (s: Standing): boolean => s.stopped;
  const allStopped = (): HttpAnswer => ({ status: 200, body: { account, results: message.orderHashes.map((orderHash): StopResult => ({ orderHash, status: 'already stopped' })) } });

  if (byKey) {
    // 4. The account's own key. Every hash stopped already: answered now, from the lookup, with no chain read, no
    // transaction, no row, no line and no budget.
    if (standing.every(answeredFromItsRow)) return allStopped();
  } else {
    // 5. Not the account: its agent, or nobody. The chain says which, at the block read.
    read = await readChain(signer);
    if (read === null) return chainUnreachable();
    // The signer is the account's agent where the contract's own rule says so at the block read, and by nothing else:
    // the agent of the account's current grant, the block's time before the grant's end, with no margin either way.
    const live = read.liveAgent === true;
    if (!live) {
      // A key that was the agent of a grant the message names, which is not the account's current grant now or has
      // ended: a former agent. A key that is the agent of none of them: a stranger, or an order's own signature
      // offered as the stop's.
      const former = [...read.grants.entries()].filter(([, grant]) => grant.agent.toLowerCase() === signer.toLowerCase()).map(([number]) => number);
      if (former.length === 0) {
        return counted(refusal(422, 'BAD_SIGNATURE', "The signature is not the account's over this stop message under the courier's domain, and not its live agent's: a stop is taken from the account's own key or from the agent of its current grant."));
      }
      const g = former.includes(read.currentGrant) ? read.currentGrant : Math.max(...former);
      const endsAt = (read.grants.get(g) as { endsAt: bigint }).endsAt;
      const T = read.header.timestamp;
      const why =
        g !== read.currentGrant
          ? read.currentGrant === 0
            ? 'the account has no grant standing now'
            : `the account's current grant is ${read.currentGrant}`
          : `the chain's time is ${T}, at or past its end`;
      return counted(
        refusal(
          422,
          'AGENT_NOT_LIVE',
          `The signature is the agent's of grant ${g} of this account, which ends at ${endsAt}, and that grant is not live at the block read: ${why}. A stop is taken from the account's own key, or from the agent of its current grant until that grant ends.`,
          { grantNumber: g, endsAt: endsAt.toString(), currentGrant: read.currentGrant, chainTime: T.toString() },
        ),
      );
    }
    if (standing.every(answeredFromItsRow)) return allStopped();
  }

  // Free of the budgets: a message that carries no original and names only hashes the account has stopped already
  // and carried orders this signer may stop. Any other is under the budgets, whole.
  const free = originals.length === 0 && standing.every((s) => !s.foreign && (answeredFromItsRow(s) || (s.carriedGrant !== null && mayStop(s.carriedGrant))));

  if (!free) {
    // 6. Under the budgets. The account has registered the relay, read at the block before any original's signature
    // is recovered and before any row: a key that registered nothing costs one read and leaves nothing.
    if (read === null) {
      read = await readChain(null);
      if (read === null) return chainUnreachable();
    }
    if (read.registered !== true) {
      return counted(refusal(422, 'NOT_REGISTERED', `The account has not registered the courier's relay, ${deps.set.relay}, with the matching contract. ${STOP_RECIPE}`));
    }
  }

  // Every original judged in full, before the transaction and holding nothing.
  const judged = new Map<Hex, Judged>();
  if (read !== null) for (const original of originals) judged.set(original.orderHash, await judgeOriginal(deps, original, account, mayStop, read));

  // Each hash, from the lookup: answered now, or to be decided under its lock.
  // 7. The lock set is the hashes this signer may decide: the account's carried orders it may stop, and the hashes of
  // its originals that passed. Nothing else is ever locked: another account's hash, an order outside the agent's
  // grant, and an unknown hash with no original or with one that failed are each answered here, untouched.
  const results = new Map<Hex, StopResult>();
  const toDecide: Array<{ hash: Hex; passed: Passed | null }> = [];
  for (const s of standing) {
    if (s.foreign) {
      results.set(s.hash, refused(s.hash, 'NOT_YOUR_ORDER', "This hash is another account's on this courier's records; a stop reaches only the orders of the account it names."));
    } else if (answeredFromItsRow(s)) {
      results.set(s.hash, { orderHash: s.hash, status: 'already stopped' });
    } else if (s.carriedGrant !== null) {
      if (mayStop(s.carriedGrant)) toDecide.push({ hash: s.hash, passed: null });
      else {
        results.set(
          s.hash,
          refused(s.hash, 'NOT_THE_GRANTS_AGENT', `This order is not signed under grant ${(read as StopRead).currentGrant}, the signer's own: an agent stops only the orders signed under its current grant; the account's own key stops any of them.`),
        );
      }
    } else {
      const verdict = judged.get(s.hash);
      if (verdict === undefined) results.set(s.hash, refused(s.hash, 'UNKNOWN_ORDER', 'The courier holds no order of this hash, and no original came with it.'));
      else if (!verdict.ok) results.set(s.hash, refused(s.hash, verdict.code, verdict.error));
      else toDecide.push({ hash: s.hash, passed: verdict.passed });
    }
  }
  const lockSet = inLockOrder(toDecide.map((d) => d.hash));

  // 8. The connection: a message under the budgets runs on the door's own, as a post does, and waits for it holding
  // nothing; a free message runs on the reads' pool and locks no budget row.
  const client = await (free ? deps.store.pool : deps.store.door).connect();
  try {
    // 9. One transaction.
    await client.query('BEGIN');
    for (const hash of lockSet) await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(hash)]);
    // Under the locks the records are read again for the locked hashes, and each is judged on what stands now, not on
    // the lookup: an order first posted while this message waited is a carried order, and a stop another message
    // recorded meanwhile is a stop.
    const now = await deps.store.stops.lookup(client, lockSet);

    if (!free) {
      // The budgets, after the hash locks: the courier's row, then the account's, as the door takes them, so every
      // writer takes its locks in one order. Over a budget, the refusal is a number on the row and nothing else.
      const budget = await takeBudgets(client, accountKey, (read as StopRead).header.timestamp);
      if (!budget.ok) {
        await client.query('COMMIT');
        return counted({ status: 429, body: { error: `${budgetRefusal(budget.which, budget.retryAfterSeconds)} ${STOP_RECIPE}`, code: 'RATE_LIMIT_EXCEEDED', budget: budget.which, retryAfterSeconds: budget.retryAfterSeconds } });
      }
    }

    // The account's stops ahead that still count, read once for the message with the account's row locked, so two
    // messages of one account cannot together pass the bound.
    let aheadStanding: number | null = null;
    const carriedStopped: Hex[] = [];
    const rows: NewStop[] = [];
    for (const d of toDecide) {
      // Whose the order is, and under which grant it was signed, were judged before the transaction, of the carried
      // row or of the original, and are not judged a second time here: an order's row is written under the hash of
      // its own fields, which fixes its account and its nonce, and a stop's row under the account of its order. What
      // the lock settles is whether a stop or an order stands for the hash now.
      if (now.stops.has(d.hash)) {
        results.set(d.hash, { orderHash: d.hash, status: 'already stopped' });
      } else if (now.orders.has(d.hash)) {
        results.set(d.hash, { orderHash: d.hash, status: 'stopped' });
        carriedStopped.push(d.hash);
        rows.push({ hash: d.hash, ahead: null });
      } else {
        if (d.passed === null) throw new Error('an order the lookup showed carried holds no row under its lock');
        const original = originalOf.get(d.hash) as Original;
        const T = (read as StopRead).header.timestamp;
        aheadStanding ??= await deps.store.stops.aheadCount(client, account, T + 1n, (read as StopRead).currentGrant);
        if (aheadStanding >= BOUNDS.stopsAheadPerAccount) {
          results.set(
            d.hash,
            refused(d.hash, 'TOO_MANY_STOPS_AHEAD', `This account holds ${BOUNDS.stopsAheadPerAccount} stops ahead whose orders have not expired, the bound: a stop ahead is taken again as those expire, and the on-chain cancel takes no slot.`),
          );
        } else {
          aheadStanding += 1;
          results.set(d.hash, { orderHash: d.hash, status: 'stopped ahead' });
          rows.push({ hash: d.hash, ahead: { original: { order: orderToJson(original.order), signature: original.signature }, originalExpiry: d.passed.originalExpiry, grantNumber: d.passed.grantNumber } });
        }
      }
    }

    const answered = message.orderHashes.map((hash) => results.get(hash) as StopResult);
    const refusals = answered.flatMap((r) => (r.status === 'refused' ? [{ hash: r.orderHash, code: r.code }] : []));
    // The writes, in this order: the message's row, the lines, the stops, the marks. The lines go before the rows the
    // database could refuse, all on this transaction's connection, so a line and its rows commit together or not at all.
    let messageId: number | null = null;
    if (rows.length > 0) {
      // The payload kept is what was signed, the account and the hashes: never an original.
      const kept = { account: message.account, orderHashes: message.orderHashes };
      const block = read === null ? null : { number: read.header.number, hash: read.header.hash, time: read.header.timestamp };
      messageId = await deps.store.stops.insertMessage(client, { account, signer, message: kept, signature, block });
      await deps.store.events.write({ run: deps.run.id, kind: 'stop received', account: accountKey, facts: { messageId, stopped: carriedStopped.length, ahead: rows.length - carriedStopped.length } }, client);
    }
    if (!free && refusals.length > 0) {
      await deps.store.events.write({ run: deps.run.id, kind: 'stop refused', account: accountKey, facts: { messageId, refused: refusals } }, client);
    }
    if (messageId !== null) {
      await deps.store.stops.insertStops(client, account, messageId, rows);
      await deps.store.stops.markStopped(client, carriedStopped);
    }
    await client.query('COMMIT');
    // 10. The answer, in the message's order.
    return { status: 200, body: { account, results: answered } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
