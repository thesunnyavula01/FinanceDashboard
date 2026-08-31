import type { SupabaseClient } from "@supabase/supabase-js";
import type { Position } from "../orders/engine.ts";

/**
 * Reading a member's portfolio.
 *
 * Both /api/portfolio and /api/orders need the same three things — the active
 * season, this member's portfolio in it, and their positions — so the read
 * lives here once. Writing is not this file's business: every mutation goes
 * through place_order(), which does its own locked read.
 *
 * The queries are kept separate and simple rather than folded into one embedded
 * PostgREST select. A member accumulates one portfolio per season, so anything
 * that does not filter by the active season first is a `maybeSingle()` that
 * starts failing in year two.
 */

export interface Season {
  id: string;
  name: string;
  /**
   * What a member who joins *now* is funded with. Not the baseline any existing
   * portfolio is measured against — that is stamped on the portfolio itself, so
   * an officer raising this figure in the admin console does not rewrite the
   * return of everyone who already joined. See migration 0005.
   */
  defaultStartingCash: number;
  tradingLocked: boolean;
  /** When the competition began. The left edge of every chart. */
  startsAt: string;
}

export interface MemberPortfolio {
  id: string;
  cash: number;
  /** What this member was funded with. The denominator of their total return. */
  startingCash: number;
  season: Season;
  positions: Position[];
}

/**
 * Thrown for a state a member can act on, rather than a bug.
 *
 * `code` is assigned in the body rather than declared as a constructor
 * parameter property. That is not a style preference: `node --test` loads these
 * modules by stripping types, which cannot synthesise the assignment a
 * parameter property implies, so one anywhere in the import graph makes every
 * test that reaches it fail to load. See CLAUDE.md on the no-build-step rule.
 */
export class PortfolioError extends Error {
  readonly code: "NO_SEASON" | "NO_PORTFOLIO";

  constructor(message: string, code: "NO_SEASON" | "NO_PORTFOLIO") {
    super(message);
    this.name = "PortfolioError";
    this.code = code;
  }
}

/**
 * The active season, cached briefly in isolate memory.
 *
 * It is the same row for every member in the club and changes about once a
 * year, so re-reading it on every portfolio poll would be a hundred identical
 * queries a minute for nothing. Thirty seconds is short enough that an officer
 * flipping `trading_locked` in the admin console sees it take effect while they
 * are still looking at the screen.
 */
const SEASON_TTL_MS = 30_000;

let cachedSeason: { season: Season | null; at: number } | null = null;

export async function activeSeason(supabase: SupabaseClient): Promise<Season | null> {
  if (cachedSeason && Date.now() - cachedSeason.at < SEASON_TTL_MS) return cachedSeason.season;

  const { data, error } = await supabase
    .from("seasons")
    .select("id, name, starting_cash, trading_locked, starts_at")
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;

  const season: Season | null = data
    ? {
        id: data.id,
        name: data.name,
        defaultStartingCash: Number(data.starting_cash),
        tradingLocked: Boolean(data.trading_locked),
        startsAt: data.starts_at,
      }
    : null;

  cachedSeason = { season, at: Date.now() };
  return season;
}

/** Drops the season cache. For the admin console, once it can edit a season. */
export function forgetSeason(): void {
  cachedSeason = null;
}

export async function loadPortfolio(
  supabase: SupabaseClient,
  userId: string,
): Promise<MemberPortfolio> {
  const season = await activeSeason(supabase);
  if (!season) {
    throw new PortfolioError(
      "There is no active season yet. Ask a club officer to start one.",
      "NO_SEASON",
    );
  }

  const { data: portfolio, error } = await supabase
    .from("portfolios")
    .select("id, cash, starting_cash")
    .eq("user_id", userId)
    .eq("season_id", season.id)
    .maybeSingle();

  if (error) throw error;
  if (!portfolio) {
    throw new PortfolioError(
      "You do not have a portfolio in the active season. Ask a club officer.",
      "NO_PORTFOLIO",
    );
  }

  const { data: rows, error: positionsError } = await supabase
    .from("positions")
    .select("symbol, qty, avg_cost")
    .eq("portfolio_id", portfolio.id);

  if (positionsError) throw positionsError;

  return {
    id: portfolio.id,
    // Postgres numeric arrives as a string. It is parsed here only to compute
    // previews and pre-flight checks; nothing derived from it is ever written
    // back, because place_order() recomputes every balance under its own lock.
    cash: Number(portfolio.cash),
    startingCash: Number(portfolio.starting_cash),
    season,
    positions: (rows ?? []).map((row) => ({
      symbol: row.symbol as string,
      qty: Number(row.qty),
      avgCost: Number(row.avg_cost),
    })),
  };
}
