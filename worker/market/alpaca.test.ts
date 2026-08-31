import test from "node:test";
import assert from "node:assert/strict";
import { AlpacaProvider, quoteFromSnapshot, resolveSessionState } from "./alpaca.ts";

/**
 * Reading a snapshot is the part of this app most likely to be silently wrong.
 * Every number a member sees — day change, P/L, the leaderboard — is derived
 * from the two decisions made in quoteFromSnapshot: which field is the price,
 * and which bar is the previous close. A mistake there does not throw, it just
 * produces a plausible wrong number, so it gets pinned here.
 *
 * All times below are August 2026, which is EDT, so ET = UTC-4.
 *
 * Run with: npm test
 */

const MIDDAY = new Date("2026-08-28T15:00:00Z"); // 11:00 ET, Friday, mid-session
const PREMARKET = new Date("2026-08-28T12:00:00Z"); // 08:00 ET, before the bell

/** A daily bar stamped at midnight ET on the given date. */
function bar(date: string, close: number, extra: Record<string, number> = {}) {
  return {
    t: `${date}T04:00:00Z`,
    o: close,
    h: close,
    l: close,
    c: close,
    v: 1_000_000,
    ...extra,
  };
}

test("during the session the latest trade is the price", () => {
  const quote = quoteFromSnapshot(
    "AAPL",
    {
      latestTrade: { t: "2026-08-28T14:59:58Z", p: 234.25, s: 100 },
      latestQuote: { t: "2026-08-28T14:59:59Z", bp: 234.2, ap: 234.3, bs: 2, as: 3 },
      dailyBar: bar("2026-08-28", 234.1, { o: 233.0, h: 235.5, l: 232.8, v: 40_000_000 }),
      prevDailyBar: bar("2026-08-27", 230.0),
    },
    MIDDAY,
  );

  assert.ok(quote);
  assert.equal(quote.price, 234.25);
  assert.equal(quote.source, "trade");
  assert.equal(quote.prevClose, 230.0);
  assert.equal(quote.dayChange?.toFixed(2), "4.25");
  assert.equal(quote.dayChangePercent?.toFixed(4), "1.8478");
  assert.equal(quote.dayOpen, 233.0);
  assert.equal(quote.dayHigh, 235.5);
  assert.equal(quote.dayVolume, 40_000_000);
});

test("with no trade, a two-sided quote gives the midpoint", () => {
  const quote = quoteFromSnapshot(
    "MSFT",
    {
      latestQuote: { t: "2026-08-28T14:59:59Z", bp: 420.0, ap: 421.0, bs: 1, as: 1 },
      dailyBar: bar("2026-08-28", 419.0),
      prevDailyBar: bar("2026-08-27", 417.0),
    },
    MIDDAY,
  );

  assert.ok(quote);
  assert.equal(quote.price, 420.5);
  assert.equal(quote.source, "quote");
});

test("a one-sided book is rejected rather than halving the price", () => {
  // Outside deep liquidity IEX will publish a zero on one side. Averaging
  // that with a real offer would price the stock at half of what it is worth,
  // and the trading engine would happily fill against it.
  const quote = quoteFromSnapshot(
    "TSLA",
    {
      latestQuote: { t: "2026-08-28T14:59:59Z", bp: 0, ap: 236.5, bs: 0, as: 4 },
      dailyBar: bar("2026-08-28", 236.15),
      prevDailyBar: bar("2026-08-27", 239.9),
    },
    MIDDAY,
  );

  assert.ok(quote);
  assert.equal(quote.price, 236.15);
  assert.equal(quote.source, "bar");
});

test("a crossed book is rejected too", () => {
  const quote = quoteFromSnapshot(
    "XOM",
    {
      latestQuote: { t: "2026-08-28T14:59:59Z", bp: 110.0, ap: 109.0, bs: 1, as: 1 },
      dailyBar: bar("2026-08-28", 109.9),
      prevDailyBar: bar("2026-08-27", 111.2),
    },
    MIDDAY,
  );

  assert.ok(quote);
  assert.equal(quote.source, "bar");
  assert.equal(quote.price, 109.9);
});

