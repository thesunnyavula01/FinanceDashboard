import { alpacaFromEnv } from "./alpaca.ts";
import type { PriceProvider, Quote } from "./provider.ts";

/**
 * The shared quote cache.
 *
 * The whole point of this file is the number in CLAUDE.md: a hundred members
 * refreshing every 20 seconds must not become a hundred requests to Alpaca. It
 * gets there in three tiers, cheapest first.
 *
 *   1. Isolate memory — a plain Map. Free, instant, and it absorbs every
 *      simultaneous member served by the same Worker instance.
 *   2. The Cache API — colo-local, shared by every isolate in that data
 *      centre, and free of both operation limits and per-write billing.
 *   3. Alpaca, batched 100 symbols to a request.
 *
 * NOT KV, despite the KV binding this project already carries. A 20-second
 * quote cache would mean roughly 234,000 writes a day (200 symbols, three
 * refreshes a minute, a 6.5-hour session), against a free-tier ceiling of
 * 1,000 writes a day and a paid allowance of a million a month. KV also
 * enforces a 60-second floor on `expirationTtl` and caches reads at the edge
 * for at least that long, so it cannot express a 20-second TTL. The Cache API
 * has none of those constraints. KV keeps the job it is actually good at —
 * the nightly asset universe in universe.ts, which is written 50-odd times a
 * day and read constantly.
 *
 * A concurrent-fetch guard sits in front of tier 3, so twenty members arriving
 * together on a cold cache produce one upstream request, not twenty.
 */

/** Never ask for more than this in one call: 3 batched Alpaca requests. */
export const MAX_SYMBOLS_PER_REQUEST = 300;

/**
 * A symbol Alpaca has no price for is remembered too, for longer. Without
 * this, one typo in a portfolio would poll upstream every 20 seconds forever.
 */
const NEGATIVE_TTL_SECONDS = 300;

/** Tickers are 1-10 characters; dots and dashes appear in names like BRK.B. */
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

interface CacheEntry {
  /** Null means "upstream had no price for this", cached to stop a hot loop. */
  quote: Quote | null;
  cachedAt: number;
}

export interface QuoteResult {
  quotes: Map<string, Quote>;
  /** Requested symbols that no provider could price. */
  unknown: string[];
  /** Where the answer came from. Surfaced in the API response for debugging. */
  stats: { memory: number; edge: number; fetched: number };
}

/**
 * Split and validate a `?symbols=` value.
 *
 * Returns the rejects rather than throwing, so one malformed ticker in a
 * portfolio does not blank the whole dashboard.
 */
export function parseSymbols(
  raw: string | null | undefined,
  max = MAX_SYMBOLS_PER_REQUEST,
): { symbols: string[]; rejected: string[] } {
  const seen = new Set<string>();
  const symbols: string[] = [];
  const rejected: string[] = [];

  for (const piece of (raw ?? "").split(",")) {
    const symbol = piece.trim().toUpperCase();
    if (!symbol) continue;
    if (!SYMBOL_PATTERN.test(symbol)) {
      if (!rejected.includes(symbol)) rejected.push(symbol);
      continue;
    }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    if (symbols.length < max) symbols.push(symbol);
  }

  return { symbols, rejected };
}

export interface QuoteCacheOptions {
  provider: PriceProvider;
  ttlSeconds: number;
  /** The colo-shared tier. Null disables it (tests, and any runtime without it). */
  cache?: Cache | null;
  /** Namespaces edge keys, so switching data feed does not serve stale prices. */
  namespace?: string;
  now?: () => number;
}

export class QuoteCache {
  #provider: PriceProvider;
  #ttlMs: number;
  #negativeTtlMs: number;
  #cache: Cache | null;
  #namespace: string;
  #now: () => number;
  #memory = new Map<string, CacheEntry>();
  /** Symbol -> the in-progress upstream batch that will resolve it. */
  #inflight = new Map<string, Promise<Map<string, Quote>>>();

  constructor(options: QuoteCacheOptions) {
    this.#provider = options.provider;
    this.#ttlMs = options.ttlSeconds * 1000;
    this.#negativeTtlMs = Math.max(options.ttlSeconds, NEGATIVE_TTL_SECONDS) * 1000;
    this.#cache = options.cache ?? null;
    this.#namespace = options.namespace ?? "v1";
    this.#now = options.now ?? Date.now;
  }

