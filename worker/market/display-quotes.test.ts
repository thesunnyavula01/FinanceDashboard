import test from "node:test";
import assert from "node:assert/strict";
import { displayQuotes, forgetDisplayQuotes } from "./display-quotes.ts";
import { quoteCache, type QuoteResult } from "./quotes.ts";
import type { Env } from "../types.ts";
import type { Quote } from "./provider.ts";
import { SAVED_PRICES_KEY, type SavedPrices } from "../analytics/backup.ts";

const quote = (price: number, symbol = "AAPL"): Quote => ({ symbol, price, source: "trade",
  prevClose: 100, dayChange: price - 100, dayChangePercent: price - 100,
  dayOpen: null, dayHigh: null, dayLow: null, dayVolume: null, asOf: null });
function fixture() {
  let stored: SavedPrices = {};
  let live: QuoteResult = { quotes: new Map(), observedAt: new Map(), unknown: ["AAPL"],
    stats: { memory: 0, edge: 0, fetched: 1 } };
  const reads: string[] = [];
  const env = { SUPABASE_URL: "https://display.example", ALPACA_API_KEY_ID: crypto.randomUUID(),
    ALPACA_API_SECRET_KEY: "test", QUOTES: { get: async (key: string) => { reads.push(key); return stored; } } } as unknown as Env;
  return { env, reads, get live() { return live; }, set live(value: QuoteResult) { live = value; },
    set stored(value: SavedPrices) { stored = value; } };
}

test("display continuity keeps newer observed prices without injecting them into the execution cache", async (t) => {
  const f = fixture(), now = Date.now(), observed = now - 5_000;
  t.mock.method(quoteCache(f.env), "get", async () => f.live);
  f.live.quotes.set("AAPL", quote(150)); f.live.observedAt.set("AAPL", observed);
  const first = await displayQuotes(f.env, ["AAPL"]);
  assert.equal(first.quotes.get("AAPL")?.stale, false);
  f.live = { ...f.live, quotes: new Map(), observedAt: new Map() };
  f.stored = { AAPL: { quote: quote(120), savedAt: new Date(now - 300_000).toISOString() } };
  const retained = await displayQuotes(f.env, ["AAPL"]);
  assert.equal(retained.quotes.get("AAPL")?.price, 150);
  assert.equal(retained.quotes.get("AAPL")?.stale, true);
  assert.equal(retained.quotes.get("AAPL")?.receivedAt, new Date(observed).toISOString());
  assert.equal((await quoteCache(f.env).get(["AAPL"])).quotes.size, 0);
  assert.deepEqual(f.reads, [SAVED_PRICES_KEY]);
  f.live.quotes.set("AAPL", quote(160)); f.live.observedAt.set("AAPL", now);
  const recovered = await displayQuotes(f.env, ["AAPL"]);
  assert.equal(recovered.quotes.get("AAPL")?.price, 160);
  assert.equal(recovered.quotes.get("AAPL")?.stale, false);
});

test("cold display readers recover across a weekend and reject expired, invalid or mismatched prices", async (t) => {
  const f = fixture();
  t.mock.method(quoteCache(f.env), "get", async () => f.live);
  const savedAt = new Date(Date.now() - 3 * 86400000).toISOString();
  f.stored = { AAPL: { quote: quote(150), savedAt } };
  const recovered = await displayQuotes(f.env, ["AAPL"]);
  assert.equal(recovered.quotes.get("AAPL")?.receivedAt, savedAt);
  assert.equal(recovered.quotes.get("AAPL")?.stale, true);
  for (const entry of [
    { quote: quote(150), savedAt: new Date(Date.now() - 8 * 86400000).toISOString() },
    { quote: quote(0), savedAt }, { quote: quote(150, "MSFT"), savedAt },
  ]) {
    forgetDisplayQuotes(); f.stored = { AAPL: entry };
    assert.deepEqual((await displayQuotes(f.env, ["AAPL"])).unknown, ["AAPL"]);
  }
});

test("invalid fresh prices use valid durable prices and old observations cannot replace newer ones", async (t) => {
  const f = fixture(), now = Date.now();
  t.mock.method(quoteCache(f.env), "get", async () => f.live);
  f.stored = { AAPL: { quote: quote(160), savedAt: new Date(now - 1000).toISOString() } };
  f.live.quotes.set("AAPL", quote(Number.NaN)); f.live.observedAt.set("AAPL", now);
  assert.equal((await displayQuotes(f.env, ["AAPL"])).quotes.get("AAPL")?.price, 160);
  f.live.quotes.set("AAPL", quote(150)); f.live.observedAt.set("AAPL", now - 2000);
  const current = await displayQuotes(f.env, ["AAPL"]);
  assert.equal(current.quotes.get("AAPL")?.price, 160);
  assert.equal(current.quotes.get("AAPL")?.stale, true);
});

test("one saved-price read serves an isolate's polls for a minute", async (t) => {
  const f = fixture();
  t.mock.method(quoteCache(f.env), "get", async () => f.live);
  f.stored = { AAPL: { quote: quote(150), savedAt: new Date().toISOString() } };
  await Promise.all([displayQuotes(f.env, ["AAPL"]), displayQuotes(f.env, ["AAPL"])]);
  await displayQuotes(f.env, ["AAPL"]);
  assert.deepEqual(f.reads, [SAVED_PRICES_KEY], "concurrent and repeated polls share one KV read");
  forgetDisplayQuotes();
  await displayQuotes(f.env, ["AAPL"]);
  assert.equal(f.reads.length, 2);
});
