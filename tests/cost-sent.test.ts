import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { noSeqScanOnOrders, openSentCost, sameAtBothSizes, summary, type Measured, type SentCost } from './support/sentcost';

// One sent bet's statements, measured, each from its own EXPLAIN (ANALYZE, BUFFERS) (tests/support/sentcost.ts), on
// the small book and the backlog: the bet sent end to end on a book of ten live quotes, before and after vacuum; and on
// 50,000 and 500,000 expired quotes not yet marked, behind the bet's live quote, first with the final block held behind
// their expiry while the bet is checked, so that F has not passed them, then with F past them, before vacuum and after.
// The book ended by the mark is in a file of its own (tests/cost-sent-ended.test.ts), so that neither file runs near the
// test's time-out on a busy machine. On the books of 500,000 no statement reads more of the orders table by a
// sequential scan than a request's own bound of rows; at 50,000 the planner may read the whole table where that costs
// less than walking an index a row at a time, and each such read is reported. After vacuum, each statement that reads
// the orders table and walks the same indexes at both sizes reads at 500,000 what it reads at 50,000, within one page a
// level of each index for each walk it makes of it; a statement planned otherwise at the two sizes is reported. The
// figures are printed for docs/COST.md, and read there as this machine's.

let cost: SentCost;

before(async () => {
  cost = await openSentCost('cost_sent');
});

after(() => cost?.close());

test('one sent bet on the small book: ten live quotes, before and after vacuum; printed for the cost page', async () => {
  const book = await cost.bookOf('ten live quotes', 10);
  const before_ = await cost.sendOne(book);
  // After vacuum: the whole database, with no other transaction open.
  await cost.pool.query('VACUUM (INDEX_CLEANUP ON)');
  const after_ = await cost.sendOne(book);
  cost.report.small = { before: summary(before_), after: summary(after_) };
});

const BACKLOG: Record<number, { after: Measured; levels: Record<string, number> }> = {};
for (const [k, n] of [50_000, 500_000].entries()) {
  test(`one sent bet on the book of ${n.toLocaleString('en-US')} expired quotes not yet marked, behind the bet's live quote: with the final block held behind them while the bet is checked, then past them, before vacuum and after; through the indexes${n === 500_000 ? ', and after vacuum the same at both sizes within one page a level of each index' : ''}; printed for the cost page`, async () => {
    const { stack, pool } = cost;
    const base = 100_000_000 * (k + 3);
    const book = await cost.bookOf(`backlog ${n}`, 3);
    // F held at the head; the backlog expires after F's time, so that F has not passed it, and is expired at the
    // latest block before the bet is checked.
    const head = BigInt((await stack.rig.rpc('eth_blockNumber', [])) as string);
    stack.proxy.finalFollows(null);
    stack.proxy.setFinal(head);
    let held: Measured;
    try {
      const at = BigInt(((await stack.rig.rpc('eth_getBlockByNumber', [`0x${head.toString(16)}`, false])) as { timestamp: string }).timestamp);
      await cost.lay(book, n, 204, at + 3n, base);
      await cost.until(() => stack.rig.time(), (t) => t > at + 3n, 30_000, 'the backlog expired at the latest block');
      held = await cost.sendOne(book, {
        sent: () => {
          stack.proxy.setFinal(null);
          stack.proxy.finalFollows(1n);
        },
      });
    } finally {
      stack.proxy.setFinal(null);
      stack.proxy.finalFollows(1n);
    }
    // Nothing of the backlog marked while F had not passed it: the bet's request passed it by.
    const notMarked = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM orders WHERE market_key = $1 AND odds_tick = 204 AND ended IS NULL AND hash > '0x' || lpad(to_hex($2::bigint), 64, '0') AND hash <= '0x' || lpad(to_hex($2::bigint + 99999999), 64, '0')`, [book.market, base]);
    assert.equal(Number(notMarked.rows[0]?.n ?? 0), n, `backlog ${n}: nothing of it marked while F had not passed it`);
    if (n === 500_000) noSeqScanOnOrders(held, `backlog ${n}, F held behind it`);
    const before_ = await cost.sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(before_, `backlog ${n}, F past it, before vacuum`);
    // After vacuum: the whole database, with no other transaction open.
    await pool.query('VACUUM (INDEX_CLEANUP ON)');
    const after_ = await cost.sendOne(book);
    if (n === 500_000) noSeqScanOnOrders(after_, `backlog ${n}, after vacuum`);
    BACKLOG[n] = { after: after_, levels: await cost.levels() };
    cost.report[`backlog ${n}`] = { heldBehind: summary(held), before: summary(before_), after: summary(after_), levels: BACKLOG[n]?.levels };
    if (n === 500_000) {
      const otherwise: unknown[] = [];
      (cost.report[`backlog ${n}`] as Record<string, unknown>).bothSizesAfterVacuum = sameAtBothSizes('backlog', (BACKLOG[50_000] as { after: Measured }).after, after_, (BACKLOG[50_000] as { levels: Record<string, number> }).levels, BACKLOG[n]?.levels ?? {}, otherwise);
      (cost.report[`backlog ${n}`] as Record<string, unknown>).plannedOtherwise = otherwise;
    }
    await cost.clear(base);
  });
}
