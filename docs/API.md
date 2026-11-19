# The courier's wire contract

What a maker's or a bettor's program sends the courier, what it is answered, and what each answer means. This wire
contract covers order submission, signed stops and the read routes. This build records bets but does not send them to
the chain.

JSON under `/v1`, over https only. No sign-in and no secret: a signed order is its own permission, and the book is
public. Amounts are decimal strings in the coin's smallest unit; addresses are hex; an order is known by its hash,
`0x` and 64 hex characters. Every refusal is `{ "error", "code" }`: a plain sentence and an UPPER_SNAKE code, with a
few more fields where the code has them. A program reads the code; the sentence is for a person.

The parts: 1, the two signed messages; 2, who may sign; 3, the door; 4, the stop; 5, the reads; 6, the bounds;
7, every code.

## Part 1. The two signed messages

Both are EIP-712 typed data, each under a domain of its own.

| | an order | a stop |
| -- | -- | -- |
| type | `OspexOrder(address account,uint256 gameId,address scorer,int32 lineTicks,uint8 positionType,uint16 oddsTick,uint256 riskAmount,uint256 nonce,uint256 expiry,uint256 minFill)` | `OspexStop(address account,bytes32[] orderHashes)` |
| domain name | `Ospex` | `Ospex Courier` |
| domain version | `3` | `1` |
| chain | the chain's id | the chain's id |
| verifying contract | the matching contract | the relay |
| what its digest is | the order's hash, which the contract computes too (`getOrderHash`) | the stop message's digest, which only this courier reads |

The two digests are built from different type hashes and different domain separators, so one signature serves as
both an order's and a stop's only on a hash collision. The courier recomputes a stop's digest from the two fields
and recovers its signer; it does not compare a stop's signature with an order's. The relay is the stop's verifying
contract because it is the one address every account registered: a stop is tied to this courier and this chain.

**The form of a signature.** 65 bytes, `r`, `s`, `v`, as `0x` and 130 hex characters. Its last byte, `v`, is 27 or
28, and its `s` is in the lower half of the curve's order. That is the form the matching contract's check takes,
and the courier holds every signature to it, an order's, a stop's and an original's alike: a signature in another
form (`v` of 0 or 1, an upper-half `s`) is `BAD_SIGNATURE` here, whatever a lenient library would recover from it.

**The nonce's three numbers.** An order's `nonce` is one 256-bit word holding three numbers, high to low: the
account's version in the top 128 bits, the grant number in the next 32, and the order number in the low 96. The
version is the account's current one: a cancel of everything on chain moves the account to a new version, and an
order at any other version is cancelled. The grant number is 0 for an order the account signs itself, and the number
of the grant for one its approved agent signs. The order number is what a line's floor is compared with.

A stop message has no nonce or expiry. A recorded stop is permanent for its hash. Replaying a message is not
universally free or without writes; see the replay rules below (part 4).

## Part 2. Who may sign

**An order.** The account's own key, for a nonce whose grant number is 0. For a nonce that names a grant, that
grant's agent, and nobody else: not the account, and not another key. The door then judges the grant as the contract
does (part 3).

**A stop.** One of two keys, and no contract's code is ever run to decide:

- **The account's own key** stops any order of the account: every order the courier carries for it, and, sent ahead
  with its original (part 4), every order the account signed itself or had signed under its current grant.
- **The account's live agent** stops the orders signed under its own grant, the account's current one, and no
  other: not an order the account signed itself (grant number 0), and not one under an earlier grant. The courier's
  stop is narrower here than the contract's cancel, on purpose. A key the account grants again is live again under
  the new grant's number, for the new number's orders.

The agent is live by the contract's own rule, read from the chain: it is the agent of the account's current grant,
and the block's time is before the grant's end (`isLiveAgent`). At the block whose time is the grant's end the
grant has ended; one second earlier it has not. No margin either way.

A signature that is neither is refused for the whole message: `AGENT_NOT_LIVE` where the signer was the agent of a
grant the message's orders name and that grant is no longer the account's current one, or has ended, with that
grant's number and end in the sentence; `BAD_SIGNATURE` where the signer is a stranger to the account, which is also
what an order's own signature offered as a stop's is.

