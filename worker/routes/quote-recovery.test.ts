import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../index.ts";
import { quoteCache } from "../market/quotes.ts";
import { SAVED_PRICES_KEY, BACKUP_PREFIX } from "../analytics/backup.ts";
import type { Env } from "../types.ts";

const secret = "test-only-session-secret";
const token = () => {
  const parts = [Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "member", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")];
  const signed = parts.join(".");
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
};
function envFor(savedAt: string) {
  const reads: string[] = [];
  const env = { SUPABASE_URL: "https://auth.example", SUPABASE_JWT_SECRET: secret,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key", ALPACA_API_KEY_ID: crypto.randomUUID(),
    ALPACA_API_SECRET_KEY: "test-key", QUOTES: { get: async (key: string) => {
      reads.push(key);
      return { AAPL: { quote: { symbol: "AAPL", price: 150, source: "trade", asOf: savedAt }, savedAt } };
    } }, ASSETS: { fetch: async () => new Response("SPA") } } as unknown as Env;
  return { env, reads };
}
async function request(env: Env, path: string, signedIn = true) {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(`https://app.example/api/${path}`, {
    headers: signedIn ? { Authorization: `Bearer ${token()}` } : {},
  }), env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext);
  await Promise.all(pending);
  return response;
}

test("a cold Worker restores saved display prices during a provider outage, without pricing executions", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
  try {
    const savedAt = new Date(Date.now() - 300000).toISOString();
    const { env, reads } = envFor(savedAt);
    const response = await request(env, "quotes?symbols=AAPL,MSFT");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { quotes: Record<string, { price: number; stale: boolean; receivedAt: string }>; unknown: string[] };
    assert.equal(body.quotes.AAPL.price, 150);
    assert.equal(body.quotes.AAPL.stale, true);
    assert.equal(body.quotes.AAPL.receivedAt, savedAt);
    assert.deepEqual(body.unknown, ["MSFT"]);
    assert.deepEqual(reads, [SAVED_PRICES_KEY], "no private backup is loaded by the quotes endpoint");
    const execution = await quoteCache(env).get(["AAPL"]);
    assert.equal(execution.quotes.size, 0, "the cache used by orders must not return the display fallback");
  } finally { globalThis.fetch = fetch; }
});

test("expired backups are not presented as current quotes", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
  try {
    const { env } = envFor("2020-01-01T00:00:00Z");
    const response = await request(env, "quotes?symbols=AAPL");
    const body = await response.json() as { quotes: object; unknown: string[] };
    assert.deepEqual(body.quotes, {});
    assert.deepEqual(body.unknown, ["AAPL"]);
  } finally { globalThis.fetch = fetch; }
});

test("signed-out visitors and ordinary members cannot export private recovery checkpoints", async () => {
  const { env, reads } = envFor(new Date().toISOString());
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ role: "member" }), { headers: { "Content-Type": "application/json" } });
  try {
    for (const path of ["backups", `backups/${encodeURIComponent(BACKUP_PREFIX + "2026-09-15T15:00:00Z")}`]) {
      assert.equal((await request(env, `admin/${path}`, false)).status, 401);
      assert.equal((await request(env, `admin/${path}`)).status, 403);
    }
    assert.deepEqual(reads, []);
  } finally { globalThis.fetch = fetch; }
});