  #ttlFor(entry: CacheEntry): number {
    return entry.quote === null ? this.#negativeTtlMs : this.#ttlMs;
  }

  #isFresh(entry: CacheEntry): boolean {
    return this.#now() - entry.cachedAt < this.#ttlFor(entry);
  }

  #edgeKey(symbol: string): string {
    return `https://quote-cache.invalid/${this.#namespace}/${symbol}`;
  }

  async get(
    symbols: string[],
    waitUntil?: (promise: Promise<unknown>) => void,
  ): Promise<QuoteResult> {
    const quotes = new Map<string, Quote>();
    const unknown: string[] = [];
    const stats = { memory: 0, edge: 0, fetched: 0 };

    const record = (symbol: string, entry: CacheEntry) => {
      if (entry.quote) quotes.set(symbol, entry.quote);
      else unknown.push(symbol);
    };

    // Tier 1 — isolate memory.
    const missing: string[] = [];
    for (const symbol of symbols) {
      const entry = this.#memory.get(symbol);
      if (entry && this.#isFresh(entry)) {
        stats.memory += 1;
        record(symbol, entry);
      } else {
        missing.push(symbol);
      }
    }

    // Tier 2 — the colo cache.
    const stillMissing: string[] = [];
    if (this.#cache && missing.length > 0) {
      const found = await Promise.all(missing.map((s) => this.#readEdge(s)));
      for (let i = 0; i < missing.length; i++) {
        const symbol = missing[i]!;
        const entry = found[i];
        if (entry && this.#isFresh(entry)) {
          stats.edge += 1;
          this.#memory.set(symbol, entry);
          record(symbol, entry);
        } else {
          stillMissing.push(symbol);
        }
      }
    } else {
      stillMissing.push(...missing);
    }

    if (stillMissing.length === 0) return { quotes, unknown, stats };

    // Tier 3 — upstream.
    const fetched = await this.#fetch(stillMissing);
    const cachedAt = this.#now();
    const writes: CacheEntry[] = [];

    for (const symbol of stillMissing) {
      const entry: CacheEntry = { quote: fetched.get(symbol) ?? null, cachedAt };
      this.#memory.set(symbol, entry);
      writes.push(entry);
      stats.fetched += 1;
      record(symbol, entry);
    }

    if (this.#cache) {
      const write = Promise.all(
        stillMissing.map((symbol, i) => this.#writeEdge(symbol, writes[i]!)),
      );
      // The response does not need to wait on a cache write, but the isolate
      // must not be torn down mid-write either.
      if (waitUntil) waitUntil(write);
      else await write;
    }

    return { quotes, unknown, stats };
  }

  /**
   * One upstream call per symbol at a time, even across concurrent requests.
   *
   * Without this, the first twenty members to hit a cold cache each start
   * their own Alpaca batch. They all want the same symbols, so they all wait
   * on whichever batch got there first instead.
   */
  async #fetch(symbols: string[]): Promise<Map<string, Quote>> {
    const joined: Array<Promise<Map<string, Quote>>> = [];
    const fresh: string[] = [];

    for (const symbol of symbols) {
      const pending = this.#inflight.get(symbol);
      if (pending) joined.push(pending);
      else fresh.push(symbol);
    }

    if (fresh.length > 0) {
      let own: Promise<Map<string, Quote>>;
      own = this.#provider.quotes(fresh).finally(() => {
        for (const symbol of fresh) {
          if (this.#inflight.get(symbol) === own) this.#inflight.delete(symbol);
        }
      });
      for (const symbol of fresh) this.#inflight.set(symbol, own);
      joined.push(own);
    }

    const merged = new Map<string, Quote>();
    // allSettled: one failed batch must not blank the symbols another one
    // resolved. A symbol left out simply reads as "no price right now".
    for (const settled of await Promise.allSettled(joined)) {
      if (settled.status === "fulfilled") {
        for (const [symbol, quote] of settled.value) merged.set(symbol, quote);
      } else {
        console.error("Quote fetch failed:", settled.reason);
      }
    }
    return merged;
  }

  async #readEdge(symbol: string): Promise<CacheEntry | null> {
    try {
      const hit = await this.#cache!.match(this.#edgeKey(symbol));
      if (!hit) return null;
      return (await hit.json()) as CacheEntry;
    } catch {
      // A cache that misbehaves is a cache miss, never an outage.
      return null;
    }
  }

  async #writeEdge(symbol: string, entry: CacheEntry): Promise<void> {
    try {
      const seconds = Math.ceil(this.#ttlFor(entry) / 1000);
      await this.#cache!.put(
        this.#edgeKey(symbol),
        new Response(JSON.stringify(entry), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${seconds}`,
          },
        }),
      );
    } catch {
      // Same: losing a cache write costs a fetch, not correctness.
    }
  }
}

interface QuoteEnv {
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
  QUOTE_CACHE_TTL?: string;
}

/**
 * The cache has to outlive a request to be worth anything, so it hangs off the
 * module and is rebuilt only if the configuration it was built from changes.
 */
let shared: { key: string; cache: QuoteCache } | null = null;

export function quoteCache(env: QuoteEnv): QuoteCache {
  const feed = env.ALPACA_DATA_FEED || "iex";
  const ttlSeconds = Math.min(Math.max(Number(env.QUOTE_CACHE_TTL) || 20, 1), 300);
  const key = `${feed}:${ttlSeconds}:${env.ALPACA_API_KEY_ID ?? ""}`;

  if (shared?.key === key) return shared.cache;

  const cache = new QuoteCache({
    provider: alpacaFromEnv(env),
    ttlSeconds,
    cache: typeof caches === "undefined" ? null : caches.default,
    namespace: `v1/${feed}`,
  });

  shared = { key, cache };
  return cache;
}
