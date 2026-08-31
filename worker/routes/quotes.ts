import { Hono } from "hono";
import { requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { describeMarketError } from "../market/provider.ts";
import { MAX_SYMBOLS_PER_REQUEST, parseSymbols, quoteCache } from "../market/quotes.ts";

export const quotes = new Hono<AuthedBindings>();

/**
 * GET /api/quotes?symbols=AAPL,MSFT,NVDA
 *
 * The only price endpoint. Behind auth deliberately: the Alpaca key is the
 * club's, and an open proxy in front of it is a good way to lose the free
 * tier. Symbols are deduped and validated here, cached in quotes.ts, and
 * batched into as few Alpaca requests as possible.
 *
 * An unknown ticker is reported in `unknown` rather than failing the request,
 * because one bad symbol in a portfolio must not blank the other nineteen.
 */
quotes.get("/", requireAuth, async (c) => {
  const { symbols, rejected } = parseSymbols(c.req.query("symbols"));

  if (symbols.length === 0) {
    return c.json(
      {
        error: rejected.length
          ? `No valid symbols in the request. Rejected: ${rejected.join(", ")}`
          : "Pass at least one symbol, e.g. ?symbols=AAPL,MSFT",
      },
      400,
    );
  }

  try {
    const result = await quoteCache(c.env).get(symbols, (p) => c.executionCtx.waitUntil(p));

    return c.json({
      quotes: Object.fromEntries(result.quotes),
      /** Valid-looking tickers that no provider could price. */
      unknown: result.unknown,
      /** Malformed tickers, dropped before they ever reached a provider. */
      rejected,
      asOf: new Date().toISOString(),
      /** Which tier served each symbol. Handy when checking the batching claim. */
      cache: result.stats,
      limit: MAX_SYMBOLS_PER_REQUEST,
    });
  } catch (err) {
    const { message, status } = describeMarketError(err);
    if (status === 502) console.error("Quote request failed:", err);
    return c.json({ error: message }, status);
  }
});
