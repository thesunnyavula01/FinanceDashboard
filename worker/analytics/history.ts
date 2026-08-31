import type { SupabaseClient } from "@supabase/supabase-js";
import { dailyBars } from "../market/bars.ts";
import { marketClock } from "../market/clock.ts";
import { exchangeDate, type DailyBar } from "../market/provider.ts";
import { quoteCache } from "../market/quotes.ts";
import type { Season } from "../lib/portfolio.ts";
import type { Position } from "../orders/engine.ts";
import type { Env } from "../types.ts";
import {
  BENCHMARKS,
  alignCloses,
  indexTo100,
  rangeStart,
  replayEquity,
  totalReturn,
  type CurveRange,
  type EquityPoint,
  type TradeRecord,
} from "./curve.ts";

/**
 * Assembling the equity curve.
 *
 * `curve.ts` holds the arithmetic and does no I/O. This file is the other half:
 * it gathers the four things that arithmetic needs — the blotter, the daily
 * bars behind every symbol in it, whatever snapshots already exist, and a live
 * mark for right now — and hands back rows a chart can draw directly.
 *
 * The rows are flat and one per session, with one key per line on the chart,
 * because that is the shape a charting library wants and reshaping four series
 * in the browser on every range toggle is work nobody needs to do twice.
 */

/** One session, with every line on the chart indexed to 100 at the range start. */
export interface CurveRow {
  date: string;
  /** The member's account value in dollars, before indexing. */
  equity: number;
  me: number | null;
  spy: number | null;
  qqq: number | null;
  club: number | null;
}

export interface CurveSummary {
  me: number | null;
  spy: number | null;
  qqq: number | null;
  club: number | null;
}

export interface HistoryResult {
  range: CurveRange;
  /** The session everything is indexed to 100 at. */
  baseDate: string | null;
  seasonStart: string;
  startingCash: number;
  rows: CurveRow[];
  /** Percentage move across the visible range, per line. */
  summary: CurveSummary;
  /** Where the member's own line came from. */
  source: "reconstructed" | "snapshots" | "mixed";
  /** Why the club average is missing, when it is. */
  clubNote: string | null;
  /** The final row is a live mark rather than a settled close. */
  live: boolean;
  /** Bars were unavailable, so the curve is shorter than it should be. */
  degraded: boolean;
  asOf: string;
  /** Why there is no curve. Present only when there is nothing to draw. */
  note?: string;
}

/**
 * The shape of "there is nothing to chart yet".
 *
 * A member with no season and a member with a flat season should send the
 * client the same fields, so the chart has one code path and a missing
 * portfolio is a caption rather than an undefined read.
 */
export function emptyHistory(range: CurveRange, note: string): HistoryResult {
  return {
    range,
    baseDate: null,
    seasonStart: exchangeDate(),
    startingCash: 0,
    rows: [],
    summary: { me: null, spy: null, qqq: null, club: null },
    source: "reconstructed",
    clubNote: null,
    live: false,
    degraded: false,
    asOf: new Date().toISOString(),
    note,
  };
}

