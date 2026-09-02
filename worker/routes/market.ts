import { Hono } from "hono";
import { requireAdmin, requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { loadChain } from "../market/chain.ts";
import { marketClock } from "../market/clock.ts";
import { describeMarketError } from "../market/provider.ts";
import { parseSymbols } from "../market/quotes.ts";
import { getSecurities } from "../market/securities.ts";
import { ASSET_CLASSES, EQUITY_SYMBOL, type AssetClass } from "../market/symbols.ts";
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
  // Which instrument the ticket is on. Absent means "any", which is what the
  // command bar wants; the ticket always names one, so a crypto search cannot
  // return a stock and an option's underlying search cannot return a coin.
  const raw = (c.req.query("class") ?? "").trim().toUpperCase();
  const assetClass = (ASSET_CLASSES as readonly string[]).includes(raw)
    ? (raw as AssetClass)
    : undefined;

  if (query.length === 0) return c.json({ results: [], warming: false });

  try {
    const found = await searchSymbols(c.env, query, limit, assetClass);

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

/**
 * GET /api/market/chain?underlying=AAPL&expiration=2026-09-18
 *
 * One underlying's option chain: every expiration it lists, and one of them
 * priced. Omit `expiration` for the front month, which is what the panel opens
 * on and what the club mostly trades.
 *
 * This is the endpoint that does not exist for equities and could not exist for
 * options as a KV list: the contract universe is hundreds of thousands of rows,
 * so it is fetched per underlying on demand. The cache in `chain.ts` is what
 * keeps thirty members watching the same expiry down to two upstream calls a
 * minute.
 *
 * `underlyingPrice` comes off the shared quote cache rather than a fresh
 * request, so the header on this panel and the price on the positions grid
 * cannot disagree about spot.
 */
market.get("/chain", async (c) => {
  const underlying = (c.req.query("underlying") ?? "").trim().toUpperCase();
  const expiration = c.req.query("expiration")?.trim() || undefined;

  if (!EQUITY_SYMBOL.test(underlying)) {
    return c.json({ error: "Enter the underlying ticker, like AAPL." }, 400);
  }

  if (expiration !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    return c.json({ error: "An expiration is a date, like 2026-09-18." }, 400);
  }

  try {
    const chain = await loadChain(c.env, underlying, expiration, (p) =>
      c.executionCtx.waitUntil(p),
    );
    return c.json(chain);
  } catch (err) {
    const { message, status } = describeMarketError(err);
    if (status === 502) console.error("Chain load failed:", err);
    return c.json({ error: message }, status);
  }
});