**The chain read a stop may need.** A stop signed by the account's own key reads no chain in two cases: where
every hash it names is one the account has stopped already; and where it carries no original and every hash it names
is an order the courier carries for the account or one the account has stopped already. Every other stop whose
signature recovers a signer reads the chain once, before anything is written: an agent's always, and the account's
own where it carries an original or names a hash that is unknown to the courier or another account's. So the stop of
a carried order sent with an original beside it needs the chain, and the same stop with no original does not. The
read is one block's header, then one call at that block, named by its hash, that asks at once whether the signer is
the account's live agent, the account's current grant, the record of each grant the message's orders name, whether
each original's line is on its grant's list, and whether the account has the relay registered. Each of the two is
tried once more when it fails; twice failed is `503 CHAIN_UNREACHABLE` and nothing is decided.

**The block is the policy.** A stop is judged at the block the courier named, and the message is recorded with
that block's number, hash and time. A signer who was the account's live agent at that block has its stop recorded
even where the grant was revoked in a later block, or the stop waited at the database, or that block was later
reorganised away; a signer who was not is refused even where a later block would have shown it live. So a stop can
stand that the chain would have refused the signer a block later, and no bound is promised on how fresh the block
is. What follows from that is a quote withdrawn, not a quote filled.

**An account with no key of its own.** A contract account that cannot make a 65-byte signature from its own
address trades only through an agent it has granted. It stops through that agent while the grant stands, order by
order under that grant. Without the agent it cancels or revokes on chain, from its own address (`cancelOrder`,
`raiseFloor`, `cancelAll`, `revokeAgent`). The courier takes no stop a contract would have to vouch for.

## Part 3. The door: `POST /v1/orders`

```
{ "role": "rest" | "take",
  "order": { "account", "gameId", "scorer", "lineTicks", "positionType",
             "oddsTick", "riskAmount", "nonce", "expiry", "minFill" },
  "signature": "0x… (65 bytes)" }
```

`role` is not signed. `rest` keeps the order on the book until its expiry, its cancel or its stop; `take` is a bet,
to be filled against the book in one Cross and kept no further. An order hash has one role at this courier, the
first one posted. The body is at most 8,192 bytes.

**What each acknowledgement means.**

- `201`, the order's record with `state: "resting"`: the quote is recorded and on the book.
- `202`, the record with `state: "queued"`: the bet is recorded and waits its turn. In this build nothing examines
  or sends it.
- `200`, the record: this order was on record already under this role. Nothing was written, and no chain was read.

