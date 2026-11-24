# The cost of the book's scan, measured

What one request to the book costs the database, measured against the three books the plan names, two of them at
two sizes, each in two maintenance states; and the orders table's maintenance settings, chosen with the figures in
view. Then what one bet's check costs: its requests to the node and its commands to the database, counted by path,
and its candidate statement, measured on the same books ("A bet's check", below).
The statement measured is the one the courier runs (`SCAN_SQL` in `courier/records/orders.ts`): the book's index
walked in its order for one side of one market, at most 2,000 rows returned, the expired among them marked where the
final block's time plus one has reached their expiry, the live among them passed. The test is `tests/cost.test.ts`;
it runs in CI, and every figure below is from one run of it on this build, on Postgres 17.10, read from the
statement's own `EXPLAIN (ANALYZE, BUFFERS)` and named by the node it comes from. Nothing is read from a
cumulative counter.

## What is measured, and what is not

`LIMIT` counts the rows a scan returns. It does not count the index entries the scan visits to find them, the rows
it fetches from the table to judge them, or the pages it reads for either, and nothing bounds those three. The
measure of that physical work here is the scan node's shared buffer accesses: its `Buffers: shared hit` and `read`
added, index and table together, non-distinct. The dead versions the mark leaves behind (a marked quote's old row
version and its index entry, until vacuum removes them) are what makes the work differ from the count of rows, so
each book is measured before vacuum, with the dead versions its own marking planted, and after `VACUUM`, run with
no other transaction open, whose own report shows them removed.

The plan in every measured case is the index scan of `orders_book`. On the small book of ten rows the planner reads
the table whole, as it does for any ten-row table; that case checks the counts, not the plan.

## The figures

Rows: the inner scan's `Actual Rows` (at or under the bound of 2,000), the outer filter's `Rows Removed by Filter`
and `Actual Rows`, and the update's rows (what the request marked). Buffers: the scan node's shared buffer
accesses.

| book | size | state | rows: inner / removed / passed / marked | buffers |
| -- | -- | -- | -- | -- |
| ten live quotes | 10 | | 10 / 0 / 10 / 0 | 1 |
| ended by the mark, ahead of ten live quotes | 50,000 | before vacuum, 50,000 dead planted | 10 / 0 / 10 / 0 | 1,253 |
| | 50,000 | after vacuum (50,040 versions cleared, 0 not yet removable) | 10 / 0 / 10 / 0 | 2 |
| | 500,000 | before vacuum, 500,000 dead planted | 10 / 0 / 10 / 0 | 12,504 |
| | 500,000 | after vacuum (500,415 cleared, 0 not yet removable) | 10 / 0 / 10 / 0 | 2 |
| expired, not yet marked, ahead of one live quote | 50,000 | the final block held behind them: nothing marked, the same rows again | 2,000 / 2,000 / 0 / 0 | 164 |
| | 50,000 | the final block past them, before vacuum: the second request, 2,000 dead ahead | 2,000 / 2,000 / 0 / 2,000 | 353 |
| | 50,000 | after vacuum (6,000 cleared) | 2,000 / 2,000 / 0 / 2,000 | 166 |
| | 500,000 | held behind | 2,000 / 2,000 / 0 / 0 | 165 |
| | 500,000 | past, before vacuum, 2,000 dead ahead | 2,000 / 2,000 / 0 / 2,000 | 354 |
| | 500,000 | after vacuum (6,000 cleared) | 2,000 / 2,000 / 0 / 2,000 | 167 |

The index's depth: two levels at 50,000, three at 500,000. The test holds the after-vacuum figures equal across
the two sizes within one page a level of the index plus one; they differ by zero and by one. Before vacuum they are
reported and held to nothing: a dead version planted costs about 0.025 buffer accesses while it stands (1,251
over 50,000; 12,502 over 500,000), which is about forty dead index entries a page, the scan visiting their pages
and not their rows once an earlier scan has marked the entries dead. Those figures are what a request pays while
vacuum has not run; they are not promised flat, and this build enforces no bound on them.

Two things the measurement taught, kept here because they shape the settings below. On-access pruning: a page an
update or a scan touches has its dead versions pruned to dead item identifiers before vacuum runs, so the vacuum's
report counts most of the planted versions under "dead item identifiers removed", not "tuples removed"; the test
reads both. Index cleanup: a vacuum left to itself may skip the indexes when the pages holding dead items are under
two per cent of the table's pages, and leave their entries standing; the test vacuums with `INDEX_CLEANUP ON`, and
the table's own setting makes autovacuum do the same. Whether a vacuum left to itself would have skipped them on
these books was not measured.

