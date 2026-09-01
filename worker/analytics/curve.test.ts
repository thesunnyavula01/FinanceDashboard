import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignCloses,
  cashDelta,
  firstUsable,
  indexTo100,
  parseRange,
  qtyDelta,
  rangeStart,
  replayEquity,
  replayIntraday,
  returnFromBase,
  scaleTo,
  shiftDate,
  type TradeRecord,
} from "./curve.ts";

/**
 * The equity curve is the one screen a member will screenshot, so the
 * arithmetic behind it is pinned here rather than eyeballed against a chart.
 *
 * These are the cases that actually go wrong: a short drawn upside down, a
 * halted ticker read as worthless, a position bought this morning valued at
 * zero because it has no close yet, and a benchmark indexed off the wrong day.
 */

const SESSION = "T14:35:00.000Z"; // 10:35 ET — inside the session, in both DST offsets.

function fill(
  date: string,
  symbol: string,
  side: TradeRecord["side"],
  qty: number,
  price: number,
): TradeRecord {
  return {
    symbol,
    side,
    qty,
    price,
    notional: Number((qty * price).toFixed(2)),
    executedAt: `${date}${SESSION}`,
  };
}

function closesOf(series: Record<string, Record<string, number>>) {
  return new Map(
    Object.entries(series).map(([symbol, byDate]) => [symbol, new Map(Object.entries(byDate))]),
  );
}

const DATES = ["2026-03-02", "2026-03-03", "2026-03-04"];

test("cash and quantity move in opposite directions per side", () => {
  // A BUY pays out and takes on shares; a SHORT takes in cash and owes them.
  assert.equal(cashDelta({ side: "BUY", notional: 500 }), -500);
  assert.equal(cashDelta({ side: "COVER", notional: 500 }), -500);
  assert.equal(cashDelta({ side: "SELL", notional: 500 }), 500);
  assert.equal(cashDelta({ side: "SHORT", notional: 500 }), 500);

  assert.equal(qtyDelta({ side: "BUY", qty: 10 }), 10);
  assert.equal(qtyDelta({ side: "COVER", qty: 10 }), 10);
  assert.equal(qtyDelta({ side: "SELL", qty: 10 }), -10);
  assert.equal(qtyDelta({ side: "SHORT", qty: 10 }), -10);
});

test("a portfolio that never trades is flat at its starting cash", () => {
  const points = replayEquity({
    dates: DATES,
    trades: [],
    startingCash: 100_000,
    closes: new Map(),
  });

  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_000, 100_000],
  );
});

test("a long is valued at each session's close", () => {
  const points = replayEquity({
    dates: DATES,
    trades: [fill("2026-03-02", "AAPL", "BUY", 10, 100)],
    startingCash: 100_000,
    closes: closesOf({
      AAPL: { "2026-03-02": 100, "2026-03-03": 110, "2026-03-04": 90 },
    }),
  });

  // 99,000 cash throughout; the position marks 1,000 -> 1,100 -> 900.
  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_100, 99_900],
  );
  assert.deepEqual(
    points.map((p) => p.longMv),
    [1_000, 1_100, 900],
  );
});

test("a short gains when the price falls, with no sign branching", () => {
  const points = replayEquity({
    dates: DATES,
    trades: [fill("2026-03-02", "TSLA", "SHORT", 10, 100)],
    startingCash: 100_000,
    closes: closesOf({
      TSLA: { "2026-03-02": 100, "2026-03-03": 80, "2026-03-04": 130 },
    }),
  });

  // Proceeds of 1,000 land in cash; the obligation marks against it.
  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_200, 99_700],
  );
  assert.deepEqual(
    points.map((p) => p.shortMv),
    [1_000, 800, 1_300],
  );
});

