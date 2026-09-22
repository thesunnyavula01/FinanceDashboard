import { Hono } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import { activeSeason, type Season } from "../lib/portfolio.ts";
import { benchmarkMove, rankClub, type ClubPortfolio, type Mark } from "../lib/leaderboard.ts";
import { BENCHMARKS } from "../analytics/curve.ts";
import { dailyBars } from "../market/bars.ts";
import { quoteCache } from "../market/quotes.ts";
import { exchangeDate } from "../market/provider.ts";
import type { Env } from "../types.ts";

/**
 * The standings.
 *
 * Every member's book, valued at one shared set of marks, ranked by return.
 * Assembled server-side even though members are allowed to read each other's
 * positions directly, for two reasons that are really the same reason:
 *
 *   * The client would have to price the *union* of the club's holdings — a
 *     couple of hundred symbols — on top of its own, turning one member's quote
 *     poll into everyone's. Here it is one batch off a cache the dashboard has
 *     already warmed.
 *   * Equity has one definition, and it lives in `marketValues()`. Computing it
 *     a second time in the browser for other people's portfolios is how the
 *     leaderboard ends up disagreeing with the positions screen.
 *
 * The ranked payload is identical for every member — nothing in it depends on
 * who asked — so it is memoised per season for one quote interval. A hundred
 * members refreshing together read one database round trip between them, and
 * the "you" highlight is applied in the browser from the row's user id.
 */

export const leaderboard = new Hono<AuthedBindings>();

leaderboard.use("*", requireAuth);

/**
 * How long a ranking is served before it is rebuilt.
 *
 * Matched to the quote cache's TTL: a fresher leaderboard would be re-reading
 * the whole club's positions to multiply them by prices that have not changed.
 */
const RANKING_TTL_MS = 20_000;

/** A club far larger than the 30-100 this is built for. Bounds one bad query. */
const MAX_MEMBERS = 500;

/** Fills shown on a member's detail panel. A season's worth is not the point. */
const DETAIL_TRADES = 50;

/** A member of the club who is not in the standings, and why. */
export interface UnrankedMember {
  userId: string;
  displayName: string;
}

interface Standings {
  season: { id: string; name: string; startsAt: string; tradingLocked: boolean };
  rows: ReturnType<typeof rankClub>["rows"];
  summary: ReturnType<typeof rankClub>["summary"];
  /** Each benchmark's move over the same window the members are measured on. */
  benchmarks: { spy: number | null; qqq: number | null };
  /** Positions across the club that nothing could price. */
  unpriced: number;
  /**
   * Members of the club with no portfolio in this season.
   *
   * Membership and active-season portfolios come from one database snapshot.
   * Only a complete read can report a genuine funding gap. A truncated or failed
   * read fails the refresh instead; it is never evidence to fund a new account.
   */
  missing: UnrankedMember[];
  /**
   * Kept for older clients. New builds reject incomplete database reads rather
   * than publishing a partial club; successful responses always carry false.
   */
  truncated: boolean;
  asOf: string;
  note?: string;
}

let cached: { seasonId: string; at: number; standings: Standings } | null = null;
let pending: { seasonId: string; promise: Promise<Standings> } | null = null;

/** Drops the memo. For the admin console, which can change what it ranks. */
export function forgetStandings(): void {
  cached = null;
  // Detach an older read too: it must not repopulate the memo after a repair,
  // reset or season change has invalidated the books it was reading.
  pending = null;
}

leaderboard.get("/", async (c) => {
  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  try {
    const season = await activeSeason(supabase);
    if (!season) {
      return c.json(emptyStandings("There is no active season yet. Ask a club officer to start one."));
    }

    if (cached && cached.seasonId === season.id && Date.now() - cached.at < RANKING_TTL_MS) {
      return c.json(cached.standings);
    }

    // Polls arriving while the memo is cold share the database read as well as
    // the quotes. Otherwise a slow older build can overwrite a newer roster.
    if (!pending || pending.seasonId !== season.id) {
      const work = {
        seasonId: season.id,
        promise: buildStandings(c.env, supabase, season, (p) => c.executionCtx.waitUntil(p)),
      };
      pending = work;
      work.promise = work.promise.then((standings) => {
        if (pending === work) cached = { seasonId: season.id, at: Date.now(), standings };
        return standings;
      }).finally(() => {
        if (pending === work) pending = null;
      });
    }
    const standings = await pending.promise;
    return c.json(standings);
  } catch (err) {
    console.error("leaderboard build failed:", err);
    return c.json({ error: "Could not load the standings." }, 500);
  }
});

