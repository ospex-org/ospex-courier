import type pg from 'pg';
import type { Address, Hex } from 'viem';
import { readForDoor, readQuotes, type DoorRead } from '../chain/reads';
import type { NodeCheck } from '../chain/node';
import type { Lane } from '../check/lane';
import { crossOf, verdictLine } from '../records/lanes';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import { BOUNDS, type Counters } from '../http/limits';
import type { HttpAnswer } from '../http/routes';
import type { MarkEnded, OrderRow } from '../records/orders';
import type { Run } from '../records/runs';
import type { Store } from '../records/store';
import { budgetRefusal, takeBudgets } from './budgets';
import { checkOrderRules, coinAmount, isChainSignature, marketKey, ORDER_RULES, orderHash, orderSigner, orderToJson, readOrderShape, splitNonce, type NonceParts, type OrderFields } from './order';
import { DOOR } from '../check/sentences';
import { isPublishedList } from './published';
import { grantGone, orderGone, quoteEnd } from './standing';

// The door: POST /v1/orders. Sixteen checks, in the plan's order; the first
// that fails is the answer. Checks 1 to 8 stand before admission: a request
// that fails one is answered, counted and logged, and no line is written for
// it. An order signed under a grant has its grant judged between checks 6 and
// 7, from check 6's read: before admission too, and before any budget is
// taken. From check 9 on the request is admitted, and whatever becomes of it is a
// line in the records. Check 5 is looked up first without a lock, so a repeat
// is answered cheaply; then checks 5 and 8 to 16 are made in one database
// transaction that first takes the order's hash lock.

export interface DoorDeps {
  store: Store;
  chain: ChainReader;
  set: BettingSet;
  /** The node's verdict from the check made at this process's start: while it is not usable, no order is taken. */
  node: Pick<NodeCheck, 'usable'>;
  /** The lane: check 17 for a bet, and the wake after a bet's commit. */
  lane: Pick<Lane, 'admits' | 'wake'>;
  run: Run;
  counters: Counters;
  /** The published list of reporters, read at start. */
  published: readonly Address[];
  coinDecimals: number;
  log(line: string): void;
}

export const GAME_STATUS = { None: 0, Unverified: 1, Verified: 2, Disputed: 3, Scored: 4, Voided: 5, Released: 6 } as const;

const refusal = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): HttpAnswer => ({ status, body: { error, code, ...extra } });

/** What a bet's record adds, read from its outcome's line and its Cross. */
export interface BetOutcome {
  verdict: Awaited<ReturnType<typeof verdictLine>>;
  cross: Awaited<ReturnType<typeof crossOf>>;
}

/**
 * A bet's state, by its first end: `stopped` where a stop's mark came before any judgment (while it waited, or while
 * it was held, with the verdict STOPPED); otherwise the judgment's own state, with `ended` showing a later stop beside
 * it: `refused`, `lapsed`, or the Cross's state, `not sent` in this build. `queued` while it waits its turn or its
 * check runs.
 */
function betState(row: OrderRow, outcome: BetOutcome | null): string {
  const verdict = outcome?.verdict ?? null;
  if (row.betState === 'waiting' || row.betState === 'held') return row.ended === 'stopped' ? 'stopped' : 'queued';
  if (row.betState === 'refused') return verdict?.reason === 'STOPPED' ? 'stopped' : 'refused';
  if (row.betState === 'lapsed') return 'lapsed';
  if (row.betState === 'sent') return outcome?.cross?.state ?? 'not sent';
  return String(row.betState);
}

/** A bet's verdict as its record serves it: the code and its sentence, the block that decided it or null, the last header read where none did, the time it was recorded, and the code's own fields. */
function verdictOf(v: NonNullable<BetOutcome['verdict']>): Record<string, unknown> {
  const { code, error, block, lastObservedBlock, ...fields } = v.facts as { code?: unknown; error?: unknown; block?: unknown; lastObservedBlock?: unknown };
  return {
    code: code ?? v.reason,
    error,
    block: block ?? null,
    ...(lastObservedBlock === undefined ? {} : { lastObservedBlock }),
    at: v.at.toISOString(),
    ...fields,
  };
}

