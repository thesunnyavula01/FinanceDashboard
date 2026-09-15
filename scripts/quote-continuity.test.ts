import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { LAST_GOOD_QUOTES_KEY, rememberQuotes, retainQuotes } from "../src/lib/quote-continuity.ts";
import type { Quote, QuotesResponse } from "../src/lib/quote-types.ts";
import { resetSessionCache } from "../src/lib/refresh.ts";

const quote = (symbol: string, price: number): Quote => ({ symbol, price, source: "trade",
  prevClose: 100, dayChange: price - 100, dayChangePercent: price - 100,
  dayOpen: 100, dayHigh: price, dayLow: 100, dayVolume: 10,
  asOf: "2026-09-15T15:00:00Z" });
const response = (quotes: Record<string, Quote>, asOf = "2026-09-15T15:00:00Z"): QuotesResponse =>
  ({ quotes, unknown: [], rejected: [], asOf, cache: { memory: 0, edge: 0, fetched: 0 }, limit: 300 });

test("an empty successful poll preserves the price and original observation time", () => {
  const good = retainQuotes(["AAPL"], response({ AAPL: quote("AAPL", 150) }), {});
  const outage = retainQuotes(["AAPL"], response({}, "2026-09-15T15:05:00Z"), good.quotes);
  assert.equal(outage.quotes.AAPL.price, 150);
  assert.equal(outage.quotes.AAPL.stale, true);
  assert.equal(outage.quotes.AAPL.receivedAt, "2026-09-15T15:00:00Z");
  assert.deepEqual(outage.unknown, []);
});

test("partial failures, changed holdings and recovery are handled per symbol", () => {
  const good = retainQuotes(["AAPL", "MSFT"], response({ AAPL: quote("AAPL", 150), MSFT: quote("MSFT", 300) }), {});
  const partial = retainQuotes(["AAPL", "MSFT", "NVDA"], response({ MSFT: quote("MSFT", 310) }), good.quotes);
  assert.equal(partial.quotes.AAPL.price, 150);
  assert.equal(partial.quotes.AAPL.stale, true);
  assert.equal(partial.quotes.MSFT.price, 310);
  assert.deepEqual(partial.unknown, ["NVDA"]);
  const recovered = retainQuotes(["AAPL"], response({ AAPL: quote("AAPL", 160) }), partial.quotes);
  assert.equal(recovered.quotes.AAPL.price, 160);
  assert.ok(!recovered.quotes.AAPL.stale);
  assert.equal(recovered.quotes.MSFT, undefined, "sold positions are not reintroduced");
});

test("an older server backup cannot replace a newer price seen in this browser", () => {
  const good = retainQuotes(["AAPL"], response({ AAPL: quote("AAPL", 150) }), {});
  const backup = { ...quote("AAPL", 140), stale: true, receivedAt: "2026-09-15T14:55:00Z" };
  const result = retainQuotes(["AAPL"], response({ AAPL: backup }), good.quotes);
  assert.equal(result.quotes.AAPL.price, 150);
  assert.equal(result.quotes.AAPL.stale, true);
  const cold = retainQuotes(["AAPL"], response({ AAPL: backup }), {});
  assert.equal(cold.quotes.AAPL.price, 140);
  assert.equal(cold.quotes.AAPL.receivedAt, backup.receivedAt);
});

test("saved prices are cleared on account change", () => {
  const client = new QueryClient();
  rememberQuotes(client, { AAPL: quote("AAPL", 150) });
  assert.equal(client.getQueryCache().find({ queryKey: LAST_GOOD_QUOTES_KEY })?.gcTime, Infinity,
    "ordinary query garbage collection must not erase outage recovery prices");
  resetSessionCache(client, "alice", "bob");
  assert.equal(client.getQueryData(["last-good-quotes"]), undefined);
  client.clear();
});

test("a delayed successful response cannot overwrite a newer observation", () => {
  const recent = retainQuotes(["AAPL"], response({ AAPL: quote("AAPL", 160) }, "2026-09-15T15:01:00Z"), {});
  const delayed = retainQuotes(["AAPL"], response({ AAPL: quote("AAPL", 150) }), recent.quotes);
  assert.equal(delayed.quotes.AAPL.price, 160);
  assert.equal(delayed.quotes.AAPL.receivedAt, "2026-09-15T15:01:00Z");
});
