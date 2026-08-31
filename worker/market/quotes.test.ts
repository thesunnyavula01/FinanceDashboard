import test from "node:test";
import assert from "node:assert/strict";
import { parseSymbols, QuoteCache } from "./quotes.ts";
import type { PriceProvider, Quote } from "./provider.ts";

/**
 * The cache is the reason a hundred members polling every twenty seconds does
 * not become a hundred requests a second to Alpaca. Every test here is really
 * asking the same question: how many times did we call upstream?
 *
 * Run with: npm test
 */

function quote(symbol: string, price: number): Quote {
  return {
    symbol,
    price,
    source: "trade",
    prevClose: price,
    dayChange: 0,
    dayChangePercent: 0,
    dayOpen: price,
    dayHigh: price,
    dayLow: price,
    dayVolume: 1,
    asOf: "2026-08-28T15:00:00Z",
  };
}

/** Records every batch it is asked for, and can be told to omit symbols. */
function stubProvider(options: { unknown?: string[] } = {}) {
  const batches: string[][] = [];
  const unknown = new Set(options.unknown ?? []);

  const provider: PriceProvider = {
    name: "stub",
    async quotes(symbols) {
      batches.push([...symbols]);
      const out = new Map<string, Quote>();
      for (const symbol of symbols) {
        if (!unknown.has(symbol)) out.set(symbol, quote(symbol, 100));
      }
      return out;
    },
    async dailyBars() {
      return new Map();
    },
    async clock() {
      throw new Error("not used");
    },
    async assets() {
      return [];
    },
  };

  return { provider, batches };
}

/** Stands in for the colo cache. Stores serialised bodies, like the real one. */
function stubEdgeCache() {
  const store = new Map<string, string>();
  const cache = {
    async match(key: unknown) {
      const body = store.get(String(key));
      return body === undefined ? undefined : new Response(body);
    },
    async put(key: unknown, response: Response) {
      store.set(String(key), await response.text());
    },
  };
  return { cache: cache as unknown as Cache, store };
}

