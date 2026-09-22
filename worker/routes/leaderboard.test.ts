import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../index.ts";
import { forgetStandings } from "./leaderboard.ts";
import { forgetSeason } from "../lib/portfolio.ts";
import { forgetBars } from "../market/bars.ts";
import { forgetDisplayQuotes } from "../market/display-quotes.ts";
import { SAVED_PRICES_KEY, type SavedPrices } from "../analytics/backup.ts";
import type { LeaderboardRow } from "../lib/leaderboard.ts";
import type { Quote } from "../market/provider.ts";
import type { Env } from "../types.ts";

const SECRET = "test-leaderboard-session-secret";

function token(): string {
  const parts = [Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "member-one", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")];
  const signed = parts.join(".");
  return `${signed}.${createHmac("sha256", SECRET).update(signed).digest("base64url")}`;
}

function book(id: string) {
  return { id, user_id: id, cash: 100_000, starting_cash: 100_000,
    profiles: { display_name: id, role: "member" },
    positions: [] as { symbol: string; qty: number; avg_cost: number; multiplier: number }[],
    position_count: [{ count: 0 }] };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Body {
  rows?: LeaderboardRow[];
  missing?: { userId: string }[];
  unpriced?: number;
  stale?: number;
  pricesAsOf?: string | null;
  error?: string;
  code?: string;
}

interface Fixture {
  portfolios: ReturnType<typeof book>[];
  roster: { id: string; display_name: string }[];
  portfolioCount?: number | null;
  rosterCount?: number | null;
  portfolioFailure: boolean;
  rosterFailure: boolean;
  reads: { seasons: number; portfolios: number; profiles: number };
  prices: Record<string, { price: number; prevClose: number }>;
  savedPrices: SavedPrices;
  marketFailure: boolean;
  quoteBatches: string[][];
  now: () => number;
  advance: (ms: number) => void;
  subrequests: number;
  enforceBudget: () => void;
  beforeClub?: (read: number) => Promise<void>;
  request: (signedIn?: boolean) => Promise<{ status: number; body: Body; cacheControl: string | null }>;
}

async function fixture(run: (state: Fixture) => Promise<void>) {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  let now = savedNow();
  let budgeted = false;
  const edge = new Map<string, string>();
  const spend = () => {
    state.subrequests += 1;
    if (budgeted && state.subrequests > 50) throw new Error("Too many subrequests");
  };
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const env = { SUPABASE_URL: "https://leaderboard.example", SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key", ALPACA_API_KEY_ID: crypto.randomUUID(),
    ALPACA_API_SECRET_KEY: "test-key", QUOTES: { get: async (key: string) => {
      spend();
      return key === SAVED_PRICES_KEY ? state.savedPrices : null;
    } },
    ASSETS: { fetch: async () => new Response("SPA") } } as unknown as Env;
  const state: Fixture = {
    portfolios: [book("member-one"), book("member-two")],
    roster: ["member-one", "member-two"].map((id) => ({ id, display_name: id })),
    portfolioFailure: false, rosterFailure: false,
    reads: { seasons: 0, portfolios: 0, profiles: 0 },
    prices: {}, savedPrices: {}, marketFailure: false, quoteBatches: [],
    now: () => now, advance: (ms) => { now += ms; }, subrequests: 0,
    enforceBudget: () => {
      budgeted = true;
      Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
        async match(key: unknown) { spend(); const body = edge.get(String(key)); return body === undefined ? undefined : new Response(body); },
        async put(key: unknown, response: Response) { spend(); edge.set(String(key), await response.text()); },
      } } });
    },
    request: async (signedIn = true) => {
      const background: Promise<unknown>[] = [];
      const response = await worker.fetch(new Request("https://terminal.example/api/leaderboard", {
        headers: signedIn ? { Authorization: `Bearer ${token()}` } : {},
      }), env, { waitUntil: (p: Promise<unknown>) => background.push(p) } as unknown as ExecutionContext);
      await Promise.all(background);
      return { status: response.status, body: await response.json() as Body,
        cacheControl: response.headers.get("cache-control") };
    },
  };
  const json = (body: unknown, count?: number | null) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (count !== undefined && count !== null) {
      const length = Array.isArray(body) ? body.length : 0;
      headers["content-range"] = length ? `0-${length - 1}/${count}` : `*/${count}`;
    }
    return new Response(JSON.stringify(body), { headers });
  };
  try {
    forgetStandings(); forgetSeason(); forgetBars(); forgetDisplayQuotes();
    Date.now = () => now;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: undefined });
    globalThis.fetch = async (input, init) => {
      spend();
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (url.pathname.endsWith("/seasons")) {
        state.reads.seasons += 1;
        return json([{ id: "season", name: "Club season", starting_cash: 100_000,
          trading_locked: false, starts_at: "2026-09-01T00:00:00Z" }]);
      }
      if (url.pathname.endsWith("/portfolios")) {
        state.reads.portfolios += 1;
        return new Response(JSON.stringify({ message: "The club must be read in one database snapshot" }), { status: 500 });
      }
      if (url.pathname.endsWith("/profiles")) {
        const read = ++state.reads.profiles;
        assert.equal(url.searchParams.get("portfolios.season_id"), "eq.season");
        assert.equal(url.searchParams.get("portfolio_count.season_id"), "eq.season");
        assert.ok(!url.searchParams.get("select")?.includes("!inner"), "unfunded members must remain in the roster");
        assert.match(new Headers(init?.headers).get("prefer") ?? "", /count=exact/);
        const captured = structuredClone(state.roster.map((profile, index) => {
          const portfolios = state.portfolios.filter((portfolio) => portfolio.user_id === profile.id);
          const count = index === 0 && state.portfolioCount !== undefined ? state.portfolioCount : portfolios.length;
          return { ...profile, role: "member", portfolios,
            ...(count === null ? {} : { portfolio_count: [{ count }] }) };
        }));
        const count = state.rosterCount === undefined ? captured.length : state.rosterCount;
        const failed = state.rosterFailure || state.portfolioFailure;
        await state.beforeClub?.(read);
        if (failed) return new Response(JSON.stringify({ message: "Club read unavailable" }), { status: 500 });
        return json(captured, count);
      }
      if (url.pathname.endsWith("/stocks/snapshots")) {
        const symbols = (url.searchParams.get("symbols") ?? "").split(",");
        state.quoteBatches.push(symbols);
        if (state.marketFailure) return new Response("Market data temporarily unavailable", { status: 503 });
        return json(Object.fromEntries(symbols.flatMap((symbol) => {
          const price = state.prices[symbol];
          if (!price) return [];
          const at = new Date(now).toISOString();
          return [[symbol, {
            latestTrade: { p: price.price, t: at },
            dailyBar: { c: price.price, o: price.prevClose, h: price.price, l: price.prevClose, v: 100, t: at },
            prevDailyBar: { c: price.prevClose, t: new Date(now - 86_400_000).toISOString() },
          }]];
        })));
      }
      if (url.pathname.endsWith("/stocks/bars")) return json({ bars: {} });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    };
    await run(state);
  } finally {
    globalThis.fetch = savedFetch;
    Date.now = savedNow;
    if (savedCaches) Object.defineProperty(globalThis, "caches", savedCaches);
    else Reflect.deleteProperty(globalThis, "caches");
    forgetStandings(); forgetSeason(); forgetBars(); forgetDisplayQuotes();
  }
}

