import test from "node:test";
import assert from "node:assert/strict";
import { parseSymbols, QuoteCache } from "./quotes.ts";
import type { PriceProvider, Quote } from "./provider.ts";
import { fanOut } from "./router.ts";

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
    async intradayBars() {
      return new Map();
    },
    async clock() {
      throw new Error("not used");
    },
    async calendar() {
      return [];
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
    async intradayBars() {
      return new Map();
    },
    async clock() {
      throw new Error("not used");
    },
    async calendar() {
      return [];
    },
    async assets() {
      return [];
    },
  };

  const result = await new QuoteCache({ provider, ttlSeconds: 20, cache: null }).get(["AAPL"]);
  assert.deepEqual(result.unknown, ["AAPL"]);
  assert.equal(result.quotes.size, 0);
});

test("a provider outage retries on the quote interval instead of hiding prices for five minutes", async () => {
  const { provider } = stubProvider();
  const clock = fakeClock();
  let calls = 0;
  provider.quotes = async () => {
    if (++calls === 1) throw new Error("temporary outage");
    return new Map([["AAPL", quote("AAPL", 101)]]);
  };
  const { cache: edge } = stubEdgeCache();
  const first = new QuoteCache({ provider, ttlSeconds: 20, cache: edge, now: clock.now });
  assert.deepEqual((await first.get(["AAPL"])).unknown, ["AAPL"]);
  await first.get(["AAPL"]);
  assert.equal(calls, 1, "failure backs off to avoid a request storm");
  clock.advance(21_000);
  const second = new QuoteCache({ provider, ttlSeconds: 20, cache: edge, now: clock.now });
  assert.equal((await second.get(["AAPL"])).quotes.get("AAPL")?.price, 101);
  assert.equal(calls, 2, "the edge cache must not preserve the outage for five minutes either");
});

test("a failed asset class recovers while genuine missing symbols stay negatively cached", async () => {
  const { provider } = stubProvider();
  const clock = fakeClock();
  let failed = true;
  const batches: string[][] = [];
  provider.quotes = async (symbols) => {
    batches.push(symbols);
    return fanOut(symbols, {
      EQUITY: async () => new Map([["AAPL", quote("AAPL", 100)]]),
      CRYPTO: async () => {
        if (failed) throw new Error("crypto unavailable");
        return new Map([["BTC/USD", quote("BTC/USD", 50_000)]]);
      },
    });
  };
  const cache = new QuoteCache({ provider, ttlSeconds: 20, now: clock.now });
  const symbols = ["AAPL", "ZZZZ", "BTC/USD"];
  const first = await cache.get(symbols);
  assert.equal(first.quotes.get("AAPL")?.price, 100);
  failed = false;
  clock.advance(21_000);
  const next = await cache.get(symbols);
  assert.equal(next.quotes.get("BTC/USD")?.price, 50_000);
  assert.deepEqual(batches[1], ["AAPL", "BTC/USD"]);
  assert.deepEqual(next.unknown, ["ZZZZ"]);
});

