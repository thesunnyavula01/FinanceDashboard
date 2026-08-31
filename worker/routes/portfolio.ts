import { Hono } from "hono";
import { requireAdmin, requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import { loadPortfolio, PortfolioError } from "../lib/portfolio.ts";
import { parseRange } from "../analytics/curve.ts";
import { buildHistory, emptyHistory } from "../analytics/history.ts";
import { snapshotSeason } from "../analytics/snapshot.ts";

export const portfolio = new Hono<AuthedBindings>();

portfolio.use("*", requireAuth);

/**
 * GET /api/portfolio — cash, positions, and the season they belong to.
 *
 * Deliberately unpriced. Prices move every twenty seconds and positions move
 * only when someone trades, so valuing the portfolio here would tie the two
 * together: either the client re-reads the database three times a minute to
 * refresh a price it already has from /api/quotes, or the numbers on screen go
 * stale between orders. The client already polls quotes for these symbols, so it
 * multiplies them out itself — see src/hooks/usePortfolio.ts.
 *
 * The one place that arrangement does not hold is an order, where the valuation
 * decides whether the fill is allowed. That one happens inside place_order(), on
 * marks the Worker fetched, under the row lock — never here, and never in the
 * browser.
 */
portfolio.get("/", async (c) => {
  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  try {
    const loaded = await loadPortfolio(supabase, c.get("user").id);

    return c.json({
      portfolio: {
        id: loaded.id,
        cash: loaded.cash,
        startingCash: loaded.startingCash,
        season: loaded.season,
      },
      positions: loaded.positions,
    });
  } catch (err) {
    if (err instanceof PortfolioError) {
      // Neither case is something the member can fix, and both are states
      // rather than faults, so the screen renders empty with a reason on it
      // instead of showing an error page.
      return c.json({ portfolio: null, positions: [], note: err.message });
    }
    console.error("portfolio load failed:", err);
    return c.json({ error: "Could not load your portfolio." }, 500);
  }
});

/**
 * GET /api/portfolio/history?range=1W|1M|3M|YTD|ALL — the equity curve.
 *
 * One row per session, with the member's account, SPY, QQQ and the club average
 * all indexed to 100 at the first session in the range. Indexing at the range
 * start rather than at the season start is deliberate: a member who switches to
 * 1W is asking how this week went against the market, and a chart still
 * measuring from January answers a different question.
 *
 * Unlike /api/portfolio this endpoint is priced, and that is not a
 * contradiction. The positions grid re-values on the 20-second quote poll and
 * would re-read the database for nothing; a curve is a day's worth of history
 * that changes once a session, so it is assembled server-side where the bars
 * are already cached and the club average is one aggregate rather than
 * twenty-five thousand rows over the wire.
 */
portfolio.get("/history", async (c) => {
  const range = parseRange(c.req.query("range"));

  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  try {
    const loaded = await loadPortfolio(supabase, c.get("user").id);

    const history = await buildHistory({
      env: c.env,
      supabase,
      portfolioId: loaded.id,
      season: loaded.season,
      startingCash: loaded.startingCash,
      positions: loaded.positions,
      range,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });

    return c.json(history);
  } catch (err) {
    if (err instanceof PortfolioError) {
      return c.json(emptyHistory(range, err.message));
    }
    console.error("history build failed:", err);
    return c.json({ error: "Could not build your equity curve." }, 500);
  }
});

/**
 * POST /api/portfolio/snapshot — run tonight's snapshot now. Officers only.
 *
 * The same job the 22:15 UTC cron runs, on the same terms: it refuses if the
 * exchange did not hold a session today, and it upserts on
 * `(portfolio_id, as_of)` so pressing it twice writes the same row twice rather
 * than doubling the club's history. That is what makes it safe to hand to an
 * officer, and it is how the deploy is verified — fire it, check the rows, fire
 * it again, check the count did not move.
 *
 * It lives here rather than in the admin console for the same reason
 * /api/orders/sweep lives with the order routes: a forced job belongs beside
 * the thing it operates on, gated by requireAdmin. Nothing in
 * worker/routes/admin.ts does arithmetic on money, and this does.
 */
portfolio.post("/snapshot", requireAdmin, async (c) => {
  const result = await snapshotSeason(c.env, (p) => c.executionCtx.waitUntil(p));
  return c.json(result);
});
