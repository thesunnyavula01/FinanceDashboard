import type { SupabaseClient } from "@supabase/supabase-js";
import { dailyBars } from "../market/bars.ts";
import { intradayBars } from "../market/intraday.ts";
import { marketCalendar, marketClock } from "../market/clock.ts";
import {
  DEFAULT_SESSION,
  exchangeDate,
  exchangeTime,
  type CalendarDay,
  type DailyBar,
  type IntradayBar,
} from "../market/provider.ts";
import { quoteCache } from "../market/quotes.ts";
import type { Season } from "../lib/portfolio.ts";
import type { Position } from "../orders/engine.ts";
import type { Env } from "../types.ts";
import {
  BENCHMARKS,
  alignCloses,
  firstUsable,
  rangeStart,
  replayEquity,
  replayIntraday,
  returnFromBase,
  scaleTo,
  shiftDate,
  type CurveRange,
  type EquityPoint,
  type TradeRecord,
} from "./curve.ts";

/**
 * Assembling the equity curve.
 *
 * `curve.ts` holds the arithmetic and does no I/O. This file is the other half:
 * it gathers what that arithmetic needs — the blotter, the bars behind every
 * symbol in it, whatever snapshots already exist, and a live mark for right
 * now — and hands back rows a chart can draw directly.
 *
 * The rows are flat and one per point, with one key per line on the chart,
 * because that is the shape a charting library wants and reshaping four series
 * in the browser on every range toggle is work nobody needs to do twice.
 *
 * **Everything is in dollars.** The chart's y-axis is the member's account, so
 * a benchmark is drawn as the comparison a member can actually act on: what
 * their money would be worth had it gone into SPY at the same starting line.
 * The lines are rescaled, never reshaped, so SPY's percentage move on this
 * chart is the same number the leaderboard prints.
 *
 * **There are two builders, and 1D is the reason.** Every range but 1D is one
 * point per session, valued at each session's official close, with the axis
 * taken from SPY's bar dates. 1D is one point per five-minute bucket inside a
 * single session, measured against the previous session's close. They share the
 * blotter, the snapshots and the shape of the answer, and nothing else.
 */

/** One point on the chart. Every series is in dollars. */
export interface CurveRow {
  /** Session date (YYYY-MM-DD) on the session ranges; an RFC-3339 instant on 1D. */
  t: string;
  /** What the axis and the crosshair show: "08/30", or "10:35" on 1D. */
  label: string;
  /** The member's account value. */
  me: number;
  /** The same money in SPY from the baseline. Null before the series starts. */
  spy: number | null;
  qqq: number | null;
  club: number | null;
}

/** Percentage move from the baseline to the last point, per line. */
export interface CurveSummary {
  me: number | null;
  spy: number | null;
  qqq: number | null;
  club: number | null;
}