test("a position opened before its first bar is marked at what it cost", () => {
  // Bought this morning: today's close does not exist yet. Valuing it at zero
  // would put a cliff in the curve; valuing it at the trade price is exactly
  // break-even, which is the truth.
  const points = replayEquity({
    dates: DATES,
    trades: [fill("2026-03-04", "IPO", "BUY", 4, 25)],
    startingCash: 1_000,
    closes: new Map(),
  });

  assert.deepEqual(
    points.map((p) => p.equity),
    [1_000, 1_000, 1_000],
  );
});

test("a session with no bar carries the last close forward", () => {
  // A halt, or a thin name. The gap must not read as a price of zero.
  const points = replayEquity({
    dates: DATES,
    trades: [fill("2026-03-02", "HALT", "BUY", 10, 50)],
    startingCash: 1_000,
    closes: closesOf({ HALT: { "2026-03-02": 50, "2026-03-04": 60 } }),
  });

  assert.deepEqual(
    points.map((p) => p.equity),
    [1_000, 1_000, 1_100],
  );
});

test("live marks apply to the final session only", () => {
  const points = replayEquity({
    dates: DATES,
    trades: [fill("2026-03-02", "NVDA", "BUY", 10, 100)],
    startingCash: 100_000,
    closes: closesOf({
      NVDA: { "2026-03-02": 100, "2026-03-03": 100, "2026-03-04": 100 },
    }),
    marks: new Map([["NVDA", 150]]),
  });

  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_000, 100_500],
  );
});

test("closing a position stops it being valued", () => {
  const points = replayEquity({
    dates: DATES,
    trades: [
      fill("2026-03-02", "AAPL", "BUY", 10, 100),
      fill("2026-03-03", "AAPL", "SELL", 10, 120),
    ],
    startingCash: 100_000,
    closes: closesOf({
      AAPL: { "2026-03-02": 100, "2026-03-03": 120, "2026-03-04": 10 },
    }),
  });

  // Out of the trade at 120 on the 3rd, so the crash on the 4th is not theirs.
  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_200, 100_200],
  );
});

test("fills are replayed in execution order, not in the order they arrive", () => {
  const first = fill("2026-03-02", "AAPL", "BUY", 10, 100);
  const second = fill("2026-03-03", "AAPL", "SELL", 4, 150);

  const points = replayEquity({
    dates: DATES,
    trades: [second, first],
    startingCash: 100_000,
    closes: closesOf({ AAPL: { "2026-03-03": 150 } }),
  });

  // Buy first, then sell: 99,600 of cash and six shares left marking at 150.
  assert.equal(points[1]!.cash, 99_600);
  assert.equal(points[1]!.equity, 100_500);
});

test("aligning a sparse series carries closes forward and gaps before the start", () => {
  const aligned = alignCloses(
    [
      { date: "2026-03-03", close: 500 },
      { date: "2026-03-05", close: 520 },
    ],
    ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"],
  );

  assert.deepEqual(aligned, [null, 500, 500, 520]);
});

test("indexing puts every line on 100 at its first usable value", () => {
  // Rounded, because an index is drawn, not reconciled: 110.00000000000001 is
  // the correct answer in binary floating point and the same pixel on screen.
  const round = (values: (number | null)[]) =>
    values.map((value) => (value === null ? null : Number(value.toFixed(6))));

  assert.deepEqual(round(indexTo100([200, 220, 180])), [100, 110, 90]);
  // A leading gap does not shift the base onto a later day.
  assert.deepEqual(round(indexTo100([null, 50, 75])), [null, 100, 150]);
  assert.deepEqual(indexTo100([null, null]), [null, null]);
});

test("scaling puts a benchmark onto the account's axis without reshaping it", () => {
  const round = (values: (number | null)[]) =>
    values.map((value) => (value === null ? null : Number(value.toFixed(6))));

  // $640 SPY, a $100,000 account: the line starts where the money did and the
  // percentage moves survive intact.
  assert.deepEqual(round(scaleTo([640, 672, 608], 100_000)), [100_000, 105_000, 95_000]);
  // An explicit base is the 1D case: the day starts at yesterday's close, which
  // is not one of the points on screen.
  assert.deepEqual(round(scaleTo([101, 102], 50_000, 100)), [50_500, 51_000]);
  // Nothing to scale from, and nothing to scale to.
  assert.deepEqual(scaleTo([null, null], 100_000), [null, null]);
  assert.deepEqual(scaleTo([640, 672], 0), [null, null]);
});

