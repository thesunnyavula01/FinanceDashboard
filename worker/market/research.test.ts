import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { AlpacaProvider } from "./alpaca.ts";
import { EdgarProvider } from "./edgar.ts";
import { FinnhubProvider } from "./finnhub.ts";
import { GdeltProvider } from "./gdelt.ts";
import { HackerNewsProvider } from "./hackernews.ts";
import { MarketDataError, type NewsItem } from "./provider.ts";
import { forgetResearch, loadResearch, mergeHeadlines } from "./research.ts";
import { forgetSecurities, getSecurities } from "./securities.ts";
import { forgetShards } from "./universe.ts";
import type { Env } from "../types.ts";

/**
 * A research panel can look healthy while silently repeating 100 upstream
 * requests, hiding a failed source, or searching a ticker as a company name.
 * These tests exercise the real aggregation and cache across those boundaries.
 * Provider parsing has separate fetch-fixture tests beside each adapter.
 *
 * Run with: npm test
 */

const AT = "2026-09-05T14:00:00.000Z";

function story(provider: NewsItem["provider"], overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    headline: `${provider} headline`, summary: "A plain summary.",
    url: `https://${provider}.example/story`, source: provider, provider,
    tier: provider === "gdelt" ? "WEB" : "WIRE", publishedAt: AT, paywalled: false,
    ...overrides,
  };
}

async function fixture(run: (f: {
  env: Env; calls: Map<string, string[]>; failed: Set<string>;
  setEmpty: () => void; setProfile: (name: string | null) => void; advance: (ms: number) => void;
}) => Promise<void>) {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let now = Date.parse(AT);
  let empty = false;
  let profileName: string | null = "Apple Inc.";
  const calls = new Map<string, string[]>();
  const failed = new Set<string>();
  const record = (key: string, query: string) => {
    const rows = calls.get(key) ?? [];
    rows.push(query);
    calls.set(key, rows);
    if (failed.has(key)) throw new MarketDataError(key, "Fixture upstream unavailable.");
  };
  const env = {
    SUPABASE_URL: "", ALPACA_API_KEY_ID: "test", ALPACA_API_SECRET_KEY: "test",
    FINNHUB_API_KEY: "test", SEC_CONTACT: "club@school.edu",
    QUOTES: { get: async () => null },
  } as unknown as Env;
  try {
    forgetResearch(); forgetSecurities(); forgetShards();
    Date.now = () => now;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: undefined });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith("/stock/profile2"), `Unexpected fetch: ${url.pathname}`);
      record("profile", url.searchParams.get("symbol") ?? "");
      return new Response(JSON.stringify({ ticker: "AAPL", name: profileName, finnhubIndustry: "Technology" }));
    }) as typeof fetch;
    mock.method(AlpacaProvider.prototype, "news", async (symbols: string[]) => {
      record("alpaca", symbols.join(",")); return empty ? [] : [story("alpaca", { headline: `${symbols[0]} price news` })];
    });
    mock.method(FinnhubProvider.prototype, "news", async (symbol: string) => {
      record("finnhub", symbol); return empty ? [] : [story("finnhub", { headline: `${symbol} earnings news` })];
    });
    mock.method(FinnhubProvider.prototype, "earnings", async (symbol: string) => {
      record("earnings", symbol); return empty ? [] : [{ period: "2026-06-30", quarter: 2, year: 2026, estimate: 1.1, actual: 1.2, surprisePercent: 9.09, source: "finnhub" }];
    });
    mock.method(GdeltProvider.prototype, "news", async (name: string) => {
      record("gdelt", name); return empty ? [] : [story("gdelt", { headline: `${name} stock news` })];
    });
    mock.method(HackerNewsProvider.prototype, "discussion", async (name: string) => {
      record("hackernews", name); return empty ? [] : [{ id: "42", title: `${name} company discussion`, url: "https://news.example/apple", commentsUrl: "https://news.ycombinator.com/item?id=42", score: 20, comments: 4, publishedAt: AT }];
    });
    mock.method(EdgarProvider.prototype, "filings", async (symbol: string) => {
      record("filings", symbol); return empty ? [] : [{ form: "10-Q", title: "Quarterly report", filedAt: "2026-08-01", url: "https://www.sec.gov/Archives/report.htm" }];
    });
    mock.method(EdgarProvider.prototype, "earnings", async (symbol: string) => {
      record("facts", symbol); return empty ? [] : [{ period: "2026-06-30", quarter: 2, year: 2026, estimate: null, actual: 1.2, surprisePercent: null, source: "edgar" }];
    });
    await run({ env, calls, failed, setEmpty: () => { empty = true; }, setProfile: (name) => { profileName = name; }, advance: (ms) => { now += ms; } });
  } finally {
    mock.restoreAll();
    globalThis.fetch = savedFetch;
    Date.now = savedNow;
    if (savedCaches) Object.defineProperty(globalThis, "caches", savedCaches);
    else Reflect.deleteProperty(globalThis, "caches");
    forgetResearch(); forgetSecurities(); forgetShards();
  }
}

