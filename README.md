# ospex-courier

The Ospex courier: one small web program with a database and, from the sender's build on, a key. It takes signed
orders over HTTP and writes each one down; serves the book, best price for the bettor first; checks a bet and the
quotes it would fill against one block of the chain; sends one Cross per bet to the matching contract through the
relay, paying the gas; and writes down what happened, one line per event. Nothing in it runs on a schedule.

It decides which signed orders are paired, in what order, and when. It decides nothing about a bet's terms: the
contract checks every signed value, and the relay passes the call through unread.

## This build

The second build: orders in. The door (`POST /v1/orders`) takes a signed order under a role, runs the sixteen
checks in order, and records what it admits, each outcome a line; the book's quotes are served, a page a side, in
the fill-priority order (`docs/FILL_PRIORITY.md`); the two budgets of admitted requests; the game rule against the
published list; the hash lock; the mark of expired quotes against the final block; and the cost of the book's scan
measured against the plan's three books in both maintenance states (`docs/COST.md`), with the table's maintenance
settings set from the measurement. On the first build's: the repository, the settings, the schema, the start-up
against the set read from a signpost, the local chain rig and the proxy, the runs and the status address, what a
node does with a block's hash and with an override, and the store's TLS check. It holds no key, signs nothing and
sends nothing: a bet posted is recorded and waits. What it does not yet do is listed on its own status address
under `notYetBuilt`: stops, the lanes and the pre-check, the sender and the key, the incidents and their cursor,
and the netted pull's `payable`.

## Running it

Node 22 or 24, and yarn 1: `yarn install --frozen-lockfile`. Every setting is read from the environment; none has
a value in this repository (`.env.example` lists them).

| setting | what it is |
|---|---|
| `DATABASE_URL` | The courier's own Postgres. Heroku sets it when the add-on is attached. |
| `POLYGON_RPC_URL` | The node. https, or plain http to this machine only, where the tests run a local chain. |
| `SIGNPOST_ADDRESS`, `BETTING_ENTRY_ID` | Where the set is: the signpost, and the betting entry's number on it. Every address of the set is read from the entry at start, and none is written in this repository. |
| `COURIER_LOW_POL` | Under this many POL the key's wallet is reported low. 3 unless set. Read now, used from the sender's build. |
| `PORT` | Where the process listens. 0 is any free port, which is how the tests start it. |
| `DATABASE_CA_FILE` | Optional: a file holding the certificate authority the database is verified against, in place of the pinned `db/database-ca.pem`. It can name another authority and nothing else; verification is never off. |
| `PUBLISHED_REPORTERS_FILE` | Optional: a file holding the published list of reporters, in place of the repository's `published-reporters.json`; the tests name the rig's reporter. It can name another list and nothing else; the game rule is never off. |

- **`yarn start`** is the web process. At start it reads the settings, the database and its schema, the chain and
  the set from the signpost, proves what the node can do, writes this run's row, and listens. Each refusal to start
  is one plain line that names the setting and never prints a value.
- **`yarn db:apply`** applies `db/schema.sql` to `DATABASE_URL`: the release step on every deploy (`Procfile`).
  Every statement in it is safe to run again. It connects through the same function the web process does, so the
  two verify the same authority.
- **`yarn check:node`** makes each request the pre-check will make three ways against `POLYGON_RPC_URL`: at the
  latest block's hash, at the hash of a block 50 back, and at a hash no block has, which must be refused; it also
  overrides one balance and reads it back. It prints the verdicts, writes them to `runs/`, and exits 1 when the
  node fails a request the pre-check needs. The web process runs the same check at every start and serves the
  verdicts on the status address.
- **`yarn typecheck`**, **`yarn build:contracts`** (the set the tests deploy, from the pinned contracts) and
  **`yarn test`** (below).

## The start-up, and what it refuses

The courier is told the signpost and the betting entry's number, and takes the set from the entry: the core, the
six modules through the core's registry, the relay as the one listed contract that is neither, and the coin. It
refuses to start unless the entry is a betting entry that is not retired; each listed address holds code that
hashes as the entry says, now and not only when the entry was written; the core is finalized and names the entry's
coin; the relay passes to the set's matching contract and answers the matching contract's own timelock. It then
proves what its node can do, writes its run, and listens.

## The door: `POST /v1/orders`

```
{ "role": "rest" | "take",
  "order": { "account", "gameId", "scorer", "lineTicks", "positionType",
             "oddsTick", "riskAmount", "nonce", "expiry", "minFill" },
  "signature": "0x… (65 bytes)" }
```

