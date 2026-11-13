// The bounds on the rows in hand, all settings, published with their values
// on the status address; and the one limit kept in memory, the requests from
// one network address, which bounds traffic and nothing durable: the courier
// keeps no log of addresses.

export const BOUNDS = {
  /** An order post's body, and a stop's, in bytes. */
  orderBodyBytes: 8 * 1024,
  stopBodyBytes: 32 * 1024,
  /** Hashes in one stop; originals in one stop. */
  hashesInStop: 100,
  originalsInStop: 16,
  /** Requests from one network address, a minute; counted in memory, each process its own. */
  requestsPerAddressPerMinute: 600,
  /** Admitted requests: one account, and all accounts together. A bucket, and its refill a minute. */
  accountBudget: { atOnce: 240, perMinute: 12 },
  courierBudget: { atOnce: 2400, perMinute: 60 },
  /** Live quotes, one account, one side of one market. */
  liveQuotesPerAccountSideMarket: 16,
  /** Bets waiting their turn: a count and never a clock. */
  betsWaiting: { perAccount: 2, all: 32 },
  /** Stops ahead whose orders have not expired, one account. */
  stopsAheadPerAccount: 32,
  /** Rows returned from the book's index for one bet or one page; quotes examined for one bet; quotes listed in one Cross. Counts of rows, not of the work the database does to return them. */
  scanRows: 2000,
  quotesExamined: 200,
  quotesListed: 40,
  /** A page of a market's quotes, a side; a page of markets, fills, incidents or runs. */
  pageQuotesPerSide: 50,
  page: 100,
} as const;

export interface AddressLimiter {
  /** Takes one request from the address's minute. Refused when the address has made its limit in the last minute. */
  take(address: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
  /** How many addresses hold a request in the last minute: what is kept, and all that is. */
  addresses(): number;
  /** Removes every address whose minute is empty. Run at every take and on the clock; here for the tests. */
  sweep(): void;
  /** Stops the clock. */
  close(): void;
}

/**
 * A sliding minute per address, in memory: the times of its requests in the
 * last 60 seconds. Nothing durable, and nothing kept once an address's minute
 * is empty: an address leaves the map when its minute has passed, whether or
 * not it is seen again, at the next request from any address and on a clock,
 * so the map holds a minute's addresses and no more. The addresses are kept
 * in the order of their last request taken, so a sweep reads from the front
 * and stops at the first whose minute still holds one.
 */
export function createAddressLimiter(perMinute: number, now: () => number = Date.now, sweepEveryMs = 15_000): AddressLimiter {
  const windows = new Map<string, number[]>();
  const sweep = () => {
    const since = now() - 60_000;
    for (const [address, times] of windows) {
      if ((times[times.length - 1] ?? 0) > since) break;
      windows.delete(address);
    }
  };
  const clock = sweepEveryMs > 0 ? setInterval(sweep, sweepEveryMs) : null;
  clock?.unref();
  return {
    take(address) {
      sweep();
      const t = now();
      const since = t - 60_000;
      let times = windows.get(address);
      if (times !== undefined) {
        let drop = 0;
        while (drop < times.length && (times[drop] as number) <= since) drop++;
        if (drop > 0) times.splice(0, drop);
        if (times.length === 0) windows.delete(address), (times = undefined);
      }
      if (times !== undefined && times.length >= perMinute) {
        // Refused: no request is added, and the address keeps its place, which is that of its last request taken.
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((times[0] as number) + 60_000 - t) / 1000)) };
      }
      // Taken: the address moves to the end, as the one with the newest request.
      windows.delete(address);
      if (times === undefined) windows.set(address, [t]);
      else {
        times.push(t);
        windows.set(address, times);
      }
      return { allowed: true };
    },
    addresses() {
      return windows.size;
    },
    sweep,
    close() {
      if (clock !== null) clearInterval(clock);
    },
  };
}

export interface Counters {
  count(code: string): void;
  /** Each code and how many times it was answered since this process started. */
  snapshot(): Record<string, number>;
  since: Date;
}

/** This run's counts of requests refused before admission, by code, in memory. */
export function createCounters(now: () => Date = () => new Date()): Counters {
  const counts = new Map<string, number>();
  return {
    since: now(),
    count(code) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    },
    snapshot() {
      return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
  };
}
