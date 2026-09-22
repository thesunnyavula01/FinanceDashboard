import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../index.ts";
import { forgetSeason } from "../lib/portfolio.ts";
import type { Env } from "../types.ts";

const secret = "membership-read-test-secret";
const currentSeason = {
  id: "current", name: "Current season", starting_cash: "100000", starts_at: "2026-09-01",
  ends_at: null, is_active: true, trading_locked: false,
};
const profiles = [
  { id: "member", display_name: "Officer", role: "admin", created_at: "2026-08-01" },
  { id: "new-member", display_name: "New member", role: "member", created_at: "2026-09-02" },
];

interface FixtureOptions {
  portfolioReadFails?: boolean;
  noActivePortfolio?: boolean;
  noActiveSeason?: boolean;
}

/** Exercise the real routes and Supabase response handling, including the
 * multiple-row error that maybeSingle() produces for a returning member.
 */
async function fixture(
  options: FixtureOptions,
  action: (request: (path: string) => Promise<Response>, queries: URL[]) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const queries: URL[] = [];
  const env = {
    SUPABASE_URL: "https://membership.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SUPABASE_JWT_SECRET: secret, QUOTES: { get: async () => null },
    ASSETS: { fetch: async () => new Response("SPA") },
  } as unknown as Env;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  const portfolios = [
    { id: "old-book", user_id: "member", season_id: "previous", cash: "125000", starting_cash: "100000",
      seasons: { ...currentSeason, id: "previous", is_active: false } },
    ...(!options.noActivePortfolio && !options.noActiveSeason ? [
      { id: "current-book", user_id: "member", season_id: "current", cash: "110000", starting_cash: "100000",
        seasons: currentSeason },
    ] : []),
  ];
  forgetSeason();
  try {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      queries.push(url);
      assert.equal(init?.method ?? "GET", "GET", "membership reads must never mutate accounts");
      if (url.pathname === "/rest/v1/profiles") {
        const id = url.searchParams.get("id")?.slice(3);
        return json(profiles.filter((profile) => !id || profile.id === id));
      }
      if (url.pathname === "/rest/v1/seasons") return json(options.noActiveSeason ? [] : [currentSeason]);
      if (url.pathname === "/rest/v1/club_settings") return json([]);
      if (url.pathname === "/rest/v1/portfolios") {
        if (options.portfolioReadFails) return json({
          code: "TEST_DB_ERROR", message: "Portfolio read failed", details: null, hint: null,
        }, 400);
        const season = url.searchParams.get("season_id")?.slice(3);
        const user = url.searchParams.get("user_id")?.slice(3);
        // An embedded filter only removes parent rows when it is an inner join.
        const activeOnly = url.searchParams.get("seasons.is_active") === "eq.true" &&
          (url.searchParams.get("select") ?? "").includes("seasons!inner(");
        return json(portfolios.filter((portfolio) =>
          (!season || portfolio.season_id === season) && (!user || portfolio.user_id === user) &&
          (!activeOnly || portfolio.seasons.is_active)));
      }
      throw new Error(`Unexpected membership fixture request: ${url.pathname}`);
    }) as typeof fetch;

    const signed = [
      Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "member", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
    ].join(".");
    const token = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
    await action(async (path) => worker.fetch(new Request(`https://app.example/api/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }), env, { waitUntil() {} } as unknown as ExecutionContext), queries);
  } finally {
    globalThis.fetch = originalFetch;
    forgetSeason();
  }
}

test("a returning member's profile selects their active portfolio when historical portfolios also exist", async () => {
  await fixture({}, async (request) => {
    const response = await request("auth/me");
    assert.equal(response.status, 200);
    const body = await response.json() as { portfolio: { id: string; cash: string; season_id: string } };
    assert.equal(body.portfolio?.id, "current-book");
    assert.equal(body.portfolio?.cash, "110000");
    assert.equal(body.portfolio?.season_id, "current");
  });
});

test("a historical portfolio cannot masquerade as an active account", async () => {
  for (const options of [{ noActivePortfolio: true }, { noActiveSeason: true }]) {
    await fixture(options, async (request) => {
      const response = await request("auth/me");
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { portfolio: unknown }).portfolio, null);
    });
  }
});

test("a failed profile portfolio read reports an error instead of claiming the account has no portfolio", async () => {
  await fixture({ portfolioReadFails: true }, async (request) => {
    const response = await request("auth/me");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Could not load your portfolio." });
  });
});

test("the officer roster distinguishes an existing active portfolio from a genuinely unfunded member", async () => {
  await fixture({}, async (request) => {
    const response = await request("admin");
    assert.equal(response.status, 200);
    const body = await response.json() as { members: { userId: string; portfolioId: string | null }[] };
    assert.deepEqual(body.members.map((member) => [member.userId, member.portfolioId]), [
      ["member", "current-book"], ["new-member", null],
    ]);
  });
});

test("a failed roster portfolio read cannot report every member as unfunded", async () => {
  await fixture({ portfolioReadFails: true }, async (request) => {
    const response = await request("admin");
    assert.equal(response.status, 500);
    assert.equal("members" in (await response.json() as object), false);
  });
});

test("a club without an active season still returns the roster without querying historical portfolios", async () => {
  await fixture({ noActiveSeason: true }, async (request, queries) => {
    const response = await request("admin");
    assert.equal(response.status, 200);
    const body = await response.json() as { members: { portfolioId: string | null }[] };
    assert.equal(body.members.length, 2);
    assert.ok(body.members.every((member) => member.portfolioId === null));
    assert.ok(queries.every((query) => query.pathname !== "/rest/v1/portfolios"));
  });
});