// Read-only production observations supplied during this investigation. The
// second account is a synthetic cash-only comparator for the screenshot's
// +5.58% threshold; this is not a reconstruction of Samuel's actual holdings.
const SARAS_POSITIONS = [
  { symbol: "IREN", qty: 814.553353, avg_cost: 36.83, price: 47.22, prevClose: 46.705 },
  { symbol: "ASTS", qty: 448.149144, avg_cost: 55.785, price: 61.86, prevClose: 58.5 },
  { symbol: "RKLB", qty: 319.667545, avg_cost: 62.565, price: 69.925, prevClose: 64.575 },
  { symbol: "CRSP", qty: 263.898662, avg_cost: 56.84, price: 58.34, prevClose: 56.53 },
  { symbol: "OKLO", qty: 259.740259, avg_cost: 38.5, price: 40.16, prevClose: 38.01 },
];

function screenshotBooks(state: Fixture): void {
  const saras = book("saras"), comparator = book("screenshot-comparator");
  saras.cash = 0;
  saras.positions = SARAS_POSITIONS.map(({ symbol, qty, avg_cost }) => ({ symbol, qty, avg_cost, multiplier: 1 }));
  saras.position_count = [{ count: saras.positions.length }];
  comparator.cash = 105_584.50;
  state.portfolios = [saras, comparator];
  state.roster = [{ id: "saras", display_name: "Saras" }, { id: comparator.user_id, display_name: "Screenshot comparator" }];
  state.prices = Object.fromEntries(SARAS_POSITIONS.map(({ symbol, price, prevClose }) => [symbol, { price, prevClose }]));
}

