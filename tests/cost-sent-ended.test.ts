import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { noSeqScanOnOrders, openSentCost, sameAtBothSizes, summary, type Measured, type SentCost } from './support/sentcost';

// One sent bet's statements, measured, each from its own EXPLAIN (ANALYZE, BUFFERS) (tests/support/sentcost.ts), on
// the book ended by the mark: the bet sent end to end on 50,000 and 500,000 orders ended by the mark, ahead of ten live
// quotes, before vacuum, with the dead versions the mark leaves, and after. A file of its own, beside the small book and
// the backlog (tests/cost-sent.test.ts), so that neither file runs near the test's time-out on a busy machine. On the
// book of 500,000 no statement reads more of the orders table by a sequential scan than a request's own bound of rows;
// at 50,000 each such read is reported. After vacuum, each statement that reads the orders table and walks the same
// indexes at both sizes reads at 500,000 what it reads at 50,000, within one page a level of each index for each walk it
// makes of it; a statement planned otherwise at the two sizes is reported. The figures are printed for docs/COST.md, and
// read there as this machine's.

let cost: SentCost;

before(async () => {
  cost = await openSentCost('cost_sent_ended');
});

after(() => cost?.close());

const ENDED: Record<number, { after: Measured; levels: Record<string, number> }> = {};
for (const [k, n] of [50_000, 500_000].entries()) {
  test(`one sent bet on the book of ${n.toLocaleString('en-US')} orders ended by the mark, ahead of ten live quotes: before vacuum, with the dead versions the mark leaves, and after; through the indexes${n === 500_000 ? ', and after vacuum the same at both sizes within one page a level of each index' : ''}; printed for the cost page`, async () => {
    const { pool } = cost;
    const base = 100_000_000 * (k + 1);
    const book = await cost.bookOf(`ended ${n}`, 10);
    // At a better price, expired, then marked as the courier's own statement marks: one dead version a quote, in the
    // table and in the book's index, ahead of the live quotes.
    await cost.lay(book, n, 200, 1n, base);
    const marked = await pool.query(`UPDATE orders SET ended = 'expired', ended_at = now() WHERE market_key = $1 AND odds_tick = 200 AND ended IS NULL`, [book.market]);
    assert.equal(marked.rowCount, n);
    const before_ = await cost.sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(before_, `ended ${n}, before vacuum`);
    // After vacuum: the whole database, with no other transaction open.
    await pool.query('VACUUM (INDEX_CLEANUP ON)');
    const after_ = await cost.sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(after_, `ended ${n}, after vacuum`);
    ENDED[n] = { after: after_, levels: await cost.levels() };
    cost.report[`ended ${n}`] = { before: summary(before_), after: summary(after_), levels: ENDED[n]?.levels };
    if (n === 500_000) {
      const otherwise: unknown[] = [];
      (cost.report[`ended ${n}`] as Record<string, unknown>).bothSizesAfterVacuum = sameAtBothSizes('ended', (ENDED[50_000] as { after: Measured }).after, after_, (ENDED[50_000] as { levels: Record<string, number> }).levels, ENDED[n]?.levels ?? {}, otherwise);
      (cost.report[`ended ${n}`] as Record<string, unknown>).plannedOtherwise = otherwise;
    }
    await cost.clear(base);
  });
}
