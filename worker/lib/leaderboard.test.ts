import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkMove, rankClub, type ClubPortfolio, type Mark } from "./leaderboard.ts";

/**
 * The leaderboard is the screen members will argue about, so the arithmetic
 * behind the order is pinned here rather than trusted to look right.
 *
 * The cases below are the ones that actually go wrong: a short ranked as a
 * loss when it is a gain, two members with different starting cash ranked by
 * dollars instead of return, a day change measured before there is a previous
 * close to measure against, and a tie broken by inventing an order.
 */

function member(
  name: string,
  cash: number,
  positions: ClubPortfolio["positions"] = [],
  startingCash = 100_000,
): ClubPortfolio {
  return {
    portfolioId: `pf-${name}`,
    userId: `u-${name}`,
    displayName: name,
    role: "member",
    cash,
    startingCash,
    positions,
  };
}

function marks(entries: Record<string, [number, number | null]>): Map<string, Mark> {
  return new Map(
    Object.entries(entries).map(([symbol, [price, prevClose]]) => [symbol, { price, prevClose }]),
  );
}

test("a member who never trades sits at exactly zero", () => {
  const { rows, summary } = rankClub([member("Ada", 100_000)], new Map(), null);

  assert.equal(rows[0]!.equity, 100_000);
  assert.equal(rows[0]!.totalPnl, 0);
  assert.equal(rows[0]!.totalReturn, 0);
  assert.equal(rows[0]!.dayPnl, 0);
  assert.equal(rows[0]!.top, null);
  assert.equal(summary.members, 1);
});

test("a profitable short ranks as a gain, not a loss", () => {
  // Short 100 TSLA at 300, now 250. The position lost $5,000 of market value
  // and the member is $5,000 up: equity = cash + long - short.
  const short = member("Grace", 130_000, [{ symbol: "TSLA", qty: -100, avgCost: 300 }]);
  const long = member("Alan", 70_000, [{ symbol: "TSLA", qty: 100, avgCost: 300 }]);

  const { rows } = rankClub([long, short], marks({ TSLA: [250, 250] }), null);

  assert.equal(rows[0]!.displayName, "Grace");
  assert.equal(rows[0]!.equity, 105_000);
  assert.equal(rows[0]!.totalReturn, 5);
  assert.equal(rows[0]!.shortMv, 25_000);

  assert.equal(rows[1]!.displayName, "Alan");
  assert.equal(rows[1]!.equity, 95_000);
  assert.equal(rows[1]!.totalReturn, -5);
});

test("ranking is by return, so a smaller account can win", () => {
  // Dollar P/L would put Bea first. Return puts Cy first, which is the
  // question this screen exists to answer.
  const bea = member("Bea", 210_000, [], 200_000);
  const cy = member("Cy", 11_000, [], 10_000);

  const { rows } = rankClub([bea, cy], new Map(), null);

  assert.deepEqual(
    rows.map((row) => [row.displayName, row.rank, row.totalReturn]),
    [
      ["Cy", 1, 10],
      ["Bea", 2, 5],
    ],
  );
});

test("a tie shares a rank and the next one skips", () => {
  const rows = rankClub(
    [member("Cy", 110_000), member("Ada", 110_000), member("Bea", 90_000)],
    new Map(),
    null,
  ).rows;

  assert.deepEqual(
    rows.map((row) => [row.displayName, row.rank]),
    [
      // Tied members are alphabetical rather than in database order.
      ["Ada", 1],
      ["Cy", 1],
      ["Bea", 3],
    ],
  );
});

test("day P/L needs a previous close, and is zero without one", () => {
  const bought = member("Ada", 90_000, [{ symbol: "NVDA", qty: 100, avgCost: 100 }]);

  // Listed this morning: a price, but nothing to compare it to. Counting the
  // whole $2,000 of P/L as today's move would be a lie about the day.
  const fresh = rankClub([bought], marks({ NVDA: [120, null] }), null).rows[0]!;
  assert.equal(fresh.totalPnl, 2_000);
  assert.equal(fresh.dayPnl, 0);
  assert.equal(fresh.dayReturn, 0);

  // With yesterday's close, the day is the move since it.
  const settled = rankClub([bought], marks({ NVDA: [120, 110] }), null).rows[0]!;
  assert.equal(settled.dayPnl, 1_000);
  assert.equal(settled.equity, 102_000);
  assert.equal(settled.dayReturn, round2((1_000 / 101_000) * 100));
});