/**
 * GET /api/leaderboard/:portfolioId — one member's book, read-only.
 *
 * Positions and fills, unpriced. The browser already knows how to value a set
 * of positions at a set of quotes — it does it for the member's own portfolio
 * on every tick — so sending the same shape means the detail panel reuses that
 * arithmetic instead of growing a second copy of it.
 *
 * `pending_orders` is not here and must not be. Every other table is open
 * across the club on purpose; a resting order is intent, and publishing it
 * invites the rest of the club to trade in front of it.
 */
leaderboard.get("/:portfolioId", async (c) => {
  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const season = await activeSeason(supabase);
  if (!season) return c.json({ error: "There is no active season." }, 404);

  const { data: portfolio, error } = await supabase
    .from("portfolios")
    .select("id, user_id, cash, starting_cash, profiles(display_name, role)")
    .eq("id", c.req.param("portfolioId"))
    .eq("season_id", season.id)
    .maybeSingle();

  if (error) {
    console.error("member lookup failed:", error);
    return c.json({ error: "Could not load that member." }, 500);
  }
  if (!portfolio) return c.json({ error: "No such member in this season." }, 404);

  const [{ data: positions, error: positionsError }, { data: trades, error: tradesError }] = await Promise.all([
    supabase.from("positions").select("symbol, qty, avg_cost, multiplier").eq("portfolio_id", portfolio.id),
    supabase
      .from("trades")
      .select("id, symbol, side, qty, price, notional, realized_pnl, executed_at")
      .eq("portfolio_id", portfolio.id)
      .order("executed_at", { ascending: false })
      .limit(DETAIL_TRADES),
  ]);

  if (positionsError || tradesError) {
    console.error("Member book query failed:", positionsError ?? tradesError);
    return c.json({ error: "Could not load that member's positions and trades." }, 500);
  }

  const profile = profileOf(portfolio);

  return c.json({
    member: {
      portfolioId: portfolio.id,
      userId: portfolio.user_id,
      displayName: profile.display_name,
      role: profile.role,
    },
    cash: Number(portfolio.cash),
    startingCash: Number(portfolio.starting_cash),
    positions: (positions ?? []).map((row) => ({
      symbol: row.symbol as string,
      qty: Number(row.qty),
      avgCost: Number(row.avg_cost),
      multiplier: Number(row.multiplier ?? 1),
    })),
    trades: (trades ?? []).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      qty: row.qty,
      price: row.price,
      notional: row.notional,
      realizedPnl: row.realized_pnl,
      executedAt: row.executed_at,
    })),
  });
});

