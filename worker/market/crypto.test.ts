import test from "node:test";
import assert from "node:assert/strict";
import { AlpacaCryptoProvider, quoteFromCryptoSnapshot, type CryptoSnapshot } from "./crypto.ts";
import { exchangeDate } from "./provider.ts";

/**
 * The crypto quote adapter.
 *
 * Two things here fail silently if they are wrong, which is why they are the
 * two things tested hardest: a day-change figure measured against the wrong
 * session, and a price taken from a one-sided book. Both produce a number that
 * looks entirely plausible on screen.
 *
 * Run with: npm test
 */

const BAR = { o: 0, h: 0, l: 0, c: 0, v: 0 };

test("the latest trade is the price, with no session to check first", () => {
  // The equity adapter asks whether the daily bar is today before it trusts a
  // print, because an after-hours IEX tick should not move an overnight
  // valuation. There is no after-hours in crypto, so the newest print always
  // wins and there is no branch to get wrong.
  const quote = quoteFromCryptoSnapshot("BTC/USD", {
    latestTrade: { t: "2026-09-02T03:14:00Z", p: 101_250, s: 0.01 },
    latestQuote: { t: "2026-09-02T03:14:00Z", bp: 101_200, ap: 101_300, bs: 1, as: 1 },
    dailyBar: { ...BAR, t: "2026-09-02T05:00:00Z", c: 101_000 },
    prevDailyBar: { ...BAR, t: "2026-09-01T05:00:00Z", c: 99_000 },
  });

  assert.equal(quote?.price, 101_250);
  assert.equal(quote?.source, "trade");
});

test("a one-sided book is never averaged into a price", () => {
  // A zero bid against a real offer halves the mid. This is the same guard the
  // equity adapter keeps, and it matters more here: a thin pair can quote one
  // side for minutes at a time.
  const oneSided = quoteFromCryptoSnapshot("SHIB/USD", {
    latestQuote: { t: "2026-09-02T03:14:00Z", bp: 0, ap: 0.000024, bs: 0, as: 1 },
    dailyBar: { ...BAR, t: "2026-09-02T05:00:00Z", c: 0.000023 },
  });

  assert.equal(oneSided?.price, 0.000023, "falls through to the close, not to half the offer");
  assert.equal(oneSided?.source, "bar");

  // A crossed book is refused for the same reason.
  const crossed = quoteFromCryptoSnapshot("SHIB/USD", {
    latestQuote: { t: "2026-09-02T03:14:00Z", bp: 0.00003, ap: 0.00002, bs: 1, as: 1 },
    dailyBar: { ...BAR, t: "2026-09-02T05:00:00Z", c: 0.000023 },
  });
  assert.equal(crossed?.source, "bar");
});

test("a two-sided book gives the midpoint when nothing has printed", () => {
  const quote = quoteFromCryptoSnapshot("BTC/USD", {
    latestQuote: { t: "2026-09-02T03:14:00Z", bp: 101_200, ap: 101_300, bs: 1, as: 1 },
    prevDailyBar: { ...BAR, t: "2026-09-01T05:00:00Z", c: 99_000 },
  });

  assert.equal(quote?.price, 101_250);
  assert.equal(quote?.source, "quote");
});

test("the day change is measured against the previous daily bar", () => {
  const quote = quoteFromCryptoSnapshot("BTC/USD", {
    latestTrade: { t: "2026-09-02T03:14:00Z", p: 101_250, s: 0.01 },
    prevDailyBar: { ...BAR, t: "2026-09-01T05:00:00Z", c: 99_000 },
  });

  assert.equal(quote?.prevClose, 99_000);
  assert.equal(quote?.dayChange, 2250);
  assert.ok(Math.abs((quote?.dayChangePercent ?? 0) - 2.2727) < 0.001);
});

/**
 * The boundary that would shift every crypto close by a day.
 *
 * A crypto daily bar runs midnight to midnight UTC and is stamped 00:00:00Z.
 * Reading that through `exchangeDate()` — which is right for every other bar in
 * this app — puts it at 20:00 ET on the PREVIOUS day, so today's close becomes
 * yesterday's. The chart still draws; it just draws the wrong number.
 *
 * Alpaca's docs show 05:00Z in an example from the v1beta1 era, which would
 * have made the exchange-date reading correct. The live v1beta3 feed returns
 * 00:00Z. This was found by calling the API, not by reading about it.
 */
test("a crypto daily bar is dated by UTC, not by the exchange calendar", async () => {
  const stamp = "2026-09-02T00:00:00Z";

  // What it must NOT be. In EDT this is 20:00 the evening before — the exact
  // off-by-one the comment in crypto.ts exists to prevent.
  assert.equal(exchangeDate(stamp), "2026-09-01");
  // Winter too: 00:00Z is 19:00 EST the previous evening.
  assert.equal(exchangeDate("2026-01-15T00:00:00Z"), "2026-01-14");

  // And what the provider actually produces, which is the part that matters.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        bars: { "BTC/USD": [{ t: stamp, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] },
        next_page_token: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const provider = new AlpacaCryptoProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    const bars = await provider.dailyBars(["BTC/USD"], { start: "2026-09-01" });
    assert.equal(bars.get("BTC/USD")?.[0]?.date, "2026-09-02");
  } finally {
    globalThis.fetch = original;
  }
});

test("a crypto pair survives the query string with its slash intact", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ snapshots: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    const provider = new AlpacaCryptoProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    await provider.quotes(["BTC/USD", "ETH/USD"]);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(seen.length, 1, "both pairs go out in one batched request");
  // Percent-encoded by URLSearchParams, which Alpaca accepts. What must never
  // happen is a raw slash reaching a path segment.
  assert.match(seen[0]!, /\/v1beta3\/crypto\/us\/snapshots\?/);
  assert.match(seen[0]!, /symbols=BTC%2FUSD%2CETH%2FUSD/);
});

test("a snapshot with nothing usable produces no quote at all", () => {
  // Absent from the map, which is what the cache negative-caches. A zero would
  // be a price, and a position marked at zero is a wiped-out member.
  assert.equal(quoteFromCryptoSnapshot("BTC/USD", {}), null);
  assert.equal(
    quoteFromCryptoSnapshot("BTC/USD", {
      latestTrade: { t: "2026-09-02T03:14:00Z", p: 0, s: 0 },
      dailyBar: { ...BAR, t: "2026-09-02T05:00:00Z", c: 0 },
    } as CryptoSnapshot),
    null,
  );
});

test("no previous bar means no day change, rather than a change of everything", () => {
  const quote = quoteFromCryptoSnapshot("BTC/USD", {
    latestTrade: { t: "2026-09-02T03:14:00Z", p: 101_250, s: 0.01 },
  });

  assert.equal(quote?.price, 101_250);
  assert.equal(quote?.prevClose, null);
  assert.equal(quote?.dayChange, null);
  assert.equal(quote?.dayChangePercent, null);
});