export interface HistoryResult {
  range: CurveRange;
  /** True when this is one session at five-minute resolution rather than many. */
  intraday: boolean;
  /** Which session 1D drew. Null on every other range. */
  sessionDate: string | null;
  /**
   * The date the baseline was taken at: the first session in the window, or
   * on 1D the *previous* session, whose close the day is measured against.
   */
  baseDate: string | null;
  /** The baseline in dollars. Every line is scaled to start here. */
  base: number | null;
  /** The account's latest value. */
  value: number | null;
  /** `value` less `base`. The dollar figure at the top of the panel. */
  change: number | null;
  seasonStart: string;
  startingCash: number;
  rows: CurveRow[];
  summary: CurveSummary;
  /** Where the member's own line came from. */
  source: "reconstructed" | "snapshots" | "mixed";
  /** Why the club average is missing, when it is. */
  clubNote: string | null;
  /** The final point is a live mark rather than a settled close. */
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
 * A member with no season, a member with a flat season, and a session whose
 * intraday bars have not arrived should all send the client the same fields, so
 * the chart has one code path and a missing portfolio is a caption rather than
 * an undefined read.
 */
export function emptyHistory(range: CurveRange, note: string): HistoryResult {
  return {
    range,
    intraday: range === "1D",
    sessionDate: null,
    baseDate: null,
    base: null,
    value: null,
    change: null,
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

/**
 * How far back 1D looks for a session to draw.
 *
 * Long enough to clear a Thursday-and-Friday holiday weekend, which is the
 * longest the US market is ever shut. Nothing here counts weekdays or knows
 * about holidays — it asks for bars and takes the most recent session that
 * actually has them, which is the same trick the session axis plays with SPY.
 */
const INTRADAY_LOOKBACK_DAYS = 6;

/** How far back 1D looks for previous closes. Wider, and one cheap daily read. */
const PREV_CLOSE_LOOKBACK_DAYS = 14;

export async function buildHistory(input: HistoryInput): Promise<HistoryResult> {
  return input.range === "1D" ? buildIntradayHistory(input) : buildSessionHistory(input);
}

// ---------------------------------------------------------------------------
// The session ranges: 1W, 1M, 3M, 1Y, ALL
// ---------------------------------------------------------------------------

async function buildSessionHistory({
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

  const symbols = pricingOrder(positions, trades);

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

  const marks = await liveMarks(
    env,
    positions.map((p) => p.symbol),
    waitUntil,
  );
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

  const windowDates = visible.map(({ date }) => date);
  const me = visible.map(({ i }) => equity[i] ?? null);

  // The baseline: what the account was worth at the left edge. Falling back to
  // the starting cash rather than to zero matters — a scale divided by zero
  // would take every benchmark line off the chart along with it.
  const base = firstUsable(me) ?? startingCash;

  const spy = scaleTo(pick(bars, "SPY", windowDates), base);
  const qqq = scaleTo(pick(bars, "QQQ", windowDates), base);
  const clubSeries = scaleTo(alignCloses(club.points, windowDates), base);

  const rows: CurveRow[] = windowDates.map((date, i) => ({
    t: date,
    label: axisDate(date),
    me: me[i] ?? base,
    spy: spy[i] ?? null,
    qqq: qqq[i] ?? null,
    club: clubSeries[i] ?? null,
  }));

  const value = rows.at(-1)?.me ?? null;

  return {
    range,
    intraday: false,
    sessionDate: null,
    baseDate: windowDates[0] ?? null,
    base,
    value,
    change: value === null ? null : value - base,
    seasonStart,
    startingCash,
    rows,
    summary: {
      me: returnFromBase(me, base),
      spy: returnFromBase(spy, base),
      qqq: returnFromBase(qqq, base),
      club: returnFromBase(clubSeries, base),
    },
    source,
    clubNote: club.note,
    live,
    degraded,
    asOf: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1D: one session, five minutes at a time
// ---------------------------------------------------------------------------

/**
 * The day's chart.
 *
 * Three decisions carry it:
 *
 * **The session is discovered, not calculated.** Whichever session SPY last
 * printed intraday bars for is the session drawn. That is a weekend, a
 * holiday, a half day and a member opening the terminal at 7am all handled by
 * the same line of code, without a calendar existing anywhere — the same trick
 * the session axis plays with SPY's daily bars. Before the opening bell the
 * chart shows yesterday, which is what every broker does and what the member
 * means by "how did we do".
 *
 * **The baseline is the previous close, not the open.** A day's change is
 * measured from where the account finished yesterday, so the account can be
 * down on the day while up since the bell. That is the number the positions
 * grid already prints as day P/L, and the two must not disagree.
 *
 * **The club average is absent, and says so.** It is a nightly aggregate over
 * `portfolio_snapshots`; there is no intraday club figure to draw and inventing
 * one from a flat line would be a claim the data cannot support.
 */
async function buildIntradayHistory({
  env,
  supabase,
  portfolioId,
  season,
  startingCash,
  positions,
  waitUntil,
}: HistoryInput): Promise<HistoryResult> {
  const today = exchangeDate();
  const seasonStart = exchangeDate(season.startsAt);

  const [trades, snapshots] = await Promise.all([
    loadTrades(supabase, portfolioId),
    loadSnapshots(supabase, portfolioId),
  ]);

  const symbols = pricingOrder(positions, trades);

  const intradayFrom = shiftDate(today, { days: INTRADAY_LOOKBACK_DAYS });

  // Two short windows and the calendar. The daily bars supply the previous
  // session's official closes — the day's opening marks and each benchmark's
  // baseline — the intraday bars supply the session itself, and the calendar
  // says where that session began and ended. Both bar reads are far smaller
  // than the season-long one the other ranges make.
  const [dailyResult, minuteResult, calendar] = await Promise.all([
    dailyBars(
      env,
      symbols,
      shiftDate(today, { days: PREV_CLOSE_LOOKBACK_DAYS }),
      today,
      waitUntil,
    ).then(
      (value) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason }),
    ),
    intradayBars(env, symbols, intradayFrom, waitUntil).then(
      (value) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason }),
    ),
    marketCalendar(env, intradayFrom, today),
  ]);

  let degraded = false;
  let daily = new Map<string, DailyBar[]>();
  let minute = new Map<string, IntradayBar[]>();

  if (dailyResult.ok) {
    daily = dailyResult.value;
  } else {
    console.error("Daily bars unavailable for the intraday curve:", dailyResult.reason);
    degraded = true;
  }

  if (minuteResult.ok) {
    // Regular hours only, before anything else looks at these. A bar feed does
    // not distinguish 09:35 from 06:35, and letting the pre-market through
    // would stretch the axis from six and a half hours to sixteen and hand the
    // chart's most prominent moves to the thinnest prints of the day.
    minute = regularHours(minuteResult.value, calendar);
  } else {
    console.error("Intraday bars unavailable:", minuteResult.reason);
    degraded = true;
  }

  const sessionDate = latestSession(minute);
  const stamps = sessionDate ? sessionStamps(minute, sessionDate) : [];

  if (!sessionDate || stamps.length === 0) {
    // Not an error, and not always a fault: this is also what a brand-new
    // account sees at 4am on a Monday in a colo with a cold cache. The other
    // ranges still draw, so say that rather than blanking the panel.
    const empty = emptyHistory(
      "1D",
      degraded
        ? "Intraday prices are unavailable right now. The other ranges still draw."
        : "No intraday prints for this session yet. The other ranges still draw.",
    );
    return { ...empty, seasonStart, startingCash, degraded };
  }

  const prevSessionDate = previousSession(daily, sessionDate);
  const prevCloses = closesAsOf(daily, prevSessionDate);

  const prices = new Map(
    [...minute].map(([symbol, series]) => [
      symbol,
      new Map(series.filter((bar) => bar.date === sessionDate).map((bar) => [bar.at, bar.close])),
    ]),
  );

  // Live marks only when the session on screen is the one happening now.
  // Overwriting the last point of Friday's chart with Monday's pre-market
  // quote would be the same mistake `quoteFromSnapshot` exists to avoid.
  const clock = await marketClock(env);
  const isNow = sessionDate === today && clock.isOpen;

  // The benchmarks are marked live too, so the right edge of the chart is one
  // instant rather than two. Without it the account's last point is the current
  // price while SPY's is up to five minutes behind, and the gap between the
  // lines — the one number the chart exists to show — would drift every time a
  // bar rolled over.
  const marks = isNow ? await liveMarks(env, symbols, waitUntil) : new Map<string, number>();

  const { points, base: replayedBase } = replayIntraday({
    stamps,
    sessionDate,
    trades,
    startingCash,
    prices,
    prevCloses,
    marks: marks.size > 0 ? marks : undefined,
  });

  // A stored snapshot for the previous session wins over the replay for the
  // same reason it does on the session chart: it was computed at that close
  // against marks that were real at the time.
  const stored = prevSessionDate ? snapshots.get(prevSessionDate) : undefined;
  const base = stored !== undefined && stored > 0 ? stored : replayedBase;

  const spy = intradaySeries(minute, "SPY", stamps, sessionDate, prevCloses, base, marks);
  const qqq = intradaySeries(minute, "QQQ", stamps, sessionDate, prevCloses, base, marks);

  const rows: CurveRow[] = stamps.map((at, i) => ({
    t: at,
    label: exchangeTime(at),
    me: points[i]?.equity ?? base,
    spy: spy[i] ?? null,
    qqq: qqq[i] ?? null,
    club: null,
  }));

  const value = rows.at(-1)?.me ?? null;

  return {
    range: "1D",
    intraday: true,
    sessionDate,
    baseDate: prevSessionDate,
    base,
    value,
    change: value === null ? null : value - base,
    seasonStart,
    startingCash,
    rows,
    summary: {
      me: returnFromBase(
        rows.map((row) => row.me),
        base,
      ),
      spy: returnFromBase(spy, base),
      qqq: returnFromBase(qqq, base),
      club: null,
    },
    // Always replayed: `portfolio_snapshots` holds one row per session, so the
    // only thing a snapshot can contribute to this chart is its baseline.
    source: "reconstructed",
    clubNote: "The club average is a nightly figure, so it has no intraday line.",
    live: isNow && marks.size > 0,
    degraded,
    asOf: new Date().toISOString(),
  };
}

/** Minutes past midnight, exchange time. "09:35" -> 575. */
function minuteOfDay(at: string): number {
  const [hours, minutes] = exchangeTime(at).split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Drop every bucket outside the session the exchange actually held.
 *
 * Alpaca's intraday bars run the full 04:00-20:00 extended day. This app has
 * never treated those hours as the market being open — `quoteFromSnapshot`
 * ignores extended prints for overnight valuations, and an order placed then is
 * refused — so a chart drawing them would be the one screen claiming otherwise,
 * and it would hand the most prominent moves of the day to its thinnest prints.
 *
 * The bounds come from the calendar rather than from constants, which is what
 * ends the line at 13:00 on the Friday after Thanksgiving instead of drawing
 * three flat hours after the close. When the calendar is unreachable the
 * regular session stands in: right on every day of the year but those three.
 *
 * A date with no calendar row at all still keeps its regular hours rather than
 * being dropped. The calendar failing should shorten nothing.
 */
export function regularHours(
  minute: Map<string, IntradayBar[]>,
  calendar: Map<string, CalendarDay>,
): Map<string, IntradayBar[]> {
  const out = new Map<string, IntradayBar[]>();

  for (const [symbol, series] of minute) {
    const kept = series.filter((bar) => {
      const session = calendar.get(bar.date) ?? DEFAULT_SESSION;
      const at = minuteOfDay(bar.at);
      // The closing bucket opens before the bell and is part of the session;
      // one opening at the bell itself is after it.
      return at >= session.openMinute && at < session.closeMinute;
    });

    if (kept.length > 0) out.set(symbol, kept);
  }

  return out;
}

/** The most recent session anything printed an intraday bar for. */
export function latestSession(minute: Map<string, IntradayBar[]>): string | null {
  // SPY first and alone if it has anything: it trades every minute of every
  // session, so its bars are the exchange calendar at this resolution just as
  // its daily bars are at the other. A thin name can be absent from a whole
  // session without the market being shut.
  const spy = minute.get("SPY");
  if (spy && spy.length > 0) {
    return spy.reduce((latest, bar) => (bar.date > latest ? bar.date : latest), spy[0]!.date);
  }

  let latest: string | null = null;
  for (const series of minute.values()) {
    for (const bar of series) if (latest === null || bar.date > latest) latest = bar.date;
  }
  return latest;
}

/**
 * The x-axis: every bucket the session actually printed, ascending.
 *
 * Taken from SPY for the same reason the session axis is, which is also what
 * ends the line at 13:00 on a half day with no half-day list existing.
 */
export function sessionStamps(minute: Map<string, IntradayBar[]>, sessionDate: string): string[] {
  const spy = (minute.get("SPY") ?? []).filter((bar) => bar.date === sessionDate);
  if (spy.length > 0) return spy.map((bar) => bar.at).sort();

  const all = new Set<string>();
  for (const series of minute.values()) {
    for (const bar of series) if (bar.date === sessionDate) all.add(bar.at);
  }
  return [...all].sort();
}

/** The last session that closed before the one being drawn. */
export function previousSession(daily: Map<string, DailyBar[]>, sessionDate: string): string | null {
  const dates = new Set<string>();

  const spy = daily.get("SPY");
  if (spy && spy.length > 0) {
    for (const bar of spy) dates.add(bar.date);
  } else {
    for (const series of daily.values()) for (const bar of series) dates.add(bar.date);
  }

  const before = [...dates].filter((date) => date < sessionDate).sort();
  return before.at(-1) ?? null;
}

/**
 * Each symbol's last official close on or before a session.
 *
 * These are the day's opening marks. `on or before` rather than `on` because a
 * name that did not trade yesterday is still worth what it was worth the last
 * time it did — the same carry-forward the replay does, applied once up front.
 */
export function closesAsOf(
  daily: Map<string, DailyBar[]>,
  sessionDate: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!sessionDate) return out;

  for (const [symbol, series] of daily) {
    let close: number | null = null;
    let on: string | null = null;

    for (const bar of series) {
      if (bar.date > sessionDate || !(bar.close > 0)) continue;
      if (on === null || bar.date >= on) {
        on = bar.date;
        close = bar.close;
      }
    }

    if (close !== null) out.set(symbol, close);
  }

  return out;
}

/**
 * A benchmark's session, in dollars, starting the day where the account did.
 *
 * The scale is anchored to the benchmark's *previous close* rather than to its
 * first print, so both lines leave the same point at 09:30 and the gap between
 * them at any moment is the day's excess return. Anchoring on the opening
 * print instead would hide the overnight gap, which on most days is most of
 * the move.
 */
export function intradaySeries(
  minute: Map<string, IntradayBar[]>,
  symbol: string,
  stamps: string[],
  sessionDate: string,
  prevCloses: Map<string, number>,
  base: number,
  marks: Map<string, number>,
): (number | null)[] {
  const bars = (minute.get(symbol) ?? []).filter((bar) => bar.date === sessionDate);
  if (bars.length === 0) return stamps.map(() => null);

  // With no previous close the day's open is the only anchor there is. The
  // line then measures from the bell rather than from yesterday, which is a
  // weaker claim but a drawable one.
  const prevClose = prevCloses.get(symbol);
  const anchor = prevClose && prevClose > 0 ? prevClose : bars[0]!.open;
  if (!(anchor > 0)) return stamps.map(() => null);

  const byStamp = new Map(bars.map((bar) => [bar.at, bar.close]));
  const lastStamp = stamps.at(-1);
  const mark = marks.get(symbol);
  let carried = anchor;

  const raw = stamps.map((stamp) => {
    const close = byStamp.get(stamp);
    if (close !== undefined && close > 0) carried = close;
    // The final point is now, not the instant its bucket opened — the same
    // rule the account's own line follows.
    return stamp === lastStamp && mark !== undefined && mark > 0 ? mark : carried;
  });

  return scaleTo(raw, base, anchor);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** "2026-08-30" -> "08/30", without constructing a Date and inviting a timezone. */
function axisDate(date: string): string {
  return date.slice(5).replace("-", "/");
}

/**
 * Every symbol the curve has to price, in the order it would rather lose them.
 *
 * The bar caches take a fixed number of symbols per call and drop the tail, so
 * the order here is a priority list, not a formality. **The benchmarks go
 * first**: without SPY there is no x-axis, and a member who has traded sixty
 * tickers in a season would otherwise be the one person whose chart loses its
 * calendar. Current holdings come next, because they are what the last point
 * is made of, and symbols only in the blotter come last — a position closed in
 * March that goes unpriced moves nothing but a few points in the middle of the
 * line.
 */
function pricingOrder(positions: Position[], trades: TradeRecord[]): string[] {
  return [
    ...new Set([
      ...BENCHMARKS,
      ...positions.map((p) => p.symbol),
      ...trades.map((t) => t.symbol),
    ]),
  ];
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

  const source = stored === 0 ? "reconstructed" : stored === equity.length ? "snapshots" : "mixed";

  return { equity, source };
}

function pick(bars: Map<string, DailyBar[]>, symbol: string, dates: string[]): (number | null)[] {
  const series = bars.get(symbol);
  return series ? alignCloses(series, dates) : dates.map(() => null);
}

async function liveMarks(
  env: Env,
  symbols: string[],
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();

  try {
    const result = await quoteCache(env).get(symbols, waitUntil);
    return new Map([...result.quotes].map(([symbol, quote]) => [symbol, quote.price]));
  } catch (err) {
    // The curve still draws; its last point is the previous close rather than
    // the current mark, which is a smaller lie than no chart.
    console.error("Live marks unavailable for the equity curve:", err);
    return new Map();
  }
}

async function loadTrades(supabase: SupabaseClient, portfolioId: string): Promise<TradeRecord[]> {
  const { data, error } = await supabase
    .from("trades")
    .select("symbol, side, qty, price, notional, multiplier, executed_at")
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
    multiplier: Number(row.multiplier ?? 1),
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

  const points = (data ?? []).map((row: { as_of: string; avg_equity: string | number }) => ({
    date: row.as_of,
    close: Number(row.avg_equity),
  }));

  return {
    points,
    note: points.length === 0 ? "The club average starts once nightly snapshots do." : null,
  };
}