/** A bet's Cross as its record serves it. */
function crossRecord(c: NonNullable<BetOutcome['cross']>, verdict: BetOutcome['verdict']): Record<string, unknown> {
  const checked = c.checked as Record<string, unknown>;
  const gas = (checked.gas ?? {}) as Record<string, unknown>;
  return {
    state: c.state,
    handOffs: c.handOffs,
    reason: c.reason,
    message: (verdict?.facts as { message?: unknown } | undefined)?.message ?? null,
    block: c.block,
    legs: c.legs.map((l) => ({ position: l.position, orderHash: l.orderHash, account: l.account, oddsTick: l.oddsTick, makerRisk: l.makerRisk, takerRisk: l.takerRisk })),
    takerRisk: checked.takerRisk ?? null,
    unfilled: checked.unfilled ?? null,
    pulls: checked.pulls ?? {},
    paysBack: checked.paysBack ?? {},
    paysBackRefused: checked.paysBackRefused ?? {},
    gas: { estimate: gas.estimate ?? checked.estimate ?? null, limit: gas.limit ?? checked.limit ?? null },
    nonce: checked.nonce ?? null,
  };
}

/** What a bet's record needs beyond its row: its outcome's line and its Cross. Two reads, along `events_bet_lines` and the Cross's key. */
export async function betOutcome(store: Store, row: OrderRow): Promise<BetOutcome | null> {
  if (row.role !== 'take' || row.betState === 'waiting' || row.betState === 'held') return null;
  const [verdict, cross] = await Promise.all([verdictLine(store.pool, row.hash), crossOf(store.pool, row.hash)]);
  return { verdict, cross };
}

/** The record of an order, as POST answers it and GET /v1/orders/{hash} serves it; a bet's with what came of it. */
export function orderRecord(row: OrderRow, outcome: BetOutcome | null = null): Record<string, unknown> {
  const state = row.role === 'rest' ? (row.ended === null ? 'resting' : row.ended) : betState(row, outcome);
  const verdict = outcome?.verdict ?? null;
  const bet =
    row.role === 'take'
      ? {
          ...(state === 'queued' ? { turn: row.betState === 'held' ? 'checking' : 'waiting' } : {}),
          ...(verdict !== null && verdict.kind !== 'cross not sent' ? { verdict: verdictOf(verdict) } : {}),
          cross: outcome?.cross === null || outcome?.cross === undefined ? null : crossRecord(outcome.cross, verdict),
        }
      : {};
  return {
    orderHash: row.hash,
    role: row.role,
    state,
    recordNumber: row.recordNumber,
    receivedAt: row.receivedAt.toISOString(),
    receivedBlock: { number: row.receivedBlock.toString(), hash: row.receivedHash },
    chainTime: row.receivedTime.toString(),
    order: orderToJson(row.order),
    signature: row.signature,
    marketKey: row.marketKey,
    ended: row.ended,
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
    endedBlock: row.endedBlock === null ? null : { number: row.endedBlock.toString(), hash: row.endedBlockHash },
    ...bet,
  };
}

