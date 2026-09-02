import test from "node:test";
import assert from "node:assert/strict";
import {
  AlpacaOptionsProvider,
  quoteFromOptionSnapshot,
  toContractMeta,
  type OptionSnapshot,
} from "./options.ts";

/**
 * The options adapter.
 *
 * Two decisions here are invisible on screen when they go wrong, which is why
 * they carry most of the assertions: a fill settled against a print that is
 * four hours old, and a contract priced with the wrong multiplier. Both produce
 * a number that looks entirely reasonable.
 *
 * Run with: npm test
 */

const BAR = { o: 0, h: 0, l: 0, c: 0, v: 0 };
const TODAY = "2026-09-02";

test("the midpoint beats the last print, which is the opposite of the equity rule", () => {
  // Taken from a live response. The book was quoted at 19:59:59Z and the last
  // trade printed at 15:17Z — four hours and twenty minutes earlier. The stock
  // adapter would take the print, because an IEX print is real and current;
  // here it is neither, and settling a paper fill against it would hand the
  // member a price the market moved away from before lunch.
  const quote = quoteFromOptionSnapshot(
    "AAPL260918C00230000",
    {
      latestTrade: { t: "2026-09-02T15:17:07Z", p: 96.71, s: 1 },
      latestQuote: { t: "2026-09-02T19:59:59Z", bp: 94.87, ap: 98.79, bs: 99, as: 54 },
      dailyBar: { ...BAR, t: "2026-09-02T04:00:00Z", c: 95.4 },
      prevDailyBar: { ...BAR, t: "2026-09-01T04:00:00Z", c: 95.75 },
    },
    TODAY,
  );

  assert.equal(quote?.source, "quote");
  assert.equal(quote?.price, (94.87 + 98.79) / 2);
});

test("a one-sided book falls through to the print rather than halving the premium", () => {
  // The wings of a chain quote one side all day. Averaging a real offer against
  // a zero bid would report a contract at half what anyone would pay.
  const quote = quoteFromOptionSnapshot(
    "AAPL260918C00500000",
    {
      latestTrade: { t: "2026-09-02T15:17:07Z", p: 0.42, s: 1 },
      latestQuote: { t: "2026-09-02T19:59:59Z", bp: 0, ap: 0.55, bs: 0, as: 10 },
      dailyBar: { ...BAR, t: "2026-09-02T04:00:00Z", c: 0.4 },
    },
    TODAY,
  );

  assert.equal(quote?.source, "trade");
  assert.equal(quote?.price, 0.42);

  // A crossed book is refused for the same reason.
  const crossed = quoteFromOptionSnapshot(
    "AAPL260918C00500000",
    {
      latestQuote: { t: "2026-09-02T19:59:59Z", bp: 0.6, ap: 0.5, bs: 1, as: 1 },
      dailyBar: { ...BAR, t: "2026-09-02T04:00:00Z", c: 0.4 },
    },
    TODAY,
  );
  assert.equal(crossed?.source, "bar");
});

test("outside the session the official close is the price, not the resting book", () => {
  // Before the bell `dailyBar` still holds the last completed session. Reading
  // it as today's would date every close a day early — the same trap the stock
  // adapter documents — and taking the overnight quote would let a stale book
  // move an account's valuation while the market is shut. Options follow the
  // equity calendar, so both rules carry over.
  const quote = quoteFromOptionSnapshot(
    "AAPL260918C00230000",
    {
      latestQuote: { t: "2026-09-03T08:00:00Z", bp: 99, ap: 101, bs: 5, as: 5 },
      dailyBar: { ...BAR, t: "2026-09-02T04:00:00Z", c: 95.4 },
      prevDailyBar: { ...BAR, t: "2026-09-01T04:00:00Z", c: 95.75 },
    },
    // A day later: the bar is yesterday's, so the session has not opened.
    "2026-09-03",
  );

  assert.equal(quote?.source, "bar");
  assert.equal(quote?.price, 95.4);
  assert.equal(quote?.prevClose, 95.4, "yesterday's close is also the baseline until one prints");
  assert.equal(quote?.dayChange, 0);
  assert.equal(quote?.dayVolume, null, "there is no day yet to report a volume for");
});

