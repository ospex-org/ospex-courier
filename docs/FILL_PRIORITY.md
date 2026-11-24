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
quotes a page lists: a cancel, a version the account has left, a floor above the quote at its version or a grant
that is gone seen there is marked `cancelled`, and less than a lot of the stake
left is marked `filled`, in the records at that block, so no later request meets them; the relay dropped is not
marked, and such a quote is not listed while it lasts.

A bet's check walks the same index in the same order. One statement takes the quotes on the other side of the bet's
market whose tick meets the bet's price, at most 2,000 of them, the ones not marked ended, and marks those whose
expiry has passed at the final block. The chain is then read at the check's block for at most 200 of them, in that
order, and the walk goes down them: a quote not live at that block is passed and marked as the book's reads mark
it, an account's own quote is passed, and each other quote fills what the bet has left, as the contract fills it,
in whole lots, within what its account's wallet can be pulled net of what the account already holds on the market.
A quote whose account cannot be pulled what its leg needs, or whose leg would be under the quote's own minimum, is
passed, as the contract passes it. The walk stops at the bet's stake, at 40 quotes
listed, or at the end of the 200 or the 2,000, and the bet's answer names the bound that ended it where a bound did.

The three bounds are settings, published on `GET /v1/status` under `bounds` (`scanRows`, `quotesExamined`,
`quotesListed`). They bound the rows one request is returned, and not the work the database does to return them,
which is measured and published separately (`docs/COST.md`).
