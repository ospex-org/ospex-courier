import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOUNDS, createAddressLimiter, createCounters, TIMEOUTS } from '../courier/http/limits';

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
  assert.deepEqual(TIMEOUTS, { requestMs: 10_000, headersMs: 10_000, checkEveryMs: 1_000 }, 'the server waits ten seconds for a request to arrive whole, and looks every second');
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

test("an address whose minute has passed leaves the map whether or not it is seen again: 2,000 addresses, one request each; within the minute every one is kept; the minute passes, and the clock removes them with no request made; without a clock, any other address's request does", async () => {
  let t = 2_000_000;
  const address = (i: number) => `10.1.${Math.floor(i / 256)}.${i % 256}`;
  // The clock every 20 ms of real time, reading the test's own time.
  const limiter = createAddressLimiter(600, () => t, 20);
  try {
    for (let i = 0; i < 2_000; i++) assert.deepEqual(limiter.take(address(i)), { allowed: true });
    assert.equal(limiter.addresses(), 2_000);
    t += 30_000;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(limiter.addresses(), 2_000, 'within the minute every address is kept');
    assert.deepEqual(limiter.take('10.2.0.1'), { allowed: true });
    assert.equal(limiter.addresses(), 2_001);
    t += 30_001;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(limiter.addresses(), 1, 'the 2,000 whose minute has passed are gone on the clock; the one whose minute still holds a request stands');
  } finally {
    limiter.close();
  }
  const noClock = createAddressLimiter(600, () => t, 0);
  for (let i = 0; i < 2_000; i++) noClock.take(address(i));
  t += 60_001;
  assert.equal(noClock.addresses(), 2_000, 'no clock and no request yet: nothing has looked');
  assert.deepEqual(noClock.take('10.4.0.1'), { allowed: true });
  assert.equal(noClock.addresses(), 1, "another address's request removed the 2,000");
  // A refused request adds nothing and moves nothing: the address leaves when its last taken request is a minute old.
  const strict = createAddressLimiter(2, () => t, 0);
  strict.take('a');
  t += 1_000;
  strict.take('b');
  strict.take('b');
  assert.ok(!strict.take('b').allowed);
  t += 59_001;
  assert.equal(strict.addresses(), 2);
  strict.sweep();
  assert.equal(strict.addresses(), 1, "a's minute passed; b's last taken request is 59 seconds old");
  t += 1_000;
  strict.sweep();
  assert.equal(strict.addresses(), 0);
  noClock.close();
  strict.close();
});

test('the counters count by code and report in order', () => {
  const counters = createCounters(() => new Date('2026-11-11T00:00:00Z'));
  counters.count('NOT_FOUND');
  counters.count('HTTPS_REQUIRED');
  counters.count('NOT_FOUND');
  assert.deepEqual(counters.snapshot(), { HTTPS_REQUIRED: 1, NOT_FOUND: 2 });
  assert.equal(counters.since.toISOString(), '2026-11-11T00:00:00.000Z');
});
