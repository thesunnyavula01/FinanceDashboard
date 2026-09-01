import { alpacaFromEnv } from "./alpaca.ts";
import type { BarTimeframe, IntradayBar } from "./provider.ts";

/**
 * Intraday bars, cached.
 *
 * The 1D chart needs one price per five-minute bucket for every symbol a member
 * holds, plus SPY and QQQ, across the session being drawn. That is a much
 * smaller read than the equity curve's — one session is 78 buckets — but it is
 * a *repeating* one: unlike a daily bar, today's five-minute bar is still being
 * written, so the chart polls it.
 *
 * Same two tiers as `bars.ts` and `quotes.ts`, for the same reasons: isolate
 * memory absorbs the repeat, the Cache API shares it across isolates in the
 * colo, and neither carries KV's per-write cost or its 60-second floor.
 *
 * **Sixty seconds, and that is what makes the club affordable.** A hundred
 * members refreshing a 1D chart every minute against a 200 request/minute
 * ceiling only works because the cache is keyed per *symbol* rather than per
 * member: the club holds a couple of hundred distinct tickers between them, so
 * a minute's worth of traffic is the same two or three batched requests no
 * matter how many people are looking. The arithmetic is the quote cache's, one
 * tier down.
 *
 * The window is anchored at a start date and runs to now, so the key does not
 * change as the session advances — the entry simply expires and is refetched
 * with more bars on the end.
 */

const TTL_MS = 60_000;

/**
 * Five minutes, not one.
 *
 * A session is 78 five-minute buckets and 390 one-minute ones. The chart is
 * roughly 600 pixels wide, so minute bars would draw four of them into every
 * pixel and cost five times the payload to do it. Five minutes is also the
 * granularity at which a thin name still prints on IEX often enough to have a
 * bar at all.
 */
export const INTRADAY_TIMEFRAME: BarTimeframe = "5Min";

/**
 * Symbols per intraday request. Lower than the daily ceiling because each
 * symbol brings ~78 bars per session rather than one, and a Worker parsing a
 * ten-thousand-bar response on the way to drawing 78 points is wasted work.
 */
export const MAX_INTRADAY_SYMBOLS = 60;

interface IntradayEnv {
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
}

interface CacheEntry {
  bars: IntradayBar[];
  cachedAt: number;
}

const memory = new Map<string, CacheEntry>();

function cacheKey(feed: string, timeframe: string, symbol: string, start: string): string {
  return `${feed}/${timeframe}/${symbol}/${start}`;
}

function edgeKey(key: string): string {
  return `https://intraday-cache.invalid/v1/${key}`;
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
 * Intraday bars for each symbol from `start` up to now, ascending by instant.
 *
 * A symbol upstream cannot supply is absent from the map rather than present
 * and empty, so a caller can tell "no intraday data for this ticker" from "it
 * did not print in that bucket".
 */
export async function intradayBars(
  env: IntradayEnv,
  symbols: string[],
  start: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Map<string, IntradayBar[]>> {
  const feed = env.ALPACA_DATA_FEED || "iex";
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(
    0,
    MAX_INTRADAY_SYMBOLS,
  );

  const out = new Map<string, IntradayBar[]>();
  if (wanted.length === 0) return out;

  const now = Date.now();
  const key = (symbol: string) => cacheKey(feed, INTRADAY_TIMEFRAME, symbol, start);
  const missing: string[] = [];

  for (const symbol of wanted) {
    const entry = memory.get(key(symbol));
    if (entry && now - entry.cachedAt < TTL_MS) out.set(symbol, entry.bars);
    else missing.push(symbol);
  }

  const stillMissing: string[] = [];
  if (missing.length > 0) {
    const found = await Promise.all(missing.map((symbol) => readEdge(key(symbol))));
    for (let i = 0; i < missing.length; i++) {
      const symbol = missing[i]!;
      const entry = found[i];
      if (entry && now - entry.cachedAt < TTL_MS) {
        memory.set(key(symbol), entry);
        out.set(symbol, entry.bars);
      } else {
        stillMissing.push(symbol);
      }
    }
  }

  if (stillMissing.length === 0) return out;

  // No `end`: the point of this chart is the bars that have just printed, and
  // naming an end instant would only invite an off-by-one against the clock.
  const fetched = await alpacaFromEnv(env).intradayBars(stillMissing, {
    start,
    timeframe: INTRADAY_TIMEFRAME,
  });

  const writes: Promise<unknown>[] = [];

  for (const symbol of stillMissing) {
    const bars = fetched.get(symbol);
    if (!bars || bars.length === 0) continue;

    bars.sort((a, b) => a.at.localeCompare(b.at));
    const entry: CacheEntry = { bars, cachedAt: now };
    memory.set(key(symbol), entry);
    out.set(symbol, bars);
    writes.push(writeEdge(key(symbol), entry));
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
export function forgetIntraday(): void {
  memory.clear();
}
