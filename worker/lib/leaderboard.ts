import { marketValues, round, type Position } from "../orders/engine.ts";

/**
 * Ranking the club.
 *
 * The arithmetic only, with no I/O, so it can be tested against the cases that
 * actually go wrong — a short drawn upside down, a member funded with a
 * different amount, a day change measured before there is a previous close.
 * `worker/routes/leaderboard.ts` is the half that fetches things.
 *
 * Three decisions are worth stating, because each has an obvious wrong answer:
 *
 * **Rank by return, not by NAV.** They are the same ordering while everyone
 * starts with the same cash, and they stop being the same the moment an officer
 * changes the starting cash or a member joins a season already in progress. The
 * question the screen answers is "who is trading well", and that is the return.
 *
 * **Every member's baseline is their own.** portfolios.starting_cash, stamped at
 * signup — see migration 0005. Measuring a March joiner against January's
 * number would hand them a return they did not earn.
 *
 * **The benchmark is a column, not a rank.** SPY does not appear in the
 * standings, because a member is not competing with an index for a place; the
 * index is the ruler laid alongside. What is ranked is people.
 */

/** A member's book, as the route reads it out of the database. */
export interface ClubPortfolio {
  portfolioId: string;
  userId: string;
  displayName: string;
  role: "member" | "admin";
  cash: number;
  /** What this member was funded with. The denominator of their return. */
  startingCash: number;
  positions: Position[];
}

/** What a symbol is worth now, and what it closed at yesterday. */
export interface Mark {
  price: number;
  /** Null before the first print of a session, or on a symbol nothing prices. */
  prevClose: number | null;
}

/** The member's largest holding by absolute market value. */
export interface TopHolding {
  symbol: string;
  marketValue: number;
  /** Share of gross exposure, so a short counts toward what it consumes. */
  weight: number;
  isShort: boolean;
}

export interface LeaderboardRow {
  /** Competition ranking: a tie takes the same number and the next one skips. */
  rank: number;
  portfolioId: string;
  userId: string;
  displayName: string;
  role: "member" | "admin";
  equity: number;
  cash: number;
  longMv: number;
  shortMv: number;
  positions: number;
  totalPnl: number;
  /** Percent since this member was funded. The ranked figure. */
  totalReturn: number;
  dayPnl: number;
  /** Percent against yesterday's close of the same book. */
  dayReturn: number;
  /** Total return minus the benchmark's over the same window. Null with no bench. */
  excess: number | null;
  top: TopHolding | null;
  /** Positions carried at average cost because nothing could price them. */
  unpriced: number;
}

export interface ClubSummary {
  members: number;
  /** One member, one vote — not weighted by account size. */
  averageReturn: number | null;
  medianReturn: number | null;
  bestReturn: number | null;
  worstReturn: number | null;
  /** How many members are ahead of the benchmark. Null without one. */
  beatingBenchmark: number | null;
  totalEquity: number;
}

export interface RankedClub {
  rows: LeaderboardRow[];
  summary: ClubSummary;
}

/**
 * Value every member's book at one set of marks and put them in order.
 *
 * `benchmarkReturn` is SPY's percentage move over the same window, or null when
 * the bars were unavailable — in which case the excess column is null for
 * everyone rather than zero, because "we could not measure it" and "you matched
 * the market exactly" are not the same claim.
 */
export function rankClub(
  portfolios: ClubPortfolio[],
  marks: Map<string, Mark>,
  benchmarkReturn: number | null,
): RankedClub {
  const priced = portfolios.map((portfolio) => valueMember(portfolio, marks, benchmarkReturn));

  // Descending by return, then by name, so a screen full of members who have
  // not traded yet is alphabetical rather than in whatever order Postgres
  // happened to return them.
  priced.sort(
    (a, b) => b.totalReturn - a.totalReturn || a.displayName.localeCompare(b.displayName),
  );

  // Competition ranking: two members on exactly the same return are both 4th
  // and the next one is 6th. Numbering them 4 and 5 would assert an order the
  // data does not contain.
  const rows: LeaderboardRow[] = [];
  for (const [index, row] of priced.entries()) {
    const previous = rows[index - 1];
    rows.push({
      ...row,
      rank: previous && previous.totalReturn === row.totalReturn ? previous.rank : index + 1,
    });
  }

  return { rows, summary: summarise(rows, benchmarkReturn) };
}