function saveObservedPrices(state: Fixture, savedAt: string, symbols = SARAS_POSITIONS.map((row) => row.symbol)): void {
  for (const symbol of symbols) {
    const observed = SARAS_POSITIONS.find((row) => row.symbol === symbol)!;
    const quote: Quote = {
      symbol, price: observed.price, prevClose: observed.prevClose, source: "bar",
      dayChange: observed.price - observed.prevClose,
      dayChangePercent: (observed.price / observed.prevClose - 1) * 100,
      dayOpen: observed.prevClose, dayHigh: observed.price, dayLow: observed.prevClose,
      dayVolume: 100, asOf: savedAt,
    };
    state.savedPrices[symbol] = { quote, savedAt };
  }
}

function assertSarasFirst(body: Body): void {
  assert.equal(body.rows?.[0]?.userId, "saras", "price loss must never hand the lead to the +5.58% comparator");
  assert.equal(body.rows?.[0]?.rank, 1);
  assert.equal(body.rows?.[0]?.equity, 114_365.49);
  assert.equal(body.rows?.[0]?.totalReturn, 14.37);
  assert.equal(body.rows?.[1]?.totalReturn, 5.58);
  assert.equal(body.unpriced, 0);
}

test("standings reject signed-out readers before reading the club", async () => {
  await fixture(async (state) => {
    assert.equal((await state.request(false)).status, 401);
    assert.deepEqual(state.reads, { seasons: 0, portfolios: 0, profiles: 0 });
  });
});

test("a hundred cold standings polls share one club read without fabricating cost-based ranks", async () => {
  await fixture(async (state) => {
    state.portfolios.forEach((portfolio, index) => {
      portfolio.positions = [{ symbol: index === 0 ? "AAPL" : "MSFT", qty: 1, avg_cost: 100, multiplier: 1 }];
      portfolio.position_count = [{ count: 1 }];
    });
    state.beforeClub = async () => { await new Promise((resolve) => setTimeout(resolve, 50)); };
    const results = await Promise.all(Array.from({ length: 100 }, () => state.request()));
    for (const result of results) {
      assert.equal(result.status, 503);
      assert.equal(result.cacheControl, "no-store");
      assert.equal(result.body.code, "PRICES_UNAVAILABLE");
      assert.equal(result.body.rows, undefined, "missing marks must not publish break-even returns or fabricated leaders");
      assert.equal(result.body.missing, undefined, "price failure must not claim a missing membership");
    }
    assert.equal(state.reads.portfolios, 0, "roster and books share one database snapshot");
    assert.equal(state.reads.profiles, 1);
    await state.request();
    assert.equal(state.reads.profiles, 2, "an unpriced build must not be memoised as successful standings");
  });
});

test("the screenshot book ranks Saras first and keeps that valuation through a live-price outage", async () => {
  await fixture(async (state) => {
    screenshotBooks(state);
    const observedAt = new Date(state.now()).toISOString();
    const live = await state.request();
    assert.equal(live.status, 200);
    assertSarasFirst(live.body);
    assert.equal(live.body.stale, 0);

    state.advance(21_000);
    state.marketFailure = true;
    const outage = await state.request();
    assert.equal(outage.status, 200);
    assertSarasFirst(outage.body);
    assert.equal(outage.body.stale, 5);
    assert.equal(outage.body.rows?.[0]?.stale, 5);
    assert.equal(outage.body.rows?.[1]?.stale, 0);
    assert.equal(outage.body.pricesAsOf, observedAt, "a failed poll must not renew price observation time");

    state.advance(21_000);
    state.marketFailure = false;
    const recovered = await state.request();
    assert.equal(recovered.status, 200);
    assertSarasFirst(recovered.body);
    assert.equal(recovered.body.stale, 0);
    assert.equal(recovered.body.pricesAsOf, new Date(state.now()).toISOString());
  });
});

