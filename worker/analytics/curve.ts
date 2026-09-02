import { exchangeDate } from "../market/provider.ts";
import type { OrderSide } from "../orders/engine.ts";
import { multiplierFor } from "../market/symbols.ts";

/**
 * What can appear in the blotter, which is one more thing than can be ordered.
 *
 * An option that reaches its expiration date is settled for cash at intrinsic
 * value by the nightly job. That is not a sale — nobody chose it, and the price
 * can legitimately be zero — so it is booked as its own side rather than as a
 * SELL a member never placed.
 */
export type TradeSide = OrderSide | "EXPIRE";

/**
 * The equity curve, as arithmetic.
 *
 * A member's curve is one number per session: what their account was worth at
 * that day's close. Phase 7 will write those numbers nightly into
 * `portfolio_snapshots`, and once it has, they are the authority — they were
 * computed at the close against real marks and nothing here improves on them.
 *
 * But a season that started before the cron did has no snapshots, and a club
 * that just deployed has none at all. Rather than show an empty chart until the
 * first week of history accumulates, the curve is *reconstructed*: replay the
 * blotter forward and value the resulting positions at each session's official
 * close. Every input is already available — trades are in the database, daily
 * bars are free from Alpaca — so the past is recoverable exactly, and the
 * reconstruction and the snapshot agree wherever both exist.
 *
 * Nothing in this file does I/O. It takes fills, bars and a date axis, and
 * returns numbers, which is what lets `npm test` check the whole thing with no
 * database and no network.
 *
 * There is no long/short branching, for the same reason there is none in
 * src/lib/portfolio.ts: a short is a negative qty and the formulas are already
 * correct in both directions.
 */

/**
 * The ranges, in the order the tabs sit on screen.
 *
 * `1D` is the odd one and the reason half of this file exists: every other
 * range is one point per session and is answered by the replay below, while
 * 1D is one point per five-minute bar inside a single session and is answered
 * by `replayIntraday`. YTD is deliberately absent — a club season that starts
 * in the autumn makes it a second, worse spelling of ALL for most of the year,
 * and 1Y is the tab a member actually reaches for.
 */
export const CURVE_RANGES = ["1D", "1W", "1M", "3M", "1Y", "ALL"] as const;
export type CurveRange = (typeof CURVE_RANGES)[number];

/** The two indices every club measures itself against. */
export const BENCHMARKS = ["SPY", "QQQ"] as const;

/** One fill, as the blotter stores it: `qty` and `notional` always positive. */
export interface TradeRecord {
  symbol: string;
  side: TradeSide;
  qty: number;
  price: number;
  notional: number;
  /**
   * Shares per unit — 100 for an option contract. Absent on every fill written
   * before migration 0006, all of which are stocks and all of which are correct
   * at 1.
   */
  multiplier?: number;
  executedAt: string;
}

export interface EquityPoint {
  /** Exchange-local session date, YYYY-MM-DD. */
  date: string;
  equity: number;
  cash: number;
  longMv: number;
  shortMv: number;
}

/**
 * What a fill does to cash. Straight from place_order(): a BUY and a COVER pay
 * out their notional, a SELL and a SHORT take it in. The short's proceeds
 * really do land in cash — the margin that offsets them is a claim against it,
 * not a deduction from it.
 */
export function cashDelta(trade: Pick<TradeRecord, "side" | "notional">): number {
  // EXPIRE pays in like a SELL, because that is what it is: a sale at intrinsic
  // value. A worthless contract settles at a notional of zero, which moves cash
  // by zero — the direction is still the direction.
  return trade.side === "BUY" || trade.side === "COVER" ? -trade.notional : trade.notional;
}

/** What a fill does to the position. COVER buys back, so it moves qty upward. */
export function qtyDelta(trade: Pick<TradeRecord, "side" | "qty">): number {
  return trade.side === "BUY" || trade.side === "COVER" ? trade.qty : -trade.qty;
}

/**
 * Shares per unit for a fill, falling back to what the symbol implies.
 *
 * The replay values a book without a positions table to read, so it learns each
 * symbol's contract size from the fills that built it.
 */
export function fillMultiplier(trade: Pick<TradeRecord, "symbol" | "multiplier">): number {
  const stored = trade.multiplier;
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0
    ? stored
    : multiplierFor(trade.symbol);
}

