import test from "node:test";
import assert from "node:assert/strict";
import { dailyBars, forgetBars } from "./bars.ts";
import { intradayBars, forgetIntraday } from "./intraday.ts";

const env = { ALPACA_API_KEY_ID: "test-key", ALPACA_API_SECRET_KEY: "test-secret" };
const symbols = Array.from({ length: 100 }, (_, i) => `SYM${i}`);
const variants = [
  { name: "daily", ttl: 15 * 60_000, forget: forgetBars,
    read: (wanted: string[]) => dailyBars(env, wanted, "2026-09-01", "2026-09-21") },
  { name: "intraday", ttl: 60_000, forget: forgetIntraday,
    read: (wanted: string[]) => intradayBars(env, wanted, "2026-09-15") },
];

for (const variant of variants) {
  test(`${variant.name} large-set edge cache spends two operations and preserves each series' age`, async () => {
    const savedFetch = globalThis.fetch;
    const savedNow = Date.now;
    const savedCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
    let now = Date.parse("2026-09-21T15:00:00Z");
    const stored = new Map<string, string>();
    const fetched: string[][] = [];
    let matches = 0, puts = 0;
    try {
      variant.forget();
      Date.now = () => now;
      Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
        match: async (key: string) => {
          matches += 1;
          return stored.has(key) ? new Response(stored.get(key)) : undefined;
        },
        put: async (key: string, response: Response) => { puts += 1; stored.set(key, await response.text()); },
      } } });
      globalThis.fetch = async (input) => {
        const wanted = new URL(String(input)).searchParams.get("symbols")!.split(",");
        fetched.push(wanted);
        return new Response(JSON.stringify({ bars: Object.fromEntries(wanted.map((symbol) => [symbol,
          [{ t: "2026-09-21T14:30:00Z", o: 100, h: 100, l: 100, c: 100, v: 10 }]])), next_page_token: null }));
      };
      // Seed one older per-symbol value, then combine it with newer series in
      // a batch. The outer cache write must not renew that older value's TTL.
      await variant.read([symbols[0]!]);
      now += variant.ttl / 2;
      matches = 0; puts = 0;
      const first = await variant.read(symbols);
      assert.ok(first.size >= 60, "large-set results retain the cache's documented symbol limit");
      assert.equal(matches, 1);
      assert.equal(puts, 1);

      // A new isolate asking in another order must hit the same envelope. Use
      // the returned set, since the intraday cache intentionally caps at sixty.
      const requested = [...first.keys()];
      variant.forget();
      const fetches = fetched.length;
      matches = 0; puts = 0;
      const restored = await variant.read([...requested].reverse());
      assert.equal(restored.size, first.size);
      assert.equal(fetched.length, fetches, "sorted batch keys reuse the shared edge response");
      assert.equal(matches, 1);
      assert.equal(puts, 0);

      now += variant.ttl / 2 + 1;
      variant.forget();
      matches = 0; puts = 0;
      await variant.read(requested);
      assert.deepEqual(fetched.at(-1), [symbols[0]], "only the original older series expires");
      assert.equal(fetched.length, fetches + 1);
      assert.equal(matches, 1);
      assert.equal(puts, 1);
    } finally {
      globalThis.fetch = savedFetch;
      Date.now = savedNow;
      if (savedCaches) Object.defineProperty(globalThis, "caches", savedCaches);
      else Reflect.deleteProperty(globalThis, "caches");
      variant.forget();
    }
  });
}