test("return is measured from an explicit base, not from the first point", () => {
  assert.equal(returnFromBase([100, 110], 100), 10);
  assert.equal(returnFromBase([null, 200, 150], 200), -25);
  // The 1D case: the account opened above yesterday's close and gave it back.
  // Measured from the open it is flat; measured from the close it is up 1%.
  assert.equal(returnFromBase([101_000, 101_000], 100_000), 1);
  assert.equal(returnFromBase([null, null], 100), null);
  assert.equal(returnFromBase([100], null), null);
});

test("the first usable value skips leading gaps and zeroes", () => {
  assert.equal(firstUsable([null, 0, 120, 130]), 120);
  assert.equal(firstUsable([null, null]), null);
});

test("date shifting is UTC and does not drift", () => {
  assert.equal(shiftDate("2026-03-02", { days: 7 }), "2026-02-23");
  assert.equal(shiftDate("2026-03-31", { months: 3 }), "2025-12-31");
  assert.equal(shiftDate("2026-01-05", { months: 1 }), "2025-12-05");
});

test("a range never starts before the season does", () => {
  const seasonStart = "2026-08-01";
  const today = "2026-08-30";

  // A club that began in August has no three months and no year behind it.
  assert.equal(rangeStart("3M", today, seasonStart), seasonStart);
  assert.equal(rangeStart("1Y", today, seasonStart), seasonStart);
  assert.equal(rangeStart("ALL", today, seasonStart), seasonStart);
  // A week fits inside it, so it is honoured.
  assert.equal(rangeStart("1W", today, seasonStart), "2026-08-23");
});

test("1Y and ALL differ once a season is older than a year", () => {
  const seasonStart = "2024-09-02";
  const today = "2026-03-04";

  assert.equal(rangeStart("1Y", today, seasonStart), "2025-03-04");
  assert.equal(rangeStart("ALL", today, seasonStart), seasonStart);
});

test("an unrecognised range falls back to the whole season", () => {
  assert.equal(parseRange("1d"), "1D");
  assert.equal(parseRange(" 1y "), "1Y");
  // YTD was a tab once. A stale client asking for it gets the season, not a 500.
  assert.equal(parseRange("YTD"), "ALL");
  assert.equal(parseRange("6M"), "ALL");
  assert.equal(parseRange(null), "ALL");
});

// ---------------------------------------------------------------------------
// 1D
// ---------------------------------------------------------------------------

/** 09:30, 09:35 and 09:40 ET on 2026-03-04, which is EST. */
const STAMPS = ["2026-03-04T14:30:00Z", "2026-03-04T14:35:00Z", "2026-03-04T14:40:00Z"];

function intradayFill(
  at: string,
  symbol: string,
  side: TradeRecord["side"],
  qty: number,
  price: number,
): TradeRecord {
  return { symbol, side, qty, price, notional: Number((qty * price).toFixed(2)), executedAt: at };
}

test("the day starts from yesterday's book valued at yesterday's closes", () => {
  // Bought 10 AAPL at 100 last week; it closed yesterday at 120. The day opens
  // with $99,000 of cash and $1,200 of stock, so the baseline is $100,200 —
  // not the $100,000 the season started with.
  const { base, points } = replayIntraday({
    stamps: STAMPS,
    sessionDate: "2026-03-04",
    trades: [intradayFill("2026-03-02T14:35:00Z", "AAPL", "BUY", 10, 100)],
    startingCash: 100_000,
    prices: new Map(),
    prevCloses: new Map([["AAPL", 120]]),
  });

  assert.equal(base, 100_200);
  // No prints today, so the position is carried at yesterday's close all day.
  assert.deepEqual(
    points.map((p) => p.equity),
    [100_200, 100_200, 100_200],
  );
});

