import test from "node:test";
import assert from "node:assert/strict";
import { forgetSweepCursor, sweepRestingOrders } from "./sweep.ts";
import { forgetShards } from "../market/universe.ts";
import type { Env } from "../types.ts";

interface FixtureOptions {
  expiryFailure?: boolean;
  positionsFailure?: boolean;
  positionsCount?: number | null;
  unpricedShort?: boolean;
  side?: "BUY" | "SELL";
  fillFailure?: boolean;
  rejectFailure?: boolean;
  orderCount?: number;
  trailing?: boolean;
  triggerTrailing?: boolean;
  touched?: Set<string>;
  positionsFailureStatus?: number;
}

async function fixture(options: FixtureOptions, action: (env: Env, calls: string[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const calls: string[] = [];
  const record = (path: string) => {
    calls.push(path);
    assert.ok(calls.length <= 50, "the sweep exceeded the Worker's subrequest limit");
  };
  const env = {
    SUPABASE_URL: "https://sweep.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    ALPACA_API_KEY_ID: crypto.randomUUID(), ALPACA_API_SECRET_KEY: "test-key",
    QUOTES: { get: async () => { record("/kv/get"); return null; } },
  } as unknown as Env;
  const json = (body: unknown, status = 200, count?: number | null) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json",
      ...(count === undefined || count === null ? {} : { "content-range": `*/${count}` }) },
  });
  const failure = () => json({ code: "TEST_DB_ERROR", message: "Temporarily unavailable" }, 400);
  try {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
      match: async () => { record("/cache/match"); return undefined; },
      put: async () => { record("/cache/put"); },
    } } });
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      record(url.pathname);
      const args = init?.body ? JSON.parse(String(init.body)) as { p_order_id?: string } : {};
      switch (url.pathname) {
        case "/rest/v1/rpc/expire_pending_orders": return options.expiryFailure ? failure() : json(0);
        case "/rest/v1/pending_orders": return json(Array.from({ length: options.orderCount ?? 1 }, (_, index) => ({
          id: `order-${index}`, portfolio_id: "book", portfolios: { user_id: "member" },
          symbol: "BTC/USD", side: options.side ?? "BUY", order_type: options.trailing ? "TRAILING_STOP" : "MARKET",
          limit_price: null, stop_price: options.trailing ? "50" : null, trail_amount: null, trail_percent: null,
          trail_anchor: null, triggered_at: null, qty: "1", notional: null, multiplier: "1",
        })));
        case "/v2/clock": return json({ is_open: true, next_open: "2030-01-02T14:30:00Z", next_close: "2030-01-02T21:00:00Z" });
        case "/v2/calendar": return json([]);
        case "/rest/v1/positions": {
          if (options.positionsFailure) return options.positionsFailureStatus
            ? json({ code: "TEST_DB_ERROR", message: "Temporarily unavailable" }, options.positionsFailureStatus) : failure();
          const rows = options.unpricedShort ? [{ portfolio_id: "book", symbol: "MSFT", qty: "-10" }] : [];
          return json(rows, 200, options.positionsCount === undefined ? rows.length : options.positionsCount);
        }
        case "/v1beta3/crypto/us/snapshots": return json({ snapshots: {
          "BTC/USD": { latestTrade: { p: 100, t: new Date().toISOString() } },
        } });
        case "/v2/stocks/snapshots": return json({});
        case "/rest/v1/rpc/trail_pending_order":
          options.touched?.add(args.p_order_id!);
          return json([{ stop_price: options.triggerTrailing ? "90" : "50", moved: true }]);
        case "/rest/v1/rpc/trigger_pending_order": return json(null);
        case "/rest/v1/rpc/place_order": return options.fillFailure
          ? json({ code: "FC001", message: "Insufficient buying power" }, 400) : json([]);
        case "/rest/v1/rpc/reject_pending_order": return options.rejectFailure ? failure() : json(null);
        default: throw new Error(`Unexpected sweep request: ${url.pathname}`);
      }
    }) as typeof fetch;
    await action(env, calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
}

test("an expiry failure stops the sweep before an expired DAY order can fill", async () => {
  await fixture({ expiryFailure: true }, async (env, calls) => {
    await assert.rejects(sweepRestingOrders(env), /Could not expire working orders/);
    assert.deepEqual(calls, ["/rest/v1/rpc/expire_pending_orders"]);
  });
});

