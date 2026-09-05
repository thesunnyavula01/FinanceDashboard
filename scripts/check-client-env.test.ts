import test from "node:test";
import assert from "node:assert/strict";

import { checkClientEnv } from "./check-client-env.ts";

/** A realistic pair, of the shape actually committed in .env.production. */
const GOOD = {
  VITE_SUPABASE_URL: "https://vtlqkgpcfdhslqahivzf.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

/** A legacy JWT claiming `role: service_role` — the key that must never ship. */
function serviceRoleJwt(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role" })}.sig`;
}

const names = (env: Record<string, string | undefined>) =>
  checkClientEnv(env).map((p) => p.variable);

test("a correctly configured environment has nothing wrong with it", () => {
  assert.deepEqual(checkClientEnv(GOOD), []);
});

test("a missing variable is reported by name", () => {
  const { VITE_SUPABASE_ANON_KEY: _omitted, ...withoutKey } = GOOD;
  assert.deepEqual(names(withoutKey), ["VITE_SUPABASE_ANON_KEY"]);
});

test("an empty or whitespace value counts as missing", () => {
  assert.deepEqual(names({ ...GOOD, VITE_SUPABASE_URL: "   " }), [
    "VITE_SUPABASE_URL",
  ]);
});

test("both missing are reported together, not one at a time", () => {
  assert.deepEqual(names({}), ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]);
});

test("an unfilled .env.example placeholder is caught", () => {
  const problems = checkClientEnv({ ...GOOD, VITE_SUPABASE_URL: "your_url_here" });
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /placeholder/);
});

test("a non-https project URL is rejected", () => {
  const problems = checkClientEnv({
    ...GOOD,
    VITE_SUPABASE_URL: "http://vtlqkgpcfdhslqahivzf.supabase.co",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /https/);
});

// The whole point of rule 1: anything Vite can read is downloaded by every
// visitor. These two cases are the ones that would actually hand the club's
// database away, so they fail the build rather than merely warning.
test("a service-role JWT in the anon slot fails the build", () => {
  const problems = checkClientEnv({
    ...GOOD,
    VITE_SUPABASE_ANON_KEY: serviceRoleJwt(),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /SERVICE-ROLE/);
});

test("an sb_secret_ key in the anon slot fails the build", () => {
  const problems = checkClientEnv({
    ...GOOD,
    VITE_SUPABASE_ANON_KEY: "sb_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /SERVICE-ROLE/);
});

test("a legacy anon JWT is accepted — only service_role is refused", () => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const anonJwt = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig`;
  assert.deepEqual(checkClientEnv({ ...GOOD, VITE_SUPABASE_ANON_KEY: anonJwt }), []);
});

test("any VITE_-prefixed Worker secret is caught, not just the two required", () => {
  for (const leaked of [
    "VITE_SUPABASE_SERVICE_ROLE_KEY",
    "VITE_SUPABASE_JWT_SECRET",
    "VITE_ALPACA_API_KEY_ID",
    "VITE_FINNHUB_API_KEY",
    // Both halves of a Reddit credential. The generic "SECRET" marker already
    // catches the second; only an explicit "REDDIT" catches the first.
    "VITE_REDDIT_CLIENT_ID",
    "VITE_REDDIT_CLIENT_SECRET",
    "VITE_CLUB_INVITE_CODE",
  ]) {
    const problems = checkClientEnv({ ...GOOD, [leaked]: "anything" });
    assert.deepEqual(
      problems.map((p) => p.variable),
      [leaked],
      `${leaked} should be refused`,
    );
  }
});

test("an unrelated VITE_ variable is left alone", () => {
  assert.deepEqual(checkClientEnv({ ...GOOD, VITE_APP_TITLE: "Terminal" }), []);
});