/** A clock the test drives by hand, so no test has to actually wait 20s. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("a second request inside the TTL never reaches the provider", async () => {
  const { provider, batches } = stubProvider();
  const clock = fakeClock();
  const cache = new QuoteCache({ provider, ttlSeconds: 20, cache: null, now: clock.now });

  const first = await cache.get(["AAPL", "MSFT"]);
  assert.equal(first.quotes.size, 2);
  assert.equal(batches.length, 1);

  clock.advance(19_000);
  const second = await cache.get(["AAPL", "MSFT"]);

  assert.equal(second.quotes.size, 2);
  assert.equal(batches.length, 1, "still one upstream call");
  assert.deepEqual(second.stats, { memory: 2, edge: 0, fetched: 0 });
});

test("a stale entry is refetched", async () => {
  const { provider, batches } = stubProvider();
  const clock = fakeClock();
  const cache = new QuoteCache({ provider, ttlSeconds: 20, cache: null, now: clock.now });

  await cache.get(["AAPL"]);
  clock.advance(21_000);
  await cache.get(["AAPL"]);

  assert.equal(batches.length, 2);
});

test("only the misses are fetched, not the whole request", async () => {
  const { provider, batches } = stubProvider();
  const clock = fakeClock();
  const cache = new QuoteCache({ provider, ttlSeconds: 20, cache: null, now: clock.now });

  await cache.get(["AAPL", "MSFT"]);
  const second = await cache.get(["AAPL", "MSFT", "NVDA"]);

  assert.equal(second.quotes.size, 3);
  assert.deepEqual(batches[1], ["NVDA"], "the two cached symbols must not be refetched");
  assert.deepEqual(second.stats, { memory: 2, edge: 0, fetched: 1 });
});

test("concurrent requests for a cold symbol share one upstream call", async () => {
  // This is the thundering herd the club will actually produce: everyone opens
  // the dashboard when the bell rings, and the cache is empty.
  const { provider, batches } = stubProvider();
  const cache = new QuoteCache({ provider, ttlSeconds: 20, cache: null });

  const results = await Promise.all([
    cache.get(["AAPL", "MSFT"]),
    cache.get(["AAPL", "MSFT"]),
    cache.get(["AAPL", "MSFT"]),
  ]);

  assert.equal(batches.length, 1, "three simultaneous members, one Alpaca request");
  for (const result of results) assert.equal(result.quotes.size, 2);
});

test("an unpriceable symbol is reported, and remembered so it stops being asked for", async () => {
  const { provider, batches } = stubProvider({ unknown: ["ZZZZ"] });
  const clock = fakeClock();
  const cache = new QuoteCache({ provider, ttlSeconds: 20, cache: null, now: clock.now });

  const first = await cache.get(["AAPL", "ZZZZ"]);
  assert.deepEqual(first.unknown, ["ZZZZ"]);
  assert.equal(first.quotes.has("AAPL"), true);

  // Past the 20s quote TTL but inside the longer negative TTL: the good symbol
  // is refetched, the bad one is not. Without this, one typo in a portfolio
  // polls upstream every twenty seconds for the rest of the season.
  clock.advance(60_000);
  const second = await cache.get(["AAPL", "ZZZZ"]);

  assert.deepEqual(second.unknown, ["ZZZZ"]);
  assert.deepEqual(batches[1], ["AAPL"]);
});

test("the colo cache serves an isolate that has never seen the symbol", async () => {
  const { cache: edge } = stubEdgeCache();
  const clock = fakeClock();

  const first = stubProvider();
  const one = new QuoteCache({
    provider: first.provider,
    ttlSeconds: 20,
    cache: edge,
    now: clock.now,
  });
  await one.get(["AAPL"]);
  assert.equal(first.batches.length, 1);

  // A different isolate in the same data centre: cold memory, warm edge.
  const second = stubProvider();
  const two = new QuoteCache({
    provider: second.provider,
    ttlSeconds: 20,
    cache: edge,
    now: clock.now,
  });
  const result = await two.get(["AAPL"]);

  assert.equal(second.batches.length, 0, "should have come from the shared cache");
  assert.equal(result.quotes.get("AAPL")?.price, 100);
  assert.deepEqual(result.stats, { memory: 0, edge: 1, fetched: 0 });
});

test("an edge entry past its TTL is treated as a miss", async () => {
  const { cache: edge } = stubEdgeCache();
  const clock = fakeClock();

  const first = stubProvider();
  await new QuoteCache({
    provider: first.provider,
    ttlSeconds: 20,
    cache: edge,
    now: clock.now,
  }).get(["AAPL"]);

  clock.advance(21_000);

  const second = stubProvider();
  const result = await new QuoteCache({
    provider: second.provider,
    ttlSeconds: 20,
    cache: edge,
    now: clock.now,
  }).get(["AAPL"]);

  assert.equal(second.batches.length, 1);
  assert.deepEqual(result.stats, { memory: 0, edge: 0, fetched: 1 });
});

test("a failing provider degrades to no price rather than an error", async () => {
  const provider: PriceProvider = {
    name: "broken",
    async quotes() {
      throw new Error("Alpaca is down");
    },
    async dailyBars() {
      return new Map();
    },
    async clock() {
      throw new Error("not used");
    },
    async assets() {
      return [];
    },
  };

  const result = await new QuoteCache({ provider, ttlSeconds: 20, cache: null }).get(["AAPL"]);
  assert.deepEqual(result.unknown, ["AAPL"]);
  assert.equal(result.quotes.size, 0);
});

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

test("symbols are upper-cased, trimmed and deduped", () => {
  const { symbols } = parseSymbols(" aapl , MSFT,aapl,  nvda ");
  assert.deepEqual(symbols, ["AAPL", "MSFT", "NVDA"]);
});

test("malformed tickers are separated out, not fatal", () => {
  const { symbols, rejected } = parseSymbols("AAPL,../etc/passwd,BRK.B,,TOOLONGTICKER1");
  assert.deepEqual(symbols, ["AAPL", "BRK.B"]);
  assert.deepEqual(rejected, ["../ETC/PASSWD", "TOOLONGTICKER1"]);
});

test("the symbol count is capped", () => {
  const many = Array.from({ length: 40 }, (_, i) => `SYM${i}`).join(",");
  const { symbols } = parseSymbols(many, 10);
  assert.equal(symbols.length, 10);
});

test("an empty query yields nothing rather than throwing", () => {
  assert.deepEqual(parseSymbols(null), { symbols: [], rejected: [] });
  assert.deepEqual(parseSymbols(""), { symbols: [], rejected: [] });
  assert.deepEqual(parseSymbols("  ,  ,"), { symbols: [], rejected: [] });
});