/** A refusal, before it is an answer: counted where it comes before admission, a line where it comes after. */
interface Refused {
  status: number;
  code: string;
  error: string;
  extra: Record<string, unknown>;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Why an order's grant is gone, in the door's words: not its account's current one, or ending at or before the chain's time plus one. The bet's check says the same. */
export function grantGoneWhy(grantNumber: number, currentGrant: number, endsAt: bigint, chainTime: bigint): string {
  return grantNumber !== currentGrant
    ? currentGrant === 0
      ? 'its account has no grant standing now'
      : `its account's current grant is ${currentGrant}`
    : `it ends at ${endsAt}, at or under the chain's time plus one, ${chainTime + 1n}`;
}

/** The refusal of an order whose grant is gone: not its account's current grant, or ending at or before the chain's time plus one. */
function grantGoneRefusal(grantNumber: number, currentGrant: number, endsAt: bigint, chainTime: bigint): Refused {
  const why = grantGoneWhy(grantNumber, currentGrant, endsAt, chainTime);
  return {
    status: 422,
    code: 'GRANT_GONE',
    error: `This order is signed under grant ${grantNumber}, and that grant is gone: ${why}. It can fill in no later block.`,
    extra: { grantNumber, currentGrant, endsAt: endsAt.toString(), chainTime: chainTime.toString() },
  };
}

/**
 * The grant of an order signed under one, judged whole as the contract judges it, from the door's one read: the
 * signer is the agent of the grant the nonce names (a number the account never made has no agent); the stake is
 * within that grant's cap; the line is on its list, or the list is empty; and the grant stands, the account's
 * current one and not ending at or before the chain's time plus one. In that order, the first that fails the
 * answer. The signer is read from the grant the nonce names, which a revoke or a later grant leaves as it was, so
 * the signer alone does not say the grant stands: the standing is its own check. Null for an order its account
 * signs, and for one whose grant passes.
 */
function judgeGrant(order: OrderFields, nonce: NonceParts, signer: Address, read: DoorRead, chainTime: bigint, coinDecimals: number): Refused | null {
  if (nonce.grantNumber === 0) return null;
  const g = nonce.grantNumber;
  if (read.grant === null || read.currentGrant === null) throw new Error(`the door's read holds no grant for an order under grant ${g}`);
  const grant = read.grant;
  if (grant.agent.toLowerCase() === ZERO_ADDRESS) {
    return { status: 422, code: 'BAD_SIGNATURE', error: `This order's nonce names grant ${g}, and its account has made no grant of that number: there is no agent whose signature it could carry.`, extra: {} };
  }
  if (grant.agent.toLowerCase() !== signer.toLowerCase()) {
    return { status: 422, code: 'BAD_SIGNATURE', error: `The signature is not the agent's of grant ${g}, the grant this order's nonce names: an order under a grant is signed by that grant's agent, not by its account and not by another key.`, extra: {} };
  }
  if (order.riskAmount > grant.stakeCap) {
    return {
      status: 422,
      code: 'AGENT_STAKE_ABOVE_CAP',
      error: `Grant ${g} lets its agent sign an order for ${coinAmount(grant.stakeCap, coinDecimals)} USDC at most. This order is signed for ${coinAmount(order.riskAmount, coinDecimals)} USDC.`,
      extra: { grantNumber: g, stakeCap: grant.stakeCap.toString() },
    };
  }
  if (grant.lineCount !== 0 && !grant.lineNamed) {
    return { status: 422, code: 'LINE_NOT_IN_GRANT', error: `Grant ${g} names the lines its agent may sign on, and this order's line is not one of them.`, extra: { grantNumber: g } };
  }
  if (grantGone(nonce, { currentGrant: read.currentGrant, endsAt: grant.endsAt }, chainTime)) return grantGoneRefusal(g, read.currentGrant, grant.endsAt, chainTime);
  return null;
}

/** The 64-bit key of an order's hash lock: the hash's first eight bytes, as Postgres's advisory lock takes them. */
export function lockKey(hash: Hex): string {
  return BigInt.asIntN(64, BigInt(hash.slice(0, 18))).toString();
}

export async function postOrder(deps: DoorDeps, raw: unknown): Promise<HttpAnswer> {
  // A refusal before admission: answered, counted and logged by its code, never with the caller's address or a value.
  const counted = (answer: HttpAnswer): HttpAnswer => {
    deps.counters.count(String(answer.body.code));
    deps.log(`refused before admission: POST /v1/orders ${String(answer.body.code)}`);
    return answer;
  };

  // 1. The body's shape.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return counted(refusal(400, 'INVALID_PARAM', 'The body must be an object: {role, order, signature}.'));
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'order,role,signature') return counted(refusal(400, 'INVALID_PARAM', 'The body must have exactly role, order and signature.'));
  if (body.role !== 'rest' && body.role !== 'take') return counted(refusal(400, 'INVALID_PARAM', 'role must be "rest" or "take".'));
  const role = body.role;
  const shape = readOrderShape(body.order);
  if (!shape.ok) return counted(refusal(400, 'INVALID_PARAM', `${shape.problem}.`));
  const order = shape.order;
  if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return counted(refusal(400, 'INVALID_PARAM', 'signature must be 65 bytes as 0x and 130 hex characters.'));
  const signature = body.signature.toLowerCase() as Hex;

