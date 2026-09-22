import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../index.ts";
import { forgetStandings } from "./leaderboard.ts";
import { forgetSeason } from "../lib/portfolio.ts";
import { forgetBars } from "../market/bars.ts";
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
  rows?: { userId: string }[];
  missing?: { userId: string }[];
  unpriced?: number;
  error?: string;
}

interface Fixture {
  portfolios: ReturnType<typeof book>[];
  roster: { id: string; display_name: string }[];
  portfolioCount?: number | null;
  rosterCount?: number | null;
  portfolioFailure: boolean;
  rosterFailure: boolean;
  reads: { seasons: number; portfolios: number; profiles: number };
  beforeClub?: (read: number) => Promise<void>;
  request: (signedIn?: boolean) => Promise<{ status: number; body: Body; cacheControl: string | null }>;
}

async function fixture(run: (state: Fixture) => Promise<void>) {
  const savedFetch = globalThis.fetch;
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const env = { SUPABASE_URL: "https://leaderboard.example", SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key", ALPACA_API_KEY_ID: crypto.randomUUID(),
    ALPACA_API_SECRET_KEY: "test-key", QUOTES: { get: async () => null },
    ASSETS: { fetch: async () => new Response("SPA") } } as unknown as Env;
  const state: Fixture = {
    portfolios: [book("member-one"), book("member-two")],
    roster: ["member-one", "member-two"].map((id) => ({ id, display_name: id })),
    portfolioFailure: false, rosterFailure: false,
    reads: { seasons: 0, portfolios: 0, profiles: 0 },
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
    forgetStandings(); forgetSeason(); forgetBars();
    Object.defineProperty(globalThis, "caches", { configurable: true, value: undefined });
    globalThis.fetch = async (input, init) => {
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
      // A quote outage may change valuation quality, never membership.
      if (url.pathname.endsWith("/stocks/snapshots")) return json({});
      if (url.pathname.endsWith("/stocks/bars")) return json({ bars: {} });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    };
    await run(state);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedCaches) Object.defineProperty(globalThis, "caches", savedCaches);
    else Reflect.deleteProperty(globalThis, "caches");
    forgetStandings(); forgetSeason(); forgetBars();
  }
}

test("standings reject signed-out readers before reading the club", async () => {
  await fixture(async (state) => {
    assert.equal((await state.request(false)).status, 401);
    assert.deepEqual(state.reads, { seasons: 0, portfolios: 0, profiles: 0 });
  });
});

test("a hundred cold standings polls share one club read and retain every unpriced member", async () => {
  await fixture(async (state) => {
    state.portfolios.forEach((portfolio, index) => {
      portfolio.positions = [{ symbol: index === 0 ? "AAPL" : "MSFT", qty: 1, avg_cost: 100, multiplier: 1 }];
      portfolio.position_count = [{ count: 1 }];
    });
    state.beforeClub = async () => { await new Promise((resolve) => setTimeout(resolve, 50)); };
    const results = await Promise.all(Array.from({ length: 100 }, () => state.request()));
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.cacheControl, "no-store");
      assert.deepEqual(result.body.rows?.map((row) => row.userId).sort(), ["member-one", "member-two"]);
      assert.equal(result.body.unpriced, 2);
    }
    assert.equal(state.reads.portfolios, 0, "roster and books share one database snapshot");
    assert.equal(state.reads.profiles, 1);
    await state.request();
    assert.equal(state.reads.profiles, 1, "completed standings remain memoised");
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
