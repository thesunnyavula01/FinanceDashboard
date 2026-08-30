/**
 * Supabase session-token verification.
 *
 * Supabase signs access tokens with HS256 using the project's JWT secret, which
 * we hold as a Worker secret. Verifying the signature locally costs nothing and
 * adds no latency; calling Supabase to validate every request would add a
 * network round trip to every single API call.
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

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Length-independent comparison, so a wrong signature leaks no timing signal. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verifies signature and expiry, then returns the claims.
 * Throws TokenError on anything malformed, unsigned, or expired.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("Malformed token");

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
  } catch {
    throw new TokenError("Malformed token header");
  }

  // Pinning the algorithm is what stops an "alg: none" or algorithm-confusion
  // token from being accepted.
  if (header.alg !== "HS256") {
    throw new TokenError(`Unsupported token algorithm: ${header.alg ?? "none"}`);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${headerB64}.${payloadB64}`)),
  );

  if (!timingSafeEqual(expected, base64UrlDecode(signatureB64))) {
    throw new TokenError("Bad token signature");
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new TokenError("Malformed token payload");
  }

  if (!claims.sub) throw new TokenError("Token has no subject");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new TokenError("Session expired");
  }

  return claims;
}