function valueMember(
  portfolio: ClubPortfolio,
  marks: Map<string, Mark>,
  benchmarkReturn: number | null,
): Omit<LeaderboardRow, "rank"> {
  const prices: Record<string, number> = {};
  for (const position of portfolio.positions) {
    const mark = marks.get(position.symbol);
    if (mark && Number.isFinite(mark.price) && mark.price > 0) {
      prices[position.symbol] = mark.price;
    }
  }

  // marketValues() is the same function the order route values a fill with, and
  // it applies the same fallback: a symbol nothing can price is carried at its
  // average cost rather than dropped, which values it at break-even.
  const valuation = marketValues(portfolio.positions, prices, portfolio.cash);

  const gross = valuation.longMv + valuation.shortMv;

  let dayPnl = 0;
  let unpriced = 0;
  let top: TopHolding | null = null;

  for (const position of portfolio.positions) {
    const mark = marks.get(position.symbol);
    const price = prices[position.symbol] ?? position.avgCost;
    if (!mark) unpriced += 1;

    // No previous close means no day to measure against, and zero is the honest
    // answer — the alternative is the position's whole P/L wearing a day's
    // clothes.
    if (mark?.prevClose != null && mark.prevClose > 0) {
      dayPnl += (price - mark.prevClose) * position.qty;
    }

    const marketValue = position.qty * price;
    if (!top || Math.abs(marketValue) > Math.abs(top.marketValue)) {
      top = {
        symbol: position.symbol,
        marketValue: round(marketValue, 2),
        weight: gross === 0 ? 0 : round((Math.abs(marketValue) / gross) * 100, 2),
        isShort: position.qty < 0,
      };
    }
  }

  dayPnl = round(dayPnl, 2);

  const totalPnl = round(valuation.equity - portfolio.startingCash, 2);
  const totalReturn =
    portfolio.startingCash === 0 ? 0 : round((totalPnl / portfolio.startingCash) * 100, 2);

  // Yesterday's value of today's book. Not the same as yesterday's equity — a
  // member who traded this morning changed the book — but it is the only
  // denominator that makes the day's move a percentage of anything real.
  const priorEquity = valuation.equity - dayPnl;
  const dayReturn = priorEquity === 0 ? 0 : round((dayPnl / priorEquity) * 100, 2);

  return {
    portfolioId: portfolio.portfolioId,
    userId: portfolio.userId,
    displayName: portfolio.displayName,
    role: portfolio.role,
    equity: valuation.equity,
    cash: round(portfolio.cash, 2),
    longMv: valuation.longMv,
    shortMv: valuation.shortMv,
    positions: portfolio.positions.length,
    totalPnl,
    totalReturn,
    dayPnl,
    dayReturn,
    excess: benchmarkReturn === null ? null : round(totalReturn - benchmarkReturn, 2),
    top,
    unpriced,
  };
}

function summarise(rows: LeaderboardRow[], benchmarkReturn: number | null): ClubSummary {
  if (rows.length === 0) {
    return {
      members: 0,
      averageReturn: null,
      medianReturn: null,
      bestReturn: null,
      worstReturn: null,
      beatingBenchmark: null,
      totalEquity: 0,
    };
  }

  const returns = rows.map((row) => row.totalReturn);
  const sorted = [...returns].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return {
    members: rows.length,
    averageReturn: round(returns.reduce((sum, value) => sum + value, 0) / returns.length, 2),
    medianReturn:
      sorted.length % 2 === 1
        ? sorted[middle]!
        : round((sorted[middle - 1]! + sorted[middle]!) / 2, 2),
    // rows are already sorted by return, descending.
    bestReturn: rows[0]!.totalReturn,
    worstReturn: rows[rows.length - 1]!.totalReturn,
    beatingBenchmark:
      benchmarkReturn === null
        ? null
        : rows.filter((row) => row.totalReturn > benchmarkReturn).length,
    totalEquity: round(
      rows.reduce((sum, row) => sum + row.equity, 0),
      2,
    ),
  };
}

/**
 * A benchmark's percentage move across a series of closes.
 *
 * The first close in the window is the baseline and the last is the mark, which
 * is the same convention `totalReturn()` in the curve uses — the two figures
 * appear on adjacent screens and disagreeing about what "SPY is up 4%" means
 * would be worse than either being slightly off.
 */
export function benchmarkMove(
  closes: readonly (number | null)[],
  latest?: number | null,
): number | null {
  const first = closes.find((value): value is number => value !== null && value > 0);
  if (first === undefined) return null;

  const last =
    latest != null && latest > 0
      ? latest
      : [...closes].reverse().find((value): value is number => value !== null && value > 0);

  if (last === undefined) return null;
  return round(((last - first) / first) * 100, 2);
}