async function buildStandings(
  env: Env,
  supabase: SupabaseClient,
  season: Season,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Standings> {
  const { portfolios, missing, truncated } = await loadClub(supabase, season.id);

  const held = [...new Set(portfolios.flatMap((p) => p.positions.map((pos) => pos.symbol)))];
  const symbols = [...new Set([...held, ...BENCHMARKS])];

  const { quotes } = await quoteCache(env).get(symbols, waitUntil);

  const marks = new Map<string, Mark>(
    [...quotes].map(([symbol, quote]) => [
      symbol,
      { price: quote.price, prevClose: quote.prevClose },
    ]),
  );

  const benchmarks = await benchmarkReturns(env, season, marks, waitUntil);

  // SPY is the ruler on every other screen in the app, so it is the one the
  // excess column is measured against. QQQ is shown but not subtracted.
  const { rows, summary } = rankClub(portfolios, marks, benchmarks.spy);

  return {
    season: {
      id: season.id,
      name: season.name,
      startsAt: season.startsAt,
      tradingLocked: season.tradingLocked,
    },
    rows,
    summary,
    benchmarks,
    unpriced: rows.reduce((sum, row) => sum + row.unpriced, 0),
    missing,
    truncated,
    asOf: new Date().toISOString(),
  };
}

/**
 * Read membership and books in one database snapshot. Separate roster and
 * portfolio reads can straddle an atomic signup, falsely reporting its owner
 * as unfunded. The left embedding retains genuinely unfunded members; the
 * season filter applies to their books, not to who belongs to the club.
 *
 * Exact counts cover both top-level rows and embedded holdings. PostgREST can
 * return HTTP 200 with fewer rows than requested when its server-side cap is
 * lower than our limit. A partial success must fail this refresh, preserving
 * the browser's last complete standings instead of replacing the club with a
 * smaller one or claiming that a truncated member needs a new portfolio.
 */
async function loadClub(
  supabase: SupabaseClient,
  seasonId: string,
): Promise<{ portfolios: ClubPortfolio[]; missing: UnrankedMember[]; truncated: boolean }> {
  const { data, error, count } = await supabase
    .from("profiles")
    .select(
      "id, display_name, role, portfolios(id, cash, starting_cash, positions(symbol, qty, avg_cost, multiplier), position_count:positions(count)), portfolio_count:portfolios(count)",
      { count: "exact" },
    )
    .eq("portfolios.season_id", seasonId)
    .eq("portfolio_count.season_id", seasonId)
    .order("id")
    .limit(MAX_MEMBERS);

  if (error) throw error;
  if (!Array.isArray(data) || data.length !== count) {
    throw new Error(`Standings incomplete: received ${data?.length ?? "no"}/${count} members.`);
  }

  const portfolios: ClubPortfolio[] = [];
  const missing: UnrankedMember[] = [];
  for (const profile of data) {
    const books = profile.portfolios;
    if (!Array.isArray(books) || books.length !== profile.portfolio_count?.[0]?.count || books.length > 1) {
      throw new Error(`Standings incomplete: portfolio count mismatch for member ${profile.id}.`);
    }
    const row = books[0];
    if (!row) {
      missing.push({ userId: profile.id, displayName: profile.display_name ?? "Unknown member" });
      continue;
    }
    if (!Array.isArray(row.positions) || row.positions.length !== row.position_count?.[0]?.count) {
      throw new Error(`Standings incomplete: holdings truncated for portfolio ${row.id}.`);
    }
    portfolios.push({
      portfolioId: row.id as string,
      userId: profile.id as string,
      displayName: profile.display_name ?? "Unknown member",
      role: profile.role === "admin" ? "admin" : "member",
      cash: Number(row.cash),
      startingCash: Number(row.starting_cash),
      positions: ((row.positions ?? []) as Record<string, unknown>[]).map((position) => ({
        symbol: position.symbol as string,
        qty: Number(position.qty),
        avgCost: Number(position.avg_cost),
        multiplier: Number(position.multiplier ?? 1),
      })),
    });
  }

  return { portfolios, missing, truncated: false };
}

/**
 * SPY and QQQ over the season, on the same basis the members are measured on.
 *
 * The first close at or after the season start is the baseline and the live
 * mark is the last point, which is what makes "you are up 4%, SPY is up 6%"
 * a comparison of two things measured the same way. Bars are cached in the
 * Worker, so this costs nothing on the second request of the day.
 *
 * A failure here is not a failure of the screen: the standings still rank, and
 * the excess column reads as unmeasured rather than as zero.
 */
async function benchmarkReturns(
  env: Env,
  season: Season,
  marks: Map<string, Mark>,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<{ spy: number | null; qqq: number | null }> {
  try {
    const bars = await dailyBars(
      env,
      [...BENCHMARKS],
      exchangeDate(season.startsAt),
      exchangeDate(),
      waitUntil,
    );

    const move = (symbol: string) => {
      const series = bars.get(symbol);
      if (!series || series.length === 0) return null;
      return benchmarkMove(
        series.map((bar) => bar.close),
        marks.get(symbol)?.price ?? null,
      );
    };

    return { spy: move("SPY"), qqq: move("QQQ") };
  } catch (err) {
    console.error("Benchmark bars unavailable for the leaderboard:", err);
    return { spy: null, qqq: null };
  }
}

/**
 * PostgREST types an embedded to-one relation as an array or an object
 * depending on how it inferred the relationship, so both are unwrapped here
 * rather than at three call sites.
 */
function profileOf(row: Record<string, unknown>): { display_name: string; role: "member" | "admin" } {
  const embedded = row.profiles;
  const profile = (Array.isArray(embedded) ? embedded[0] : embedded) as
    | { display_name?: string; role?: string }
    | null
    | undefined;

  return {
    display_name: profile?.display_name ?? "Unknown member",
    role: profile?.role === "admin" ? "admin" : "member",
  };
}

/** The shape of "there is nothing to rank", so the screen has one code path. */
function emptyStandings(note: string): Standings {
  return {
    season: { id: "", name: "", startsAt: new Date().toISOString(), tradingLocked: false },
    rows: [],
    summary: {
      members: 0,
      averageReturn: null,
      medianReturn: null,
      bestReturn: null,
      worstReturn: null,
      beatingBenchmark: null,
      totalEquity: 0,
    },
    benchmarks: { spy: null, qqq: null },
    unpriced: 0,
    missing: [],
    truncated: false,
    asOf: new Date().toISOString(),
    note,
  };
}