  // 2 is the caller's minute, taken by the service before any route.

  // The node's gate, for every order: the node failed the check made at this process's start, so no order is taken
  // until a process starts on a node that passes. Before anything is read or charged, and nothing is recorded.
  if (!deps.node.usable) return counted(refusal(503, 'NODE_UNUSABLE', DOOR.NODE_UNUSABLE));

  // 3. The order's own rules, as the contract has them.
  const rules = checkOrderRules(order, deps.set);
  if (!rules.ok) return counted(refusal(422, rules.code, rules.error));

  // 4. The signature, over the order's hash under the matching contract's domain, in the form the contract takes.
  // An order its account signs (grant number 0 in its nonce) is the account's, decided here. An order under a grant
  // is its grant's agent's: who that is the chain says, so the signer is kept and judged with the grant, right after
  // the read of check 6.
  const hash = orderHash(order, deps.set.chainId, deps.set.matching);
  const nonce = splitNonce(order.nonce);
  const signer = await orderSigner(order, signature, deps.set.chainId, deps.set.matching);
  if (signer === null) {
    return counted(
      refusal(
        422,
        'BAD_SIGNATURE',
        isChainSignature(signature)
          ? 'No signer recovers from this signature over this order\'s hash under the matching contract\'s domain.'
          : 'The signature is in a form the matching contract refuses: its last byte, v, must be 27 or 28, and its s must be in the lower half of the curve\'s order. No fill could take an order so signed.',
      ),
    );
  }
  if (nonce.grantNumber === 0 && signer.toLowerCase() !== order.account.toLowerCase()) {
    return counted(refusal(422, 'BAD_SIGNATURE', 'The signature is not the account\'s over this order\'s hash under the matching contract\'s domain.'));
  }
  const key = marketKey(order.gameId, order.scorer, order.lineTicks);

  // 5. On record already? A repeat is answered from the record; the other role is a conflict.
  const known = await deps.store.orders.get(hash);
  if (known !== null) {
    if (known.role === role) return { status: 200, body: orderRecord(known, await betOutcome(deps.store, known)) };
    return counted(refusal(409, 'ROLE_CONFLICT', `This order is on record as ${known.role === 'rest' ? 'a quote' : 'a bet'}; an order hash has one role at this courier, the first one posted.`));
  }

  // 6. One read of the chain at the latest block, named by its hash.
  let read;
  try {
    const header = await deps.chain.latestHeader();
    read = await readForDoor(deps.chain, deps.set, header, order, hash, key);
  } catch (err) {
    if (err instanceof ChainUnreachable) return counted(refusal(503, 'CHAIN_UNREACHABLE', 'The chain could not be read, twice; nothing is decided without one block to decide at.'));
    throw err;
  }
  const T = read.header.timestamp;

  // The grant, for an order under one, judged whole from that same read, before the registration and before any
  // budget is taken: its signer, its cap, its list, its standing, in that order. Each is a refusal before admission,
  // so an order that names a grant it has no right to costs the account it names nothing and leaves no line: not a
  // stranger's with a grant number it made up, and not a former agent's under a grant that is gone.
  const grantRefusal = judgeGrant(order, nonce, signer, read, T, deps.coinDecimals);
  if (grantRefusal !== null) return counted(refusal(grantRefusal.status, grantRefusal.code, grantRefusal.error, grantRefusal.extra));

