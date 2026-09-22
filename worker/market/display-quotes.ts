import type { Env } from "../types.ts";
import { BoundedCache } from "../lib/cache.ts";
import { readSavedPrices, usableSavedPrice, type SavedPrice } from "../analytics/backup.ts";
import { quoteCache } from "./quotes.ts";
import type { Quote } from "./provider.ts";

export interface DisplayQuote extends Quote {
  receivedAt: string;
  stale: boolean;
}

let memory: { key: string; prices: BoundedCache<SavedPrice> } | null = null;

/** Display-only continuity. Orders must continue to use quoteCache directly. */
export async function displayQuotes(
  env: Env, symbols: string[], waitUntil?: (promise: Promise<unknown>) => void,
) {
  const key = `${env.SUPABASE_URL}:${env.ALPACA_API_KEY_ID}:${env.ALPACA_DATA_FEED ?? "iex"}`;
  if (memory?.key !== key) memory = { key, prices: new BoundedCache<SavedPrice>(2000) };
  const remembered = memory.prices;
  const live = await quoteCache(env).get(symbols, waitUntil);
  const usable = (symbol: string, quote?: Quote) => quote?.symbol === symbol && Number.isFinite(quote.price) && quote.price > 0;
  const missing = symbols.filter((symbol) => !usable(symbol, live.quotes.get(symbol)));
  const saved = missing.length ? await readSavedPrices(env.QUOTES) : {};
  const quotes = new Map<string, DisplayQuote>();

  for (const symbol of symbols) {
    const fresh = live.quotes.get(symbol);
    const stored = saved[symbol];
    const previous = remembered.get(symbol);
    const candidates = [previous, stored].filter((entry): entry is SavedPrice =>
      usableSavedPrice(entry) && entry!.quote.symbol === symbol);
    if (fresh && usable(symbol, fresh)) {
      candidates.push({ quote: fresh, savedAt: new Date(live.observedAt.get(symbol) ?? Date.now()).toISOString() });
    }
    candidates.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    const best = candidates[0];
    if (!best) { remembered.delete(symbol); continue; }
    remembered.set(symbol, best);
    quotes.set(symbol, { ...best.quote, receivedAt: best.savedAt, stale: best.quote !== fresh });
  }
  return { quotes, unknown: symbols.filter((symbol) => !quotes.has(symbol)), stats: live.stats };
}

/** Tests can simulate a cold isolate without touching the execution cache. */
export function forgetDisplayQuotes(): void { memory = null; }