The ten fields are the contract's `OspexOrder`, signed under its EIP-712 domain (name `Ospex`, version `3`, the
chain, the matching contract); the amounts are decimal strings in the coin's smallest unit. `role` is not signed:
`rest` keeps the order on the book until its expiry, its cancel or its stop, and the courier never uses it to take;
`take` is a bet, to be filled against the book in one Cross and kept no further. An order hash has one role at this
courier, the first one posted.

Sixteen checks, in order; the first that fails is the answer. Before admission (no row, no line; counted by code
on the status address): the body's shape and its size (8 KB), the caller's minute, the order's own rules as the
contract has them (`PRICE_OUT_OF_RANGE`, `STAKE_NOT_IN_LOTS`, `MIN_FILL_ABOVE_STAKE`, `UNKNOWN_MARKET_CONTRACT`,
`INVALID_LINE`), the signature (`BAD_SIGNATURE`), the hash on record (a repeat is answered from the record, the
first answer whole, with no chain read; the other role is `ROLE_CONFLICT`), one read of the chain at the latest block named by its hash
(`CHAIN_UNREACHABLE`), the account's registration of the relay (`NOT_REGISTERED`), and the two budgets
(`RATE_LIMIT_EXCEEDED`, naming which). From then on the request is admitted, and whatever becomes of it is a line:
the contract's own `getOrderHash` must equal the hash computed here (else `INTERNAL_ERROR`, recorded as the
courier's own fault); a stop on record (`STOPPED`); the game, whose start must be written, whose reporters must
be exactly the published list, which must not have ended and whose close must not have passed (`UNKNOWN_GAME`,
`NO_WRITTEN_START`, `REPORTERS_NOT_THE_PUBLISHED_LIST`, `GAME_ENDED`, `BETS_CLOSED`); the order's standing on chain
(`CANCELLED`, `EXPIRED`, `FILLED`), the expiry exact with no margin; for a quote, fewer than 16 live quotes of the
account on that side of that market (`TOO_MANY_QUOTES`), the unexpired ones gathered sixteen at a time and the
chain asked which of them it shows ended, so that cancelled or filled quotes standing in front hide none behind
them; for a bet, the signed stake not above the cap until the lift, both read from the matching contract at the
block (`ABOVE_CAP`), the expiry at most 30 seconds past the chain's time (`EXPIRY_TOO_FAR`), and fewer than two of
the account's bets, and 32 in all, waiting their turn (`QUEUE_FULL`). Checks 5 and 8 to 16 run in one database
transaction under the order's hash lock. A quote accepted is `201 resting`; a bet accepted is `202 queued`, recorded
and waiting, and in this build nothing examines or sends it. Either answer is the order's record, which carries the
chain's time it was taken at as `chainTime`; a repeat post is answered with the same record.

The two budgets are rows in the database, one count for every process and across a restart: an account's 240
admitted requests at once and 12 a minute after; the courier's 2,400 at once and 60 a minute after, for all
accounts together. Their clock is the chain's time, read at the block the door named. A request over a budget is
not admitted, and the row counts how many and when last.

`GET /v1/orders/{hash}` is the courier's record of one order.

## What is served

