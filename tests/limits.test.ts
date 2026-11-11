import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOUNDS, createAddressLimiter, createCounters } from '../courier/http/limits';

// The published bounds, pinned to the plan's numbers; and the one limit kept
// in memory, the requests from one network address.

test('the bounds are the plan\'s numbers', () => {
  assert.deepEqual(BOUNDS, {
    orderBodyBytes: 8192,
    stopBodyBytes: 32768,
    hashesInStop: 100,
    originalsInStop: 16,
    requestsPerAddressPerMinute: 600,
    accountBudget: { atOnce: 240, perMinute: 12 },
    courierBudget: { atOnce: 2400, perMinute: 60 },
    liveQuotesPerAccountSideMarket: 16,
    betsWaiting: { perAccount: 2, all: 32 },
    stopsAheadPerAccount: 32,
    scanRows: 2000,
    quotesExamined: 200,
    quotesListed: 40,
    pageQuotesPerSide: 50,
    page: 100,
  });
});

test('an address has its minute: the limit allowed, the next refused, and the minute slides', () => {
  let t = 1_000_000;
  const limiter = createAddressLimiter(600, () => t);
  for (let i = 0; i < 600; i++) {
    assert.deepEqual(limiter.take('10.0.0.1'), { allowed: true }, `request ${i + 1}`);
    t += 10;
  }
  const refused = limiter.take('10.0.0.1');
  assert.ok(!refused.allowed);
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60, String(refused.retryAfterSeconds));
  // Another address is not touched by the first one's minute.
  assert.deepEqual(limiter.take('10.0.0.2'), { allowed: true });
  // Once the first request is a minute old, one more is allowed, and only one.
  t = 1_000_000 + 60_000 + 1;
  assert.deepEqual(limiter.take('10.0.0.1'), { allowed: true });
  assert.ok(!limiter.take('10.0.0.1').allowed);
  // A whole minute later the address starts again.
  t += 61_000;
  assert.deepEqual(limiter.take('10.0.0.1'), { allowed: true });
});

test('the counters count by code and report in order', () => {
  const counters = createCounters(() => new Date('2026-11-11T00:00:00Z'));
  counters.count('NOT_FOUND');
  counters.count('HTTPS_REQUIRED');
  counters.count('NOT_FOUND');
  assert.deepEqual(counters.snapshot(), { HTTPS_REQUIRED: 1, NOT_FOUND: 2 });
  assert.equal(counters.since.toISOString(), '2026-11-11T00:00:00.000Z');
});
