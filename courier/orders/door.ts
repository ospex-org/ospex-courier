import type pg from 'pg';
import type { Address, Hex } from 'viem';
import { readForDoor, readQuotes } from '../chain/reads';
import type { BettingSet } from '../chain/set';
import { ChainUnreachable, type ChainReader } from '../chain/snapshot';
import { BOUNDS, type Counters } from '../http/limits';
import type { HttpAnswer } from '../http/routes';
import type { MarkEnded, OrderRow } from '../records/orders';
import type { Run } from '../records/runs';
import type { Store } from '../records/store';
import { budgetRefusal, takeBudgets } from './budgets';
import { checkOrderRules, coinAmount, marketKey, ORDER_RULES, orderHash, orderSigner, orderToJson, readOrderShape, type OrderFields } from './order';
import { isPublishedList } from './published';

// The door: POST /v1/orders. Sixteen checks, in the plan's order; the first
// that fails is the answer. Checks 1 to 8 stand before admission: a request
// that fails one is answered, counted and logged, and no line is written for
// it. From check 9 on the request is admitted, and whatever becomes of it is a
// line in the records. Check 5 is looked up first without a lock, so a repeat
// is answered cheaply; then checks 5 and 8 to 16 are made in one database
// transaction that first takes the order's hash lock.

export interface DoorDeps {
  store: Store;
  chain: ChainReader;
  set: BettingSet;
  run: Run;
  counters: Counters;
  /** The published list of reporters, read at start. */
  published: readonly Address[];
  coinDecimals: number;
  log(line: string): void;
}

export const GAME_STATUS = { None: 0, Unverified: 1, Verified: 2, Disputed: 3, Scored: 4, Voided: 5, Released: 6 } as const;

const refusal = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): HttpAnswer => ({ status, body: { error, code, ...extra } });

/** The record of an order, as POST answers it and GET /v1/orders/{hash} serves it. */
export function orderRecord(row: OrderRow): Record<string, unknown> {
  const state = row.role === 'rest' ? (row.ended === null ? 'resting' : row.ended) : row.ended !== null ? row.ended : row.betState === 'waiting' ? 'queued' : row.betState;
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
    ...(row.role === 'take' ? { cross: null, note: 'a bet posted in this build is recorded and waits; the pre-check and the sender are later builds, so nothing is sent yet' } : {}),
  };
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

  // 3. The order's own rules, as the contract has them.
  const rules = checkOrderRules(order, deps.set);
  if (!rules.ok) return counted(refusal(422, rules.code, rules.error));

  // 4. The signature: the signer of the order's hash under the matching contract's domain is the order's account.
  const hash = orderHash(order, deps.set.chainId, deps.set.matching);
  const signer = await orderSigner(order, signature, deps.set.chainId, deps.set.matching);
  if (signer === null || signer.toLowerCase() !== order.account.toLowerCase()) {
    return counted(refusal(422, 'BAD_SIGNATURE', 'The signature is not the account\'s over this order\'s hash under the matching contract\'s domain.'));
  }
  const key = marketKey(order.gameId, order.scorer, order.lineTicks);

  // 5. On record already? A repeat is answered from the record; the other role is a conflict.
  const known = await deps.store.orders.get(hash);
  if (known !== null) {
    if (known.role === role) return { status: 200, body: orderRecord(known) };
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

  // 7. The account has registered the relay.
  if (!read.registered) return counted(refusal(422, 'NOT_REGISTERED', `The account has not registered the courier's relay, ${deps.set.relay}, with the matching contract.`));

  // Checks 5 and 8 to 16, in one transaction under the order's hash lock, on the door's own connection: one post at
  // a time in this process holds it, the others wait for it holding nothing, and the pool the reads go through is
  // never held idle on the courier's row. A read of the chain inside this transaction notes what it learns of the
  // chain-unreachable condition in memory; the service writes it once the connection is released (settle).
  const client = await deps.store.door.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(hash)]);
    const again = await deps.store.orders.get(hash, client);
    if (again !== null) {
      await client.query('COMMIT');
      if (again.role === role) return { status: 200, body: orderRecord(again) };
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
    const closesAt = game.start + (game.window ?? 0n);
    if (T >= closesAt) return await refuse(422, 'BETS_CLOSED', `Bets on game ${order.gameId} closed at ${closesAt}, the start plus the window; the chain's time is ${T}.`, { closesAt: closesAt.toString(), chainTime: T.toString() });

    // 12. The order's standing on chain.
    if (read.cancelled || order.nonce < read.floor) return await refuse(422, 'CANCELLED', 'This order is cancelled on chain, or its nonce is under its account\'s floor for the market.');
    if (order.expiry <= T + 1n) return await refuse(422, 'EXPIRED', `This order's expiry, ${order.expiry}, is at or under the chain's time plus one, ${T + 1n}: it can fill in no later block.`, { chainTime: T.toString() });
    if (order.riskAmount - read.filled < ORDER_RULES.lot) return await refuse(422, 'FILLED', 'This order has less than a lot of its stake left on chain.');

    if (role === 'rest') {
      // 13. Fewer than 16 live quotes on this side of this market: the account's quotes on the side the courier has
      // not marked ended and the block's time has not expired, one page of at most seventeen. Fewer than sixteen
      // standing, the chain is asked nothing. Sixteen or more, the chain is asked once about sixteen of them, and
      // the ones it shows ended are marked here, at the block read, so no later request asks about them again:
      // cancelled, or under the account's floor (the maker's own acts), as `cancelled`; with less than a lot of the
      // stake left (a fill through another courier; this courier's own fills are the sender build's), as `filled`.
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
          state = await readQuotes(deps.chain, deps.set, read.header, key, asked.map((q) => ({ hash: q.hash, account: order.account })));
        } catch (err) {
          if (err instanceof ChainUnreachable) return await refuse(503, 'CHAIN_UNREACHABLE', "The chain could not be read, twice, for the account's standing quotes.");
          throw err;
        }
        const floor = state.accounts.get(order.account.toLowerCase())?.floor ?? 0n;
        const ended = asked.flatMap((q): MarkEnded[] => {
          const s = state.quotes.get(q.hash.toLowerCase());
          if (s === undefined) return [];
          if (s.cancelled || q.nonce < floor) return [{ hash: q.hash, how: 'cancelled' }];
          if (q.riskAmount - s.filled < ORDER_RULES.lot) return [{ hash: q.hash, how: 'filled' }];
          return [];
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
    }

    // Recorded, with its line.
    const row = await deps.store.orders.insert(client, { hash, role, order, signature, marketKey: key, receivedBlock: read.header.number, receivedHash: read.header.hash, receivedTime: T });
    await line('order received', undefined, { recordNumber: row.recordNumber, chainTime: T.toString() });
    await client.query('COMMIT');
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
