import test from "node:test";
import assert from "node:assert/strict";
import { BoundedCache } from "./cache.ts";

/**
 * The isolate-memory tier used to be a plain `Map` with a TTL check on read,
 * which is a map that only grows: nothing deleted the expired entry, and the
 * keys in `bars.ts`, `intraday.ts` and `chain.ts` carry a date or an OCC symbol,
 * so the key space turns over instead of repeating. A Worker isolate that
 * crosses its memory ceiling is killed with its in-flight requests, which is
 * the failure these tests exist to keep out.
 */

test("a bounded cache evicts the least recently used entry rather than growing", () => {
  const cache = new BoundedCache<number>(3);

  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  // Touching `a` makes `b` the oldest, which is the whole point of the LRU:
  // SPY and QQQ are read by every member's chart and must not be evicted by a
  // long tail of keys nothing will ask for twice.
  assert.equal(cache.get("a"), 1);

  cache.set("d", 4);

  assert.equal(cache.size, 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("d"), 4);
});

test("a cache written far past its cap stays at its cap", () => {
  const cache = new BoundedCache<number>(10);
  for (let i = 0; i < 5_000; i++) cache.set(`key-${i}`, i);

  assert.equal(cache.size, 10);
  assert.equal(cache.get("key-4999"), 4999);
  assert.equal(cache.get("key-0"), undefined);
});

test("re-setting a key moves it rather than storing it twice", () => {
  const cache = new BoundedCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 9);
  cache.set("c", 3);

  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), 9, "the rewritten key was the most recent, so it survives");
  assert.equal(cache.get("b"), undefined);
});

test("a deleted entry is gone, so a caller that finds one stale releases it at once", () => {
  const cache = new BoundedCache<number>(4);
  cache.set("a", 1);
  cache.delete("a");

  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), undefined);
});

test("a cache with no room is a programming error, not a silently empty cache", () => {
  assert.throws(() => new BoundedCache<number>(0), RangeError);
});
