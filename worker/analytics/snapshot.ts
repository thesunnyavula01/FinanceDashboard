import type { SupabaseClient } from "@supabase/supabase-js";
import { activeSeason } from "../lib/portfolio.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import { dailyBars, MAX_BAR_SYMBOLS } from "../market/bars.ts";
import { exchangeDate, type DailyBar } from "../market/provider.ts";
import { marketValues, round, type Position } from "../orders/engine.ts";
import type { Env } from "../types.ts";
import { BENCHMARKS, shiftDate } from "./curve.ts";

/**
 * The nightly snapshot.
 *
 * Phase 5 made the equity curve a replay of the blotter, which is why there is
 * a chart at all before this file existed. So the first question is what a
 * stored snapshot is still for, and there are three answers:
 *
 *   * **A replay decays.** It values a position at whatever daily bars are
 *     still available, and a delisted or renamed ticker eventually has none.
 *     A snapshot written the evening it was true stays true.
 *   * **It is the positions table, not the blotter.** The replay derives the
 *     book from fills; this reads the book. They should agree, and a snapshot
 *     is the record that says whether they did.
 *   * **The club average needs rows.** `club_equity_curve()` averages
 *     `portfolio_snapshots` inside Postgres precisely so a hundred members'
 *     history is one aggregate rather than twenty-five thousand rows over the
 *     wire — and it has had nothing to average until now.
 *
 * **Prices come from daily bars, not from the quote cache.** This is the
 * decision the whole file turns on. The job runs after the close, when
 * `latestTrade` is an after-hours IEX print — thin, and not what anyone's
 * screen said at 16:00. More importantly `history.ts` *merges* snapshots into a
 * replay valued at bar closes, so a snapshot priced any other way would put a
 * step in the curve on exactly the days it was meant to improve. The official
 * close is the only mark that makes the two agree.
 *
 * **A missed night is not backfilled, deliberately.** Reconstructing Tuesday's
 * snapshot on Wednesday means replaying Tuesday — and `mergeSnapshots()` trusts
 * a snapshot over a replay on the grounds that it was computed at the close
 * against marks that were real at the time. A replay wearing a snapshot's
 * clothes would quietly retire that guarantee, and the replay already covers
 * the gap for free. So this writes today or it writes nothing.
 *
 * Everything is upserted on the unique constraints the schema already carries,
 * so running it twice in an evening is the same as running it once. That is
 * what makes `POST /api/portfolio/snapshot` safe to press.
 */

/**
 * How far back bars are pulled.
 *
 * Only today's close is needed to value the book, but a fortnight costs the
 * same one request and buys two things: a carried-forward close for a name that
 * did not trade today, and a benchmark series that repairs any night this job
 * did not run.
 */
const LOOKBACK_DAYS = 21;

/** A club far larger than the 30-100 this is built for. Bounds one bad query. */
const MAX_PORTFOLIOS = 500;

/** Rows per upsert. A whole club fits in one; this is the guard, not the plan. */
const UPSERT_CHUNK = 250;

/** A portfolio as this job reads it: the book, not the blotter. */
export interface SnapshotPortfolio {
  portfolioId: string;
  cash: number;
  positions: Position[];
}

/** A `portfolio_snapshots` row, in the column names the table uses. */
export interface SnapshotRow {
  portfolio_id: string;
  as_of: string;
  equity: number;
  cash: number;
  long_mv: number;
  short_mv: number;
}

/** A `benchmark_snapshots` row. */
export interface BenchmarkRow {
  symbol: string;
  as_of: string;
  close: number;
}

export interface SnapshotResult {
  /** False when there was no session to record, which is the holiday case. */
  ran: boolean;
  reason: string | null;
  /** The session recorded, or null when none was. */
  asOf: string | null;
  seasonId: string | null;
  portfolios: number;
  benchmarks: number;
  /** Positions carried at average cost because no bar could price them. */
  unpriced: number;
}

