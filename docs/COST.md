# The cost of the book's scan, measured

What one request to the book costs the database, measured against the three books the plan names, two of them at
two sizes, each in two maintenance states; and the orders table's maintenance settings, set from the figures.
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
reads both. Index cleanup: a vacuum left to itself skips the indexes when the dead items are under two per cent of
the table's pages, and leaves their entries standing; the test vacuums with `INDEX_CLEANUP ON`, and the table's
own setting makes autovacuum do the same.

## The maintenance settings, set from the figures

In `db/schema.sql`, on the orders table:

```
autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0,
autovacuum_analyze_threshold = 2000, autovacuum_analyze_scale_factor = 0,
vacuum_index_cleanup = on
```

At Postgres's defaults the table is due for vacuum at 50 dead versions plus a fifth of its rows: at 500,000 rows
that is 100,000 dead, which at 0.025 accesses each is about 2,500 buffer accesses ahead of a scan that costs 166
clean, fifteen times over, and the number grows with the table. At 2,000 the table is due after the most one request
marks, whatever its size; the dead ahead of a scan are then at most a few thousand between vacuums, about 190
accesses over the clean 166, as the third book's before-vacuum row shows. `vacuum_index_cleanup = on` is what makes
each of those vacuums remove the index entries, which is where the cost lives: at 2,000 dead on a table of some
hundred thousand rows the default would skip them every time. The threshold is when the table becomes due, not a
ceiling: autovacuum's workers can be busy elsewhere, and a version an older transaction can still see is not
removed until it cannot. The status address serves the settings as the database holds them.

## The growth

From the same run: an orders row with its indexes is about 927 bytes, an events line about 306, so an admitted
order, one row and one line, is about 1,233 bytes. At the courier's budget refilling all day (86,400 admitted a
day) that is about 107 MB a day, 39 GB a year; at one maker's defaults (13 games, 3 markets, 2 sides, re-signed
every 10 minutes: 11,232 orders a day) about 14 MB a day, 5 GB a year. The status address computes the same from
the database it has, once a table holds a thousand rows or more.
