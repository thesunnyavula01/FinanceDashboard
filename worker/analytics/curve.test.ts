import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignCloses,
  cashDelta,
  indexTo100,
  parseRange,
  qtyDelta,
  rangeStart,
  replayEquity,
  shiftDate,
  totalReturn,
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

test("total return spans the first and last usable values", () => {
  assert.equal(totalReturn([100, 110]), 10);
  assert.equal(totalReturn([null, 200, 150]), -25);
  assert.equal(totalReturn([null, null]), null);
});

test("date shifting is UTC and does not drift", () => {
  assert.equal(shiftDate("2026-03-02", { days: 7 }), "2026-02-23");
  assert.equal(shiftDate("2026-03-31", { months: 3 }), "2025-12-31");
  assert.equal(shiftDate("2026-01-05", { months: 1 }), "2025-12-05");
});

test("a range never starts before the season does", () => {
  const seasonStart = "2026-08-01";
  const today = "2026-08-30";

  // A club that began in August has no 3 months and no January.
  assert.equal(rangeStart("3M", today, seasonStart), seasonStart);
  assert.equal(rangeStart("YTD", today, seasonStart), seasonStart);
  assert.equal(rangeStart("ALL", today, seasonStart), seasonStart);
  // A week fits inside it, so it is honoured.
  assert.equal(rangeStart("1W", today, seasonStart), "2026-08-23");
});

test("YTD and ALL differ once a season spans a new year", () => {
  const seasonStart = "2025-09-02";
  const today = "2026-03-04";

  assert.equal(rangeStart("YTD", today, seasonStart), "2026-01-01");
  assert.equal(rangeStart("ALL", today, seasonStart), seasonStart);
});

test("an unrecognised range falls back to the whole season", () => {
  assert.equal(parseRange("1w"), "1W");
  assert.equal(parseRange(" ytd "), "YTD");
  assert.equal(parseRange("6M"), "ALL");
  assert.equal(parseRange(null), "ALL");
});