export interface ReplayInput {
  /** Session dates in ascending order. This is the x-axis. */
  dates: string[];
  /** Every fill in the portfolio, in any order. */
  trades: TradeRecord[];
  startingCash: number;
  /** symbol -> date -> official close. Sparse; gaps are carried forward. */
  closes: Map<string, Map<string, number>>;
  /**
   * Live marks, applied to the final date only. During a session the last
   * point is "right now", not a close that has not happened yet.
   */
  marks?: Map<string, number>;
}

/**
 * Replay the blotter and value the book at every session on the axis.
 *
 * Two details carry most of the correctness:
 *
 * **Closes are carried forward, never zeroed.** A halted or thinly traded name
 * has no bar on some days. Reading that as "no price" would value the position
 * at nothing and put a cliff in the curve, so the last known close stands until
 * a new one arrives.
 *
 * **A position opened before its first bar is marked at what it cost.** A
 * ticker bought this morning has no close yet today; its trade price is the
 * only price that exists for it, and it values the position at exactly
 * break-even rather than at zero.
 */
export function replayEquity({
  dates,
  trades,
  startingCash,
  closes,
  marks,
}: ReplayInput): EquityPoint[] {
  const fills = trades
    .map((trade) => ({ ...trade, date: exchangeDate(trade.executedAt) }))
    .sort((a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt));

  const held = new Map<string, number>();
  // Contract size per symbol, learned from the fills. The replay has no
  // positions table to read it off.
  const sizeOf = new Map<string, number>();
  const lastClose = new Map<string, number>();
  const lastDate = dates.at(-1);

  let cash = startingCash;
  let cursor = 0;
  const points: EquityPoint[] = [];

  for (const date of dates) {
    // Every fill that had happened by the end of this session. The cursor only
    // moves forward, so the whole replay is one pass over the blotter.
    while (cursor < fills.length && fills[cursor]!.date <= date) {
      const fill = fills[cursor]!;
      cursor += 1;
      cash += cashDelta(fill);
      held.set(fill.symbol, (held.get(fill.symbol) ?? 0) + qtyDelta(fill));
      sizeOf.set(fill.symbol, fillMultiplier(fill));
      if (!lastClose.has(fill.symbol)) lastClose.set(fill.symbol, fill.price);
    }

    let longMv = 0;
    let shortMv = 0;

    for (const [symbol, qty] of held) {
      if (qty === 0) continue;

      const close = closes.get(symbol)?.get(date);
      if (close !== undefined) lastClose.set(symbol, close);

      const live = date === lastDate ? marks?.get(symbol) : undefined;
      const price = live ?? lastClose.get(symbol) ?? 0;

      const value = Math.abs(qty) * (sizeOf.get(symbol) ?? 1) * price;
      if (qty > 0) longMv += value;
      else shortMv += value;
    }

    points.push({
      date,
      cash,
      longMv,
      shortMv,
      equity: cash + longMv - shortMv,
    });
  }

  return points;
}

/** One five-minute bucket inside a session. The 1D chart's row. */
export interface IntradayPoint {
  /** RFC-3339 instant at the start of the bar this was valued at. */
  at: string;
  equity: number;
  cash: number;
  longMv: number;
  shortMv: number;
}

export interface IntradayReplayInput {
  /** Bar instants for the session, ascending. This is the x-axis. */
  stamps: string[];
  /** The session being drawn, YYYY-MM-DD. */
  sessionDate: string;
  /** Every fill in the portfolio, in any order. */
  trades: TradeRecord[];
  startingCash: number;
  /** symbol -> instant -> that bucket's close. Sparse; gaps carry forward. */
  prices: Map<string, Map<string, number>>;
  /** symbol -> the previous session's official close. The day's opening mark. */
  prevCloses: Map<string, number>;
  /** Live marks, applied to the final bucket only. */
  marks?: Map<string, number>;
}

export interface IntradayReplay {
  points: IntradayPoint[];
  /**
   * The account at the previous session's close — the day's baseline, and the
   * denominator of every figure the 1D chart reports.
   */
  base: number;
}

