import { Hono } from "hono";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin, requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import { activeSeason, forgetSeason } from "../lib/portfolio.ts";
import { generateInviteCode, inviteCode, setInviteCode } from "../lib/club.ts";
import { forgetStandings } from "./leaderboard.ts";
import { universeMeta } from "../market/universe.ts";
import { exchangeDate } from "../market/provider.ts";
import { backfillBenchmarks } from "../analytics/snapshot.ts";

/**
 * The officers' console.
 *
 * Every route here is behind requireAdmin, and the role is read from the
 * database on each call rather than from the session token — a token minted
 * before a demotion would keep asserting "admin" for the rest of its hour.
 *
 * Nothing in this file does arithmetic on money. Each mutation is one RPC into
 * migration 0005, which takes the locks, enforces the invariants, and is the
 * single place that knows what a correction implies. The Worker's job is to
 * check who is asking, shape the request, and translate a SQLSTATE into a
 * sentence — the same division of labour as the order route.
 */

export const admin = new Hono<AuthedBindings>();

admin.use("*", requireAuth, requireAdmin);

/** Club-wide fills shown for correction. Newest first; a season's worth is not. */
const MAX_TRADES = 200;

/**
 * The admin functions raise with a SQLSTATE per reason, the same convention
 * place_order() uses, so the console can style a refusal without matching on
 * message text.
 */
const SQLSTATE: Record<string, { code: string; status: 400 | 404 | 409 }> = {
  FC010: { code: "LAST_ADMIN", status: 409 },
  FC011: { code: "NOT_FOUND", status: 404 },
  FC012: { code: "INVALID_REQUEST", status: 400 },
  FC013: { code: "REPLAY_IMPOSSIBLE", status: 409 },
};

function describeRpcError(
  error: PostgrestError,
  fallback: string,
): [{ error: string; code?: string }, 400 | 404 | 409 | 500] {
  const known = SQLSTATE[error.code ?? ""];
  if (known) return [{ error: error.message, code: known.code }, known.status];

  console.error("admin RPC failed:", error);
  return [{ error: fallback }, 500];
}

/**
 * A mutation changed something the read paths cache.
 *
 * Both caches are per-isolate and short-lived, so this is not a correctness
 * mechanism — it is what makes the change visible on the officer's own screen
 * immediately rather than up to twenty seconds later, which is the difference
 * between a console that works and one they press twice.
 */
function invalidate(): void {
  forgetSeason();
  forgetStandings();
}

/**
 * GET /api/admin — everything the console draws on one screen.
 *
 * One request rather than five, because the console is a single screen that is
 * either loaded or not; a member list that arrives after the season panel would
 * only give an officer a moment in which the club looks empty.
 */
admin.get("/", async (c) => {
  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const [seasons, members, invite, universe] = await Promise.all([
    supabase
      .from("seasons")
      .select("id, name, starting_cash, starts_at, ends_at, is_active, trading_locked, created_at")
      .order("starts_at", { ascending: false }),
    loadMembers(supabase),
    inviteCode(c.env, supabase),
    universeMeta(c.env).catch(() => null),
  ]);

  if (seasons.error) {
    console.error("season list failed:", seasons.error);
    return c.json({ error: "Could not load the seasons." }, 500);
  }

  return c.json({
    seasons: (seasons.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      startingCash: Number(row.starting_cash),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      isActive: row.is_active,
      tradingLocked: row.trading_locked,
    })),
    members,
    invite: {
      code: invite.code,
      source: invite.source,
      updatedAt: invite.updatedAt,
    },
    universe: universe ?? { count: 0, syncedAt: null },
  });
});

/**
 * Every member, with their portfolio in the active season.
 *
 * A member with no portfolio still appears — that is exactly the state an
 * officer needs to see, because it means someone signed up between seasons and
 * cannot trade until a portfolio exists for them.
 */