## The maintenance settings, chosen with the figures in view

In `db/schema.sql`, on the orders table:

```
autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0,
autovacuum_analyze_threshold = 2000, autovacuum_analyze_scale_factor = 0,
vacuum_index_cleanup = on
```

What the figures support is two things: removing dead index entries promptly, since they are where the cost
lives, and a trigger that does not grow with the history kept. At Postgres's defaults the table is due for vacuum
at 50 dead versions plus a fifth of its rows: at 500,000 rows that is 100,000 dead, which at 0.025 accesses each
is about 2,500 buffer accesses ahead of a scan that costs 166 clean, fifteen times over, and the number grows with
the table. A scale factor of 0 removes the growth. The threshold of 2,000 is a chosen batch: the bound of rows one
request is returned, and so the most one request marks, so that the table is due after one request's worth of
marking whatever its size. What was measured of that state is the third book's before-vacuum row: 2,000 dead
versions, planted by one request's marking, standing ahead of the next scan, which then costs 353 accesses against
166 clean, about 190 more. How many dead versions gather between production's vacuums was not measured here; it is
read from the live table (`n_dead_tup`, below) once the courier runs. The threshold is not a measured optimum (no
other threshold was measured against it) and it is not a ceiling on the dead versions: the threshold is when the
table becomes due, autovacuum's workers can be busy elsewhere, and a version an older transaction can still see is
not removed until it cannot.

`vacuum_index_cleanup = on` makes each vacuum of this table remove the index entries. A vacuum left to itself may
skip the indexes when the pages holding dead items are under two per cent of the table's pages. The run above
forces the cleanup on (`VACUUM (INDEX_CLEANUP ON)`), which is the state the setting aims at; it does not show what
the default (`auto`) or `off` would have left standing on this table, nor how long production's autovacuum takes
to come round to it, and neither is claimed here. Both are to be read from the live table's statistics
(`pg_stat_user_tables`: `n_dead_tup`, `last_autovacuum`) once the courier runs, beside the settings the status
address serves as the database holds them.

## The markets of a game, measured

`GET /v1/book?gameId=` walks the game's (market, side) pairs along `orders_markets_of_game`, the index on
`(game_id, scorer, line_ticks, side)` over the quotes not marked ended, from the page's cursor: one index probe a
pair, each returning the next pair past the one before, at most two a market of the page plus one
(`MARKETS_OF_GAME_SQL` in `courier/records/orders.ts`); then each market of the page is scanned on its sides, each
scan at most the bound of rows measured above. The walk, measured by the book test from the statement's own
`EXPLAIN (ANALYZE, BUFFERS)` with 5,000 pairs standing on another game:

| read | probes (loops of the index scan) | pairs returned | shared buffer accesses |
| -- | -- | -- | -- |
| a game of five markets, two sides each | 11 | 10 | 41 |
| a game with nothing on it | 1 | 0 | 2 |
| the other game's page of 7 markets, from the start | 16 | 16 | 48 |
| the same page from its cursor | 16 | 16 | 48 |

The probes are the pairs found plus one, each one descent of the index, three buffer accesses at this size, and
the 5,000 pairs of the other game enter none of the four. The test asserts the probes and the pairs exactly, and
the index by name. Before this index the walk was along the book's index over every unmarked pair the whole book
held, the game kept afterwards: a probe for every pair in the book, whatever game was asked for.

## A bet's check

What one bet's check costs, counted by path. The counts of requests and commands below are the design's, and the
tests hold the build to them where a test says so; the candidate statement's work is measured, as the book's scan's
is above.

### Requests to the node, one round

Counted at the proxy between the courier and the chain, from the moment a held check is let go to its outcome
(`tests/lane.test.ts`, "the cost, in requests to the node"; the gas cases in `tests/precheck.test.ts`).