JSON, under `/v1`, over https only (behind Heroku's router; plain http is served only from this machine). No sign-in
and no secret: the book is public. Every refusal is `{error, code}`, a plain sentence and an UPPER_SNAKE code.
Reads from one network address are limited to 600 a minute, counted in memory; the courier keeps no log of
addresses.

- `GET /healthz`: the process answers, and no more. `GET /readyz`: the database answers.
- `GET /v1/status`: what stands now. This run; the open conditions; the number of the newest report line; the last
  block the courier read, and when (a quiet courier reads no chain, so an old one means a quiet courier and nothing
  more); the set, every address, as read from the signpost at start, and the block it was read at; the relay's
  sender, and the key's address (none in this build); what the node can do; the published bounds; the settings;
  this run's counts of requests refused before admission, by code; the database's size; and what is not yet built.
  If the database cannot be read it answers `503` and says that: it does not serve what it last knew as if it were
  now.
- `GET /v1/runs?after=&limit=`: the runs, 100 to a page: each start of the process, and each stop the process
  wrote itself. A process that dies writes nothing, and no later start writes it for it. This is the courier's own
  account of when it was running, not a measure of whether a caller could reach it.
- `GET /v1/book?gameId=`: the markets of a game that hold a live quote, each side's count within the bound of
  2,000 rows and whether the bound ended the count, at one block named by number, hash and time, with the final
  block beside it. `GET /v1/book?gameId=&scorer=&lineTicks=[&side=A|B&after=tick:record&limit=]`: one market's
  quotes, 50 a side to a page at most, in the fill-priority order; each with `remaining` (the signed stake less
  what the chain shows filled) and `payable` (what the account's balance and allowance cover, this quote alone);
  once per account on the page, its balance and allowance; a page short of its limit says whether the book or the
  bound ended it, and where the next page starts. Listed: quotes not stopped, not expired at the block, not
  cancelled or under a floor, with a lot or more left, whose account still has the relay registered. A request that
  is returned an expired quote marks it, where the final block's time plus one has reached its expiry, so the next
  request does not meet it; a backlog the final block has not passed is met again, and the answer names the bound
  and never an empty book.

One standing condition is raised in this build: `chain-unreachable`, when a read of the chain fails and fails
again when tried once more; it clears at the next read that succeeds. Each opening and clearing is a numbered line
in the records.

## The database

The courier's own Postgres, `db/schema.sql`: ten tables (orders, stops, lanes, crosses, legs, events, conditions,
accounts, runs, games) and the indexes the book and the door read along. The schema's comments say what each bound
counts: a scan along the book's index is bounded by the rows it is returned, which is what `LIMIT` counts, and not
by the index entries it visits, the rows it fetches or the pages it reads to return them. That work is measured
(`docs/COST.md`, `tests/cost.test.ts`), and the orders table's maintenance is set from the measurement: due for
vacuum at 2,000 dead versions whatever its size, with its indexes cleaned at every vacuum. The status address
serves the settings as the database holds them, under `database.maintenance`, and the bytes a row takes with its
indexes under `database.tables` and `database.growth`.

Off this machine the connection uses TLS and checks the server's certificate against a pinned authority. No
authority is pinned yet: `db/database-ca.pem` is added at the first release, as the public bundle that verifies the
chain the add-on's host presents. Until then a database off this machine is refused rather than reached with
verification off. An option in `DATABASE_URL` cannot turn verification off: only the URL's user, password, host,
port and database are read.

## The published list

`published-reporters.json` is the list of reporters a game must have, exactly, for the courier to carry it. It is a
file in this repository, changed by a reviewed commit, and is never read from the chain's approved list. The door
compares a game's reporters with it at every order; the status address serves the list under `published`.

## The tests

`yarn test` needs: `TEST_DATABASE_URL`, a Postgres server on this machine (the tests create and drop their own
databases there; the cost test lays 500,000 rows and needs the `pgstattuple` extension, which the server's contrib
modules provide); `anvil` and `forge` on the PATH, with the contracts built once by `yarn build:contracts`; and
`openssl` on the PATH, for the TLS test's authorities. CI (`.github/workflows/ci.yml`) provides all three.

The orders, the book and the budgets are tested from a user's side: orders signed with real keys, posted over HTTP
to the courier running as its own process, and judged by the answer, the rows and the lines. The rig's final block
is named by the test through the proxy where a test needs it: anvil's own answer for the `finalized` tag is the
block 64 behind the head.

The rig is a local chain with the set deployed from the pinned contracts, from their build artifacts: a six-decimal
coin; a stock timelock with a test key as its proposer and a 60-second delay; the games set with a fixture reporter
as its first-n reporter, and one game with its start written; the betting set, bootstrapped and finalized; the
relay; a signpost whose first entry is the games set and whose betting entry is added through the timelock, as a
set is listed live; two accounts with coin, an allowance to the positions contract and the relay registered. The
courier is then started as its own process against that chain and a real Postgres, and the tests speak to it over
HTTP. Between the courier and the chain sits a proxy the tests control: it counts requests, can refuse or rewrite
one, and answers the `finalized` tag itself.

What the rig proves is the process, the start-up, the schema and the reads. What the app's own node accepts is
proved only against that node: `yarn check:node`, run once against it with its output kept, and then at every
start.

## Layout

```
Procfile                 release: apply db/schema.sql.  web: one process.
db/schema.sql            the one schema file
published-reporters.json the published list, changed by a reviewed commit
courier/
  server.ts  config.ts  startup.ts
  http/      service.ts  routes.ts  limits.ts
  chain/     abi.ts  set.ts  snapshot.ts  rpc.ts  node.ts  reads.ts
  orders/    order.ts  door.ts  budgets.ts  published.ts
  records/   store.ts  orders.ts  events.ts  runs.ts  conditions.ts
  status/    status.ts
  book/      read.ts
scripts/     apply-schema.ts  check-node.ts
docs/        INCIDENT_NOTES.md  FILL_PRIORITY.md  COST.md
tests/       the suite, its support (the rig, the proxy, the TLS front) and fixtures
contracts/   a submodule: the contracts repository at the pinned commit, for the tests only
```

The contracts submodule is pinned to one commit. Each time it moves, it moves in a change of its own, and the ABI
test (`tests/abi.test.ts`) says what the interface changed.

MIT.