/**
 * Replay one session at five-minute resolution.
 *
 * The same walk as `replayEquity`, one level down, and it exists as its own
 * function because three things genuinely differ at this resolution:
 *
 * **The day starts from a book, not from cash.** Every fill before this session
 * is applied first, in one pass, to produce the cash and positions the member
 * woke up with. Valuing that book at the *previous* session's closes gives
 * `base`, which is what the day's change is measured against — the same number
 * the positions grid calls day P/L, arrived at the same way.
 *
 * **Fills land at an instant, not on a date.** A buy at 11:42 belongs to the
 * 11:45 point and not to the 09:30 one, so the cursor advances on timestamps.
 *
 * **A gap is a symbol that did not print, not a symbol that is worthless.**
 * Intraday bars come from the IEX feed, which is a slice of the tape, so a thin
 * name has no bar in plenty of buckets. Marks are seeded from the previous
 * close and carried forward, exactly as the daily replay carries closes.
 */
export function replayIntraday({
  stamps,
  sessionDate,
  trades,
  startingCash,
  prices,
  prevCloses,
  marks,
}: IntradayReplayInput): IntradayReplay {
  const fills = trades
    .map((trade) => ({
      ...trade,
      date: exchangeDate(trade.executedAt),
      at: Date.parse(trade.executedAt),
    }))
    .sort((a, b) => a.at - b.at);

  const held = new Map<string, number>();
  // As in the session replay: contract size is learned from the fills, because
  // there is no positions table in here to read it from.
  const sizeOf = new Map<string, number>();
  const lastPrice = new Map<string, number>();
  let cash = startingCash;

  const during: typeof fills = [];

  for (const fill of fills) {
    if (fill.date < sessionDate) {
      cash += cashDelta(fill);
      held.set(fill.symbol, (held.get(fill.symbol) ?? 0) + qtyDelta(fill));
      sizeOf.set(fill.symbol, fillMultiplier(fill));
      if (!lastPrice.has(fill.symbol)) lastPrice.set(fill.symbol, fill.price);
    } else if (fill.date === sessionDate) {
      during.push(fill);
    }
    // A fill after this session is not this session's business. On a Saturday
    // the chart draws Friday, and Friday could not have known about it.
  }

  // Seeded after the pre-session fills, so a real close beats an old trade
  // price — but a symbol with no close at all (bought yesterday, delisted
  // since) still carries the only price that ever existed for it.
  for (const [symbol, close] of prevCloses) {
    if (close > 0) lastPrice.set(symbol, close);
  }

  let base = cash;
  for (const [symbol, qty] of held) {
    if (qty === 0) continue;
    base += qty * (sizeOf.get(symbol) ?? 1) * (lastPrice.get(symbol) ?? 0);
  }

  const lastStamp = stamps.at(-1);
  let cursor = 0;
  const points: IntradayPoint[] = [];

  for (const stamp of stamps) {
    // The final point is "now", not the instant its bucket opened, which is
    // why it takes every remaining fill: a member who traded four minutes ago
    // must see that trade on the chart rather than wait for the bar to close.
    const cutoff = stamp === lastStamp ? Number.POSITIVE_INFINITY : Date.parse(stamp);

    while (cursor < during.length && during[cursor]!.at <= cutoff) {
      const fill = during[cursor]!;
      cursor += 1;
      cash += cashDelta(fill);
      held.set(fill.symbol, (held.get(fill.symbol) ?? 0) + qtyDelta(fill));
      if (!lastPrice.has(fill.symbol)) lastPrice.set(fill.symbol, fill.price);
    }

    let longMv = 0;
    let shortMv = 0;

    for (const [symbol, qty] of held) {
      if (qty === 0) continue;

      const printed = prices.get(symbol)?.get(stamp);
      if (printed !== undefined && printed > 0) lastPrice.set(symbol, printed);

      const live = stamp === lastStamp ? marks?.get(symbol) : undefined;
      const price = live ?? lastPrice.get(symbol) ?? 0;

      const value = Math.abs(qty) * (sizeOf.get(symbol) ?? 1) * price;
      if (qty > 0) longMv += value;
      else shortMv += value;
    }

    points.push({ at: stamp, cash, longMv, shortMv, equity: cash + longMv - shortMv });
  }

  return { points, base };
}

/**
 * Put a sparse bar series onto a fixed date axis, carrying each close forward.
 *
 * Null before the series starts, which is how a benchmark that was not yet
 * being tracked draws as a gap rather than as a crash to zero.
 */