for (const size of [83, 300]) {
  test(`${size} symbols fit the 50-subrequest budget and a cold isolate reuses the whole edge batch`, async () => {
    const symbols = Array.from({ length: size }, (_, index) => `SYM${index}`);
    const stored = new Map<string, string>();
    let calls = { match: 0, put: 0, provider: 0 };
    const spend = (kind: keyof typeof calls) => {
      calls[kind] += 1;
      if (calls.match + calls.put + calls.provider > 50) throw new Error("Too many subrequests");
    };
    const edge = {
      async match(key: unknown) {
        spend("match");
        const body = stored.get(String(key));
        return body === undefined ? undefined : new Response(body);
      },
      async put(key: unknown, response: Response) {
        spend("put");
        stored.set(String(key), await response.text());
      },
    } as unknown as Cache;
    const { provider } = stubProvider();
    provider.quotes = async (asked) => {
      // Alpaca's provider batches at 100 symbols. Its fetches consume the same
      // request budget as cache.match/put, even if those cache calls miss.
      for (let offset = 0; offset < asked.length; offset += 100) spend("provider");
      return new Map(asked.map((symbol) => [symbol, quote(symbol, 100)]));
    };
    const clock = fakeClock();
    const first = await new QuoteCache({ provider, ttlSeconds: 20, cache: edge, now: clock.now }).get(symbols);
    assert.equal(first.quotes.size, size, "edge probes must leave enough budget to obtain every price");
    assert.deepEqual(first.unknown, []);
    assert.deepEqual(calls, { match: 1, put: 1, provider: Math.ceil(size / 100) });

    calls = { match: 0, put: 0, provider: 0 };
    const cold = await new QuoteCache({ provider, ttlSeconds: 20, cache: edge, now: clock.now }).get([...symbols].reverse());
    assert.equal(cold.quotes.size, size);
    assert.deepEqual(calls, { match: 1, put: 0, provider: 0 });
    assert.deepEqual(cold.stats, { memory: 0, edge: size, fetched: 0 });
  });
}

test("rebuilding a mixed warm and missing edge batch does not renew older quote observations", async () => {
  const clock = fakeClock();
  const { cache: edge } = stubEdgeCache();
  const first = stubProvider();
  const one = new QuoteCache({ provider: first.provider, ttlSeconds: 20, cache: edge, now: clock.now });
  const original = await one.get(["AAPL"]);
  const firstAt = clock.now();
  clock.advance(10_000);
  const symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOG"];
  const mixed = await one.get(symbols);
  assert.equal(mixed.observedAt.get("AAPL"), original.observedAt.get("AAPL"));
  assert.equal(mixed.observedAt.get("MSFT"), firstAt + 10_000);

  clock.advance(11_000);
  const second = stubProvider();
  const cold = await new QuoteCache({ provider: second.provider, ttlSeconds: 20, cache: edge, now: clock.now }).get(symbols);
  assert.deepEqual(second.batches, [["AAPL"]], "the original mark expires while the later four remain fresh");
  assert.equal(cold.observedAt.get("AAPL"), firstAt + 21_000);
  assert.equal(cold.observedAt.get("MSFT"), firstAt + 10_000);
});

test("batched edge entries retain separate failure and genuine-unknown retry lifetimes", async () => {
  const { cache: edge } = stubEdgeCache();
  const clock = fakeClock();
  const { provider } = stubProvider();
  const batches: string[][] = [];
  let failed = true;
  provider.quotes = async (symbols) => {
    batches.push(symbols);
    return fanOut(symbols, {
      EQUITY: async () => new Map([["AAPL", quote("AAPL", 100)]]),
      CRYPTO: async (asked) => {
        if (failed) throw new Error("temporary crypto outage");
        return new Map(asked.map((symbol) => [symbol, quote(symbol, 100)]));
      },
    });
  };
  const symbols = ["AAPL", "ZZZZ", "BTC/USD", "ETH/USD", "DOGE/USD"];
  const initial = await new QuoteCache({ provider, ttlSeconds: 20, cache: edge, now: clock.now }).get(symbols);
  assert.deepEqual(initial.unknown, ["ZZZZ", "BTC/USD", "ETH/USD", "DOGE/USD"]);
  failed = false;
  clock.advance(21_000);
  const recovered = await new QuoteCache({ provider, ttlSeconds: 20, cache: edge, now: clock.now }).get(symbols);
  assert.deepEqual(batches[1], ["AAPL", "BTC/USD", "ETH/USD", "DOGE/USD"]);
  assert.deepEqual(recovered.unknown, ["ZZZZ"]);
  assert.equal(recovered.quotes.size, 4);
  clock.advance(280_000);
  await new QuoteCache({ provider, ttlSeconds: 20, cache: edge, now: clock.now }).get(symbols);
  assert.ok(batches[2]!.includes("ZZZZ"), "genuine unknowns retry after their own five-minute lifetime");
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
