import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../index.ts";
import { forgetResearch } from "../market/research.ts";
import { forgetSecurities } from "../market/securities.ts";
import { forgetShards } from "../market/universe.ts";
import type { Env } from "../types.ts";

/**
 * Research adds one authenticated route, not a public proxy for upstream
 * quotas. Invalid symbols must stop before I/O; a partial feed must remain a
 * 200, while a complete outage still uses the shared market-error response.
 * These requests enter through index.ts so route registration is covered too.
 *
 * Run with: npm test
 */

const SECRET = "a-test-session-secret";
const env = {
  SUPABASE_URL: "https://auth.example", SUPABASE_JWT_SECRET: SECRET,
  QUOTES: { get: async () => null },
  ASSETS: { fetch: async () => new Response("SPA") },
} as unknown as Env;

function token(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: "club-member", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const signed = `${header}.${claims}`;
  return `${signed}.${createHmac("sha256", SECRET).update(signed).digest("base64url")}`;
}

async function request(query: string, authorization: string | null = `Bearer ${token()}`): Promise<Response> {
  const background: Promise<unknown>[] = [];
  const context = { waitUntil: (promise: Promise<unknown>) => background.push(promise), passThroughOnException() {} } as unknown as ExecutionContext;
  const response = await worker.fetch(new Request(`https://terminal.example/api/research${query}`, {
    headers: authorization ? { Authorization: authorization } : {},
  }), env, context);
  await Promise.all(background);
  return response;
}

async function withFetch(run: () => Promise<void>, response: (url: URL) => Response = () => new Response("Unavailable", { status: 503 })) {
  const saved = globalThis.fetch;
  forgetResearch(); forgetSecurities(); forgetShards();
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => response(new URL(String(input)))) as typeof fetch;
    await run();
  } finally {
    globalThis.fetch = saved;
    forgetResearch(); forgetSecurities(); forgetShards();
  }
}

test("research rejects a signed-out reader before requesting market data", async () => {
  await withFetch(async () => {
    const response = await request("?symbol=BTC%2FUSD", null);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Sign in to continue." });
  }, () => { throw new Error("Unauthorized request reached an upstream."); });
});

test("research rejects malformed, missing and multiple symbols before provider calls", async () => {
  await withFetch(async () => {
    for (const raw of ["", "AAPL,TSLA", "../etc/passwd", "javascript:alert(1)", "AAPL261331C00150000"]) {
      const response = await request(`?symbol=${encodeURIComponent(raw)}`);
      assert.equal(response.status, 400, raw);
      assert.match((await response.json() as { error: string }).error, /one ticker or pair/);
    }
  }, () => { throw new Error("Invalid symbol reached an upstream."); });
});

test("a complete research outage returns a JSON 502 through the registered route", async () => {
  await withFetch(async () => {
    const response = await request("?symbol=BTC%2FUSD");
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), { error: "Research sources are temporarily unavailable. Try again shortly." });
  });
});

test("a successful empty source keeps a partially unavailable research request at 200", async () => {
  await withFetch(async () => {
    const response = await request("?symbol=btc%2Fusd");
    assert.equal(response.status, 200);
    const body = await response.json() as { symbol: string; sources: string[]; missing: string[]; headlines: unknown[]; sectionMissing: { discussion: string[] } };
    assert.equal(body.symbol, "BTC/USD");
    assert.deepEqual(body.sources, ["hackernews"]);
    assert.deepEqual(body.missing, ["alpaca", "finnhub", "gdelt"]);
    assert.deepEqual(body.headlines, []);
    assert.deepEqual(body.sectionMissing.discussion, []);
  }, (url) => url.hostname === "hn.algolia.com"
    ? new Response(JSON.stringify({ hits: [] }), { headers: { "content-type": "application/json" } })
    : new Response("Unavailable", { status: 503 }));
});