export function alignCloses(
  bars: readonly { date: string; close: number }[],
  dates: readonly string[],
): (number | null)[] {
  const byDate = new Map(bars.map((bar) => [bar.date, bar.close]));
  let carried: number | null = null;

  return dates.map((date) => {
    const close = byDate.get(date);
    if (close !== undefined) carried = close;
    return carried;
  });
}

/**
 * Rescale a series so that `seriesBase` reads as `targetBase`.
 *
 * This is what puts a $640 share of SPY on an axis of dollars. The chart's
 * y-axis is the member's account, so a benchmark is drawn as the thing a member
 * can actually compare against it: what their money would have been worth had
 * it gone into SPY at the same starting line. The shape of the line is
 * untouched — only the units change — so "SPY is up 2.1%" means the same thing
 * on the chart as it does on the leaderboard.
 *
 * Omit `seriesBase` to scale from the series' own first usable value, which is
 * what every range but 1D wants. Pass it explicitly for 1D, where each line
 * starts the day at its previous close rather than at its first print.
 */
export function scaleTo(
  values: readonly (number | null)[],
  targetBase: number,
  seriesBase?: number | null,
): (number | null)[] {
  const base =
    seriesBase === undefined ? (values.find((value) => value !== null && value > 0) ?? null) : seriesBase;

  if (base === null || !(base > 0) || !(targetBase > 0)) return values.map(() => null);
  return values.map((value) => (value === null ? null : (value / base) * targetBase));
}

/**
 * Index a series to 100 at its first usable value.
 *
 * Kept because it is the one honest way to compare two series whose units
 * differ, and it is what `scaleTo` is underneath.
 */
export function indexTo100(values: readonly (number | null)[]): (number | null)[] {
  return scaleTo(values, 100);
}

/**
 * Percentage move from an explicit base to the last usable value.
 *
 * The base is passed in rather than taken from the head of the series because
 * on the 1D chart it is not in the series at all: the day is measured against
 * the previous session's close, which is a number from before the first point
 * on screen. Every range routes through this, so "up 4.8%" is arrived at the
 * same way on all of them.
 */
export function returnFromBase(
  values: readonly (number | null)[],
  base: number | null,
): number | null {
  if (base === null || !(base > 0)) return null;
  const last = [...values].reverse().find((value) => value !== null) ?? null;
  if (last === null) return null;
  return ((last - base) / base) * 100;
}

/** The first value a series actually has. The base for every range but 1D. */
export function firstUsable(values: readonly (number | null)[]): number | null {
  return values.find((value) => value !== null && value > 0) ?? null;
}

/**
 * Shift a YYYY-MM-DD date by whole days or months.
 *
 * UTC arithmetic on a date-only string, so no timezone can move it across a
 * boundary. Month arithmetic overflows the way JavaScript's does — 31 March
 * less one month lands in early March, not on the 28th — which is immaterial
 * for choosing where a chart starts and is not worth a calendar library.
 */
export function shiftDate(date: string, { days = 0, months = 0 }): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1 - months, day! - days));
  return shifted.toISOString().slice(0, 10);
}

/** Narrow a `?range=` value, defaulting to the whole season. */
export function parseRange(raw: string | null | undefined): CurveRange {
  const upper = (raw ?? "").trim().toUpperCase();
  return (CURVE_RANGES as readonly string[]).includes(upper) ? (upper as CurveRange) : "ALL";
}

/**
 * The first date a range covers.
 *
 * Always clamped to the season start: a club that began in March has no year
 * before March, and drawing a benchmark from last June while the member's line
 * starts in March would put the two on different baselines and make the
 * comparison a lie.
 *
 * 1D returns today because it is not a window over sessions at all — it is one
 * session at five-minute resolution, and `buildHistory` routes it elsewhere
 * before this is reached. The answer here is the honest one for the shape of
 * the function rather than a case anything depends on.
 */
export function rangeStart(range: CurveRange, today: string, seasonStart: string): string {
  const raw =
    range === "ALL"
      ? seasonStart
      : range === "1D"
        ? today
        : range === "1W"
          ? shiftDate(today, { days: 7 })
          : shiftDate(today, { months: range === "1M" ? 1 : range === "3M" ? 3 : 12 });

  return raw < seasonStart ? seasonStart : raw;
}
