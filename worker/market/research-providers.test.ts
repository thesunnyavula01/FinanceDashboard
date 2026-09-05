/**
 * News APIs disagree on symbol spelling, timestamps, and whether a result is
 * ticker-matched. Pin those boundaries and keep untrusted markup out of rows.
 * Run with: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AlpacaProvider } from "./alpaca.ts";
import { FinnhubProvider } from "./finnhub.ts";
import { GdeltProvider } from "./gdelt.ts";
import { MarketDataError } from "./provider.ts";
import { normalizeNews, safeExternalUrl, stripMarkup } from "./research-utils.ts";

test("alpaca news uses existing auth, a real lookback, and the news API crypto symbol spelling", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1beta1/news");
    assert.equal(url.searchParams.get("symbols"), "BTCUSD,TSLA");
    assert.ok(Date.parse(url.searchParams.get("start")!) < Date.now() - 6 * 86_400_000);
    assert.equal(new Headers(init?.headers).get("APCA-API-KEY-ID"), "test-key");
    return Response.json({ news: [{ id: 1, headline: "<b>Bitcoin</b> rises", summary: "<p>Wire &amp; detail</p>",
      url: "https://www.benzinga.com/story", source: "Benzinga", created_at: "2026-09-05T12:00:00Z" }] });
  };
  try {
    const [item] = await new AlpacaProvider({ keyId: "test-key", secretKey: "test-secret", feed: "iex" }).news(["BTC/USD", "TSLA"]);
    assert.equal(item?.summary, "Wire & detail");
    assert.equal(item?.provider, "alpaca");
    assert.equal(item?.tier, "WIRE");
  } finally { globalThis.fetch = original; }
});

test("finnhub crypto category headlines are filtered to the coin and labelled as keyword matches", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/news");
    assert.equal(url.searchParams.get("category"), "crypto");
    assert.equal(new Headers(init?.headers).get("X-Finnhub-Token"), "test-token");
    return Response.json([
      { headline: "Bitcoin rally", url: "https://reuters.com/bitcoin", datetime: Date.parse("2026-09-05T12:00:00Z") / 1000 },
      { headline: "Ethereum update", url: "https://reuters.com/ethereum", datetime: Date.parse("2026-09-05T12:00:00Z") / 1000 },
    ]);
  };
  try {
    const rows = await new FinnhubProvider("test-token").news("BTC/USD", { start: "2026-09-01T00:00:00Z", end: "2026-09-06T00:00:00Z" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.headline, "Bitcoin rally");
    assert.equal(rows[0]?.tier, "WEB");
  } finally { globalThis.fetch = original; }
});

test("finnhub earnings preserve a zero actual and report access failures with their upstream status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json([{ period: "2026-06-30", year: 2026, quarter: 2, actual: 0, estimate: 0.2, surprisePercent: -100 }]);
  try {
    const provider = new FinnhubProvider("test-token");
    const [row] = await provider.earnings("TSLA");
    assert.equal(row?.actual, 0);
    assert.equal(row?.estimate, 0.2);
    globalThis.fetch = async () => new Response("no access", { status: 403 });
    await assert.rejects(provider.earnings("TSLA"), (error: unknown) => error instanceof MarketDataError && error.status === 403);
  } finally { globalThis.fetch = original; }
});

test("gdelt sends a named user agent and normalizes its compact UTC date as a web match", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("query"), '"Tesla"');
    assert.equal(url.searchParams.get("mode"), "artlist");
    assert.equal(url.searchParams.get("format"), "json");
    assert.ok(new Headers(init?.headers).get("User-Agent"));
    return Response.json({ articles: [{ title: "Tesla launch", url: "https://techcrunch.com/launch", domain: "techcrunch.com", seendate: "20260905T120000Z" }] });
  };
  try {
    const [row] = await new GdeltProvider().news("Tesla Inc.");
    assert.equal(row?.publishedAt, "2026-09-05T12:00:00.000Z");
    assert.equal(row?.tier, "WEB");
  } finally { globalThis.fetch = original; }
});

test("research markup is text and publisher links exclude unsafe schemes while preserving paywall markers", () => {
  assert.equal(stripMarkup("<script>alert(1)</script><p>Hello &amp; &#x77;orld</p>"), "Hello & world");
  assert.equal(stripMarkup("&lt;b&gt;Hello&lt;/b&gt;"), "Hello");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("https://name:password@wsj.com/story"), null);
  const row = normalizeNews({ headline: "News", url: "https://www.wsj.com/story", provider: "gdelt", tier: "WEB", publishedAt: "2026-09-05T12:00:00Z" });
  assert.equal(row?.paywalled, true);
  const redirect = normalizeNews({ headline: "News", url: "https://finnhub.io/api/news?id=123", source: "SeekingAlpha",
    provider: "finnhub", tier: "WIRE", publishedAt: "2026-09-05T12:00:00Z" });
  assert.equal(redirect?.paywalled, true);
  assert.equal(normalizeNews({ headline: "News", url: "https://wsj.com/story", provider: "gdelt", tier: "WEB", publishedAt: "invalid" }), null);
});
