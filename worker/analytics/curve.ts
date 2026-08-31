import { exchangeDate } from "../market/provider.ts";
import type { OrderSide } from "../orders/engine.ts";

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

export const CURVE_RANGES = ["1W", "1M", "3M", "YTD", "ALL"] as const;
export type CurveRange = (typeof CURVE_RANGES)[number];

/** The two indices every club measures itself against. */
export const BENCHMARKS = ["SPY", "QQQ"] as const;

/** One fill, as the blotter stores it: `qty` and `notional` always positive. */
export interface TradeRecord {
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  notional: number;
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
  return trade.side === "BUY" || trade.side === "COVER" ? -trade.notional : trade.notional;
}

/** What a fill does to the position. COVER buys back, so it moves qty upward. */
export function qtyDelta(trade: Pick<TradeRecord, "side" | "qty">): number {
  return trade.side === "BUY" || trade.side === "COVER" ? trade.qty : -trade.qty;
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

      if (qty > 0) longMv += qty * price;
      else shortMv += -qty * price;
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
 * Index a series to 100 at its first usable value.
 *
 * This is what makes a $100,000 portfolio comparable to a $640 share of SPY:
 * both start at 100 and the distance between the lines is the only thing on
 * the chart, which is exactly the question a club is asking.
 */
export function indexTo100(values: readonly (number | null)[]): (number | null)[] {
  const base = values.find((value) => value !== null && value > 0) ?? null;
  if (base === null) return values.map(() => null);
  return values.map((value) => (value === null ? null : (value / base) * 100));
}

/** Percentage move from the first usable value to the last. Null if either is missing. */
export function totalReturn(values: readonly (number | null)[]): number | null {
  const first = values.find((value) => value !== null && value > 0) ?? null;
  const last = [...values].reverse().find((value) => value !== null) ?? null;
  if (first === null || last === null) return null;
  return ((last - first) / first) * 100;
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
 * Always clamped to the season start: a club that began in March has no
 * "YTD" before March, and drawing the index from January while the member's
 * line starts in March would put the two on different baselines and make the
 * comparison a lie.
 */
export function rangeStart(range: CurveRange, today: string, seasonStart: string): string {
  const raw =
    range === "ALL"
      ? seasonStart
      : range === "YTD"
        ? `${today.slice(0, 4)}-01-01`
        : range === "1W"
          ? shiftDate(today, { days: 7 })
          : shiftDate(today, { months: range === "1M" ? 1 : 3 });

  return raw < seasonStart ? seasonStart : raw;
}
