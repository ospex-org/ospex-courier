# The cost of the book's scan, measured

What one request to the book costs the database, measured against the three books the plan names, two of them at
two sizes, each in two maintenance states; and the orders table's maintenance settings, chosen with the figures in
view.
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

## The growth

From the same run: an orders row with its indexes is about 1,000 bytes (927 before the index on the game's markets
was added), an events line about 306, so an admitted order, one row and one line, is about 1,306 bytes. At the
courier's budget refilling all day (86,400 admitted a day) that is about 113 MB a day, 41 GB a year; at one maker's
defaults (13 games, 3 markets, 2 sides, re-signed every 10 minutes: 11,232 orders a day) about 15 MB a day, 5.4 GB
a year. The status address computes the same from the database it has, once a table holds a thousand rows or more.

### The three shapes this build does not yet write

Measured from fixture rows the same test lays in the frozen schema's shape: every column as the schema has it,
and the free parts (a line's `facts`, a Cross's `node_answer`, both `jsonb`) holding what this fixture puts there,
small objects of a few fields. These are fixture figures, to be read again from real rows once the stop build and
the sender build write them; the status address will then serve them under `database.tables` as it serves the
orders table's.

| shape | rows | bytes with indexes |
| -- | -- | -- |
| a stop of 100 carried hashes | 100 `stops` rows, each carrying the message as received (100 hashes, about 7 KB as JSON, stored compressed) and its signature; one `stop received` line | about 104,000 for the rows (1,040 a row) and about 200 for the line |
| a stop ahead of 16 originals | 16 `stops` rows, each with the message of 16 hashes, the signed original and its expiry; one line | about 34,000 for the rows (2,140 a row) and about 200 for the line |
| a 40-leg Cross | one `crosses` row, confirmed, with its transaction, receipt and final block; 40 `legs` rows with the stakes expected and recorded; three lines (sent, pending, confirmed). The bet's own row and line are the order's figures above | about 970 for the Cross, 13,200 for the legs (330 a leg), 1,050 for the lines: about 15,200 |

What the first row says about the schema's shape: a stop's message is kept once for every hash it stops, so a
stop of 100 hashes keeps its message a hundred times over, about 100 KB a stop against about 1.3 KB an order.
That is the frozen schema measured as it stands, and these notes stop there. At the bounds: an account's 32 stops
ahead whose orders have not expired are 32 rows (the bound is on stopped hashes, one row each, not on groups of
sixteen), about 68 KB at this fixture's 2,140 bytes a row, before their lines; a stop of carried orders is bounded
by the orders stopped, one row each, about 1,040
bytes on top of each stopped order's 1,306; a 40-leg Cross adds about 15 KB to its bet's 1.3 KB, which at the
courier's budget refilling all day with every admitted request a 40-leg bet would be about 1.3 GB a day, the
largest shape at the budget's rate and not a forecast.