export async function snapshotSeason(
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<SnapshotResult> {
  const empty: SnapshotResult = {
    ran: false,
    reason: null,
    asOf: null,
    seasonId: null,
    portfolios: 0,
    benchmarks: 0,
    unpriced: 0,
  };

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(env);
  } catch (err) {
    if (err instanceof ConfigError) return { ...empty, reason: err.message };
    throw err;
  }

  const season = await activeSeason(supabase);
  if (!season) return { ...empty, reason: "There is no active season to snapshot." };

  const today = exchangeDate();
  const from = shiftDate(today, { days: LOOKBACK_DAYS });
  const portfolios = await loadSeasonPortfolios(supabase, season.id);

  const symbols = [
    ...new Set([
      ...portfolios.flatMap((p) => p.positions.map((position) => position.symbol)),
      ...BENCHMARKS,
    ]),
  ];

  let bars: Map<string, DailyBar[]>;
  try {
    bars = await fetchBars(env, symbols, from, today, waitUntil);
  } catch (err) {
    // Nothing is written on a bad price feed. A gap in the table is repaired by
    // the replay; a row full of average costs recorded as though it were a set
    // of closes would be wrong forever, and `mergeSnapshots()` would prefer it
    // to the truth.
    console.error("Snapshot bars unavailable:", err);
    return { ...empty, seasonId: season.id, reason: "Daily bars were unavailable." };
  }

  // The gate, and the same one the chart's x-axis uses: SPY trades every
  // session and never halts, so a SPY bar dated today *is* the statement that
  // today was a session. Thanksgiving and the weekend both fail it, and neither
  // has to be enumerated anywhere.
  if (!tradedOn(bars, today)) {
    return { ...empty, seasonId: season.id, reason: `The market did not trade on ${today}.` };
  }

  const { rows, unpriced } = snapshotRows(portfolios, closesOn(bars, today), today);

  const [written, benchmarks] = await Promise.all([
    upsertSnapshots(supabase, rows),
    upsertBenchmarks(supabase, benchmarkRows(bars, BENCHMARKS, from)),
  ]);

  return {
    ran: true,
    reason: null,
    asOf: today,
    seasonId: season.id,
    portfolios: written,
    benchmarks,
    unpriced,
  };
}

/**
 * SPY and QQQ over a date range, stored.
 *
 * Called when a season is created, because a season may start in the past — an
 * officer setting one up in October for a club that began in September — and
 * the benchmark is the ruler every other number on the leaderboard is read
 * against. The nightly job keeps it current from there.
 *
 * A benchmark close is a fact about the market rather than about the club, so
 * re-writing a range is always safe and never means anything different.
 */
