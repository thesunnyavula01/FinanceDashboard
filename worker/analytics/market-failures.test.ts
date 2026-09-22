import test from "node:test";
import assert from "node:assert/strict";
import { snapshotSeason } from "./snapshot.ts";
import { buildHistory } from "./history.ts";
import { forgetBars, MAX_BAR_SYMBOLS } from "../market/bars.ts";
import { forgetIntraday } from "../market/intraday.ts";
import { forgetCalendar } from "../market/clock.ts";
import { exchangeDate } from "../market/provider.ts";
import { forgetSeason } from "../lib/portfolio.ts";
import { serviceClient } from "../lib/supabase.ts";
import type { Env } from "../types.ts";

const option = "AAPL261218C00150000";
type Venue = "equity" | "crypto" | "options";
type PositionRow = { symbol: string; qty: number; avg_cost: number; multiplier: number };

async function fixture(run: (state: {
  env: Env;
  today: string;
  previous: string;
  failures: Set<string>;
  empty: Set<string>;
  positions: PositionRow[];
  writes: { table: string; rows: Record<string, unknown>[] }[];
  operations: { cache: number; fetch: number };
  enableEdgeCache: () => void;
}) => Promise<void>) {
  const savedFetch = globalThis.fetch;
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const today = exchangeDate();
  const previous = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const env = { SUPABASE_URL: "https://snapshot.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    ALPACA_API_KEY_ID: crypto.randomUUID(), ALPACA_API_SECRET_KEY: "test-secret",
    QUOTES: { get: async () => null } } as unknown as Env;
  const failures = new Set<string>();
  const empty = new Set<string>();
  const positions: PositionRow[] = [
    { symbol: "AAPL", qty: 2, avg_cost: 100, multiplier: 1 },
    { symbol: "BTC/USD", qty: 0.5, avg_cost: 40_000, multiplier: 1 },
    { symbol: option, qty: 1, avg_cost: 2, multiplier: 100 },
  ];
  const writes: { table: string; rows: Record<string, unknown>[] }[] = [];
  const operations = { cache: 0, fetch: 0 };
  const enableEdgeCache = () => {
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
      match: async (key: string) => {
        operations.cache += 1;
        return stored.has(key) ? new Response(stored.get(key)) : undefined;
      },
      put: async (key: string, response: Response) => {
        operations.cache += 1;
        stored.set(key, await response.text());
      },
    } } });
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  try {
    forgetBars(); forgetIntraday(); forgetCalendar(); forgetSeason();
    Object.defineProperty(globalThis, "caches", { configurable: true, value: undefined });
    globalThis.fetch = async (input, init) => {
      operations.fetch += 1;
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      const table = url.pathname.split("/").at(-1)!;
      if (url.hostname === "snapshot.example") {
        if (init?.method === "POST" && !url.pathname.includes("/rpc/")) {
          writes.push({ table, rows: JSON.parse(String(init.body)) });
          return json([]);
        }
        if (table === "seasons") return json([{ id: "season", name: "Season", starting_cash: 100_000,
          trading_locked: false, starts_at: `${previous}T12:00:00Z` }]);
        if (table === "portfolios") return json([{ id: "portfolio", cash: 1_000, positions }]);
        if (table === "trades") return json(positions.map((position) => ({
          ...position, side: "BUY", price: position.avg_cost,
          notional: position.qty * position.avg_cost * position.multiplier,
          executed_at: `${previous}T14:30:00Z`,
        })));
        if (["portfolio_snapshots", "benchmark_snapshots", "club_equity_curve"].includes(table)) return json([]);
      }
      if (table === "clock") return json({ timestamp: `${today}T14:45:00Z`, is_open: true,
        next_open: `${today}T13:30:00Z`, next_close: `${today}T20:00:00Z` });
      if (table === "calendar") return json([previous, today].map((date) => ({ date, open: "09:30", close: "16:00" })));
      if (table === "snapshots") return json(url.pathname.includes("/stocks/") ? {} : { snapshots: {} });
      if (table === "bars") {
        const venue: Venue = url.pathname.includes("/crypto/") ? "crypto" : url.pathname.includes("/options/") ? "options" : "equity";
        const timeframe = url.searchParams.get("timeframe")!;
        if (failures.has(`${venue}/${timeframe}`)) return new Response("Provider unavailable", { status: 500 });
        const symbols = url.searchParams.get("symbols")!.split(",");
        return json({ bars: Object.fromEntries(symbols.filter((symbol) => !empty.has(symbol)).map((symbol) => {
          const close = symbol === "BTC/USD" ? 60_000 : symbol === option ? 5 : 150;
          const stamps = timeframe === "1Day" ? [`${previous}T14:30:00Z`, `${today}T14:30:00Z`]
            : [`${today}T14:30:00Z`, `${today}T14:35:00Z`];
          return [symbol, stamps.map((t) => ({ t, o: close, h: close, l: close, c: close, v: 1000 }))];
        })), next_page_token: null });
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    };
    await run({ env, today, previous, failures, empty, positions, writes, operations, enableEdgeCache });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedCaches) Object.defineProperty(globalThis, "caches", savedCaches);
    else Reflect.deleteProperty(globalThis, "caches");
    forgetBars(); forgetIntraday(); forgetCalendar(); forgetSeason();
  }
}