test("unavailable or truncated position reads cannot become average-cost risk checks", async () => {
  for (const options of [{ positionsFailure: true }, { positionsCount: 1 }, { positionsCount: null }]) {
    await fixture(options, async (env, calls) => {
      await assert.rejects(sweepRestingOrders(env), /Could not read complete positions/);
      assert.ok(!calls.includes("/rest/v1/rpc/place_order"));
      assert.ok(!calls.includes("/rest/v1/rpc/reject_pending_order"));
      assert.ok(!calls.some((path) => path.endsWith("/snapshots")), "fail before provider work or order mutations");
    });
  }
});

test("an opening order stays pending until every existing short has a live mark", async () => {
  await fixture({ unpricedShort: true }, async (env, calls) => {
    const result = await sweepRestingOrders(env);
    assert.equal(result.filled, 0);
    assert.equal(result.rejected, 0);
    assert.equal(result.resting, 1);
    assert.ok(!calls.includes("/rest/v1/rpc/place_order"));
  });
});

test("a closing order can reduce exposure even when another short cannot be priced", async () => {
  await fixture({ unpricedShort: true, side: "SELL" }, async (env, calls) => {
    const result = await sweepRestingOrders(env);
    assert.equal(result.filled, 1);
    assert.equal(result.resting, 0);
    assert.ok(calls.includes("/rest/v1/rpc/place_order"));
  });
});

test("a failed rejection is reported as still resting until the rejection is persisted", async () => {
  for (const rejectFailure of [true, false]) {
    await fixture({ fillFailure: true, rejectFailure }, async (env, calls) => {
      const result = await sweepRestingOrders(env);
      assert.equal(result.rejected, rejectFailure ? 0 : 1);
      assert.equal(result.resting, rejectFailure ? 1 : 0);
      assert.ok(calls.includes("/rest/v1/rpc/reject_pending_order"));
    });
  }
});

test("fifty marketable orders cannot exhaust one Worker's subrequest budget", async () => {
  for (const worstCase of [false, true]) await fixture({
    orderCount: 50, trailing: worstCase, triggerTrailing: worstCase,
    fillFailure: worstCase, rejectFailure: worstCase,
  }, async (env, calls) => {
    const result = await sweepRestingOrders(env);
    assert.ok(calls.length <= 50);
    assert.ok(result.resting > 0, "excess orders must wait instead of exhausting the invocation");
    assert.match(result.reason ?? "", /next sweep/);
    assert.ok(calls.includes("/rest/v1/rpc/place_order"));
    if (worstCase) assert.ok(calls.includes("/rest/v1/rpc/trigger_pending_order"));
  });
});

test("long-lived trailing stops cannot starve later pending orders across budgeted sweeps", async () => {
  const touched = new Set<string>();
  await fixture({ orderCount: 50, trailing: true, side: "SELL", touched }, async (env, calls) => {
    for (let sweep = 0; sweep < 4; sweep += 1) {
      calls.length = 0;
      const result = await sweepRestingOrders(env);
      assert.equal(result.filled, 0);
      assert.equal(result.resting, 50);
    }
    assert.equal(touched.size, 50, "the cursor must reach every stop even though no row leaves the queue");
  });
});

test("repeated cold-isolate sweeps advance through persistent trailing orders", async () => {
  const touched = new Set<string>();
  await fixture({ orderCount: 50, trailing: true, side: "SELL", touched }, async (env, calls) => {
    const base = Date.parse("2030-01-01T00:00:00Z");
    for (let minutes = 0; minutes < 10; minutes += 1) {
      calls.length = 0;
      forgetSweepCursor();
      const result = await sweepRestingOrders(env, undefined, base + minutes * 60_000);
      assert.equal(result.resting, 50);
      assert.equal(result.filled, 0);
    }
    assert.equal(touched.size, 50, "fresh isolates must not repeatedly service only the oldest stops");
  });
});

test("a missing cold universe shard does not start an unbudgeted asset download", async () => {
  forgetShards();
  await fixture({}, async (env, calls) => {
    assert.equal((await sweepRestingOrders(env)).filled, 1);
    assert.equal(calls.filter((path) => path === "/kv/get").length, 1);
    assert.ok(!calls.some((path) => path.endsWith("/assets")));
  });
});

test("sweep reads disable hidden SDK retries and leave recovery to the next scheduled invocation", async () => {
  await fixture({ positionsFailure: true, positionsFailureStatus: 520 }, async (env, calls) => {
    await assert.rejects(sweepRestingOrders(env), /complete positions/);
    assert.equal(calls.filter((path) => path === "/rest/v1/positions").length, 1);
  });
});