export async function backfillBenchmarks(
  env: Env,
  supabase: SupabaseClient,
  from: string,
  to: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<number> {
  const bars = await dailyBars(env, [...BENCHMARKS], from, to, waitUntil);
  return upsertBenchmarks(supabase, benchmarkRows(bars, BENCHMARKS, from));
}

// -----------------------------------------------------------------------------
// The arithmetic. No I/O below this line, which is what snapshot.test.ts pins.
// -----------------------------------------------------------------------------

/** Whether the exchange held a session on `date`, according to SPY's bars. */
export function tradedOn(bars: Map<string, DailyBar[]>, date: string): boolean {
  return (bars.get("SPY") ?? []).some((bar) => bar.date === date && bar.close > 0);
}

/**
 * The latest close at or before `on`, per symbol.
 *
 * Carried forward rather than dropped, for the same reason the replay carries
 * it forward: a halted or thinly traded name has no bar on some days, and "no
 * bar" is not "worth nothing". A symbol with no bar anywhere in the window is
 * absent from the map, which is how the caller counts it as unpriced.
 */
export function closesOn(bars: Map<string, DailyBar[]>, on: string): Map<string, number> {
  const out = new Map<string, number>();

  for (const [symbol, series] of bars) {
    let bestDate = "";
    let close: number | undefined;

    for (const bar of series) {
      if (bar.date > on || !(bar.close > 0) || bar.date < bestDate) continue;
      bestDate = bar.date;
      close = bar.close;
    }

    if (close !== undefined) out.set(symbol, close);
  }

  return out;
}

/**
 * Value every book at the close and shape the rows the table wants.
 *
 * `marketValues()` is the same function the order route and the leaderboard
 * value a portfolio with, so a snapshot cannot disagree with the screen that
 * was showing that portfolio a minute earlier. Its fallback applies here too: a
 * symbol nothing could price is carried at its average cost, which records it
 * at break-even rather than at zero, and the count comes back so the caller can
 * say how much of the evening was guesswork.
 */
export function snapshotRows(
  portfolios: SnapshotPortfolio[],
  marks: Map<string, number>,
  asOf: string,
): { rows: SnapshotRow[]; unpriced: number } {
  const prices = Object.fromEntries(marks);
  let unpriced = 0;

  const rows = portfolios.map((portfolio) => {
    for (const position of portfolio.positions) {
      if (!marks.has(position.symbol)) unpriced += 1;
    }

    const valuation = marketValues(portfolio.positions, prices, portfolio.cash);

    return {
      portfolio_id: portfolio.portfolioId,
      as_of: asOf,
      equity: valuation.equity,
      cash: round(portfolio.cash, 2),
      long_mv: valuation.longMv,
      short_mv: valuation.shortMv,
    };
  });

  return { rows, unpriced };
}

/** Every close in the window, as `benchmark_snapshots` rows. */
export function benchmarkRows(
  bars: Map<string, DailyBar[]>,
  symbols: readonly string[],
  from: string,
): BenchmarkRow[] {
  const rows: BenchmarkRow[] = [];

  for (const symbol of symbols) {
    for (const bar of bars.get(symbol) ?? []) {
      if (bar.date < from || !(bar.close > 0)) continue;
      rows.push({ symbol, as_of: bar.date, close: bar.close });
    }
  }

  return rows;
}

// -----------------------------------------------------------------------------
// I/O
// -----------------------------------------------------------------------------

async function loadSeasonPortfolios(
  supabase: SupabaseClient,
  seasonId: string,
): Promise<SnapshotPortfolio[]> {
  const { data, error } = await supabase
    .from("portfolios")
    .select("id, cash, positions(symbol, qty, avg_cost)")
    .eq("season_id", seasonId)
    .limit(MAX_PORTFOLIOS);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    portfolioId: row.id as string,
    cash: Number(row.cash),
    positions: ((row.positions ?? []) as Record<string, unknown>[]).map((position) => ({
      symbol: position.symbol as string,
      qty: Number(position.qty),
      avgCost: Number(position.avg_cost),
    })),
  }));
}

/**
 * Bars for every symbol the club holds, in provider-sized batches.
 *
 * `dailyBars()` truncates past its own ceiling rather than paging, so a club
 * holding more distinct names than one request allows would silently lose the
 * tail — and the portfolios holding those names would be snapshotted at average
 * cost without anything having failed.
 */
async function fetchBars(
  env: Env,
  symbols: string[],
  from: string,
  to: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Map<string, DailyBar[]>> {
  const out = new Map<string, DailyBar[]>();

  for (let i = 0; i < symbols.length; i += MAX_BAR_SYMBOLS) {
    const batch = await dailyBars(env, symbols.slice(i, i + MAX_BAR_SYMBOLS), from, to, waitUntil);
    for (const [symbol, series] of batch) out.set(symbol, series);
  }

  return out;
}

/**
 * Written idempotently, on the unique constraints the schema already carries.
 *
 * `(portfolio_id, as_of)` means a second run this evening overwrites the first
 * rather than doubling the club's history, which is what lets an officer press
 * the manual button without having to think about it.
 */
async function upsertSnapshots(supabase: SupabaseClient, rows: SnapshotRow[]): Promise<number> {
  return upsert(supabase, "portfolio_snapshots", "portfolio_id,as_of", rows);
}

async function upsertBenchmarks(supabase: SupabaseClient, rows: BenchmarkRow[]): Promise<number> {
  return upsert(supabase, "benchmark_snapshots", "symbol,as_of", rows);
}

async function upsert(
  supabase: SupabaseClient,
  table: string,
  onConflict: string,
  rows: object[],
): Promise<number> {
  let written = 0;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });

    // A failed chunk must not discard the ones that landed: the count returned
    // is what actually got written, and the next run repairs the rest.
    if (error) {
      console.error(`${table} upsert failed:`, error);
      break;
    }

    written += chunk.length;
  }

  return written;
}
