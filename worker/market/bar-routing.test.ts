import test from "node:test";
import assert from "node:assert/strict";
import { barMemorySize, dailyBars, forgetBars, MAX_MEMORY_ENTRIES as BAR_MEMORY_CAP } from "./bars.ts";
import {
  forgetIntraday,
  intradayBars,
  intradayMemorySize,
  MAX_MEMORY_ENTRIES as INTRADAY_MEMORY_CAP,
} from "./intraday.ts";

const env = { ALPACA_API_KEY_ID: "test-key", ALPACA_API_SECRET_KEY: "test-secret" };
const option = "AAPL261218C00150000";
const symbols = ["SPY", "QQQ", "BTC/USD", option];

test("the chart caches route mixed holdings by asset class, keeping Bitcoin out of stock requests", async () => {
  const fetch = globalThis.fetch;
  const calls: URL[] = [];
  forgetBars(); forgetIntraday();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)); calls.push(url);
    const requested = url.searchParams.get("symbols")!.split(",");
    const expected = url.pathname.includes("/crypto/") ? ["BTC/USD"] : url.pathname.includes("/options/") ? [option] : ["SPY", "QQQ"];
    assert.deepEqual(requested, expected, "a mixed request would be rejected by Alpaca");
    return new Response(JSON.stringify({ bars: Object.fromEntries(requested.map((symbol) => [symbol,
      [{ t: "2026-09-15T15:00:00Z", o: 100, h: 110, l: 90, c: 105, v: 1000 }]])), next_page_token: null }));
  };
  try {
    const daily = await dailyBars(env, symbols, "2026-09-14", "2026-09-15");
    assert.deepEqual([...daily.keys()].sort(), [...symbols].sort());
    assert.equal(calls.length, 3);
    const intraday = await intradayBars(env, symbols, "2026-09-14T00:00:00Z");
    assert.deepEqual([...intraday.keys()].sort(), ["BTC/USD", "QQQ", "SPY"]);
    assert.equal(calls.length, 5, "options use their daily close on the intraday chart");
    await dailyBars(env, symbols, "2026-09-14", "2026-09-15");
    await intradayBars(env, ["SPY", "QQQ", "BTC/USD"], "2026-09-14T00:00:00Z");
    assert.equal(calls.length, 5, "the per-symbol cache still batches shared readers");
  } finally { globalThis.fetch = fetch; forgetBars(); forgetIntraday(); }
});

test("a crypto history outage does not discard the stock benchmarks or cache the failure", async () => {
  const fetch = globalThis.fetch;
  let cryptoFailed = true;
  forgetBars(); forgetIntraday();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/crypto/") && cryptoFailed) return new Response("Unavailable", { status: 503 });
    const requested = url.searchParams.get("symbols")!.split(",");
    return new Response(JSON.stringify({ bars: Object.fromEntries(requested.map((symbol) => [symbol,
      [{ t: "2026-09-15T15:00:00Z", o: 100, h: 110, l: 90, c: 105, v: 1000 }]])), next_page_token: null }));
  };
  try {
    const daily = await dailyBars(env, ["SPY", "BTC/USD"], "2026-09-14", "2026-09-15");
    const intraday = await intradayBars(env, ["SPY", "BTC/USD"], "2026-09-14T00:00:00Z");
    assert.deepEqual([...daily.keys()], ["SPY"]);
    assert.deepEqual([...intraday.keys()], ["SPY"]);
    cryptoFailed = false;
    assert.ok((await dailyBars(env, ["SPY", "BTC/USD"], "2026-09-14", "2026-09-15")).has("BTC/USD"));
    assert.ok((await intradayBars(env, ["SPY", "BTC/USD"], "2026-09-14T00:00:00Z")).has("BTC/USD"));
  } finally { globalThis.fetch = fetch; forgetBars(); forgetIntraday(); }
});

/**
 * The bar caches key on the window they were asked for, and the window moves:
 * `end` is today on the session chart and `start` rolls forward every day on
 * the 1D one. So yesterday's keys are dead the moment the date changes, and a
 * cache that only checked freshness on read kept every one of them — a season
 * of daily bars per symbol per day, for as long as the isolate lived. An
 * isolate over its memory ceiling is torn down with the requests on it, which
 * is not evenly spread: it lands on whoever is sharing it.
 */
test("the bar caches stay bounded as the chart's window rolls forward", async () => {
  const fetch = globalThis.fetch;
  forgetBars(); forgetIntraday();
  globalThis.fetch = async (input) => {
    const requested = new URL(String(input)).searchParams.get("symbols")!.split(",");
    return new Response(JSON.stringify({ bars: Object.fromEntries(requested.map((symbol) => [symbol,
      [{ t: "2026-09-15T15:00:00Z", o: 100, h: 110, l: 90, c: 105, v: 1000 }]])), next_page_token: null }));
  };
  try {
    // Two hundred sessions of a twenty-symbol club is four thousand distinct
    // keys, an order of magnitude past the cap.
    const club = Array.from({ length: 20 }, (_, i) => `SYM${i}`);
    let end = "";
    for (let day = 1; day <= 200; day++) {
      end = `2026-${String(Math.floor(day / 31) + 1).padStart(2, "0")}-${String((day % 28) + 1).padStart(2, "0")}`;
      await dailyBars(env, club, "2026-01-02", end);
      await intradayBars(env, club, `${end}T00:00:00Z`);
    }

    assert.ok(barMemorySize() <= BAR_MEMORY_CAP, `daily tier held ${barMemorySize()} series`);
    assert.ok(intradayMemorySize() <= INTRADAY_MEMORY_CAP, `intraday tier held ${intradayMemorySize()}`);

    // Still a cache, not merely a small one: the window just asked for is warm.
    const before = globalThis.fetch;
    let called = false;
    globalThis.fetch = async (...args) => { called = true; return before(...(args as [RequestInfo])); };
    await dailyBars(env, club, "2026-01-02", end);
    assert.equal(called, false, "the most recent window must still be served from memory");
  } finally { globalThis.fetch = fetch; forgetBars(); forgetIntraday(); }
});

/** A stale entry is released when it is noticed, not carried until the cap reaches it. */
test("an expired bar entry is dropped rather than held to the cap", async () => {
  const fetch = globalThis.fetch;
  forgetBars();
  globalThis.fetch = async (input) => {
    const requested = new URL(String(input)).searchParams.get("symbols")!.split(",");
    return new Response(JSON.stringify({ bars: Object.fromEntries(requested.map((symbol) => [symbol,
      [{ t: "2026-09-15T15:00:00Z", o: 100, h: 110, l: 90, c: 105, v: 1000 }]])), next_page_token: null }));
  };
  try {
    await dailyBars(env, ["SPY"], "2026-09-14", "2026-09-15");
    assert.equal(barMemorySize(), 1);
  } finally { globalThis.fetch = fetch; forgetBars(); }
});