  // 7. The account has registered the relay.
  if (!read.registered) return counted(refusal(422, 'NOT_REGISTERED', `The account has not registered the courier's relay, ${deps.set.relay}, with the matching contract.`));

  // Checks 5 and 8 to 16, in one transaction under the order's hash lock, on the door's own connection: one post at
  // a time in this process holds it, the others wait for it holding nothing, and the pool the reads go through is
  // never held idle on the courier's row. A read of the chain inside this transaction applies what it learns of the
  // chain-unreachable condition at once, on the reads' pool (a lookup, and a transaction under the condition's lock
  // only where the condition changes): a connection of another pool than the one this transaction holds, so it never
  // waits on a connection the request holds.
  const client = await deps.store.door.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(hash)]);
    const again = await deps.store.orders.get(hash, client);
    if (again !== null) {
      await client.query('COMMIT');
      if (again.role === role) return { status: 200, body: orderRecord(again, await betOutcome(deps.store, again)) };
      return counted(refusal(409, 'ROLE_CONFLICT', `This order is on record as ${again.role === 'rest' ? 'a quote' : 'a bet'}; an order hash has one role at this courier, the first one posted.`));
    }

    // 8. The budgets: the account's, then the courier's. A refusal is a number on the row, not a line.
    const budget = await takeBudgets(client, order.account.toLowerCase(), T);
    if (!budget.ok) {
      await client.query('COMMIT');
      return counted({ status: 429, body: { error: budgetRefusal(budget.which, budget.retryAfterSeconds), code: 'RATE_LIMIT_EXCEEDED', budget: budget.which, retryAfterSeconds: budget.retryAfterSeconds } });
    }

    // Admitted. From here every outcome is a line.
    const line = async (kind: 'order received' | 'order refused' | 'incident', reason: string | undefined, facts: Record<string, unknown>) =>
      deps.store.events.write({ run: deps.run.id, kind, orderHash: hash, account: order.account.toLowerCase(), gameId: order.gameId, ...(reason === undefined ? {} : { reason }), facts: { role, block: read.header.number.toString(), ...facts } }, client);
    // Every `return await refuse(...)` below is `return await`: a bare `return promise` inside this try block would run the
    // finally, and release the client to the pool, before the line was written and the transaction committed on
    // it; the next request would then begin its transaction inside this one. The budgets test found that.
    const refuse = async (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Promise<HttpAnswer> => {
      await line('order refused', code, { error, ...extra });
      await client.query('COMMIT');
      return refusal(status, code, error, extra);
    };

    // 9. The contract's own hash of these ten values equals the hash computed here.
    if (read.contractHash.toLowerCase() !== hash.toLowerCase()) {
      await line('incident', 'ORDER_HASH_MISMATCH', { contractHash: read.contractHash, courierHash: hash });
      await client.query('COMMIT');
      deps.log(`incident: the contract's hash of an order differs from the courier's (block ${read.header.number})`);
      return refusal(500, 'INTERNAL_ERROR', "The courier's hash of this order is not the contract's. That is the courier's own fault, and it is recorded as one; nothing was recorded for the order.");
    }

    // 10. A stop for this hash is on record.
    const stopped = await client.query('SELECT 1 FROM stops WHERE hash = $1', [hash.toLowerCase()]);
    if ((stopped.rowCount ?? 0) > 0) return await refuse(422, 'STOPPED', 'A stop for this order is on record; it is carried for no bet.');

    // 11. The game: its start is written; its reporters are exactly the published list; it has not ended; the contract's close has not passed.
    const game = read.game;
    if (!game.known) return await refuse(422, 'UNKNOWN_GAME', `Game ${order.gameId} is not a game on the games set.`);
    const reportersPublished = game.reporters === null ? null : isPublishedList(game.reporters, deps.published);
    const seen = await deps.store.games.seen(client, { gameId: order.gameId, start: game.start, reportersPublished });
    if (game.start === null) {
      if (seen.firstUnreadable) await deps.store.events.write({ run: deps.run.id, kind: 'start unreadable', gameId: order.gameId, facts: { status: game.status, block: read.header.number.toString(), time: T.toString() } }, client);
      return await refuse(422, 'NO_WRITTEN_START', `Game ${order.gameId} has no written start yet; the courier carries a game once its start is written.`);
    }
    if (reportersPublished !== true) {
      return await refuse(422, 'REPORTERS_NOT_THE_PUBLISHED_LIST', `Game ${order.gameId}'s reporters are not exactly the published list; the courier carries only games whose reporters are.`, { published: deps.published });
    }
    if (game.status !== null && game.status >= GAME_STATUS.Scored) return await refuse(422, 'GAME_ENDED', `Game ${order.gameId} has ended (status ${game.status}).`);
    // The contract refuses a fill from the second the game closes, and no later block's time is under T + 1: an order
    // whose game closes at or under T + 1 can fill in no later block, in either role.
    const closesAt = game.start + (game.window ?? 0n);
    if (closesAt <= T + 1n) return await refuse(422, 'BETS_CLOSED', DOOR.BETS_CLOSED(order.gameId.toString(), closesAt.toString(), T.toString()), { closesAt: closesAt.toString(), chainTime: T.toString() });

    // 12. The order's standing on chain, as the contract judges it (standing.ts): the order's own half, then its
    // grant's. For a new order the grant's half was judged above, before the budgets, from this same read, so it
    // does not fire here; it is written here as the one predicate, whole.
    if (orderGone(nonce, read)) {
      return await refuse(422, 'CANCELLED', 'This order is cancelled on chain: by its own cancel, by naming a version that is not its account\'s current one (a cancel of everything moves the account to a new version), or by a floor raised above its order number on its line at that version.');
    }
    if (read.grant !== null && read.currentGrant !== null && grantGone(nonce, { currentGrant: read.currentGrant, endsAt: read.grant.endsAt }, T)) {
      const gone = grantGoneRefusal(nonce.grantNumber, read.currentGrant, read.grant.endsAt, T);
      return await refuse(gone.status, gone.code, gone.error, gone.extra);
    }
    if (order.expiry <= T + 1n) return await refuse(422, 'EXPIRED', `This order's expiry, ${order.expiry}, is at or under the chain's time plus one, ${T + 1n}: it can fill in no later block.`, { chainTime: T.toString() });
    if (order.riskAmount - read.filled < ORDER_RULES.lot) return await refuse(422, 'FILLED', 'This order has less than a lot of its stake left on chain.');

    if (role === 'rest') {
      // 13. Fewer than 16 live quotes on this side of this market: the account's quotes on the side the courier has
      // not marked ended and the block's time has not expired, one page of at most seventeen. Fewer than sixteen
      // standing, the chain is asked nothing. Sixteen or more, the chain is asked once about sixteen of them, and
      // the ones it shows ended are marked here, at the block read, so no later request asks about them again:
      // cancelled, at a version the account has left, under its floor at its version, or under a grant that is gone
      // (the account's own acts, or its grant's own end), as `cancelled`; with less than a lot of the stake left (a
      // fill through another courier; this courier's own fills are the sender build's), as `filled`.
      // The count is then read once more from the records. A quote partly filled with a lot or more left stands
      // and is counted. So one post is one page, at most one read of the chain for the quotes, and one more page: a
      // number, whatever the account has posted before.
      const bound = BOUNDS.liveQuotesPerAccountSideMarket;
      const page = await deps.store.orders.quotesOfAccount(client, order.account, key, order.positionType, T);
      let standing = page.length;
      if (page.length >= bound) {
        const asked = page.slice(0, bound);
        let state;
        try {
          state = await readQuotes(deps.chain, deps.set, read.header, key, asked.map((q) => ({ hash: q.hash, account: order.account, nonce: q.nonce })));
        } catch (err) {
          if (err instanceof ChainUnreachable) return await refuse(503, 'CHAIN_UNREACHABLE', "The chain could not be read, twice, for the account's standing quotes.");
          throw err;
        }
        // The same predicate as check 12, each quote at the version and under the grant its own nonce names.
        const ended = asked.flatMap((q): MarkEnded[] => {
          const how = quoteEnd({ hash: q.hash, account: order.account, nonce: q.nonce, riskAmount: q.riskAmount }, state, T);
          return how === null ? [] : [{ hash: q.hash, how }];
        });
        await deps.store.orders.markEnded(client, ended, read.header);
        standing = (await deps.store.orders.quotesOfAccount(client, order.account, key, order.positionType, T)).length;
      }
      if (standing >= bound) {
        return await refuse(422, 'TOO_MANY_QUOTES', `This account holds ${standing > bound ? `${bound} or more` : standing} live quotes on this side of this market; the bound is ${bound}.`);
      }
    } else {
      // 14. Before the lift, the signed stake is not above the cap, both read from the matching contract.
      if (order.riskAmount > read.cap && !read.capLifted) {
        return await refuse(422, 'ABOVE_CAP', `Bets are capped at ${coinAmount(read.cap, deps.coinDecimals)} USDC until the cap is lifted. This bet is signed for ${coinAmount(order.riskAmount, deps.coinDecimals)} USDC. Nothing was sent.`, { cap: read.cap.toString() });
      }
      // 15. The expiry is at most 30 seconds past the chain's time.
      if (order.expiry - T > ORDER_RULES.maxTakingLife) {
        return await refuse(422, 'EXPIRY_TOO_FAR', `A bet's expiry is at most ${ORDER_RULES.maxTakingLife} seconds past the chain's time, which is ${T}; this bet's is ${order.expiry}. Sign again at the chain's time plus ${ORDER_RULES.maxTakingLife}.`, { chainTime: T.toString() });
      }
      // 16. Fewer than two of the account's bets, and fewer than 32 in all, are waiting their turn.
      const waiting = await deps.store.orders.waiting(client, order.account);
      if (waiting.account >= BOUNDS.betsWaiting.perAccount || waiting.all >= BOUNDS.betsWaiting.all) {
        return await refuse(503, 'QUEUE_FULL', `${waiting.account >= BOUNDS.betsWaiting.perAccount ? `This account has ${waiting.account} bets waiting their turn, the bound` : `${waiting.all} bets are waiting their turn, the bound for all accounts`}; a bet is refused for the count ahead of it and never for the time it has left.`, { waiting });
      }
      // 17. This process owns the lane and takes bets: the lane's epoch, under a share lock that a take raising it
      // waits behind, is the one this process took, and no lane step of this process has failed on the database. So a
      // bet admitted here is one this process's runner will check, or one the next owner's take will find waiting.
      if (!(await deps.lane.admits(client))) return await refuse(503, 'NOT_TAKING_BETS', DOOR.NOT_TAKING_BETS);
    }

    // Recorded, with its line.
    const row = await deps.store.orders.insert(client, { hash, role, order, signature, marketKey: key, receivedBlock: read.header.number, receivedHash: read.header.hash, receivedTime: T });
    await line('order received', undefined, { recordNumber: row.recordNumber, chainTime: T.toString() });
    await client.query('COMMIT');
    // A bet admitted here: this process's runner goes on, after the commit.
    if (role === 'take') deps.lane.wake();
    // The record carries the chain's time it was taken at, so the first answer and a repeat's are the same answer.
    return { status: role === 'rest' ? 201 : 202, body: orderRecord(row) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type { OrderFields };
export type DoorClient = pg.PoolClient;
