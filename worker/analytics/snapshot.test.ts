import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyBar } from "../market/provider.ts";
import {
  benchmarkRows,
  closesOn,
  snapshotRows,
  tradedOn,
  type SnapshotPortfolio,
} from "./snapshot.ts";

/**
 * The nightly job writes rows that are never recomputed — `history.ts` prefers
 * a stored snapshot to a replay precisely because it is supposed to be the
 * better number. So the cases pinned here are the ones that would put a
 * permanent wrong answer in the table: a short valued as though it were long,
 * a halted ticker read as worthless, a holiday mistaken for a session, and a
 * snapshot that disagrees with the replay of the same day.
 */

function bars(series: Record<string, Record<string, number>>): Map<string, DailyBar[]> {
  return new Map(
    Object.entries(series).map(([symbol, byDate]) => [
      symbol,
      Object.entries(byDate).map(([date, close]) => ({
        date,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000,
      })),
    ]),
  );
}

function book(cash: number, positions: SnapshotPortfolio["positions"]): SnapshotPortfolio {
  return { portfolioId: "p1", cash, positions };
}

test("a SPY bar dated today is what makes today a session", () => {
  const week = bars({ SPY: { "2026-11-25": 500, "2026-11-27": 505 } });

  assert.equal(tradedOn(week, "2026-11-25"), true);
  // Thanksgiving. No SPY bar, so no snapshot — without enumerating a holiday.
  assert.equal(tradedOn(week, "2026-11-26"), false);
  // The weekend fails the same test for the same reason.
  assert.equal(tradedOn(week, "2026-11-28"), false);
});

test("a zero close is not a session", () => {
  // A malformed bar must not be read as "the market traded and SPY is free".
  assert.equal(tradedOn(bars({ SPY: { "2026-03-02": 0 } }), "2026-03-02"), false);
});

test("closes carry forward, so a halted ticker is not valued at zero", () => {
  const week = bars({
    SPY: { "2026-03-02": 500, "2026-03-03": 505, "2026-03-04": 510 },
    HALT: { "2026-03-02": 40 },
  });

  const marks = closesOn(week, "2026-03-04");

  assert.equal(marks.get("SPY"), 510);
  // Two sessions without a print. The last real close stands.
  assert.equal(marks.get("HALT"), 40);
});

test("a close after the snapshot date is never used", () => {
  // The fortnight of bars the job pulls contains dates on both sides of the
  // session being recorded whenever it is re-run for an earlier day.
  const marks = closesOn(bars({ AAPL: { "2026-03-02": 100, "2026-03-03": 130 } }), "2026-03-02");
  assert.equal(marks.get("AAPL"), 100);
});

test("a symbol with no bar in the window is absent, not zero", () => {
  const marks = closesOn(bars({ SPY: { "2026-03-02": 500 } }), "2026-03-02");
  assert.equal(marks.has("DELISTED"), false);
});

test("equity is cash plus longs minus shorts", () => {
  const marks = new Map([
    ["AAPL", 200],
    ["TSLA", 300],
  ]);

  const { rows, unpriced } = snapshotRows(
    [
      book(10_000, [
        { symbol: "AAPL", qty: 50, avgCost: 180 },
        // Signed quantity: negative is short, and it subtracts.
        { symbol: "TSLA", qty: -10, avgCost: 320 },
      ]),
    ],
    marks,
    "2026-03-04",
  );

  const row = rows[0]!;
  assert.equal(row.long_mv, 10_000);
  assert.equal(row.short_mv, 3_000);
  assert.equal(row.equity, 17_000);
  assert.equal(row.cash, 10_000);
  assert.equal(row.as_of, "2026-03-04");
  assert.equal(unpriced, 0);
});

test("a short that has fallen is worth more, not less", () => {
  const sold = snapshotRows([book(10_000, [{ symbol: "TSLA", qty: -10, avgCost: 300 }])], new Map([["TSLA", 300]]), "2026-03-04");
  const fallen = snapshotRows([book(10_000, [{ symbol: "TSLA", qty: -10, avgCost: 300 }])], new Map([["TSLA", 250]]), "2026-03-04");

  assert.equal(sold.rows[0]!.equity, 7_000);
  assert.equal(fallen.rows[0]!.equity, 7_500);
});

