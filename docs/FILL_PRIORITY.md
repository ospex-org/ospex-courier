# The fill-priority rule

How the courier orders the quotes of one side of one market: the order a bet meets them in, and the order the book
shows them in. The rule, as published:

> For a bet, the courier lists the quotes on the other side of the same market whose price meets the bet's. It lists them lowest tick first: against a quote at tick R the bettor stakes R − 100 for every 100 the maker stakes, so the lowest tick is the bettor's best price. Between two quotes at the same tick, the one the courier recorded first comes first: each order is given a number when it is recorded, numbers rise and are never reused, and the lower number wins. The time of receipt is shown beside the number, but the number decides. Nothing else enters: not the account, not the size, not the expiry, not who is asking.
>
> The courier takes at most 2,000 quotes from its book for one bet, in that order, the ones it has not itself marked ended, to find the quotes that are live; it examines at most 200 of those against the chain and lists at most 40 in one Cross, in that same order and no other. A quote behind any of the three bounds is neither listed nor passed over for a later one: the walk ends there. When a bound, and not the book, ended the walk, the answer says so and names the bound.

The record number is the order in which the database took the orders in. Two orders can share a millisecond, and a
clock can step back, but no two orders share a number, so the list is the same after a restart. A quote signed
again is a new order with a new number: a maker that re-signs goes to the back of its price's line each time,
behind any quote at the same price that has stood longer.

## In this build

The book's reads (`GET /v1/book`) list quotes in this order: `orders_book`, the index on `(market_key, side,
odds_tick, record_number)` over the quotes the courier has not marked ended, walked from the start or from a page's
cursor, at most 2,000 rows returned to one request. What is live at the block is passed; what has expired at the
final block is marked, so the next request does not meet it; what only the chain knows is read at the block for the
quotes a page lists: a cancel or a raised floor seen there is marked `cancelled`, and less than a lot of the stake
left is marked `filled`, in the records at that block, so no later request meets them; the relay dropped is not
marked, and such a quote is not listed while it lasts. The walk for a bet, with its 200 and its 40, is the pre-check
build's; it reads the same index in the same order.

The three bounds are settings, published on `GET /v1/status` under `bounds` (`scanRows`, `quotesExamined`,
`quotesListed`). They bound the rows one request is returned, and not the work the database does to return them,
which is measured and published separately (`docs/COST.md`).