test("one syndicated story keeps the earliest complete row across three providers", () => {
  const rows = mergeHeadlines([
    story("alpaca", { url: "https://www.publisher.example/story?utm=a", headline: "Later wire", publishedAt: "2026-09-05T15:00:00Z" }),
    story("finnhub", { url: "http://publisher.example/story/#section", headline: "Original wire", publishedAt: "2026-09-05T13:00:00Z" }),
    story("gdelt", { url: "https://publisher.example/story?tracking=b", headline: "Web copy" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.headline, "Original wire");
  assert.equal(rows[0]?.provider, "finnhub");
  assert.equal(rows[0]?.publishedAt, "2026-09-05T13:00:00.000Z");
});

test("markup is plain text and unsafe story links never cross the response boundary", () => {
  const rows = mergeHeadlines([
    story("alpaca", { summary: "<p>Sales <b>rose</b> &amp; costs fell.</p><script>evil()</script>" }),
    story("finnhub", { url: "javascript:alert(1)" }),
    story("gdelt", { url: "data:text/html,unsafe" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.summary, "Sales rose & costs fell.");
});

test("distinct Finnhub redirect article ids survive while tracking copies still merge", () => {
  const rows = mergeHeadlines([
    story("finnhub", { url: "https://finnhub.io/api/news?id=101&utm_source=feed", headline: "Original one", publishedAt: "2026-09-05T13:00:00Z" }),
    story("finnhub", { url: "https://finnhub.io/api/news?id=102", headline: "Article two" }),
    story("alpaca", { url: "https://finnhub.io/api/news?utm_source=copy&id=101#top", headline: "Later copy" }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.headline), ["Article two", "Original one"]);
});

test("wire and web keep their tiers and paywalled domains lose timestamp ties", () => {
  const rows = mergeHeadlines([
    story("alpaca", { url: "https://www.wsj.com/story" }),
    story("gdelt", { url: "https://tech.example/story" }),
    story("finnhub", { url: "https://ft.com/another" }),
  ]);
  assert.deepEqual(rows.map((row) => row.paywalled), [false, true, true]);
  assert.equal(rows[0]?.tier, "WEB");
  assert.ok(rows.slice(1).every((row) => row.tier === "WIRE"));
});

test("a hundred cold readers share profile resolution and every upstream inside the TTL", async () => {
  await fixture(async ({ env, calls }) => {
    const results = await Promise.all(Array.from({ length: 100 }, () => loadResearch(env, " aapl ")));
    await loadResearch(env, "AAPL");
    assert.equal(results[0]?.name, "Apple Inc.");
    assert.deepEqual(calls.get("profile"), ["AAPL"]);
    for (const source of ["alpaca", "finnhub", "earnings", "filings", "gdelt", "hackernews"]) assert.equal(calls.get(source)?.length, 1, source);
    assert.deepEqual(calls.get("gdelt"), ["Apple Inc."]);
    assert.deepEqual(calls.get("hackernews"), ["Apple Inc."]);
    assert.equal(results[0]?.headlines.length, 3);
  });
});

test("Tesla research rejects unrelated provider-tagged headlines and discussion titles even from a warm cache", async () => {
  await fixture(async ({ env, setProfile, calls }) => {
    setProfile("Tesla Inc.");
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
      match: async (key: string) => stored.has(key) ? new Response(stored.get(key)) : undefined,
      put: async (key: string, response: Response) => { stored.set(key, await response.text()); },
    } } });
    await loadResearch(env, "TSLA");
    const replace = (kind: string, items: unknown[]) => {
      const key = `https://research-cache.invalid/v1/${encodeURIComponent(`${kind}/TSLA`)}`;
      const entry = JSON.parse(stored.get(key)!);
      entry.value.value.items = items;
      stored.set(key, JSON.stringify(entry));
    };
    replace("wire", [
      story("finnhub", { headline: "Prediction: Amazon Will Join the $4 Trillion Club", summary: "Amazon stock has underperformed the S&P 500.", url: "https://finnhub.io/api/news?id=amazon" }),
      story("alpaca", { headline: "Amazon expands its stores", summary: "Tesla appears in a list of other market movers.", url: "https://benzinga.com/amazon" }),
      story("alpaca", { headline: "Tesla deliveries increase", url: "https://benzinga.com/tesla" }),
    ]);
    replace("web", [
      story("gdelt", { headline: "Amazon AWS introduces a new service", url: "https://publisher.example/tesla-tag" }),
      story("gdelt", { headline: "Tesla and Amazon compare autonomous fleets", url: "https://publisher.example/comparison" }),
    ]);
    replace("social", [
      { id: "99", title: "Amazon cloud price changes", url: "https://publisher.example/tesla", commentsUrl: "https://news.ycombinator.com/item?id=99", score: 5, comments: 2, publishedAt: AT },
    ]);
    const before = [...calls].map(([key, values]) => [key, values.length]);
    forgetResearch();
    const result = await loadResearch(env, "TSLA");
    assert.deepEqual(result.headlines.map((row) => row.headline).sort(), ["Tesla and Amazon compare autonomous fleets", "Tesla deliveries increase"]);
    assert.deepEqual(result.discussion, []);
    assert.deepEqual(result.missing, []);
    assert.ok(result.sources.includes("hackernews"), "irrelevant results mean empty coverage, not an outage");
    assert.deepEqual([...calls].map(([key, values]) => [key, values.length]), before, "warm reads make no additional upstream requests");
  });
});

test("a research read joins the asset card's in-flight profile enrichment", async () => {
  await fixture(async ({ env, calls }) => {
    const work: Promise<unknown>[] = [];
    await getSecurities(env, ["AAPL"], (promise) => work.push(promise));
    const result = await loadResearch(env, "AAPL");
    await Promise.all(work);
    assert.equal(result.name, "Apple Inc.");
    assert.equal(calls.get("profile")?.length, 1);
  });
});

test("a failed profile is tried once and does not poison keyword caches with its ticker", async () => {
  await fixture(async ({ env, calls, failed }) => {
    failed.add("profile");
    const first = await loadResearch(env, "AAPL");
    assert.equal(calls.get("profile")?.length, 1);
    assert.equal(calls.has("gdelt"), false);
    assert.deepEqual(first.sectionMissing.discussion, ["hackernews"]);
    failed.delete("profile");
    const recovered = await loadResearch(env, "AAPL");
    assert.equal(recovered.name, "Apple Inc.");
    assert.deepEqual(calls.get("gdelt"), ["Apple Inc."]);
    assert.deepEqual(recovered.missing, []);
  });
});

test("a dead provider degrades to the rest and is not retried by every arriving member", async () => {
  await fixture(async ({ env, calls, failed, advance }) => {
    failed.add("gdelt");
    const first = await loadResearch(env, "AAPL");
    const second = await loadResearch(env, "AAPL");
    assert.deepEqual(first.missing, ["gdelt"]);
    assert.deepEqual(second.sources, ["alpaca", "finnhub", "edgar", "hackernews"]);
    assert.equal(second.headlines.length, 2);
    assert.equal(calls.get("gdelt")?.length, 1);
    advance(60_001);
    failed.delete("gdelt");
    const recovered = await loadResearch(env, "AAPL");
    assert.deepEqual(recovered.missing, []);
    assert.equal(calls.get("gdelt")?.length, 2);
    assert.equal(calls.get("alpaca")?.length, 1);
  });
});

test("one failed method remains missing when another method from the provider works", async () => {
  await fixture(async ({ env, failed }) => {
    failed.add("earnings");
    const result = await loadResearch(env, "AAPL");
    assert.ok(result.sources.includes("finnhub"));
    assert.ok(result.missing.includes("finnhub"));
    assert.deepEqual(result.sectionMissing.headlines, []);
    assert.deepEqual(result.sectionMissing.earnings, ["finnhub"]);
    assert.equal(result.earnings[0]?.source, "edgar");
    assert.equal(result.earnings[0]?.estimate, null);
  });
});

test("every provider dead throws and failure caches still throw on the next read", async () => {
  await fixture(async ({ env, calls, failed }) => {
    for (const name of ["alpaca", "finnhub", "earnings", "facts", "filings", "gdelt", "hackernews"]) failed.add(name);
    await assert.rejects(loadResearch(env, "AAPL"), MarketDataError);
    await assert.rejects(loadResearch(env, "AAPL"), MarketDataError);
    for (const name of failed) assert.equal(calls.get(name)?.length, 1, name);
  });
});

test("successful empty results are negative-cached beyond the normal news and web TTLs", async () => {
  await fixture(async ({ env, calls, setEmpty, advance }) => {
    setEmpty();
    const first = await loadResearch(env, "AAPL");
    advance(20 * 60_000);
    const second = await loadResearch(env, "AAPL");
    assert.deepEqual(first.headlines, []);
    assert.deepEqual(second.missing, []);
    for (const name of ["alpaca", "finnhub", "gdelt", "hackernews"]) assert.equal(calls.get(name)?.length, 1, name);
  });
});

test("news expiration leaves web, discussion, earnings and filings on their own TTLs", async () => {
  await fixture(async ({ env, calls, advance }) => {
    await loadResearch(env, "AAPL");
    advance(5 * 60_000 + 1);
    await loadResearch(env, "AAPL");
    assert.equal(calls.get("alpaca")?.length, 2);
    assert.equal(calls.get("finnhub")?.length, 2);
    for (const name of ["gdelt", "hackernews", "earnings", "filings"]) assert.equal(calls.get(name)?.length, 1, name);
    advance(5 * 60_000);
    await loadResearch(env, "AAPL");
    assert.equal(calls.get("hackernews")?.length, 2);
    assert.equal(calls.get("gdelt")?.length, 1);
    advance(5 * 60_000);
    await loadResearch(env, "AAPL");
    assert.equal(calls.get("gdelt")?.length, 2);
    assert.equal(calls.get("earnings")?.length, 1);
    assert.equal(calls.get("filings")?.length, 1);
  });
});

test("an OCC contract and its underlying share the same research and profile cache", async () => {
  await fixture(async ({ env, calls }) => {
    const [option, equity] = await Promise.all([loadResearch(env, "aapl260918c00150000"), loadResearch(env, "AAPL")]);
    assert.equal(option.symbol, "AAPL");
    assert.equal(option.assetClass, "EQUITY");
    assert.deepEqual(option, equity);
    assert.deepEqual(calls.get("profile"), ["AAPL"]);
    assert.deepEqual(calls.get("filings"), ["AAPL"]);
  });
});

test("filings expire after six hours while quarterly earnings remain cached for twelve", async () => {
  await fixture(async ({ env, calls, advance }) => {
    await loadResearch(env, "AAPL");
    advance(6 * 60 * 60_000 + 1);
    await loadResearch(env, "AAPL");
    assert.equal(calls.get("filings")?.length, 2);
    assert.equal(calls.get("earnings")?.length, 1);
    advance(6 * 60 * 60_000);
    await loadResearch(env, "AAPL");
    assert.equal(calls.get("earnings")?.length, 2);
  });
});

test("a crypto pair never requests a company profile, earnings or SEC filings", async () => {
  await fixture(async ({ env, calls }) => {
    const result = await loadResearch(env, " btc/usd ");
    assert.equal(result.symbol, "BTC/USD");
    assert.equal(result.assetClass, "CRYPTO");
    assert.deepEqual(result.earnings, []);
    assert.deepEqual(result.filings, []);
    for (const name of ["profile", "earnings", "facts", "filings"]) assert.equal(calls.has(name), false, name);
    assert.equal(result.sources.includes("edgar"), false);
    assert.deepEqual(calls.get("alpaca"), ["BTC/USD"]);
  });
});

test("a fresh isolate reuses the edge cache and encodes a crypto slash inside its key", async () => {
  await fixture(async ({ env, calls }) => {
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
      match: async (key: string) => stored.has(key) ? new Response(stored.get(key)) : undefined,
      put: async (key: string, response: Response) => { stored.set(key, await response.text()); },
    } } });
    await loadResearch(env, "BTC/USD");
    forgetResearch();
    await loadResearch(env, "BTC/USD");
    assert.equal(calls.get("alpaca")?.length, 1);
    assert.ok([...stored.keys()].some((key) => key === "https://research-cache.invalid/v1/wire%2FBTC%2FUSD"));
  });
});

test("edge-cache exceptions are misses and never turn a working source into an outage", async () => {
  await fixture(async ({ env }) => {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
      match: async () => { throw new Error("cache read"); },
      put: async () => { throw new Error("cache write"); },
    } } });
    const result = await loadResearch(env, "AAPL");
    assert.equal(result.headlines.length, 3);
    assert.deepEqual(result.missing, []);
  });
});

test("a malformed edge-cache body is a miss rather than a successful broken fragment", async () => {
  await fixture(async ({ env }) => {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
      match: async () => new Response(JSON.stringify({ expiresAt: Date.now() + 60_000, value: { ok: true } })),
      put: async () => {},
    } } });
    const result = await loadResearch(env, "AAPL");
    assert.equal(result.headlines.length, 3);
    assert.deepEqual(result.missing, []);
  });
});
