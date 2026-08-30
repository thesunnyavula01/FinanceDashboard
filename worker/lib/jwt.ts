/**
 * Supabase session-token verification.
 *
 * Supabase projects sign access tokens one of two ways, and this project uses
 * the newer one:
 *
 *   ES256 / RS256 — asymmetric. The public half is published at
 *                   /auth/v1/.well-known/jwks.json and the token names which
 *                   key signed it via the `kid` header. This is what this
 *                   project uses.
 *   HS256         — legacy shared secret, the project's JWT secret.
 *
 * Both are supported so a project can migrate signing keys without this Worker
 * needing a redeploy. Verification happens locally either way — asking Supabase
 * to validate every request would add a network round trip to every API call.
 *
 * Written against Web Crypto so it runs in workerd with no dependencies.
 */

export interface SessionClaims {
  /** auth.users.id */
  sub: string;
  email?: string;
  role?: string;
  exp: number;
  iat?: number;
}

export class TokenError extends Error {}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
  } catch {
    throw new TokenError(`Malformed token ${what}`);
  }
}

/** Length-independent comparison, so a wrong signature leaks no timing signal. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// JWKS changes only when signing keys rotate, so a short cache removes the
// fetch from the hot path while still picking up a rotation within minutes.
const JWKS_TTL_MS = 10 * 60_000;
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function loadJwks(jwksUrl: string, force = false): Promise<Jwk[]> {
  const fresh =
    jwksCache &&
    jwksCache.url === jwksUrl &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;

  if (fresh && !force) return jwksCache!.keys;

  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new TokenError(`Could not load signing keys (${response.status})`);
  }

  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache = { url: jwksUrl, keys, fetchedAt: Date.now() };
  return keys;
}

/**
 * Described structurally rather than with DOM crypto type names, which the
 * Cloudflare Workers type package does not declare. The call sites adapt these
 * to whatever ambient SubtleCrypto signature is in scope.
 */
interface AlgorithmSpec {
  import: { name: string; namedCurve?: string; hash?: string };
  verify: { name: string; hash?: string };
}

type ImportAlgorithm = Parameters<SubtleCrypto["importKey"]>[2];
type VerifyAlgorithm = Parameters<SubtleCrypto["verify"]>[0];

const ALGORITHMS: Record<string, AlgorithmSpec> = {
  ES256: {
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
};

async function verifyAsymmetric(
  header: JwtHeader,
  signingInput: string,
  signature: Uint8Array,
  jwksUrl: string,
): Promise<void> {
  const spec = ALGORITHMS[header.alg!];
  if (!spec) throw new TokenError(`Unsupported token algorithm: ${header.alg}`);

  // On a kid miss, refetch once: that is what a key rotation looks like.
  let keys = await loadJwks(jwksUrl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await loadJwks(jwksUrl, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new TokenError("Token signed by an unknown key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    spec.import as ImportAlgorithm,
    false,
    ["verify"],
  );

  const ok = await crypto.subtle.verify(
    spec.verify as VerifyAlgorithm,
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
  if (!ok) throw new TokenError("Bad token signature");
}

async function verifyHmac(
  signingInput: string,
  signature: Uint8Array,
  secret: string,
): Promise<void> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  if (!timingSafeEqual(expected, signature)) {
    throw new TokenError("Bad token signature");
  }
}

export interface VerifyOptions {
  /** Where to fetch public signing keys, for ES256 / RS256 tokens. */
  jwksUrl: string;
  /** The project JWT secret, for legacy HS256 tokens. */
  hmacSecret?: string;
}

/**
 * Verifies signature and expiry, then returns the claims.
 * Throws TokenError on anything malformed, unsigned, or expired.
 */
export async function verifySessionToken(
  token: string,
  options: VerifyOptions,
): Promise<SessionClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("Malformed token");

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = decodeJson<JwtHeader>(headerB64, "header");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);

  // Pinning to a known set is what stops an "alg: none" token, and refusing to
  // pick the verifier from the token alone stops algorithm confusion: an HS256
  // token is only ever checked against the shared secret, never against a
  // public key treated as an HMAC secret.
  if (header.alg === "HS256") {
    if (!options.hmacSecret) {
      throw new TokenError("Token uses HS256 but no JWT secret is configured");
    }
    await verifyHmac(signingInput, signature, options.hmacSecret);
  } else if (header.alg && header.alg in ALGORITHMS) {
    await verifyAsymmetric(header, signingInput, signature, options.jwksUrl);
  } else {
    throw new TokenError(`Unsupported token algorithm: ${header.alg ?? "none"}`);
  }

  const claims = decodeJson<SessionClaims>(payloadB64, "payload");

  if (!claims.sub) throw new TokenError("Token has no subject");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new TokenError("Session expired");
  }

  return claims;
}
