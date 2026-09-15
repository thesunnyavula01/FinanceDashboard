import test from "node:test";
import assert from "node:assert/strict";
import { dailyBars, forgetBars } from "./bars.ts";
import { intradayBars, forgetIntraday } from "./intraday.ts";

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
