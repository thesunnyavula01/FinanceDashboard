/**
 * A bounded map for the isolate-memory tier.
 *
 * Every cache in `worker/market` is three tiers — isolate memory, the Cache
 * API, then the provider — and the first tier was a plain `Map` in each of
 * them. A `Map` with a TTL check on read is not a cache: nothing ever deletes
 * the expired entry, so the map only grows, and whether that matters depends
 * entirely on whether the key space is finite.
 *
 * For quotes it is: the key is a symbol, and the club holds a few hundred. For
 * bars, intraday bars and chains it is not. `bars.ts` keys on
 * `feed/symbol/start/end` and `end` is today, so **every symbol gets a fresh
 * key every day**, each holding a season of daily bars. `intraday.ts` keys on a
 * rolling six-day window, and `chain.ts` keys on every underlying and every OCC
 * symbol anybody has ever looked at. None of those is bounded by anything but
 * how long the isolate happens to live.
 *
 * A Cloudflare isolate that crosses its memory limit is torn down, and the
 * requests in flight on it fail. That failure is not evenly spread: it lands on
 * whoever happens to share the isolate that filled up, and it fills up fastest
 * when the market is live and the charts are polling — which is exactly the
 * shape of "it crashes for some people, during the session, for no reason".
 *
 * So the tier is bounded here instead. Insertion order is the eviction order
 * and a read moves an entry back to the end, which makes this an LRU: the
 * benchmark series every member's chart wants stay hot while yesterday's keys
 * fall off the back. Callers still own freshness — they know their own TTL —
 * and `delete()` is what they call when they find an entry stale, so a stale
 * entry costs nothing beyond the moment it is noticed.
 */
export class BoundedCache<T> {
  readonly #max: number;
  readonly #entries = new Map<string, T>();

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError("A bounded cache needs room for at least one entry.");
    }
    this.#max = max;
  }

  /** The entry, and a hit moves it to the back of the eviction queue. */
  get(key: string): T | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert rather than leave it where it was: a `Map` iterates in
    // insertion order, so this is the whole of the LRU.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);

    // A loop rather than one delete, so lowering the cap in a later change
    // still drains to it rather than leaking the difference forever.
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** Drops an entry the caller has found stale. */
  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
