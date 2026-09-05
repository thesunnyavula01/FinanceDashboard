import { Hono } from "hono";
import { requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { describeMarketError } from "../market/provider.ts";
import { loadResearch } from "../market/research.ts";
import { isTradableSymbol, normalise } from "../market/symbols.ts";

export const research = new Hono<AuthedBindings>();

research.use("*", requireAuth);

/** GET /api/research?symbol=TSLA — one cached answer, including partial failures. */
research.get("/", async (c) => {
  const symbol = normalise(c.req.query("symbol") ?? "");
  if (!isTradableSymbol(symbol)) {
    return c.json({ error: "Enter one ticker or pair, like AAPL or BTC/USD." }, 400);
  }
  try {
    const result = await loadResearch(c.env, symbol, (promise) => c.executionCtx.waitUntil(promise));
    return c.json(result);
  } catch (error) {
    // Individual providers are reported in `missing`; only a complete outage
    // reaches the route's existing market-error mapping.
    const { message, status } = describeMarketError(error);
    if (status === 502) console.error("Research load failed:", error);
    return c.json({ error: message }, status);
  }
});