test("a bucket with no print carries the last one forward", () => {
  const { points } = replayIntraday({
    stamps: STAMPS,
    sessionDate: "2026-03-04",
    trades: [intradayFill("2026-03-02T14:35:00Z", "THIN", "BUY", 10, 100)],
    startingCash: 100_000,
    // IEX is a slice of the tape: a thin name simply does not print in the
    // middle bucket. That is missing data, not a price of zero.
    prices: new Map([["THIN", new Map([[STAMPS[0]!, 110], [STAMPS[2]!, 130]])]]),
    prevCloses: new Map([["THIN", 100]]),
  });

  assert.deepEqual(
    points.map((p) => p.equity),
    [100_100, 100_100, 100_300],
  );
});

test("a fill mid-session lands on the bucket it happened in, not on the open", () => {
  const { base, points } = replayIntraday({
    stamps: STAMPS,
    sessionDate: "2026-03-04",
    // 09:33 ET, which is inside the 09:30 bucket and before the 09:35 one.
    trades: [intradayFill("2026-03-04T14:33:00Z", "NVDA", "BUY", 10, 100)],
    startingCash: 100_000,
    prices: new Map([["NVDA", new Map([[STAMPS[1]!, 100], [STAMPS[2]!, 150]])]]),
    prevCloses: new Map(),
  });

  // The day opened flat: nothing was held before the bell.
  assert.equal(base, 100_000);
  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_000, 100_500],
  );
});

test("a short drawn intraday gains as the price falls", () => {
  const { base, points } = replayIntraday({
    stamps: STAMPS,
    sessionDate: "2026-03-04",
    trades: [intradayFill("2026-03-02T14:35:00Z", "TSLA", "SHORT", 10, 100)],
    startingCash: 100_000,
    prices: new Map([["TSLA", new Map([[STAMPS[1]!, 80], [STAMPS[2]!, 130]])]]),
    prevCloses: new Map([["TSLA", 100]]),
  });

  // Proceeds of 1,000 landed in cash last week; the obligation marks against it.
  assert.equal(base, 100_000);
  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_200, 99_700],
  );
});

test("the last bucket takes the live mark and any fill that beat the bar", () => {
  const { points } = replayIntraday({
    stamps: STAMPS,
    sessionDate: "2026-03-04",
    trades: [
      intradayFill("2026-03-02T14:35:00Z", "NVDA", "BUY", 10, 100),
      // 09:44 ET: after the last bar opened, and the bar has not closed yet.
      // A member who just traded must see it rather than wait five minutes.
      intradayFill("2026-03-04T14:44:00Z", "NVDA", "BUY", 10, 100),
    ],
    startingCash: 100_000,
    prices: new Map([["NVDA", new Map([[STAMPS[2]!, 100]])]]),
    prevCloses: new Map([["NVDA", 100]]),
    marks: new Map([["NVDA", 150]]),
  });

  assert.deepEqual(
    points.map((p) => p.equity),
    // 99,000 + 10 x 100, twice over, then 98,000 of cash and 20 shares at the
    // live 150.
    [100_000, 100_000, 101_000],
  );
});

test("a fill from after the session on screen is not drawn into it", () => {
  // On a Saturday the chart draws Friday. Friday could not have known about a
  // fill that has not happened yet, and nor can its line.
  const { base, points } = replayIntraday({
    stamps: STAMPS,
    sessionDate: "2026-03-04",
    trades: [intradayFill("2026-03-05T14:35:00Z", "NVDA", "BUY", 10, 100)],
    startingCash: 100_000,
    prices: new Map(),
    prevCloses: new Map(),
  });

  assert.equal(base, 100_000);
  assert.deepEqual(
    points.map((p) => p.equity),
    [100_000, 100_000, 100_000],
  );
});
