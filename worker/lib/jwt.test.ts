import test from "node:test";
import assert from "node:assert/strict";
import { TokenError, verifySessionToken } from "./jwt.ts";

/**
 * Session verification is the boundary between "anyone on the internet" and
 * "a club member", so it gets tested against real crypto rather than mocks of
 * itself. Only the JWKS fetch is stubbed.
 *
 * Run with: npm test
 */

const KID = "test-key-1";

/** Unique per call, so the module-level JWKS cache never bleeds between tests. */
let urlCounter = 0;
const nextJwksUrl = () =>
  `https://example.test/${++urlCounter}/auth/v1/.well-known/jwks.json`;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf.toString("base64url");
}

async function makeEs256Key() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
}

async function signEs256(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", kid: KID, typ: "JWT" },
): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    enc.encode(input),
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function signHs256(secret: string, claims: Record<string, unknown>): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/** Serves the public half at a fresh JWKS url; everything else 404s. */
function stubJwks(publicJwk: JsonWebKey, kid = KID): string {
  const url = nextJwksUrl();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === url) {
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, use: "sig" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return url;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 60;

test("accepts a valid ES256 token and returns its claims", async () => {
  const { privateKey, publicKey } = await makeEs256Key();
  const jwksUrl = stubJwks(await crypto.subtle.exportKey("jwk", publicKey));

  const token = await signEs256(privateKey, {
    sub: "user-123",
    email: "member@school.edu",
    exp: future(),
  });

  const claims = await verifySessionToken(token, { jwksUrl });
  assert.equal(claims.sub, "user-123");
  assert.equal(claims.email, "member@school.edu");
});

test("rejects a token signed by a different key", async () => {
  const legit = await makeEs256Key();
  const attacker = await makeEs256Key();
  // JWKS publishes the legitimate key; the token is signed by the attacker's.
  const jwksUrl = stubJwks(await crypto.subtle.exportKey("jwk", legit.publicKey));

  const token = await signEs256(attacker.privateKey, { sub: "user-123", exp: future() });

  await assert.rejects(
    () => verifySessionToken(token, { jwksUrl }),
    (err: Error) => err instanceof TokenError && /signature/i.test(err.message),
  );
});

test("rejects an expired token even though the signature is good", async () => {
  const { privateKey, publicKey } = await makeEs256Key();
  const jwksUrl = stubJwks(await crypto.subtle.exportKey("jwk", publicKey));

  const token = await signEs256(privateKey, { sub: "user-123", exp: past() });

  await assert.rejects(
    () => verifySessionToken(token, { jwksUrl }),
    (err: Error) => err instanceof TokenError && /expired/i.test(err.message),
  );
});

test("rejects alg:none, the classic forged-token attack", async () => {
  const { publicKey } = await makeEs256Key();
  const jwksUrl = stubJwks(await crypto.subtle.exportKey("jwk", publicKey));

  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: "admin", exp: future() }));
  const token = `${header}.${payload}.`;

  await assert.rejects(
    () => verifySessionToken(token, { jwksUrl }),
    (err: Error) => err instanceof TokenError,
  );
});

test("rejects a token whose payload was tampered with after signing", async () => {
  const { privateKey, publicKey } = await makeEs256Key();
  const jwksUrl = stubJwks(await crypto.subtle.exportKey("jwk", publicKey));

  const token = await signEs256(privateKey, { sub: "member", exp: future() });
  const [h, , s] = token.split(".");
  const forged = `${h}.${b64url(JSON.stringify({ sub: "admin", exp: future() }))}.${s}`;

  await assert.rejects(
    () => verifySessionToken(forged, { jwksUrl }),
    (err: Error) => err instanceof TokenError && /signature/i.test(err.message),
  );
});

test("rejects an unknown kid rather than falling back to any key", async () => {
  const { privateKey, publicKey } = await makeEs256Key();
  const jwksUrl = stubJwks(await crypto.subtle.exportKey("jwk", publicKey), "some-other-kid");

  const token = await signEs256(privateKey, { sub: "user-123", exp: future() });

  await assert.rejects(
    () => verifySessionToken(token, { jwksUrl }),
    (err: Error) => err instanceof TokenError && /unknown key/i.test(err.message),
  );
});

test("still accepts legacy HS256 tokens when a secret is configured", async () => {
  const secret = "a-legacy-project-jwt-secret-value";
  const jwksUrl = nextJwksUrl();
  const token = await signHs256(secret, { sub: "legacy-user", exp: future() });

  const claims = await verifySessionToken(token, {
    jwksUrl,
    hmacSecret: secret,
  });
  assert.equal(claims.sub, "legacy-user");
});

test("rejects an HS256 token signed with the wrong secret", async () => {
  const jwksUrl = nextJwksUrl();
  const token = await signHs256("attacker-guess", { sub: "admin", exp: future() });

  await assert.rejects(
    () => verifySessionToken(token, { jwksUrl, hmacSecret: "real-secret" }),
    (err: Error) => err instanceof TokenError && /signature/i.test(err.message),
  );
});

test("rejects a token with no subject", async () => {
  const { privateKey, publicKey } = await makeEs256Key();
  const jwksUrl = stubJwks(await crypto.subtle.exportKey("jwk", publicKey));

  const token = await signEs256(privateKey, { exp: future() });

  await assert.rejects(
    () => verifySessionToken(token, { jwksUrl }),
    (err: Error) => err instanceof TokenError && /subject/i.test(err.message),
  );
});