interface HistoryInput {
  env: Env;
  supabase: SupabaseClient;
  portfolioId: string;
  season: Season;
  /**
   * What this portfolio was funded with, not what the season funds a new member
   * with today. The replay starts from it, so reading the season's figure would
   * redraw the whole curve the moment an officer edits it.
   */
  startingCash: number;
  positions: Position[];
  range: CurveRange;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** A season's worth of fills for one member. Far above any real club's volume. */
const MAX_TRADES = 5000;

export async function buildHistory({
  env,
  supabase,
  portfolioId,
  season,
  startingCash,
  positions,
  range,
  waitUntil,
}: HistoryInput): Promise<HistoryResult> {
  const today = exchangeDate();
  const seasonStart = exchangeDate(season.startsAt);

  const [trades, snapshots, club, clock] = await Promise.all([
    loadTrades(supabase, portfolioId),
    loadSnapshots(supabase, portfolioId),
    loadClubCurve(supabase, season.id, seasonStart),
    marketClock(env),
  ]);

  // Every symbol the curve has to price: what is held now, what was held at
  // some point during the season, and the two benchmarks. One batched request
  // covers all of it.
  const symbols = [
    ...new Set([
      ...positions.map((p) => p.symbol),
      ...trades.map((t) => t.symbol),
      ...BENCHMARKS,
    ]),
  ];

  let bars = new Map<string, DailyBar[]>();
  let degraded = false;
  try {
    bars = await dailyBars(env, symbols, seasonStart, today, waitUntil);
  } catch (err) {
    // A curve is worth drawing short rather than not at all, and the member is
    // told the difference rather than shown a truncated line as if it were
    // whole.
    console.error("Daily bars unavailable for the equity curve:", err);
    degraded = true;
  }

  // The benchmarks fall back to what the nightly job stored. This is the whole
  // reason `benchmark_snapshots` exists as a table rather than as a cache: when
  // Alpaca is unreachable the member's own line is unreconstructable, but the
  // ruler is a set of closes that were already written down, and a chart with
  // SPY on it and a short account line is a great deal more useful than an
  // empty panel. It also restores the x-axis, since the axis is SPY's sessions.
  //
  // Costs nothing on the ordinary path: the check is false and no query runs.
  if (BENCHMARKS.some((symbol) => !bars.get(symbol)?.length)) {
    for (const [symbol, series] of await storedBenchmarks(supabase, seasonStart, today)) {
      if (!bars.get(symbol)?.length) bars.set(symbol, series);
    }
  }

  const dates = sessionAxis({ bars, snapshots, seasonStart, today, clock });

  const marks = await liveMarks(env, positions, waitUntil);
  const live = dates.at(-1) === today && marks.size > 0;

  const closes = new Map(
    [...bars].map(([symbol, series]) => [
      symbol,
      new Map(series.map((bar) => [bar.date, bar.close])),
    ]),
  );

  const replayed = replayEquity({
    dates,
    trades,
    startingCash,
    closes,
    marks: live ? marks : undefined,
  });

  const { equity, source } = mergeSnapshots(replayed, snapshots);

  // Everything below is the visible window only. The replay runs over the whole
  // season regardless, because a position opened in March still has to be
  // carried forward to be valued in August.
  const from = rangeStart(range, today, seasonStart);
  const visible = dates.map((date, i) => ({ date, i })).filter(({ date }) => date >= from);

  const window = visible.map(({ i }) => i);
  const windowDates = visible.map(({ date }) => date);

  const me = window.map((i) => equity[i] ?? null);
  const spy = pick(bars, "SPY", windowDates);
  const qqq = pick(bars, "QQQ", windowDates);
  const clubSeries = alignCloses(club.points, windowDates);

  const meIndexed = indexTo100(me);
  const spyIndexed = indexTo100(spy);
  const qqqIndexed = indexTo100(qqq);
  const clubIndexed = indexTo100(clubSeries);

  const rows: CurveRow[] = windowDates.map((date, i) => ({
    date,
    equity: me[i] ?? 0,
    me: meIndexed[i] ?? null,
    spy: spyIndexed[i] ?? null,
    qqq: qqqIndexed[i] ?? null,
    club: clubIndexed[i] ?? null,
  }));

  return {
    range,
    baseDate: windowDates[0] ?? null,
    seasonStart,
    startingCash,
    rows,
    summary: {
      me: totalReturn(me),
      spy: totalReturn(spy),
      qqq: totalReturn(qqq),
      club: totalReturn(clubSeries),
    },
    source,
    clubNote: club.note,
    live,
    degraded,
    asOf: new Date().toISOString(),
  };
}

/**
 * Which sessions the chart has an x-axis for.
 *
 * SPY's bar dates *are* the exchange calendar — it trades every session and
 * never halts — so the axis is taken from them rather than from a weekday
 * count that would invent Thanksgiving. When bars are unavailable the stored
 * snapshots stand in, and when there are neither the chart is a single point.
 *
 * Today is added only when today is genuinely a trading day. A curve drawn on
 * a Saturday ends on Friday, because that is when the account last had a value
 * that meant anything.
 */
function sessionAxis({
  bars,
  snapshots,
  seasonStart,
  today,
  clock,
}: {
  bars: Map<string, DailyBar[]>;
  snapshots: Map<string, number>;
  seasonStart: string;
  today: string;
  clock: { isOpen: boolean; nextOpen: string | null };
}): string[] {
  const calendar = bars.get("SPY");

  const dates = new Set<string>();
  if (calendar && calendar.length > 0) {
    for (const bar of calendar) dates.add(bar.date);
  } else {
    // No SPY, so fall back to every date any symbol traded on, then to the
    // snapshots. Both are worse calendars than SPY and neither is wrong.
    for (const series of bars.values()) for (const bar of series) dates.add(bar.date);
    for (const date of snapshots.keys()) dates.add(date);
  }

  const sessionToday =
    clock.isOpen || (clock.nextOpen !== null && exchangeDate(clock.nextOpen) === today);
  if (sessionToday) dates.add(today);

  const axis = [...dates].filter((date) => date >= seasonStart && date <= today).sort();

  // A season that starts today, or a club whose first member signed up an hour
  // ago, still gets one point: the account exists and is worth something.
  return axis.length > 0 ? axis : [today];
}

/**
 * Stored snapshots win wherever they exist.
 *
 * They were written at the close against the marks that were real at the time,
 * and a reconstruction cannot improve on that — a symbol that has since been
 * delisted has no bars left to replay, but its snapshot is still true. The
 * reconstruction fills everything the cron has not covered, which before
 * Phase 7 is the entire season.
 */
function mergeSnapshots(
  replayed: EquityPoint[],
  snapshots: Map<string, number>,
): { equity: number[]; source: HistoryResult["source"] } {
  let stored = 0;

  const equity = replayed.map((point) => {
    const snapshot = snapshots.get(point.date);
    if (snapshot === undefined) return point.equity;
    stored += 1;
    return snapshot;
  });

  const source =
    stored === 0 ? "reconstructed" : stored === equity.length ? "snapshots" : "mixed";

  return { equity, source };
}

function pick(
  bars: Map<string, DailyBar[]>,
  symbol: string,
  dates: string[],
): (number | null)[] {
  const series = bars.get(symbol);
  return series ? alignCloses(series, dates) : dates.map(() => null);
}

async function liveMarks(
  env: Env,
  positions: Position[],
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Map<string, number>> {
  if (positions.length === 0) return new Map();

  try {
    const result = await quoteCache(env).get(
      positions.map((p) => p.symbol),
      waitUntil,
    );
    return new Map([...result.quotes].map(([symbol, quote]) => [symbol, quote.price]));
  } catch (err) {
    // The curve still draws; its last point is the previous close rather than
    // the current mark, which is a smaller lie than no chart.
    console.error("Live marks unavailable for the equity curve:", err);
    return new Map();
  }
}

async function loadTrades(
  supabase: SupabaseClient,
  portfolioId: string,
): Promise<TradeRecord[]> {
  const { data, error } = await supabase
    .from("trades")
    .select("symbol, side, qty, price, notional, executed_at")
    .eq("portfolio_id", portfolioId)
    .order("executed_at", { ascending: true })
    .limit(MAX_TRADES);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    symbol: row.symbol as string,
    side: row.side as TradeRecord["side"],
    qty: Number(row.qty),
    price: Number(row.price),
    notional: Number(row.notional),
    executedAt: row.executed_at as string,
  }));
}

