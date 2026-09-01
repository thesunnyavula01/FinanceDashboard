import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyBar, IntradayBar } from "../market/provider.ts";
import {
  closesAsOf,
  intradaySeries,
  latestSession,
  previousSession,
  regularHours,
  sessionStamps,
} from "./history.ts";

/**
 * Which session the 1D chart draws, and what it measures against.
 *
 * The arithmetic of the day is pinned in curve.test.ts. This pins the part that
 * decides *which day* — and it is the part with the failure modes, because
 * every one of them is silent. A chart that quietly draws Friday on a Tuesday
 * looks exactly like a chart that draws Tuesday. So does one anchored on this
 * morning's open instead of last night's close: same shape, wrong number, and
 * the only tell is that it disagrees with the day P/L on the grid beside it.
 *
 * There is no holiday list anywhere in this code and there must not be. SPY
 * trades every minute of every session and never halts, so "which sessions
 * exist" is answered by asking which sessions SPY printed bars for — the same
 * trick the season-long axis plays one resolution up.
 */

/** 09:30, 09:35 and 09:40 ET on the given date. March is EST, so ET+5. */
function stamps(date: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${date}T${String(14).padStart(2, "0")}:${String(30 + i * 5).padStart(2, "0")}:00Z`,
  );
}

function minuteBars(date: string, closes: number[], open = closes[0]!): IntradayBar[] {
  return stamps(date, closes.length).map((at, i) => ({
    at,
    date,
    open: i === 0 ? open : closes[i - 1]!,
    high: closes[i]!,
    low: closes[i]!,
    close: closes[i]!,
    volume: 1_000,
  }));
}

function dayBars(series: Record<string, number>): DailyBar[] {
  return Object.entries(series).map(([date, close]) => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  }));
}

/** A bar at a given ET wall-clock time on 2026-03-04, which is EST (ET+5). */
function barAt(time: string, close = 600): IntradayBar {
  const [hour, minute] = time.split(":").map(Number);
  const utc = String((hour! + 5) % 24).padStart(2, "0");
  return {
    at: `2026-03-04T${utc}:${String(minute!).padStart(2, "0")}:00Z`,
    date: "2026-03-04",
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

// ---------------------------------------------------------------------------
// The session's bounds
// ---------------------------------------------------------------------------

test("pre-market and after-hours buckets are dropped from the axis", () => {
  // Alpaca's bars run the full 04:00-20:00 extended day. Drawing them would
  // stretch a six-and-a-half-hour chart to sixteen and hand its most prominent
  // moves to the thinnest prints of the day — and nothing else in this app
  // treats those hours as the market being open.
  const minute = new Map([
    ["SPY", [barAt("07:15"), barAt("09:30"), barAt("15:55"), barAt("16:00"), barAt("18:40")]],
  ]);

  const kept = regularHours(minute, new Map());

  assert.deepEqual(
    kept.get("SPY")?.map((bar) => bar.at),
    [barAt("09:30").at, barAt("15:55").at],
  );
});

test("a half day ends at the bell the exchange actually rang", () => {
  // The Friday after Thanksgiving closes at 13:00. Without the calendar the
  // chart would draw three flat hours of after-hours prints past the close and
  // present them as the session.
  const minute = new Map([["SPY", [barAt("12:55"), barAt("13:00"), barAt("14:30")]]]);

  const calendar = new Map([
    ["2026-03-04", { date: "2026-03-04", openMinute: 9 * 60 + 30, closeMinute: 13 * 60 }],
  ]);

  assert.deepEqual(
    regularHours(minute, calendar).get("SPY")?.map((bar) => bar.at),
    [barAt("12:55").at],
  );
});

test("a symbol left with nothing in hours is absent, not empty", () => {
  // The difference between "this ticker has no intraday data" and "it did not
  // print in that bucket", which is the same distinction the bar cache keeps.
  const minute = new Map([["THIN", [barAt("05:10"), barAt("19:30")]]]);

  assert.equal(regularHours(minute, new Map()).has("THIN"), false);
});

// ---------------------------------------------------------------------------
// Picking the session
// ---------------------------------------------------------------------------

test("the session drawn is the last one SPY actually printed", () => {
  const minute = new Map([
    ["SPY", [...minuteBars("2026-03-03", [600, 601]), ...minuteBars("2026-03-04", [602, 604])]],
  ]);

  assert.equal(latestSession(minute), "2026-03-04");
});

test("before the opening bell the chart falls back to yesterday", () => {
  // 07:00 on a Wednesday: today is a trading day, and there is not one bar of
  // it yet. Every broker shows yesterday here, and so does this — without ever
  // asking what time it is.
  const minute = new Map([["SPY", minuteBars("2026-03-03", [600, 601, 602])]]);

  assert.equal(latestSession(minute), "2026-03-03");
});

test("a thin name cannot extend the session past where SPY stopped", () => {
  // A late print on a half day, or a name whose IEX bar lands in a bucket SPY's
  // did not. SPY is the calendar; nothing else gets a vote while it has bars.
  const minute = new Map([
    ["SPY", minuteBars("2026-03-04", [602, 604])],
    ["THIN", minuteBars("2026-03-05", [10, 11, 12])],
  ]);

  assert.equal(latestSession(minute), "2026-03-04");
  assert.deepEqual(sessionStamps(minute, "2026-03-04"), stamps("2026-03-04", 2));
});

test("with no SPY at all the axis falls back to whatever did print", () => {
  const minute = new Map([["AAPL", minuteBars("2026-03-04", [100, 101, 102])]]);

  assert.equal(latestSession(minute), "2026-03-04");
  assert.deepEqual(sessionStamps(minute, "2026-03-04"), stamps("2026-03-04", 3));
  assert.equal(latestSession(new Map()), null);
});

test("the axis ends where the session did, which is what handles a half day", () => {
  // The 1pm close on Christmas Eve is not a special case here: SPY simply has
  // no bars after it, so neither does the chart.
  const minute = new Map([["SPY", minuteBars("2026-03-04", [602, 604, 603])]]);

  assert.deepEqual(sessionStamps(minute, "2026-03-04"), stamps("2026-03-04", 3));
});

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

test("the previous session skips the weekend without counting days", () => {
  const daily = new Map([
    ["SPY", dayBars({ "2026-02-27": 598, "2026-03-02": 600, "2026-03-03": 601 })],
  ]);

  // Monday's previous session is the Friday before it.
  assert.equal(previousSession(daily, "2026-03-02"), "2026-02-27");
  assert.equal(previousSession(daily, "2026-03-03"), "2026-03-02");
  // Nothing before the first bar there is.
  assert.equal(previousSession(daily, "2026-02-27"), null);
});

test("today's partial daily bar is never mistaken for the previous close", () => {
  // Alpaca serves an in-progress daily bar during the session. Reading it as
  // "yesterday" would measure the day's change against itself and draw a line
  // that starts flat and stays flat.
  const daily = new Map([["SPY", dayBars({ "2026-03-03": 601, "2026-03-04": 604 })]]);

  assert.equal(previousSession(daily, "2026-03-04"), "2026-03-03");
});

test("a name that did not trade yesterday is still worth its last close", () => {
  const daily = new Map([
    ["SPY", dayBars({ "2026-03-02": 600, "2026-03-03": 601 })],
    // Halted through Tuesday. The mark is Monday's close, not nothing.
    ["HALT", dayBars({ "2026-03-02": 50 })],
    // Listed after the baseline session: no opening mark exists.
    ["IPO", dayBars({ "2026-03-04": 25 })],
  ]);

  const closes = closesAsOf(daily, "2026-03-03");

  assert.equal(closes.get("SPY"), 601);
  assert.equal(closes.get("HALT"), 50);
  assert.equal(closes.has("IPO"), false);
  assert.equal(closesAsOf(daily, null).size, 0);
});

// ---------------------------------------------------------------------------
// The benchmark line
// ---------------------------------------------------------------------------

test("a benchmark starts the day at its previous close, not at its open", () => {
  // SPY closed at 600 and gapped up to 606 at the bell. Anchoring on the open
  // would hide that 1% — which on most days is most of the move — and would
  // put SPY level with the account at 09:30 when it is a full point ahead.
  const minute = new Map([["SPY", minuteBars("2026-03-04", [606, 612], 606)]]);
  const prevCloses = new Map([["SPY", 600]]);

  const series = intradaySeries(
    minute,
    "SPY",
    stamps("2026-03-04", 2),
    "2026-03-04",
    prevCloses,
    100_000,
    new Map(),
  );

  assert.deepEqual(series, [101_000, 102_000]);
});

test("a benchmark bucket with no print carries forward, and the last one goes live", () => {
  const axis = stamps("2026-03-04", 3);
  const minute = new Map([
    [
      "SPY",
      // Deliberately missing the middle bucket.
      minuteBars("2026-03-04", [606, 612], 606).filter((_, i) => i !== 1),
    ],
  ]);

  const carried = intradaySeries(
    minute,
    "SPY",
    axis,
    "2026-03-04",
    new Map([["SPY", 600]]),
    100_000,
    new Map(),
  );

  assert.deepEqual(carried, [101_000, 101_000, 101_000]);

  // With a live mark, the right edge is now rather than up to five minutes ago,
  // so the gap between this line and the account's is one instant.
  const live = intradaySeries(
    minute,
    "SPY",
    axis,
    "2026-03-04",
    new Map([["SPY", 600]]),
    100_000,
    new Map([["SPY", 618]]),
  );

  assert.deepEqual(live, [101_000, 101_000, 103_000]);
});

test("a benchmark with no bars for the session is absent, not zero", () => {
  const series = intradaySeries(
    new Map(),
    "QQQ",
    stamps("2026-03-04", 2),
    "2026-03-04",
    new Map([["QQQ", 500]]),
    100_000,
    new Map(),
  );

  assert.deepEqual(series, [null, null]);
});

test("with no previous close the benchmark measures from the bell instead", () => {
  // Weaker than measuring from yesterday, and still drawable. The alternative
  // is dropping the ruler off the chart entirely.
  const minute = new Map([["SPY", minuteBars("2026-03-04", [606, 612], 600)]]);

  const series = intradaySeries(
    minute,
    "SPY",
    stamps("2026-03-04", 2),
    "2026-03-04",
    new Map(),
    100_000,
    new Map(),
  );

  assert.deepEqual(series, [101_000, 102_000]);
});
