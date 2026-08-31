import { Hono } from "hono";
import { requireAdmin, requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { marketClock } from "../market/clock.ts";
import { describeMarketError } from "../market/provider.ts";
import { parseSymbols } from "../market/quotes.ts";
import { getSecurities } from "../market/securities.ts";
import { searchSymbols, syncUniverse, universeMeta } from "../market/universe.ts";

export const market = new Hono<AuthedBindings>();

/** Everything under /api/market is for signed-in members. */
market.use("*", requireAuth);

/**
 * GET /api/market/clock
 *
 * Open or closed, from the exchange calendar. `authoritative: false` means
 * Alpaca could not be reached and this is a wall-clock guess, which the status
 * rail labels and the order route will refuse to trade on.
 */
market.get("/clock", async (c) => {
  const clock = await marketClock(c.env);
  return c.json({ ...clock, serverTime: new Date().toISOString() });
});

/**
 * GET /api/market/symbols?q=nvi
 *
 * Ticker autocomplete, served from the KV copy of Alpaca's asset list.
 *
 * `warming: true` means that list has never been synced. The cron trigger does
 * it nightly, but a fresh deployment would otherwise have a dead search box
 * until the first weekday evening, so a cold read kicks off a sync behind the
 * response and the next keystroke finds it.
 */
market.get("/symbols", async (c) => {
  const query = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);

  if (query.length === 0) return c.json({ results: [], warming: false });

  try {
    const found = await searchSymbols(c.env, query, limit);

    if (found.warming) {
      c.executionCtx.waitUntil(
        syncUniverse(c.env).catch((err) => console.error("Universe sync failed:", err)),
      );
    }

    return c.json(found);
  } catch (err) {
    const { message, status } = describeMarketError(err);
    if (status === 502) console.error("Symbol search failed:", err);
    return c.json({ error: message }, status);
  }
});

/**
 * GET /api/market/securities?symbols=AAPL,SPY
 *
 * Names and sectors. Split from /api/quotes on purpose: prices change every
 * twenty seconds and this does not change at all, so the client caches the two
 * on completely different schedules.
 *
 * Symbols nobody has looked up before come back in `pending` rather than
 * holding up the response; the Finnhub call runs behind it and the next
 * request has them.
 */
market.get("/securities", async (c) => {
  const { symbols, rejected } = parseSymbols(c.req.query("symbols"));

  if (symbols.length === 0) {
    return c.json({ securities: {}, pending: [], rejected });
  }

  const result = await getSecurities(c.env, symbols, (p) => c.executionCtx.waitUntil(p));

  return c.json({
    securities: Object.fromEntries(result.securities),
    pending: result.pending,
    rejected,
  });
});

/**
 * POST /api/market/universe/sync — officers only.
 *
 * The cron trigger handles this nightly. This exists for the first deploy and
 * for the day a member asks why a newly listed ticker is missing.
 */
market.post("/universe/sync", requireAdmin, async (c) => {
  try {
    const meta = await syncUniverse(c.env);
    return c.json({ ok: true, ...meta });
  } catch (err) {
    const { message, status } = describeMarketError(err);
    if (status === 502) console.error("Universe sync failed:", err);
    return c.json({ error: message }, status);
  }
});

/** GET /api/market/universe — when the asset list was last synced, and how big. */
market.get("/universe", async (c) => {
  const meta = await universeMeta(c.env);
  return c.json(meta ?? { count: 0, syncedAt: null });
});