| the path | requests | held to it by |
| -- | -- | -- |
| Lapsed | 1: the header of H | the lane's cost case |
| Refused at read A (the sender, the bet's grant, registration, the game, its standing, the cap) | 2: H, read A | the lane's cost case |
| Refused after the walk, nothing listed | 3: H, read A, the final block | the lane's cost case |
| Refused after the walk with quotes read (`NOT_ENOUGH_DEPTH`, `DEPTH_BEYOND_BOUND`, `CANNOT_PAY`) | 4 to 6: and read B, one call a 100 quotes, and read C | the design |
| Refused by the simulation | 5 to 7 | the design |
| Ready, not trimmed | 9 to 12 | the lane's cost case: 10 in its run |
| Each listed leg the comparison shows unfilled, with a pull | 1 more: the probe | the design |
| The one re-walk after a coin's refusal | 1 to 2 more | the design |
| Over a ceiling, the search finding no fit | 6 to 9, and 0 to 6 estimates | the gas cases: 8, and 9 |
| Over a ceiling, a step refused | 6 to 9, and 1 to 6 estimates | the gas cases |
| Trimmed for gas, and ready | up to 6 estimates more, and 1 to 2 for the chosen prefix | the gas cases |

A round that passes makes at most 20 requests with no coin refusal, and 22 + s with s legs probed. Each request is
tried once more on a failure and the round once more, so a check makes at most four times one round's count. Each
request ends within ten seconds, its body included.

### Commands to the database

Counted as the commands the courier sends, `BEGIN`, `COMMIT` and `ROLLBACK` included, at the relay its connections
pass through in the tests (`tests/lane.test.ts`, "the cost, in commands to the database").

| the step | commands | held to it by |
| -- | -- | -- |
| One reservation, won | 6: `BEGIN`, the lane's lock, the find, the guarded update of the bet, the lane's write, `COMMIT` | the lane's cost case |
| One reservation, lost to a stop | 5: `BEGIN`, the lane's lock, the find, the update that matches no row, `ROLLBACK` | the lane's cost case |
| One reservation, the queue empty | 4 | the design |
| One reservation, the lane not this process's | 3 | the design |
| One loss and then a win | 11; r losses and then a win, 5r + 6; at the queue's bound, 32 losses and a win, 166 | the lane's cost case: 11 |
| The candidate statement | 1 | the design |
| The marks | 0 or 1 | the design |
| An outcome: a lapse or a refusal | 7: `BEGIN`, the lane's lock, the bet read again, the line, the bet's state, the lane freed, `COMMIT` | the lane's cost case |
| An outcome: ready | 9, with the Cross and its legs in one insert | the design |

With the door's, about 19 for a bet, the ordinary path in all is about 33 for a lapse, 34 for a refusal at read A,
and 44 to 48 for a ready bet. Each attempt lost to a stop adds 5. A second round adds its own requests' bookkeeping,
one candidate statement and 0 or 1 marks.

### The candidate statement, measured

`CANDIDATES_SQL` in `courier/records/orders.ts`: the book's index walked for the other side of the bet's market up to
the highest tick that meets the bet's price, at most 2,000 rows, the expired among them marked against the final
block, the live among them counted as the bettor's own or others', and the first 200 of the others returned. Measured
by `tests/cost.test.ts` as the book's scan is, on two of the books at the two sizes, from the statement's own
`EXPLAIN (ANALYZE, BUFFERS)`: the scan node's rows and shared buffer accesses, and the update's rows.

| book | size | state | rows: inner / marked | buffers |
| -- | -- | -- | -- | -- |
| ended by the mark, ahead of ten live quotes | 50,000 | before vacuum, 50,000 dead planted | 10 / 0 | 1,253 |
| | 50,000 | after vacuum | 10 / 0 | 2 |
| | 500,000 | before vacuum, 500,000 dead planted | 10 / 0 | 12,504 |
| | 500,000 | after vacuum | 10 / 0 | 2 |
| expired, not yet marked, ahead of one live quote | 50,000 | the final block held behind them: nothing marked | 2,000 / 0 | 164 |
| | 50,000 | the final block past them: the statement marks what it was returned | 2,000 / 2,000 | 164 |
| | 500,000 | held behind | 2,000 / 0 | 165 |
| | 500,000 | past | 2,000 / 2,000 | 165 |

On the book ended by the mark, after vacuum, the statement's own answer is ten rows scanned, none marked, none the
bettor's own, ten others, ten returned. The figures are the book's scan's, row for row: the statement walks the same
index the same way, and the bet's price stops it past every row of these books. The index's depth is two levels at
50,000 and three at 500,000; the test holds the after-vacuum figures, and each of the backlog's, equal across the two
sizes within one page a level of the index plus one, and they differ by zero and by one. Before vacuum they are
reported and held to nothing, as the scan's are.

### Idle

Nothing. With no request, an hour of blocks writes no row and no line and makes no request to the node (the lane's
idle case).

## The growth

From the same run: an orders row with its indexes is about 1,000 bytes (927 before the index on the game's markets
was added), an events line about 306, so an admitted order, one row and one line, is about 1,306 bytes. At the
courier's budget refilling all day (86,400 admitted a day) that is about 113 MB a day, 41 GB a year; at one maker's
defaults (13 games, 3 markets, 2 sides, re-signed every 10 minutes: 11,232 orders a day) about 15 MB a day, 5.4 GB
a year. The status address computes the same from the database it has, once a table holds a thousand rows or more.

### The two shapes a stop writes

A stop writes one row to `stop_messages` a message, which holds the signed payload once, and one row to `stops` a
hash it stops; a stop ahead's row holds its order's signed original, the second from which that order can fill no
more, and its grant number besides. Two kinds of figure follow, and they are not the same kind. Both are from one
run of the suite on this build, on Postgres 17 on Linux.

**Read back from rows the route wrote** (`tests/stops.test.ts`, case 12): a real signer on the local chain posts
one message stopping a hundred quotes the door had admitted, and one message stopping sixteen orders ahead. The rows
each message wrote are counted exactly; their bytes are the database's size of each row's data, added up, with no
index and no page in them:

| what was sent | `stops` rows | their bytes | the one `stop_messages` row | the one line |
| -- | -- | -- | -- | -- |
| one stop of 100 carried quotes | 100 | 16,000 (160 a row) | 7,360 | 190 |
| one stop ahead of 16 originals | 16 | 10,240 (640 a row) | 1,553 | 190 |

Two messages are too few for an average with indexes: a relation grows a page of 8,192 bytes at a time, and the
relations these rows went into held other cases' rows already. What the two establish is the shape, from real rows:
which rows a message writes, how many, and that the signed message is kept once a message at both sizes and not
once a hash. The quotes' own set-up, a hundred orders rows and their hundred lines, is counted apart from the stop
and is the order's figure above.

**Scaled-fixture estimates** (`tests/cost.test.ts`): rows laid by hand in the same shape, 100 stops of 100 hashes
and 100 stops ahead of 16 originals, with order hashes that are digests, as real ones are. Each figure is the bytes
a relation grew by, with its indexes, over the rows or the messages laid, and the divisor is beside it:

| shape | figure | bytes grown | divided by | each |
| -- | -- | -- | -- | -- |
| a stop of 100 carried hashes | a `stops` row | 2,957,312 | 10,000 rows | 296 |
| | its `stop_messages` row | 950,272 | 100 messages | 9,503 |
| a stop ahead of 16 originals | a `stops` row, with its original | 1,425,408 | 1,600 rows | 891 |
| | its `stop_messages` row | 163,840 | 100 messages | 1,638 |
| either | its `stop received` line | 663,552 | 3,000 lines | 221 |

So a stop of 100 carried hashes is about 39,300 bytes at this fixture's scale (a hundred rows, the message, the
line), about 390 a stopped order; and a stop ahead of 16 originals about 16,100, about 1,000 a hash. The index the
stops-ahead count reads, `stops_ahead_by_account`, is inside the stops' figure: it holds the stops ahead and no
carried stop, 122,880 bytes for the 1,600 laid. Before this build the fixture kept the message on every row it
stopped, as the schema then had it, and measured about 104,000 bytes for a stop of 100 and about 34,000 for a stop
ahead of 16.