test("a cold isolate uses durable prices across a holiday weekend without replacing Saras's gains with cost", async () => {
  await fixture(async (state) => {
    screenshotBooks(state);
    const oldest = new Date(state.now() - 4 * 86_400_000).toISOString();
    saveObservedPrices(state, oldest);
    saveObservedPrices(state, new Date(state.now() - 3 * 86_400_000).toISOString(), ["IREN"]);
    state.prices = {};
    const result = await state.request();
    assert.equal(result.status, 200);
    assertSarasFirst(result.body);
    assert.equal(result.body.stale, 5);
    assert.equal(result.body.pricesAsOf, oldest);
  });
});

test("partial venue data combines current and durable marks and reports only saved holdings as stale", async () => {
  await fixture(async (state) => {
    screenshotBooks(state);
    const savedAt = new Date(state.now() - 90_000).toISOString();
    saveObservedPrices(state, savedAt, ["RKLB", "CRSP", "OKLO"]);
    for (const symbol of ["RKLB", "CRSP", "OKLO"]) delete state.prices[symbol];
    const result = await state.request();
    assert.equal(result.status, 200);
    assertSarasFirst(result.body);
    assert.equal(result.body.stale, 3);
    assert.equal(result.body.rows?.[0]?.stale, 3);
    assert.equal(result.body.pricesAsOf, savedAt);
  });
});

test("one absent held price rejects the whole ranking instead of publishing a partial or cost-valued winner", async () => {
  await fixture(async (state) => {
    screenshotBooks(state);
    delete state.prices.IREN;
    const result = await state.request();
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "PRICES_UNAVAILABLE");
    assert.equal(result.body.rows, undefined);
    assert.equal(result.body.missing, undefined);
  });
});

test("expired durable prices are rejected and a later provider recovery releases the failed ranking", async () => {
  await fixture(async (state) => {
    screenshotBooks(state);
    saveObservedPrices(state, new Date(state.now() - 8 * 86_400_000).toISOString());
    state.marketFailure = true;
    const failed = await state.request();
    assert.equal(failed.status, 503);
    assert.equal(failed.body.rows, undefined);
    state.advance(21_000);
    state.marketFailure = false;
    const recovered = await state.request();
    assert.equal(recovered.status, 200);
    assertSarasFirst(recovered.body);
    assert.equal(recovered.body.stale, 0);
    assert.equal(state.reads.profiles, 2);
  });
});

test("the real leaderboard prices 83 symbols within the Worker's shared 50-subrequest budget", async () => {
  await fixture(async (state) => {
    screenshotBooks(state);
    const extra = book("broad-portfolio");
    extra.positions = Array.from({ length: 76 }, (_, index) => ({ symbol: `SYM${index}`, qty: 1, avg_cost: 100, multiplier: 1 }));
    extra.cash -= extra.positions.length * 100;
    extra.position_count = [{ count: extra.positions.length }];
    for (const position of extra.positions) state.prices[position.symbol] = { price: 100, prevClose: 100 };
    for (const symbol of ["SPY", "QQQ"]) state.prices[symbol] = { price: 100, prevClose: 100 };
    state.portfolios.push(extra);
    state.roster.push({ id: extra.user_id, display_name: "Broad portfolio" });
    state.enforceBudget();
    const result = await state.request();
    assert.equal(result.status, 200);
    assertSarasFirst(result.body);
    assert.equal(result.body.rows?.length, 3);
    assert.equal(state.quoteBatches.length, 1);
    assert.equal(state.quoteBatches[0]?.length, 83);
    assert.ok(state.subrequests <= 50, `used ${state.subrequests} subrequests across database, cache and providers`);
    assert.equal(result.body.stale, 0);
  });
});