for (const totalSymbols of [4, 5, 100]) {
  test(`a cold ${totalSymbols}-symbol 1D history stays within one Worker's subrequest budget`, async () => {
    await fixture(async ({ env, previous, positions, operations, enableEdgeCache }) => {
      positions.splice(0, positions.length, ...Array.from({ length: totalSymbols - 2 }, (_, i) => ({
        symbol: `SYM${i}`, qty: 1, avg_cost: 100, multiplier: 1,
      })));
      enableEdgeCache();
      const history = await buildHistory({ env, supabase: serviceClient(env), portfolioId: "portfolio",
        startingCash: 100_000, season: { id: "season", name: "Season", startsAt: `${previous}T12:00:00Z`,
          defaultStartingCash: 100_000, tradingLocked: false }, range: "1D",
        positions: positions.map((position) => ({ symbol: position.symbol, qty: position.qty,
          avgCost: position.avg_cost, multiplier: position.multiplier })) });
      assert.ok(history.rows.length > 0);
      // Includes both bar caches, quotes, database, calendar and clock. Keep
      // headroom for the route's authentication and portfolio/season reads.
      assert.ok(operations.cache + operations.fetch <= 45,
        `${operations.cache} Cache API operations + ${operations.fetch} network calls exceed the shared budget`);
      if (totalSymbols > 4) assert.ok(operations.cache <= 6, "each of three large-set caches gets one read and one write");
    });
  });
}

for (const venue of ["crypto", "options"] as const) {
  test(`a ${venue} bar outage cannot persist cost-valued snapshots when SPY still works`, async () => {
    await fixture(async ({ env, failures, writes }) => {
      failures.add(`${venue}/1Day`);
      const failed = await snapshotSeason(env);
      assert.equal(failed.ran, false);
      assert.match(failed.reason ?? "", /bars were unavailable/i);
      assert.deepEqual(writes, [], "neither portfolio nor benchmark snapshots may publish the incomplete run");

      failures.clear();
      const recovered = await snapshotSeason(env);
      assert.equal(recovered.ran, true);
      assert.equal(recovered.unpriced, 0);
      const rows = writes.find((write) => write.table === "portfolio_snapshots")?.rows;
      assert.equal(rows?.length, 1);
      assert.equal(rows?.[0]?.equity, 31_800, "all three asset classes use recovered closes and contract multipliers");
    });
  });
}

test("snapshot batching retains a failure after an earlier complete batch", async () => {
  await fixture(async ({ env, failures, positions, writes }) => {
    positions.splice(0, positions.length, ...Array.from({ length: MAX_BAR_SYMBOLS }, (_, i) => ({
      symbol: `SYM${i}`, qty: 1, avg_cost: 100, multiplier: 1,
    })), { symbol: "BTC/USD", qty: 1, avg_cost: 40_000, multiplier: 1 });
    failures.add("crypto/1Day");
    assert.equal((await snapshotSeason(env)).ran, false);
    assert.deepEqual(writes, []);
  });
});

test("a successful empty history remains distinct from a failed provider", async () => {
  await fixture(async ({ env, empty, writes }) => {
    empty.add(option);
    const result = await snapshotSeason(env);
    assert.equal(result.ran, true);
    assert.equal(result.unpriced, 1, "the existing explicit cost fallback remains available for unsupported symbols");
    assert.equal(writes.find((write) => write.table === "portfolio_snapshots")?.rows[0]?.equity, 31_500);
  });
});

for (const [range, failedFeed] of [["ALL", "crypto/1Day"], ["1D", "crypto/1Day"], ["1D", "crypto/5Min"]] as const) {
  test(`${range} history discloses a partial ${failedFeed} outage while retaining working benchmarks`, async () => {
    await fixture(async ({ env, previous, failures, positions }) => {
      failures.add(failedFeed);
      const input = { env, supabase: serviceClient(env), portfolioId: "portfolio", startingCash: 100_000,
        season: { id: "season", name: "Season", startsAt: `${previous}T12:00:00Z`,
          defaultStartingCash: 100_000, tradingLocked: false },
        positions: positions.map((position) => ({ symbol: position.symbol, qty: position.qty,
          avgCost: position.avg_cost, multiplier: position.multiplier })), range };
      const degraded = await buildHistory(input);
      assert.equal(degraded.degraded, true);
      assert.ok(degraded.rows.length > 0);
      assert.ok(degraded.rows.some((row) => row.spy !== null));
      failures.clear();
      const recovered = await buildHistory(input);
      assert.equal(recovered.degraded, false, "recovered venues must not inherit an earlier failure flag");
    });
  });
}