test("an unpriced position is carried at cost and counted", () => {
  const { rows, unpriced } = snapshotRows(
    [
      book(1_000, [
        { symbol: "AAPL", qty: 10, avgCost: 100 },
        { symbol: "GONE", qty: 5, avgCost: 20 },
      ]),
    ],
    new Map([["AAPL", 150]]),
    "2026-03-04",
  );

  // Break-even for the unpriceable name — 5 x 20 — rather than zero, which
  // would report a loss the member did not take.
  assert.equal(rows[0]!.long_mv, 1_600);
  assert.equal(rows[0]!.equity, 2_600);
  assert.equal(unpriced, 1);
});

test("a member who has never traded still gets a row", () => {
  const { rows } = snapshotRows([book(25_000, [])], new Map(), "2026-03-04");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.equity, 25_000);
  assert.equal(rows[0]!.long_mv, 0);
  assert.equal(rows[0]!.short_mv, 0);
});

test("every book is stamped with the same session", () => {
  const { rows } = snapshotRows(
    [
      { portfolioId: "a", cash: 100, positions: [] },
      { portfolioId: "b", cash: 200, positions: [] },
    ],
    new Map(),
    "2026-03-04",
  );

  assert.deepEqual(
    rows.map((row) => [row.portfolio_id, row.as_of]),
    [
      ["a", "2026-03-04"],
      ["b", "2026-03-04"],
    ],
  );
});

test("benchmark rows cover the window, which is what repairs a missed night", () => {
  const rows = benchmarkRows(
    bars({
      SPY: { "2026-03-02": 500, "2026-03-03": 505 },
      QQQ: { "2026-03-02": 400, "2026-03-03": 402 },
    }),
    ["SPY", "QQQ"],
    "2026-03-01",
  );

  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { symbol: "SPY", as_of: "2026-03-02", close: 500 });
  assert.deepEqual(rows[3], { symbol: "QQQ", as_of: "2026-03-03", close: 402 });
});

test("bars before the window are not written", () => {
  const rows = benchmarkRows(
    bars({ SPY: { "2026-02-27": 490, "2026-03-02": 500 } }),
    ["SPY"],
    "2026-03-01",
  );

  assert.deepEqual(rows, [{ symbol: "SPY", as_of: "2026-03-02", close: 500 }]);
});

test("a snapshot agrees with a replay of the same session", async () => {
  // The reason both exist: history.ts merges them into one line, so a snapshot
  // priced differently from the replay would put a step in the curve on exactly
  // the days it was meant to improve. Both value the book at the official
  // close, so the two numbers have to land on top of each other.
  const { replayEquity } = await import("./curve.ts");

  const positions = [
    { symbol: "AAPL", qty: 10, avgCost: 100 },
    { symbol: "TSLA", qty: -5, avgCost: 300 },
  ];
  const closes = new Map([
    ["AAPL", 150],
    ["TSLA", 250],
  ]);

  const trades = [
    {
      symbol: "AAPL",
      side: "BUY" as const,
      qty: 10,
      price: 100,
      notional: 1_000,
      executedAt: "2026-03-02T14:35:00.000Z",
    },
    {
      symbol: "TSLA",
      side: "SHORT" as const,
      qty: 5,
      price: 300,
      notional: 1_500,
      executedAt: "2026-03-02T14:36:00.000Z",
    },
  ];

  const replayed = replayEquity({
    dates: ["2026-03-02"],
    trades,
    startingCash: 10_000,
    closes: new Map([...closes].map(([symbol, close]) => [symbol, new Map([["2026-03-02", close]])])),
  });

  // 10,000 - 1,000 + 1,500 = 10,500 cash, matching the replay's own arithmetic.
  const { rows } = snapshotRows([book(10_500, positions)], closes, "2026-03-02");

  assert.equal(rows[0]!.equity, replayed[0]!.equity);
});