test("the day change is measured against the previous session's close", () => {
  const quote = quoteFromOptionSnapshot(
    "AAPL260918C00230000",
    {
      latestQuote: { t: "2026-09-02T19:59:59Z", bp: 95, ap: 97, bs: 1, as: 1 },
      dailyBar: { ...BAR, t: "2026-09-02T04:00:00Z", c: 95.4 },
      prevDailyBar: { ...BAR, t: "2026-09-01T04:00:00Z", c: 80 },
    },
    TODAY,
  );

  assert.equal(quote?.price, 96);
  assert.equal(quote?.prevClose, 80);
  assert.equal(quote?.dayChange, 16);
  assert.equal(quote?.dayChangePercent, 20);
});

test("a contract nothing can price is absent, not free", () => {
  assert.equal(quoteFromOptionSnapshot("AAPL260918C00230000", {}, TODAY), null);
  assert.equal(
    quoteFromOptionSnapshot(
      "AAPL260918C00230000",
      {
        latestTrade: { t: "2026-09-02T15:17:07Z", p: 0, s: 0 },
        latestQuote: { t: "2026-09-02T19:59:59Z", bp: 0, ap: 0, bs: 0, as: 0 },
      } as OptionSnapshot,
      TODAY,
    ),
    null,
    "a zero premium is not a price; the cache negative-caches it instead",
  );
});

/**
 * `/v2/options/contracts` sends every number as a string, and the multiplier is
 * the one that silently costs money: 100 read as NaN, or a post-split 1000 read
 * as the constant, misprices the whole position by an order of magnitude.
 */
test("contract metadata is parsed from strings and cross-checked against the symbol", () => {
  const meta = toContractMeta({
    symbol: "AAPL260904C00110000",
    underlying_symbol: "AAPL",
    expiration_date: "2026-09-04",
    type: "call",
    strike_price: "110",
    multiplier: "100",
    size: "100",
    open_interest: "2",
    status: "active",
    tradable: true,
  });

  assert.deepEqual(meta, {
    symbol: "AAPL260904C00110000",
    underlying: "AAPL",
    expiration: "2026-09-04",
    type: "CALL",
    strike: 110,
    multiplier: 100,
    openInterest: 2,
    tradable: true,
  });
});

test("a post-split multiplier is carried, not replaced with the usual 100", () => {
  const meta = toContractMeta({
    symbol: "AAPL260904C00110000",
    multiplier: "1000",
    open_interest: "0",
  });
  assert.equal(meta?.multiplier, 1000);
  assert.equal(meta?.openInterest, 0, "zero open interest is a fact, not a missing value");
});

test("the symbol is the authority, so a row that does not parse is dropped", () => {
  // The strike and expiry are read out of the OCC symbol rather than off the
  // row, because the symbol is what settles the money. A row with neither is
  // not usable at any price.
  assert.equal(toContractMeta({ symbol: "AAPL" }), null);
  assert.equal(toContractMeta({}), null);
  assert.equal(
    toContractMeta({ symbol: "AAPL260231C00110000" })?.symbol,
    undefined,
    "February 31st is not an expiry",
  );
});

test("a missing multiplier falls back to a contract's hundred shares", () => {
  assert.equal(toContractMeta({ symbol: "T261218P00025500" })?.multiplier, 100);
  assert.equal(toContractMeta({ symbol: "T261218P00025500", multiplier: "0" })?.multiplier, 100);
  assert.equal(toContractMeta({ symbol: "T261218P00025500" })?.openInterest, null);
});

test("a delisted contract is marked untradable rather than dropped", () => {
  // Dropping it would make it indistinguishable from a typo, and the orders
  // route says different things about those two.
  const meta = toContractMeta({ symbol: "T261218P00025500", tradable: false });
  assert.equal(meta?.tradable, false);
});

/**
 * The parameter that reads as a thin underlying rather than as a mistake.
 *
 * `expiration_date_lte` defaults to next weekend. Omit it and a request for a
 * year of expirations answers with this Friday's — a 200, a well-formed body,
 * and a chain rail with one date on it. Nothing about the response says the
 * request was wrong.
 */