test("before the bell, the last official close wins over a thin overnight print", () => {
  // The trap this test exists for: at 08:00 ET `dailyBar` is still YESTERDAY.
  // Reading prevDailyBar as "the previous close" here would be off by a whole
  // session and every day-change figure on the dashboard would be wrong.
  const quote = quoteFromSnapshot(
    "NVDA",
    {
      latestTrade: { t: "2026-08-28T11:55:00Z", p: 171.0, s: 5 },
      dailyBar: bar("2026-08-27", 180.1),
      prevDailyBar: bar("2026-08-26", 178.3),
    },
    PREMARKET,
  );

  assert.ok(quote);
  assert.equal(quote.price, 180.1, "should be the last close, not the 5-share pre-market print");
  assert.equal(quote.source, "bar");
  assert.equal(quote.prevClose, 178.3);
  // Outside the session the day change is the last session's move, which is
  // what a member expects to see on a Saturday morning.
  assert.equal(quote.dayChange?.toFixed(2), "1.80");
  assert.equal(quote.dayOpen, null, "there is no session today yet");
  assert.equal(quote.dayVolume, null);
});

test("a symbol with nothing usable produces no quote at all", () => {
  assert.equal(quoteFromSnapshot("NOPE", {}, MIDDAY), null);
  assert.equal(
    quoteFromSnapshot("NOPE", { latestTrade: { t: "", p: 0, s: 0 } }, MIDDAY),
    null,
    "a zero price is absence, not free stock",
  );
});

test("falls back to the previous bar when the daily bar is missing entirely", () => {
  const quote = quoteFromSnapshot("THIN", { prevDailyBar: bar("2026-08-27", 12.5) }, MIDDAY);
  assert.ok(quote);
  assert.equal(quote.price, 12.5);
  assert.equal(quote.source, "prev-bar");
});

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const REGULAR_DAY = { open: "09:30", close: "16:00" };

test("session state uses the calendar, so a holiday is not pre-market", () => {
  const eightAm = new Date("2026-08-28T12:00:00Z");

  assert.equal(resolveSessionState(eightAm, false, REGULAR_DAY), "PRE");
  // Same clock time, but the exchange is not trading today at all. The
  // wall-clock estimate this replaced would have said "Pre-market".
  assert.equal(resolveSessionState(eightAm, false, null), "CLOSED");
});

test("open beats everything", () => {
  assert.equal(resolveSessionState(MIDDAY, true, REGULAR_DAY), "OPEN");
});

test("after the close is after hours, until 20:00 ET", () => {
  const fivePm = new Date("2026-08-28T21:00:00Z");
  const ninePm = new Date("2026-08-29T01:00:00Z");
  assert.equal(resolveSessionState(fivePm, false, REGULAR_DAY), "POST");
  assert.equal(resolveSessionState(ninePm, false, REGULAR_DAY), "CLOSED");
});

test("the small hours are closed, not pre-market", () => {
  const twoAm = new Date("2026-08-28T06:00:00Z");
  assert.equal(resolveSessionState(twoAm, false, REGULAR_DAY), "CLOSED");
});

test("a half day closes when the calendar says it closes", () => {
  const twoPm = new Date("2026-08-28T18:00:00Z"); // 14:00 ET
  assert.equal(resolveSessionState(twoPm, false, { open: "09:30", close: "13:00" }), "POST");
  assert.equal(resolveSessionState(twoPm, false, REGULAR_DAY), "CLOSED");
});

// ---------------------------------------------------------------------------
// Batching — the whole reason Alpaca was chosen over Finnhub for prices
// ---------------------------------------------------------------------------

test("splits a large symbol list into batched requests, not one per symbol", async () => {
  const requested: string[][] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requested.push((url.searchParams.get("symbols") ?? "").split(","));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const provider = new AlpacaProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    const symbols = Array.from({ length: 150 }, (_, i) => `SYM${i}`);
    await provider.quotes(symbols);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requested.length, 2, "150 symbols should cost two requests, not 150");
  assert.equal(requested[0]?.length, 100);
  assert.equal(requested[1]?.length, 50);
});

test("accepts both snapshot payload shapes Alpaca has shipped", async () => {
  const originalFetch = globalThis.fetch;
  // Trade only, no bars: the price is then the same whatever day this test
  // runs on, so the assertion is about the payload shape and nothing else.
  const payload = {
    snapshots: {
      AAPL: { latestTrade: { t: "2026-08-28T14:59:58Z", p: 234.25, s: 100 } },
    },
  };

  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const provider = new AlpacaProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    const quotes = await provider.quotes(["AAPL"]);
    assert.equal(quotes.get("AAPL")?.price, 234.25);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an upstream rate limit surfaces as 429, not a generic failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;

  try {
    const provider = new AlpacaProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    await assert.rejects(
      () => provider.quotes(["AAPL"]),
      (err: Error & { status?: number }) => err.status === 429,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