The record carries `orderHash`, `role`, `state`, `recordNumber`, `receivedAt`, `receivedBlock` (number and hash),
`chainTime` (the chain's time the order was taken at), the ten fields under `order`, `signature`, `marketKey`,
`ended`, `endedAt` and `endedBlock`. A bet's record carries two more: `cross`, which is `null` in this build, and
`note`, a sentence that says the bet is recorded and waits.

**The sixteen checks, in order.** The first that fails is the answer, but for the place of the first two: the
service makes two checks of its own before it reads a body, https (`403 HTTPS_REQUIRED`) and then check 2, the
caller's minute, and check 1 comes after them. So a request from an address whose minute is spent is answered `429`
whatever its body holds, and a request whose body fails check 1 has taken one from its address's minute all the
same. Checks 1 to 8, and the grant's four, stand before admission: a request that fails one leaves no row and no
line, and is counted by its code on the status address. From check 9 on the request is admitted, has taken one from
each budget, and whatever becomes of it is a line in the records.

| | the check | fails as |
| -- | -- | -- |
| 1 | The body's shape: exactly `role`, `order`, `signature`; the ten fields, each of its type; the body within its size. | `400 INVALID_PARAM`; `413 BODY_TOO_LARGE` |
| 2 | The caller's minute: 600 requests a minute from one network address. | `429 RATE_LIMIT_EXCEEDED`, with `retry-after` |
| 3 | The order's own rules, as the contract has them: the price a tick from 101 to 10,100; the stake above zero and in whole lots of 100; the minimum fill not above the stake; the market contract one of the set's three; the line within 1,000,000 ticks, a moneyline's zero, a total's not negative. | `422 PRICE_OUT_OF_RANGE`, `STAKE_NOT_IN_LOTS`, `MIN_FILL_ABOVE_STAKE`, `UNKNOWN_MARKET_CONTRACT`, `INVALID_LINE` |
| 4 | The signature: in the form the chain takes, and, for an order the account signs itself, the account's. | `422 BAD_SIGNATURE` |
| 5 | The hash on record already: a repeat is answered with the record, the first answer whole. | `200`; under the other role, `409 ROLE_CONFLICT` |
| 6 | One read of the chain at the latest block, named by its hash. | `503 CHAIN_UNREACHABLE` |
| | For an order under a grant, the grant, judged whole from that read as the contract judges it, in this order: the signer is the agent of the grant the nonce names; the stake is within the grant's cap; the line is on the grant's list, or the list is empty; the grant is the account's current one and does not end at or before the chain's time plus one. | `422 BAD_SIGNATURE`, `AGENT_STAKE_ABOVE_CAP`, `LINE_NOT_IN_GRANT`, `GRANT_GONE` |
| 7 | The account has registered the relay with the matching contract. | `422 NOT_REGISTERED` |
| 8 | The two budgets of admitted requests: the account's, 240 at once and 12 a minute after; the courier's for all accounts, 2,400 at once and 60 a minute after. Their clock is the chain's time. | `429 RATE_LIMIT_EXCEEDED`, with `budget: "account"` or `"courier"` and `retryAfterSeconds` |
| 9 | The contract's own `getOrderHash` of the ten values equals the hash computed here. | `500 INTERNAL_ERROR`, recorded as the courier's own fault |
| 10 | No stop is on record for the hash. A stop ahead of the order (part 4) is one. | `422 STOPPED` |
| 11 | The game: a game of the games set; its start written; its reporters exactly the published list; not ended; its close, the start plus the window, not passed. | `422 UNKNOWN_GAME`, `NO_WRITTEN_START`, `REPORTERS_NOT_THE_PUBLISHED_LIST`, `GAME_ENDED`, `BETS_CLOSED` |
| 12 | The order's standing on chain: not cancelled, at the account's current version, at or above its line's floor at that version; its expiry above the chain's time plus one, exactly, with no margin; a lot or more of its stake left. | `422 CANCELLED`, `EXPIRED`, `FILLED` |
| 13 | A quote: fewer than 16 live quotes of the account on that side of that market. | `422 TOO_MANY_QUOTES`; `503 CHAIN_UNREACHABLE` where the chain cannot be asked about the sixteen |
| 14 | A bet: until the cap is lifted, the signed stake not above it. | `422 ABOVE_CAP` |
| 15 | A bet: the expiry at most 30 seconds past the chain's time. | `422 EXPIRY_TOO_FAR` |
| 16 | A bet: fewer than two of the account's bets, and fewer than 32 in all, waiting their turn. A count and not a clock. | `503 QUEUE_FULL` |

So an order that names a grant it has no right to, a stranger's or a former agent's, takes nothing from the
account's budget and leaves no line. A database that cannot be read is `503 DATABASE_UNREADABLE`.

**The same order posted again** is answered at check 5 from its record, whatever has become of it since: a stopped
order's record says `ended: "stopped"`. It writes nothing.

## Part 4. The stop: `POST /v1/stops`

```
{ "account": "0x…",
  "orderHashes": ["0x…", …],                       1 to 100, each once
  "signature": "0x… (65 bytes)",                   over { account, orderHashes }, under the courier's domain
  "originals": [ { "orderHash": "0x…",             optional, at most 16: an order the courier may never
                   "order": { the ten fields },     have seen, named by its hash, with its own signature
                   "signature": "0x…" }, … ] }
```

An account signs one message that names orders of its own by hash. From the moment the courier writes it down,
those orders are carried for no fill: a quote is listed for no bet, and a bet waiting its turn is not sent. No gas,
no transaction, no wallet asked. A stop is permanent for its hash: it is written once and not removed.

The body is at most 32,768 bytes. `orderHashes` are compared lowercased, and their order is part of what is
signed. `originals` is not part of what is signed (see the limits below).

### What a stop does, in order

1. The body's shape. Any fault refuses the message whole, `400 INVALID_PARAM`: a key missing or unknown; no hash,
   more than 100, or a hash twice; a signature that is not 65 bytes; more than 16 originals; an original that names
   no hash of the message, or the hash another original names; an original's order that is not the ten fields.
2. The signer, recovered from the signature over the message's digest, in the form the chain takes. Nothing
   recovered: `422 BAD_SIGNATURE`, whole.
3. The hashes are looked up, with no lock held: which are orders the courier carries, whose, and under which grant;
   which hold a stop already; which are unknown.
4. Who the signer is (part 2). The account's own key: go on. Anyone else: the chain is read; the account's live
   agent goes on, and anyone else is refused whole, `422 AGENT_NOT_LIVE` or `422 BAD_SIGNATURE`.
5. A message whose every hash the account has stopped already is answered now, `already stopped` for each, from
   the records, and nothing is written.
6. Whether the message is free of the budgets or under them (below). Under them, the account must have the relay
   registered, read at the block, else `422 NOT_REGISTERED`, whole.
7. Every original is judged in full, holding nothing (below).
8. One database transaction: the hash locks; the records read again under them, each hash judged on what stands
   then; the budgets, where the message is under them; the results; the rows and the lines.

### The result for each hash

`200 { "account", "results": [ … ] }`, one result a hash, in the message's order. A result is
`{ "orderHash", "status" }` with `status` one of `"stopped"`, `"already stopped"`, `"stopped ahead"`, or
`{ "orderHash", "status": "refused", "code", "error" }`.

| the hash | the result | what is written |
| -- | -- | -- |
| An order the courier carries for the account, not stopped, that the signer may stop | `stopped` | A stop for the hash. The order is marked stopped, where no other end stood already: an order that had expired, been cancelled or been filled keeps that first end in its record, and the stop is on record all the same. |
| A hash the account has stopped already, carried or ahead, whatever grant its order was signed under | `already stopped` | Nothing. |
| An order, or a stop, of another account | refused, `NOT_YOUR_ORDER` | Nothing, and no lock is taken on it. |
| An order the courier carries for the account that the signer may not stop: an agent's message, the order not under the agent's current grant | refused, `NOT_THE_GRANTS_AGENT` | Nothing, and no lock. |
| Unknown to the courier, and no original came for it | refused, `UNKNOWN_ORDER` | Nothing. |
| Unknown to the courier, its original came, and the original passes | `stopped ahead` | A stop for the hash, holding the original. The order is refused at the door, `STOPPED`, if it ever arrives. |
| Unknown to the courier, its original came, and the original fails | refused, by the original's code | Nothing, and no lock. |

A hash that was unknown when the message arrived and is a carried order by the time its lock is held (its first
post was recorded meanwhile) is answered `stopped`, as a carried order, and takes no place among the stops ahead.
Whichever of the two is recorded first, the stop or the post, the order is carried after its stop by neither.

### An original, and when it passes

A stop ahead is for the post that is still on its way: an order signed and sent, not yet answered, that its maker
wants dead on arrival. Each original is judged as the door would judge its post, and the first fault is its hash's
code:

1. Its ten fields hash to the hash it names: `ORIGINAL_NOT_THE_HASH`.
2. It is an order of the stop's account: `NOT_YOUR_ORDER`.
3. It passes the order's own rules, the door's check 3, by the same codes.
4. Its signature, in the form the chain takes, is its signer's: the account's for a grant number of 0, and else
   the agent's of the grant its nonce names: `BAD_SIGNATURE`, for this hash and not for the message.
5. Under a grant: its stake is within the grant's cap, `AGENT_STAKE_ABOVE_CAP`; its line is on the grant's list,
   or the list is empty, `LINE_NOT_IN_GRANT`; the grant is the account's current one and does not end at or before
   the chain's time plus one, `GRANT_GONE`. An order under a grant that is gone can fill in no later block, so
   there is nothing to stop.
6. Its expiry is above the chain's time plus one: `EXPIRED`.
7. The stop's signer may stop it: the account's key any of these; an agent only an original signed under its own
   current grant, else `NOT_THE_GRANTS_AGENT`.
8. Last, with the account's budget row locked: the account holds fewer than 32 stops ahead that still count,
   else `TOO_MANY_STOPS_AHEAD`. A stop ahead counts while its order could still fill in a later block: while the
   order's expiry, or its grant's end where that comes first, is above the chain's time plus one, and, for one
   under a grant, while that grant is the account's current one. A revoke or a new grant frees a gone grant's
   places at the block read; the stops themselves stand.

The original's standing on chain is not read: its game, its floor, its fill. A stop ahead stops what a post would
have been, and the post's own checks run if the post ever comes.

**What an original is.** An unexpired order signature the account signed, not a cancel. This courier keeps it with
the stop, serves it on no route, lists it nowhere and fills nothing from it. If it leaks, from the courier's
database or a backup of it, it is fillable through any other courier the account has registered, within every other
check the contract makes. The stop does not close that. The on-chain cancel, a raised floor, a change of version, a
revoke of its grant, or its expiry does.

### Free of the budgets, or under them

Free, taking none of the budgets and needing no registration:

- a message that carries no original and names only orders the courier carries that its signer may stop, with or
  without hashes the account has stopped already;
- a message whose every hash the account has stopped already.

Every other message is under the budgets, whole: one that names an unknown hash, another account's hash, or an
order outside the signer's grant, and one that carries an original. It needs the account registered, and takes one
from the account's budget and one from the courier's, once a message, whatever its results. Over a budget it is
refused whole, `429 RATE_LIMIT_EXCEEDED`, and nothing in it is stopped: not the carried orders it also named.

So send the emergency stop of the orders the courier carries as a message of its own, never mixed with an unknown
hash, another account's hash, an order outside the signer's grant, or a stop ahead. In three statements:

- A stop of your own live orders takes none of your budgets.
- The only limit on it is the stop route's count for your network address, 600 a minute, which nothing else you
  send counts against; its `retry-after` is the next slot's eligibility and not success within a minute.
- The on-chain cancel always stands and does not go through the courier.

The three whole-message refusals such a message does not receive, the budgets' `RATE_LIMIT_EXCEEDED`,
`NOT_REGISTERED` and `CHAIN_UNREACHABLE`, each end with this sentence:

> Send the stop of your own carried orders as a message of its own, with no other hash and no original: it takes
> none of your budgets, and signed by the account's key it reads no chain; the only limit on it is this route's
> count for your network address (its `retry-after`, when it refuses, names the next free slot and promises
> nothing), and the on-chain cancel does not go through this courier.

### The stop route's own count of an address

Every stop request, the free one included, is counted against its network address before its body is read: 600 a
rolling minute, each process its own count, kept in memory and no longer than its minute. The count is the stop
route's own. No other request from the address counts against it, and it counts against no other route: a maker's
posting and reading do not hold up its stop, and its stops hold up nothing else. Over the count:
`429 RATE_LIMIT_EXCEEDED`, with a `retry-after` header and no `budget` field, and this sentence:

> Too many stop requests from this address in the last minute: the count is this route's own, and nothing else you
> send counts against it. `retry-after` is when the next slot frees — the next slot's eligibility, not success
> within a minute, since continued stop traffic from this address can take the next slots too; the on-chain cancel
> (`cancelOrder`, `raiseFloor`, `cancelAll`) does not go through this courier.

What that can cost a maker is a wait when its own address, its own program or another user of the same address,
has made 600 stop requests in the last minute: the current `retry-after` is at most a minute; continued stop
traffic may repeatedly take the next available slots, so it does not guarantee withdrawal by then. The on-chain
cancel is the answer named for that case.

**What 600 means for a maker pulling everything it has live.** A stop names up to 100 orders, and an address has 600
stop requests a rolling minute, so at most 60,000 orders a minute from an otherwise empty window. There is no
account-wide bound on live orders (16 a side of a market, and no total), so a larger book takes longer, and other
stop traffic from the same address uses the same count. The pull that does not depend on the courier is the
on-chain `cancelAll`, called by the account or its live agent: it moves the account's version in one transaction, so
every order signed at the old version fills no more, on every market, an order signed beforehand for the resulting
version excepted.

What stands behind the number, and what does not: A stop that needs the chain reads one header and one multicall,
each with one retry. The storage tests measure bytes for the two stop shapes, including their rows and indexes,
alongside order storage. They do not measure processing time or throughput and do not establish the right
stop-request allowance.

### What the acknowledgement means

`200` with a result of `stopped`, `already stopped` or `stopped ahead` for a hash: the stop of that hash is
recorded. From then on this courier lists the order for no bet and sends no bet of it.

A maker that re-prices by "stop, confirmation, then post" can rely on that: stop the old quote, wait for its
`200`, then post the new one.

**The same stop sent twice.** An account-key message whose every hash is already stopped, or the corresponding
message from a currently live agent, is answered `already stopped` without a new stop, message, event or budget
charge. Otherwise the message is judged again: refused or unresolved hashes can make a replay charge budgets and
append a refusal line.

**A `503` is not proof that nothing was recorded.** A definite failure before the commit rolls the stop back whole:
no row and no line. But a connection lost around the commit can leave the stop recorded and the request
unanswered. To learn which, read one of its orders by hash, or send the same message again: where it was
recorded, the answer is `already stopped`.

**Where a hand-off stood: the `handOff` field.** A transaction already handed to the node cannot be withdrawn by
anyone, so once the courier sends bets, a stop's result for an order a Cross already names will say where that
hand-off stood. The field has three states, and this build's answers carry none of them, since this build sends
nothing: every carried order answers `stopped` or `already stopped` and no more. The sender's build fills it:

| the Cross that names the order | the result | what follows |
| -- | -- | -- |
| not yet through the gate, signed or not | `stopped`, and no `handOff` | The gate finds the stop, and the Cross is closed without being handed to the node. |
| through the gate, and the node's answer is on record | `stopped`, with `handOff: { txHash, state }`: handed to the node, or in a block that is not final | It may still fill. The order is stopped for every later Cross. |
| through the gate, and no answer is on record | `stopped`, with `handOff: { txHash, state: "uncertain" }` | The courier does not know whether the node has it. It may still fill. |

### What a stop does not do

- **A signed stop is not a one-use budget authorization.** When an admitted budgeted message creates no stop, its
  refusal line does not deduplicate the message; any holder of the signature can present it again and cause
  another charge while authorization, registration and budgets permit. A partially successful message may remain
  chargeable for its unresolved hashes. `originals` is outside the signed payload, so its presence or omission can
  change processing without changing that signature. Only the applicable carried-only/all-stopped rules give the
  stated free/no-write behavior; do not generalize them to every replay. Measured in the suite as it stands: the
  same stop of one unknown hash, signed once and presented twice, is admitted twice, refused by its hash twice,
  takes one from each budget twice and leaves two lines.
- **It does not reach the chain.** An order stopped here is still a valid signature on chain. It is filled by
  nothing this courier sends; it is not cancelled, and another courier the account registered can still fill it.
- **It does not undo a mark.** A quote the chain showed ended (cancelled, or filled) is marked in the records at
  the block that showed it. If that block is later reorganised away, the quote stays marked here until a later
  build lifts the mark; a maker who wants it carried signs the quote again.
- **It does not sweep.** A quote let expire is a row kept: nothing is deleted. An expired quote is marked when a
  read of its market next meets it, and a stop is the way to end a quote the book has not yet read.

**The locks.** A stop locks only a hash it is authorised to decide, the account's own carried orders it may stop
and the hashes of its originals that passed, and may still refuse one under its lock. It takes no lock on another
account's order, on an order outside the signer's grant, or on an unknown hash whose original failed. Two hashes
whose first eight bytes are the same wait on each other, and nothing more follows from it.

### The order's record afterwards

`GET /v1/orders/{hash}` for a stopped order the courier carried is its record, with `ended` the first end the
courier saw, `"stopped"` where the stop came first. For a hash stopped ahead of its order it is
`{ "orderHash", "state": "stopped ahead", "stoppedAt" }` and no field of the order: the original is served on no
route. For any other hash it is `404 UNKNOWN_ORDER`.

## Part 5. The reads

All public, and each bounded: no read returns a list without a limit.

- `GET /healthz`: the process answers. `GET /readyz`: the database answers, else `503 NOT_READY`.
- `GET /v1/status`: what stands now: this run; the open conditions; the last block read; the set, every address;
  what the node can do; the bounds of part 6 with their values; the counts of requests refused before admission,
  by code, since this process started; `addressMinute` and `stopsMinute`, how many addresses hold a request, and
  a stop request, in the last minute, never which; the database's size and the bytes its tables take; and what is
  not yet built. `503 DATABASE_UNREADABLE` where the database cannot be read.
- `GET /v1/runs?after=&limit=`: the runs of the process, 100 to a page.
- `GET /v1/book?gameId=[&after=scorer:lineTicks&limit=]`: the markets of a game that hold a live quote, 100 to a
  page, each side's count, at one block named by number, hash and time, with the final block beside it.
- `GET /v1/book?gameId=&scorer=&lineTicks=[&side=A|B&after=tick:record&limit=]`: one market's quotes, 50 a side to
  a page at most, best price for the bettor first and then the record number. Each quote: `orderHash`, `account`,
  `positionType`, `oddsTick`, `perLot`, `bettorPrice`, `remaining`, `payable`, `minFill`, `expiry`,
  `recordNumber`. Listed: quotes not stopped, not expired at the block, not cancelled, at the account's current
  version, at or above its floor, not under a grant that is gone, with a lot or more left, whose account has the
  relay registered. A page read before a stop was recorded may list the quote; the next does not: a page is one
  block's and one scan's answer, and it says which block.
- `GET /v1/orders/{hash}`: the record of one order (parts 3 and 4).

**Which requests read the chain.** A post of an order not yet on record: one header and one read; a quote's post
makes one read more where the account has sixteen quotes standing on the side, and a bet's never does. A post of an
order on record: none. A stop signed by the account's key whose every hash the account has stopped already, or that
carries no original and names only orders the courier carries for the account and hashes the account has stopped
already: none. Any other stop whose signature recovers a signer, an agent's included, even an agent's whose every
hash is stopped: one header and one read. A game's list of markets: two headers. A market's page: two headers, and
one read where it has quotes to ask about. A record, the status and the runs: none. Each read is tried once more when
it fails, and twice failed is `503 CHAIN_UNREACHABLE`.

## Part 6. The bounds

All settings, served with their values on the status address under `bounds`.

| what | the bound | where it is counted |
| -- | -- | -- |
| An order post's body; a stop's body | 8,192 bytes; 32,768 bytes | the process |
| Hashes in one stop; originals in one stop | 100; 16 | the process |
| Requests from one network address, a stop excepted | 600 a minute | memory, each process its own |
| Stop requests from one network address | 600 a minute, the stop route's own count | memory, each process its own |
| Admitted requests, one account | 240 at once, 12 a minute after | the database, on the chain's clock |
| Admitted requests, all accounts | 2,400 at once, 60 a minute after | the database, on the chain's clock |
| Live quotes, one account, one side of one market | 16 | the database |
| Bets waiting their turn | two an account, 32 in all | the database; a count and not a clock |
| Stops ahead that still count, one account | 32 | the database |
| Rows returned from the book's index for one page | 2,000 | the read |
| Quotes examined for one bet; quotes listed in one Cross | 200; 40 | nowhere yet: set and served, and used by the build that fills bets, which this one is not |
| A page of a market's quotes; of markets or runs | 50 a side; 100 | the read |

The address counts are each process's own and start again when a process does; they bound traffic and nothing
durable, and the courier keeps no log of addresses. They are not a rate the service as a whole admits or completes
stops at: none is claimed.

## Part 7. Every code

| code | status | where | what it says |
| -- | -- | -- | -- |
| `HTTPS_REQUIRED` | 403 | every route but `/healthz` | This service answers only over https. |
| `NOT_FOUND` | 404 | no route matched | Not found. |
| `INVALID_PARAM` | 400 | every route | The fault of the body or the query, named. |
| `BODY_TOO_LARGE` | 413 | the two posts | The body's bound, in bytes. |
| `RATE_LIMIT_EXCEEDED` | 429 | every route but `/healthz` | The address's minute: the general count's sentence, or the stop route's (part 4), with a `retry-after` header. Or a budget: which one (`budget`), its two numbers, and when to try again (`retryAfterSeconds`); on the stop route, followed by the recipe. |
| `BAD_SIGNATURE` | 422 | the door; the stop, whole or for one original | The signature is in a form the chain refuses, or is not the signer's it had to be. |
| `AGENT_NOT_LIVE` | 422 | the stop, whole | The signer was the agent of a grant that is not live at the block read: the grant's number and end, the account's current grant, the chain's time. |
| `NOT_REGISTERED` | 422 | the door; the stop, whole | The account has not registered the relay; on the stop route, followed by the recipe. |
| `ROLE_CONFLICT` | 409 | the door | The order is on record under the other role. |
| `PRICE_OUT_OF_RANGE`, `STAKE_NOT_IN_LOTS`, `MIN_FILL_ABOVE_STAKE`, `UNKNOWN_MARKET_CONTRACT`, `INVALID_LINE` | 422 | the door; the stop, for one original | The order's own rule it breaks, with its value. |
| `AGENT_STAKE_ABOVE_CAP`, `LINE_NOT_IN_GRANT`, `GRANT_GONE` | 422 | the door; the stop, for one original | What of the grant the order fails: its cap, its list, or its standing. |
| `STOPPED` | 422 | the door | A stop for this order is on record; it is carried for no bet. |
| `UNKNOWN_GAME`, `NO_WRITTEN_START`, `REPORTERS_NOT_THE_PUBLISHED_LIST`, `GAME_ENDED`, `BETS_CLOSED` | 422 | the door | What of the game the order fails. |
| `CANCELLED`, `EXPIRED`, `FILLED` | 422 | the door; `EXPIRED` also the stop, for one original | The order's standing on chain: cancelled, at another version or under its floor; its expiry at or under the chain's time plus one; less than a lot left. |
| `TOO_MANY_QUOTES` | 422 | the door | The account's sixteen on that side of that market. |
| `ABOVE_CAP`, `EXPIRY_TOO_FAR` | 422 | the door, a bet | The stake above the cap; the expiry more than 30 seconds past the chain's time. |
| `QUEUE_FULL` | 503 | the door, a bet | Two of the account's bets, or 32 in all, wait their turn. |
| `NOT_YOUR_ORDER` | — | the stop, for one hash | The hash is another account's, or the original is. |
| `NOT_THE_GRANTS_AGENT` | — | the stop, for one hash | The order is not under the signing agent's current grant. |
| `UNKNOWN_ORDER` | — / 404 | the stop, for one hash; `GET /v1/orders/{hash}` | The courier holds no order of this hash; on a stop, and no original came with it. |
| `ORIGINAL_NOT_THE_HASH` | — | the stop, for one hash | The original's ten fields do not hash to the hash it names. |
| `TOO_MANY_STOPS_AHEAD` | — | the stop, for one hash | The account's 32 stops ahead that still count. |
| `CHAIN_UNREACHABLE` | 503 | the door, the stop, the book | The chain could not be read, twice; on the stop route, followed by the recipe. |
| `DATABASE_UNREADABLE` | 503 | every `/v1` route that reads the database | The database could not be read; with `retryAfterSeconds` where the courier waited ten seconds for a connection and none came free. |
| `NOT_READY` | 503 | `/readyz` | The database did not answer. |
| `INTERNAL_ERROR` | 500 | any | The courier failed on this request, by a fault of its own. |

A code with no status of its own (—) is a hash's result inside a `200`.
