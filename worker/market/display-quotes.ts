import type { Env } from "../types.ts";
import { BoundedCache } from "../lib/cache.ts";
import { readSavedPrices, usableSavedPrice, type SavedPrice, type SavedPrices } from "../analytics/backup.ts";
import { quoteCache } from "./quotes.ts";
import type { Quote } from "./provider.ts";

export interface DisplayQuote extends Quote {
  receivedAt: string;
  stale: boolean;
}

/**
 * How long one KV read of the saved prices serves this isolate. KV already
 * edge-caches a read for at least this long and the copy is rewritten every
 * five to fifteen minutes, so this costs no freshness — and without it every
 * quote poll holding one unpriced symbol was a KV read against a daily cap.
 */
const SAVED_PRICES_MEMORY_MS = 60_000;

let memory: {
  key: string;
  prices: BoundedCache<SavedPrice>;
  saved: { loadedAt: number; value: Promise<SavedPrices> } | null;
} | null = null;

/** Display-only continuity. Orders must continue to use quoteCache directly. */
export async function displayQuotes(
  env: Env, symbols: string[], waitUntil?: (promise: Promise<unknown>) => void,
) {
  const key = `${env.SUPABASE_URL}:${env.ALPACA_API_KEY_ID}:${env.ALPACA_DATA_FEED ?? "iex"}`;
  if (memory?.key !== key) memory = { key, prices: new BoundedCache<SavedPrice>(2000), saved: null };
  const state = memory;
  const remembered = state.prices;
  const live = await quoteCache(env).get(symbols, waitUntil);
  const usable = (symbol: string, quote?: Quote) => quote?.symbol === symbol && Number.isFinite(quote.price) && quote.price > 0;
  const missing = symbols.filter((symbol) => !usable(symbol, live.quotes.get(symbol)));
  if (missing.length && !(state.saved && Date.now() - state.saved.loadedAt < SAVED_PRICES_MEMORY_MS)) {
    // Shared while in flight, so a burst of cold polls is one read.
    state.saved = { loadedAt: Date.now(), value: readSavedPrices(env.QUOTES) };
  }
  const saved = missing.length ? await state.saved!.value : {};
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