test("an unpriced symbol is carried at cost and counted, not dropped", () => {
  const halted = member("Ada", 50_000, [
    { symbol: "AAPL", qty: 100, avgCost: 200 },
    { symbol: "XXXX", qty: 100, avgCost: 300 },
  ]);

  const row = rankClub([halted], marks({ AAPL: [250, 240] }), null).rows[0]!;

  // XXXX is valued at its own cost — break-even — rather than at zero, which
  // would report a loss the member has not taken.
  assert.equal(row.longMv, 25_000 + 30_000);
  assert.equal(row.unpriced, 1);
  assert.equal(row.dayPnl, 1_000);
});

test("the top holding is the largest by absolute value, short or long", () => {
  const row = rankClub(
    [
      member("Ada", 50_000, [
        { symbol: "AAPL", qty: 100, avgCost: 200 },
        { symbol: "TSLA", qty: -200, avgCost: 300 },
      ]),
    ],
    marks({ AAPL: [200, 200], TSLA: [300, 300] }),
    null,
  ).rows[0]!;

  assert.equal(row.top?.symbol, "TSLA");
  assert.equal(row.top?.isShort, true);
  // Gross exposure is 20,000 long + 60,000 short, so the short is 75% of it —
  // netting it against the long would report a member who is 0% exposed.
  assert.equal(row.top?.weight, 75);
});

test("excess return is against the benchmark, and null when there is none", () => {
  const rows = rankClub([member("Ada", 108_000), member("Bea", 102_000)], new Map(), 5).rows;

  assert.equal(rows[0]!.excess, 3);
  assert.equal(rows[1]!.excess, -3);

  // No bars, no benchmark. Every excess is null rather than zero: "we could not
  // measure it" and "you matched the market exactly" are different claims.
  const blind = rankClub([member("Ada", 108_000)], new Map(), null).rows[0]!;
  assert.equal(blind.excess, null);
});

test("the club summary averages members, not dollars", () => {
  // One large account up 1% and one small account up 11%. Weighting by size
  // would report the club at roughly 1%; one member, one vote reports 6%.
  const { summary } = rankClub(
    [member("Bea", 1_010_000, [], 1_000_000), member("Cy", 11_100, [], 10_000)],
    new Map(),
    5,
  );

  assert.equal(summary.averageReturn, 6);
  assert.equal(summary.medianReturn, 6);
  assert.equal(summary.bestReturn, 11);
  assert.equal(summary.worstReturn, 1);
  assert.equal(summary.beatingBenchmark, 1);
  assert.equal(summary.totalEquity, 1_021_100);
});

test("an empty club summarises to nulls rather than zeroes", () => {
  const { rows, summary } = rankClub([], new Map(), 5);

  assert.equal(rows.length, 0);
  assert.equal(summary.members, 0);
  // Zero would draw a flat line at the origin and read as "the club is up 0%".
  assert.equal(summary.averageReturn, null);
  assert.equal(summary.beatingBenchmark, null);
});

test("benchmarkMove reads the window's first close, and prefers a live mark", () => {
  assert.equal(benchmarkMove([100, 105, 110]), 10);

  // A leading gap is not a baseline of zero.
  assert.equal(benchmarkMove([null, 200, 220]), 10);

  // Today's bar is partial; the live quote is the better last point.
  assert.equal(benchmarkMove([100, 105, 110], 120), 20);

  assert.equal(benchmarkMove([]), null);
  assert.equal(benchmarkMove([null, null]), null);
});

function round2(value: number): number {
  return Number(value.toFixed(2));
}
