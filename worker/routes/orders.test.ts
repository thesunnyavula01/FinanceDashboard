import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../index.ts";
import { forgetSeason } from "../lib/portfolio.ts";
import { forgetChains } from "../market/chain.ts";
import { sweepRestingOrders } from "../orders/sweep.ts";
import type { Env } from "../types.ts";

/** Exercise the real authenticated routes and sweep against provider/DB fixtures.
 * Money must use the verified multiplier all the way into the locked RPC.
 * Run with: npm test
 */
const secret = "order-route-test-secret";
const symbol = "AAPL300118C00150000";
let run = 0;

async function fixture(action: (env: Env, rpc: Record<string, unknown>[]) => Promise<void>, multiplier = 1000) {
  const rpc: Record<string, unknown>[] = [];
  const saved = globalThis.fetch;
  const env = {
    SUPABASE_URL: "https://orders.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SUPABASE_JWT_SECRET: secret, ALPACA_API_KEY_ID: `test-${++run}`, ALPACA_API_SECRET_KEY: "test-secret",
    QUOTES: { get: async () => null }, ASSETS: { fetch: async () => new Response("SPA") },
  } as unknown as Env;
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  forgetSeason(); forgetChains();
  try {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/options/contracts") return json({ option_contracts: [{ symbol, multiplier: String(multiplier), status: "active", tradable: true }] });
      if (url.pathname === "/v1beta1/options/snapshots") return json({ snapshots: { [symbol]: { latestQuote: { bp: 2, ap: 4, t: new Date().toISOString() } } } });
      if (url.pathname === "/v1beta3/crypto/us/snapshots") return json({ snapshots: { "SHIB/USD": { latestTrade: { p: 0.000023, t: new Date().toISOString() } } } });
      if (url.pathname === "/v2/clock") return json({ is_open: true, next_open: "2030-01-02T14:30:00Z", next_close: "2030-01-02T21:00:00Z" });
      if (url.pathname === "/v2/calendar") return json([]);
      if (url.pathname === "/rest/v1/seasons") return json({ id: "season", name: "Club", starting_cash: 100000, trading_locked: false, starts_at: "2026-01-01" });
      if (url.pathname === "/rest/v1/portfolios") return json({ id: "portfolio", cash: 100000, starting_cash: 100000 });
      if (url.pathname === "/rest/v1/positions") return json([]);
      if (url.pathname === "/rest/v1/pending_orders") return json([{
        id: "pending", portfolio_id: "portfolio", symbol, side: "BUY", order_type: "LIMIT", limit_price: "4",
        stop_price: null, trail_amount: null, trail_percent: null, trail_anchor: null, triggered_at: null,
        qty: null, notional: "6500", multiplier: String(multiplier), portfolios: { user_id: "member" },
      }]);
      if (url.pathname === "/rest/v1/rpc/expire_pending_orders") return json(0);
      if (url.pathname === "/rest/v1/rpc/place_order") {
        const args = JSON.parse(String(init?.body));
        rpc.push(args);
        return json([{ trade_id: "fill", symbol, side: "BUY", qty: args.p_qty, price: args.p_price,
          notional: args.p_qty * args.p_price * args.p_multiplier, cash: 94000 }]);
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    }) as typeof fetch;
    await action(env, rpc);
  } finally {
    globalThis.fetch = saved;
    forgetSeason(); forgetChains();
  }
}

async function post(env: Env, body: unknown) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: "member", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const signed = `${header}.${claims}`;
  const token = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil: (job: Promise<unknown>) => jobs.push(job), passThroughOnException() {} } as unknown as ExecutionContext;
  const response = await worker.fetch(new Request("https://terminal.example/api/orders", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, ctx);
  await Promise.all(jobs);
  return response;
}

test("immediate option orders pass the actual contract cost to Postgres and ignore client prices", async () => {
  for (const multiplier of [100, 1000]) await fixture(async (env, rpc) => {
    const response = await post(env, { symbol, side: "BUY", qty: 2, price: 0.01 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(rpc[0]?.p_multiplier, multiplier);
    assert.equal(rpc[0]?.p_price, 3);
    const body = await response.json() as { trade: { notional: number } };
    assert.equal(body.trade.notional, 2 * 3 * multiplier);
  }, multiplier);
});

test("immediate dollar orders and swept dollar limits agree on adjusted contract quantities", async () => {
  await fixture(async (env, rpc) => {
    const response = await post(env, { symbol, side: "BUY", notional: 6500 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(rpc[0]?.p_qty, 2);
    const result = await sweepRestingOrders(env);
    assert.equal(result.filled, 1);
    assert.equal(rpc[1]?.p_qty, 2);
    assert.equal(rpc[1]?.p_multiplier, 1000);
    assert.equal(rpc[1]?.p_pending_order_id, "pending");
  });
});

test("a non-object JSON order returns a validation error rather than crashing", async () => {
  await fixture(async (env, rpc) => {
    for (const body of [null, [], "BUY AAPL"]) assert.equal((await post(env, body)).status, 400);
    assert.equal(rpc.length, 0);
  });
});

test("a low-priced crypto asset that fits six-decimal storage can be traded", async () => {
  await fixture(async (env, rpc) => {
    const response = await post(env, { symbol: "SHIB/USD", side: "BUY", qty: 1_000_000, timeInForce: "GTC" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(rpc[0]?.p_price, 0.000023);
    assert.equal(rpc[0]?.p_multiplier, 1);
  });
});