/**
 * SPY and QQQ as the nightly job recorded them, shaped as bars.
 *
 * Only the date and the close are real; the other fields are filled with the
 * close so the series satisfies `DailyBar` and every function downstream —
 * the axis, `alignCloses`, the benchmark move — works on it unchanged. Nothing
 * on the curve reads an open, a high, a low or a volume, so inventing a
 * plausible one would be a lie with no purpose; repeating the close is visibly
 * a placeholder.
 */
async function storedBenchmarks(
  supabase: SupabaseClient,
  start: string,
  end: string,
): Promise<Map<string, DailyBar[]>> {
  const { data, error } = await supabase
    .from("benchmark_snapshots")
    .select("symbol, as_of, close")
    .in("symbol", [...BENCHMARKS])
    .gte("as_of", start)
    .lte("as_of", end)
    .order("as_of", { ascending: true });

  if (error) {
    // The fallback failing is not worth failing the chart over — it is already
    // the degraded path.
    console.warn("Stored benchmarks unavailable:", error.message);
    return new Map();
  }

  const out = new Map<string, DailyBar[]>();

  for (const row of data ?? []) {
    const close = Number(row.close);
    if (!(close > 0)) continue;

    const series = out.get(row.symbol as string) ?? [];
    series.push({
      date: row.as_of as string,
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
    });
    out.set(row.symbol as string, series);
  }

  return out;
}

async function loadSnapshots(
  supabase: SupabaseClient,
  portfolioId: string,
): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("as_of, equity")
    .eq("portfolio_id", portfolioId)
    .order("as_of", { ascending: true });

  if (error) throw error;

  return new Map((data ?? []).map((row) => [row.as_of as string, Number(row.equity)]));
}

/**
 * The club average, one row per session.
 *
 * Aggregated in Postgres rather than here: a hundred members over a full season
 * is twenty-five thousand snapshot rows, and pulling all of them across the
 * wire to average them in JavaScript would be the slowest thing in the app.
 *
 * The function arrives in migration 0004. Until that is applied — and there is
 * nothing for it to average until Phase 7 writes the first snapshots anyway —
 * this returns a note instead of an error, so the chart draws with three lines
 * rather than none.
 */
async function loadClubCurve(
  supabase: SupabaseClient,
  seasonId: string,
  start: string,
): Promise<{ points: { date: string; close: number }[]; note: string | null }> {
  const { data, error } = await supabase.rpc("club_equity_curve", {
    p_season_id: seasonId,
    p_start: start,
  });

  if (error) {
    console.warn("Club curve unavailable:", error.message);
    return {
      points: [],
      note: "The club average needs migration 0004 applied.",
    };
  }

  const points = (data ?? []).map(
    (row: { as_of: string; avg_equity: string | number }) => ({
      date: row.as_of,
      close: Number(row.avg_equity),
    }),
  );

  return {
    points,
    note: points.length === 0 ? "The club average starts once nightly snapshots do." : null,
  };
}