for (const [name, breakRead] of [
  ["a truncated portfolio collection", (state: Fixture) => { state.portfolioCount = 3; }],
  ["a truncated roster", (state: Fixture) => { state.rosterCount = 3; }],
  ["truncated embedded holdings", (state: Fixture) => { state.portfolios[0]!.position_count = [{ count: 1 }]; }],
  ["a missing portfolio count", (state: Fixture) => { state.portfolioCount = null; }],
  ["a missing roster count", (state: Fixture) => { state.rosterCount = null; }],
  ["a failed roster read", (state: Fixture) => { state.rosterFailure = true; }],
] as const) {
  test(`standings never publish or memoise ${name}`, async () => {
    await fixture(async (state) => {
      breakRead(state);
      const failed = await state.request();
      assert.equal(failed.status, 500);
      assert.equal(failed.body.rows, undefined);
      assert.equal(failed.body.missing, undefined, "incomplete reads must not claim a membership problem");
      state.portfolioCount = undefined; state.rosterCount = undefined; state.rosterFailure = false;
      state.portfolios[0]!.position_count = [{ count: 0 }];
      const recovered = await state.request();
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.rows?.length, 2);
      assert.equal(state.reads.profiles, 2, "the failed build must release its shared promise");
    });
  });
}

test("a complete roster names a genuinely missing portfolio without removing ranked members", async () => {
  await fixture(async (state) => {
    state.portfolios = [book("member-one")];
    const result = await state.request();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.rows?.map((row) => row.userId), ["member-one"]);
    assert.deepEqual(result.body.missing?.map((row) => row.userId), ["member-two"]);
  });
});

test("a failed shared standings build releases all readers and the next poll retries", async () => {
  await fixture(async (state) => {
    state.portfolioFailure = true;
    state.beforeClub = async () => { await new Promise((resolve) => setTimeout(resolve, 50)); };
    const failed = await Promise.all(Array.from({ length: 10 }, () => state.request()));
    assert.ok(failed.every((result) => result.status === 500));
    assert.equal(state.reads.profiles, 1);
    state.portfolioFailure = false;
    assert.equal((await state.request()).body.rows?.length, 2);
    assert.equal(state.reads.profiles, 2);
  });
});

test("a delayed pre-invalidation build cannot replace a newer complete roster", async () => {
  await fixture(async (state) => {
    const firstStarted = deferred(), releaseFirst = deferred();
    state.portfolios = [book("member-one")];
    state.beforeClub = async (read) => {
      if (read === 1) { firstStarted.resolve(); await releaseFirst.promise; }
    };
    const older = state.request();
    await firstStarted.promise;
    let newer;
    try {
      forgetStandings();
      state.portfolios.push(book("member-two"));
      newer = await state.request();
      assert.equal(newer.body.rows?.length, 2);
    } finally { releaseFirst.resolve(); }
    assert.equal((await older).body.rows?.length, 1);
    const next = await state.request();
    assert.deepEqual(next.body, newer.body, "the old completion must not resurrect a smaller cached roster");
    assert.equal(state.reads.profiles, 2);
  });
});

test("an invalidated build finishing early cannot detach a newer in-flight build", async () => {
  await fixture(async (state) => {
    const firstStarted = deferred(), secondStarted = deferred();
    const releaseFirst = deferred(), releaseSecond = deferred();
    state.beforeClub = async (read) => {
      if (read === 1) { firstStarted.resolve(); await releaseFirst.promise; }
      if (read === 2) { secondStarted.resolve(); await releaseSecond.promise; }
    };
    const older = state.request();
    await firstStarted.promise;
    forgetStandings();
    const newer = state.request();
    await secondStarted.promise;
    releaseFirst.resolve();
    await older;
    const joined = state.request();
    // Give authentication time to enter the handler before finishing its build.
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseSecond.resolve();
    assert.equal((await newer).status, 200);
    assert.equal((await joined).status, 200);
    assert.equal(state.reads.profiles, 2);
  });
});