test("every contracts request bounds its own expiry range", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ option_contracts: [], next_page_token: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    const provider = new AlpacaOptionsProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    await provider.expirations("AAPL", 232.5);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /expiration_date_gte=/);
  assert.match(seen[0]!, /expiration_date_lte=/);
  // The strike band is what keeps this to a few dozen rows instead of the whole
  // surface. ±8% of 232.50.
  assert.match(seen[0]!, /strike_price_gte=213\.90/);
  assert.match(seen[0]!, /strike_price_lte=251\.10/);
  assert.match(seen[0]!, /type=call/, "one side is enough — a listed expiry lists both");
});

test("with no spot price the band is dropped and the horizon shortened instead", () => {
  // Asking for a year of every strike is the payload this file exists to avoid.
  // Without spot there is no band to draw, so the range shrinks rather than the
  // request growing.
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ option_contracts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const provider = new AlpacaOptionsProvider({ keyId: "k", secretKey: "s", feed: "iex" });
  return provider
    .expirations("AAPL", null)
    .then(() => {
      assert.doesNotMatch(seen[0]!, /strike_price/);
      const lte = new URL(seen[0]!).searchParams.get("expiration_date_lte")!;
      const gte = new URL(seen[0]!).searchParams.get("expiration_date_gte")!;
      const days = (Date.parse(lte) - Date.parse(gte)) / 86_400_000;
      assert.ok(days <= 130, `horizon is ${days} days, which is not shortened`);
    })
    .finally(() => {
      globalThis.fetch = original;
    });
});

test("a chain is fetched one expiration at a time, never whole", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    const target = String(url);
    const body = target.includes("/v2/options/contracts")
      ? {
          option_contracts: [
            { symbol: "AAPL260918C00230000", multiplier: "100", open_interest: "12" },
            { symbol: "AAPL260918P00230000", multiplier: "100", open_interest: "8" },
          ],
          next_page_token: null,
        }
      : {
          snapshots: {
            AAPL260918C00230000: {
              latestQuote: { t: "2026-09-02T19:59:59Z", bp: 94.87, ap: 98.79, bs: 9, as: 5 },
              dailyBar: { ...BAR, t: "2026-09-02T04:00:00Z", c: 95.4 },
            },
          },
          next_page_token: null,
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  let rows;
  try {
    const provider = new AlpacaOptionsProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    rows = await provider.chain("AAPL", "2026-09-18");
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(seen.length, 2, "one contracts call for the metadata, one for the prices");
  for (const url of seen) {
    assert.match(url, /expiration_date=2026-09-18/, "both calls are bounded to one expiry");
  }

  assert.equal(rows.length, 2);
  // Open interest exists only on the contracts endpoint and the mark exists
  // only on the data one. A row carries both or the panel has a hole in it.
  assert.equal(rows[0]?.openInterest, 12);
  assert.equal(rows[0]?.mark, (94.87 + 98.79) / 2);
  assert.equal(rows[0]?.bid, 94.87);
  assert.equal(rows[0]?.ask, 98.79);

  // A contract the data endpoint had nothing for is still a row: it is listed,
  // it just has no price, and dropping it would put a gap in the strike ladder.
  assert.equal(rows[1]?.symbol, "AAPL260918P00230000");
  assert.equal(rows[1]?.mark, null);
  assert.equal(rows[1]?.openInterest, 8);
});

/**
 * Greeks and implied volatility are not on this key, and this is the note that
 * stops someone adding the columns back.
 *
 * The fields are absent under the default feed and under `feed=indicative`;
 * `feed=opra` answers 403 "OPRA agreement is not signed". So the type carries
 * no delta and no IV, and a chain that grew those columns would render a column
 * of dashes. Verified against the live API, not the documentation.
 */
test("the chain row type has no greeks, because the feed has none to give", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    new Response(
      JSON.stringify(
        String(url).includes("/v2/options/contracts")
          ? { option_contracts: [{ symbol: "AAPL260918C00230000" }], next_page_token: null }
          : { snapshots: {} },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  let rows;
  try {
    const provider = new AlpacaOptionsProvider({ keyId: "k", secretKey: "s", feed: "iex" });
    rows = await provider.chain("AAPL", "2026-09-18");
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(
    Object.keys(rows[0] ?? {}).filter((key) => /greek|delta|vol|iv/i.test(key)),
    [],
  );
});
