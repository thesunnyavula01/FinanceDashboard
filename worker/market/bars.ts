import { alpacaFromEnv } from "./alpaca.ts";
import type { DailyBar } from "./provider.ts";

/**
 * Daily bars, cached.
 *
 * The equity curve needs one close per session for every symbol a member has
 * ever traded, plus SPY and QQQ, back to the start of the season. That is a
 * large read — a year of a twenty-symbol portfolio is five thousand bars — and
 * it is the *same* read for the whole club on the benchmarks and for the same
 * member on every range toggle. So it is cached, in the same two tiers as
 * quotes and for the same reasons: isolate memory absorbs the repeat, the
 * Cache API shares it across isolates in the colo, and neither has KV's
 * per-write cost or its 60-second floor.
 *
 * What is cached is a whole symbol's series from the season start, not a
 * window, so switching the chart from 3M to ALL is free. The key carries the
 * range, so a new season simply gets new keys.
 *
 * Fifteen minutes, because today's bar is still forming while the market is
 * open. That staleness never reaches the chart: the curve overwrites its final
 * point with a live mark from the quote cache, so an out-of-date partial bar
 * only ever affects whether today is on the axis at all.
 *
 * There is no concurrent-fetch guard here, unlike quotes.ts. This is a
 * screen-load read, not a 20-second poll, so the worst case is a handful of
 * duplicate requests on a cold isolate rather than one per member per tick.
 */

const TTL_MS = 15 * 60_000;

/** Bars are cheap in bulk and the provider batches them, so ask widely. */
export const MAX_BAR_SYMBOLS = 120;

interface BarsEnv {
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
}

interface CacheEntry {
  bars: DailyBar[];
  cachedAt: number;
}

const memory = new Map<string, CacheEntry>();

function cacheKey(feed: string, symbol: string, start: string, end: string): string {
  return `${feed}/${symbol}/${start}/${end}`;
}

function edgeKey(key: string): string {
  return `https://bar-cache.invalid/v1/${key}`;
}

async function readEdge(key: string): Promise<CacheEntry | null> {
  if (typeof caches === "undefined") return null;
  try {
    const hit = await caches.default.match(edgeKey(key));
    return hit ? ((await hit.json()) as CacheEntry) : null;
  } catch {
    // A cache that misbehaves is a miss, never an outage.
    return null;
  }
}

async function writeEdge(key: string, entry: CacheEntry): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await caches.default.put(
      edgeKey(key),
      new Response(JSON.stringify(entry), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${Math.ceil(TTL_MS / 1000)}`,
        },
      }),
    );
  } catch {
    // Losing a cache write costs a fetch, not correctness.
  }
}

/**
 * Split-and-dividend-adjusted daily closes for each symbol, ascending by date.
 *
 * A symbol upstream cannot supply is absent from the map rather than present
 * and empty, so a caller can tell "no bars for this ticker" from "no trading
 * that week".
 */
export async function dailyBars(
  env: BarsEnv,
  symbols: string[],
  start: string,
  end: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Map<string, DailyBar[]>> {
  const feed = env.ALPACA_DATA_FEED || "iex";
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(
    0,
    MAX_BAR_SYMBOLS,
  );

  const out = new Map<string, DailyBar[]>();
  if (wanted.length === 0) return out;

  const now = Date.now();
  const missing: string[] = [];

  for (const symbol of wanted) {
    const entry = memory.get(cacheKey(feed, symbol, start, end));
    if (entry && now - entry.cachedAt < TTL_MS) out.set(symbol, entry.bars);
    else missing.push(symbol);
  }

  const stillMissing: string[] = [];
  if (missing.length > 0) {
    const found = await Promise.all(
      missing.map((symbol) => readEdge(cacheKey(feed, symbol, start, end))),
    );
    for (let i = 0; i < missing.length; i++) {
      const symbol = missing[i]!;
      const entry = found[i];
      if (entry && now - entry.cachedAt < TTL_MS) {
        memory.set(cacheKey(feed, symbol, start, end), entry);
        out.set(symbol, entry.bars);
      } else {
        stillMissing.push(symbol);
      }
    }
  }

  if (stillMissing.length === 0) return out;

  const fetched = await alpacaFromEnv(env).dailyBars(stillMissing, { start, end });
  const writes: Promise<unknown>[] = [];

  for (const symbol of stillMissing) {
    const bars = fetched.get(symbol);
    if (!bars || bars.length === 0) continue;

    bars.sort((a, b) => a.date.localeCompare(b.date));
    const entry: CacheEntry = { bars, cachedAt: now };
    memory.set(cacheKey(feed, symbol, start, end), entry);
    out.set(symbol, bars);
    writes.push(writeEdge(cacheKey(feed, symbol, start, end), entry));
  }

  if (writes.length > 0) {
    const write = Promise.all(writes);
    // The response must not wait on a cache write, but the isolate must not be
    // torn down mid-write either.
    if (waitUntil) waitUntil(write);
    else await write;
  }

  return out;
}

/** Drops the in-memory tier. Tests only. */
export function forgetBars(): void {
  memory.clear();
}