None of these figures is a time or a rate: neither kind measures how long a stop takes to process, or how many a
minute the service sustains.

At the bounds: an account's 32 stops ahead that still count are 32 rows, about 28,500 bytes at this fixture's 891 a
row, before their messages and lines; a stop of carried orders is bounded by the orders stopped, one row each,
about 296 bytes on top of each stopped order's 1,306, and one message row a message, about 9,500 bytes for one of
a hundred hashes.

### The shape this build does not yet write

A Cross sent, with its transaction, its receipt and its lines, is written by no build yet: this build closes a Cross
not sent, with its legs and one line. Measured from fixture rows the same test lays in the schema's shape: every column as the schema has it, and the free parts (a line's `facts`, a Cross's `node_answer`, both
`jsonb`) holding what this fixture puts there, small objects of a few fields. These are fixture figures, to be read
again from real rows once the sender's build writes them.

| shape | rows | bytes with indexes |
| -- | -- | -- |
| a 40-leg Cross | one `crosses` row, confirmed, with its transaction, receipt and final block; 40 `legs` rows with the stakes expected and recorded; three lines (sent, pending, confirmed). The bet's own row and line are the order's figures above | about 970 for the Cross, 13,200 for the legs (330 a leg), 1,050 for the lines: about 15,200 |

A 40-leg Cross adds about 15 KB to its bet's 1.3 KB, which at the courier's budget refilling all day with every
admitted request a 40-leg bet would be about 1.3 GB a day, the largest shape at the budget's rate and not a
forecast.