async function loadMembers(supabase: SupabaseClient) {
  const season = await activeSeason(supabase);

  const [{ data: profiles, error }, { data: portfolios }] = await Promise.all([
    supabase.from("profiles").select("id, display_name, role, created_at").order("created_at"),
    season
      ? supabase
          .from("portfolios")
          .select("id, user_id, cash, starting_cash")
          .eq("season_id", season.id)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  if (error) throw error;

  const byUser = new Map(
    (portfolios ?? []).map((row) => [row.user_id as string, row as Record<string, unknown>]),
  );

  return (profiles ?? []).map((profile) => {
    const portfolio = byUser.get(profile.id as string);
    return {
      userId: profile.id,
      displayName: profile.display_name,
      role: profile.role,
      joinedAt: profile.created_at,
      portfolioId: (portfolio?.id as string) ?? null,
      cash: portfolio ? Number(portfolio.cash) : null,
      startingCash: portfolio ? Number(portfolio.starting_cash) : null,
    };
  });
}

/**
 * POST /api/admin/seasons — start a new competition.
 *
 * Every existing member gets a portfolio in it immediately, inside the same
 * transaction that activates it. A rollover that left members portfolio-less
 * would show the whole club "you do not have a portfolio in the active season"
 * the next morning, which reads as an outage.
 */
admin.post("/seasons", async (c) => {
  const body = await readJson<{ name?: unknown; startingCash?: unknown; startsAt?: unknown }>(c);
  if (!body) return c.json({ error: "Expected a JSON body.", code: "INVALID_REQUEST" }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const startingCash = Number(body.startingCash);

  if (name.length < 1 || name.length > 80) {
    return c.json({ error: "A season needs a name of 1 to 80 characters.", code: "INVALID_REQUEST" }, 400);
  }
  if (!Number.isFinite(startingCash) || startingCash <= 0) {
    return c.json({ error: "Starting cash must be greater than zero.", code: "INVALID_REQUEST" }, 400);
  }

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const startsAt = typeof body.startsAt === "string" ? body.startsAt : new Date().toISOString();

  const { data, error } = await supabase.rpc("create_season", {
    p_name: name,
    p_starting_cash: startingCash,
    p_starts_at: startsAt,
  });

  if (error) return c.json(...describeRpcError(error, "Could not start the season."));

  invalidate();
  const row = Array.isArray(data) ? data[0] : data;

  // Store SPY and QQQ back to the start date. A season can begin in the past —
  // an officer setting one up in October for a club that has been meeting since
  // September — and the benchmark is the ruler every figure on the leaderboard
  // is read against, so it should exist before the first member logs in rather
  // than from tonight onwards.
  //
  // Not awaited: the season exists either way, and an officer waiting on a
  // multi-month bar download to find out whether their season was created would
  // be the slowest thing in the console. The nightly job repairs a failure here
  // for every date inside its window, and this route can simply be pressed
  // again for the rest.
  c.executionCtx.waitUntil(
    backfillBenchmarks(c.env, supabase, exchangeDate(startsAt), exchangeDate())
      .then((count) => console.log(`Benchmark history stored: ${count} closes.`))
      .catch((err) => console.error("Benchmark backfill failed:", err)),
  );

  return c.json({
    ok: true,
    seasonId: row?.season_id ?? null,
    name: row?.season_name ?? name,
    portfolios: row?.portfolio_count ?? 0,
  });
});

/**
 * PATCH /api/admin/seasons/:id — rename, re-fund, lock.
 *
 * Every field is optional and an omitted one is left alone, so the lock toggle
 * does not have to restate the name and two officers editing different fields
 * cannot overwrite each other.
 *
 * Changing `startingCash` sets what a member who joins from now on is funded
 * with. It does not touch a portfolio that already exists — those carry their
 * own baseline, so an officer cannot accidentally rewrite the return of
 * everyone who has been trading since January.
 */
admin.patch("/seasons/:id", async (c) => {
  const body = await readJson<{
    name?: unknown;
    startingCash?: unknown;
    tradingLocked?: unknown;
    endsAt?: unknown;
  }>(c);
  if (!body) return c.json({ error: "Expected a JSON body.", code: "INVALID_REQUEST" }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : null;
  const startingCash = body.startingCash === undefined ? null : Number(body.startingCash);
  const tradingLocked = typeof body.tradingLocked === "boolean" ? body.tradingLocked : null;

  if (name !== null && (name.length < 1 || name.length > 80)) {
    return c.json({ error: "A season needs a name of 1 to 80 characters.", code: "INVALID_REQUEST" }, 400);
  }
  if (startingCash !== null && (!Number.isFinite(startingCash) || startingCash <= 0)) {
    return c.json({ error: "Starting cash must be greater than zero.", code: "INVALID_REQUEST" }, 400);
  }
  if (name === null && startingCash === null && tradingLocked === null && !body.endsAt) {
    return c.json({ error: "Nothing to change.", code: "INVALID_REQUEST" }, 400);
  }

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data, error } = await supabase.rpc("update_season", {
    p_season_id: c.req.param("id"),
    p_name: name,
    p_starting_cash: startingCash,
    p_trading_locked: tradingLocked,
    p_ends_at: typeof body.endsAt === "string" ? body.endsAt : null,
  });

  if (error) return c.json(...describeRpcError(error, "Could not update the season."));

  invalidate();
  const season = Array.isArray(data) ? data[0] : data;

  return c.json({
    ok: true,
    season: season && {
      id: season.id,
      name: season.name,
      startingCash: Number(season.starting_cash),
      startsAt: season.starts_at,
      endsAt: season.ends_at,
      isActive: season.is_active,
      tradingLocked: season.trading_locked,
    },
  });
});

/**
 * POST /api/admin/seasons/:id/reset — back to the starting line.
 *
 * Irreversible: positions, fills and resting orders in the season are deleted,
 * and every portfolio is re-funded at the season's current starting cash. The
 * officer has to send the season's exact name back, which is the whole safety
 * mechanism — a confirmation the browser can generate is not a confirmation.
 */
admin.post("/seasons/:id/reset", async (c) => {
  const body = await readJson<{ confirm?: unknown }>(c);
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data: season, error: lookup } = await supabase
    .from("seasons")
    .select("id, name")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (lookup) {
    console.error("season lookup failed:", lookup);
    return c.json({ error: "Could not read that season." }, 500);
  }
  if (!season) return c.json({ error: "No such season.", code: "NOT_FOUND" }, 404);

  if (confirm !== season.name) {
    return c.json(
      {
        error: `To reset this season, type its name exactly: ${season.name}`,
        code: "CONFIRM_REQUIRED",
      },
      400,
    );
  }

  const { data, error } = await supabase.rpc("reset_season", { p_season_id: season.id });
  if (error) return c.json(...describeRpcError(error, "Could not reset the season."));

  invalidate();
  const row = Array.isArray(data) ? data[0] : data;

  return c.json({
    ok: true,
    portfolios: row?.portfolio_count ?? 0,
    tradesDeleted: row?.trades_deleted ?? 0,
    positionsDeleted: row?.positions_deleted ?? 0,
  });
});

/**
 * POST /api/admin/invite — rotate the code.
 *
 * Send a code to set a specific one, or nothing to have one generated. The old
 * code stops working the moment this returns: there is no grace period, because
 * the reason to rotate is that the old one got out.
 */
admin.post("/invite", async (c) => {
  const body = await readJson<{ code?: unknown }>(c);
  const requested = typeof body?.code === "string" ? body.code.trim() : "";

  if (requested && (requested.length < 6 || requested.length > 64)) {
    return c.json({ error: "An invite code is 6 to 64 characters.", code: "INVALID_REQUEST" }, 400);
  }

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const code = requested || generateInviteCode();

  try {
    await setInviteCode(supabase, code, c.get("user").id);
  } catch (err) {
    console.error("invite code rotation failed:", err);
    return c.json({ error: "Could not save the new code. The old one still works." }, 500);
  }

  return c.json({ ok: true, code, source: "database", updatedAt: new Date().toISOString() });
});

/**
 * POST /api/admin/members/:userId/role — promote or demote.
 *
 * The database refuses to remove the last officer. Doing that check here as
 * well would be two officers reading "there is another admin" at the same
 * moment and both being right until they both commit.
 */
admin.post("/members/:userId/role", async (c) => {
  const body = await readJson<{ role?: unknown }>(c);
  const role = typeof body?.role === "string" ? body.role.trim().toLowerCase() : "";

  if (role !== "member" && role !== "admin") {
    return c.json({ error: "A role is either member or admin.", code: "INVALID_REQUEST" }, 400);
  }

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data, error } = await supabase.rpc("set_member_role", {
    p_user_id: c.req.param("userId"),
    p_role: role,
  });

  if (error) return c.json(...describeRpcError(error, "Could not change that member's role."));

  const profile = Array.isArray(data) ? data[0] : data;

  return c.json({
    ok: true,
    userId: profile?.id ?? c.req.param("userId"),
    displayName: profile?.display_name ?? null,
    role: profile?.role ?? role,
  });
});

/**
 * GET /api/admin/trades — the club's fills, newest first.
 *
 * The blotter an officer corrects from. Filterable by member and symbol,
 * because "void the AAPL fill someone entered at the wrong price" is how the
 * request always arrives.
 */
admin.get("/trades", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), MAX_TRADES);
  const portfolioId = c.req.query("portfolio")?.trim();
  const symbol = c.req.query("symbol")?.trim().toUpperCase();

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const season = await activeSeason(supabase);
  if (!season) return c.json({ trades: [], note: "There is no active season." });

  let query = supabase
    .from("trades")
    .select(
      "id, portfolio_id, symbol, side, qty, price, notional, realized_pnl, executed_at, " +
        "portfolios!inner(season_id, profiles(display_name))",
    )
    .eq("portfolios.season_id", season.id)
    .order("executed_at", { ascending: false })
    .limit(limit);

  if (portfolioId) query = query.eq("portfolio_id", portfolioId);
  if (symbol) query = query.eq("symbol", symbol);

  const { data, error } = await query;

  if (error) {
    console.error("admin blotter failed:", error);
    return c.json({ error: "Could not load the club's trades." }, 500);
  }

  // The row type is cast rather than inferred: PostgREST's TypeScript parser
  // does not model a nested embed behind an `!inner` join, and the alternative
  // is two round trips to avoid a cast.
  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  return c.json({
    trades: rows.map((row) => ({
      id: row.id,
      portfolioId: row.portfolio_id,
      member: memberNameOf(row),
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

/**
 * DELETE /api/admin/trades/:id — void a fill.
 * PATCH  /api/admin/trades/:id — correct its quantity or price.
 *
 * Both are the same move underneath: change the blotter, then replay it. The
 * replay is what keeps the average cost and every realised figure after the
 * change honest — see rebuild_portfolio() in migration 0005. If the replay
 * cannot produce a possible portfolio it raises FC013 and nothing is changed,
 * which is the right answer: the officer is told which later fill to deal with
 * first rather than handed a book that could not have happened.
 */
admin.delete("/trades/:id", async (c) => {
  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data, error } = await supabase.rpc("void_trade", { p_trade_id: c.req.param("id") });
  if (error) return c.json(...describeRpcError(error, "Could not void that trade."));

  invalidate();
  return c.json({ ok: true, ...rebuilt(data) });
});

admin.patch("/trades/:id", async (c) => {
  const body = await readJson<{ qty?: unknown; price?: unknown }>(c);
  if (!body) return c.json({ error: "Expected a JSON body.", code: "INVALID_REQUEST" }, 400);

  const qty = body.qty === undefined || body.qty === null ? null : Number(body.qty);
  const price = body.price === undefined || body.price === null ? null : Number(body.price);

  if (qty !== null && (!Number.isFinite(qty) || qty <= 0)) {
    return c.json(
      { error: "Quantity must be greater than zero. To remove a fill, void it.", code: "INVALID_REQUEST" },
      400,
    );
  }
  if (price !== null && (!Number.isFinite(price) || price <= 0)) {
    return c.json({ error: "Price must be greater than zero.", code: "INVALID_REQUEST" }, 400);
  }
  if (qty === null && price === null) {
    return c.json(
      { error: "A correction has to change the quantity, the price, or both.", code: "INVALID_REQUEST" },
      400,
    );
  }

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data, error } = await supabase.rpc("amend_trade", {
    p_trade_id: c.req.param("id"),
    p_qty: qty,
    p_price: price,
  });

  if (error) return c.json(...describeRpcError(error, "Could not correct that trade."));

  invalidate();
  return c.json({ ok: true, ...rebuilt(data) });
});

/** What a replay left behind, for the confirmation line in the console. */
function rebuilt(data: unknown) {
  const row = (Array.isArray(data) ? data[0] : data) as
    | { portfolio?: string; new_cash?: string; position_count?: number; trade_count?: number }
    | null
    | undefined;

  return {
    portfolioId: row?.portfolio ?? null,
    cash: row?.new_cash ?? null,
    positions: row?.position_count ?? 0,
    trades: row?.trade_count ?? 0,
  };
}

async function readJson<T>(c: { req: { json: <U>() => Promise<U> } }): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

/** PostgREST returns an embedded to-one relation as an object or an array. */
function memberNameOf(row: Record<string, unknown>): string {
  const portfolio = (Array.isArray(row.portfolios) ? row.portfolios[0] : row.portfolios) as
    | { profiles?: unknown }
    | null
    | undefined;
  const profile = (
    Array.isArray(portfolio?.profiles) ? portfolio?.profiles[0] : portfolio?.profiles
  ) as { display_name?: string } | null | undefined;

  return profile?.display_name ?? "Unknown member";
}
