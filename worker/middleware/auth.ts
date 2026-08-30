import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { TokenError, verifySessionToken, type SessionClaims } from "../lib/jwt";

export interface AuthedUser {
  id: string;
  email?: string;
}

export type AuthedBindings = {
  Bindings: Env;
  Variables: { user: AuthedUser };
};

/**
 * Rejects any request without a valid Supabase session.
 *
 * Everything downstream can rely on c.get("user") being a real, verified
 * identity — routes never read a user id out of the request body, because a
 * client could put anyone's id there.
 */
export const requireAuth = createMiddleware<AuthedBindings>(async (c, next) => {
  const supabaseUrl = c.env.SUPABASE_URL;
  if (!supabaseUrl) {
    return c.json({ error: "Auth is not configured on the server." }, 503);
  }

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return c.json({ error: "Sign in to continue." }, 401);
  }

  let claims: SessionClaims;
  try {
    claims = await verifySessionToken(token, {
      jwksUrl: `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`,
      hmacSecret: c.env.SUPABASE_JWT_SECRET,
    });
  } catch (err) {
    const message = err instanceof TokenError ? err.message : "Invalid session";
    return c.json({ error: message }, 401);
  }

  c.set("user", { id: claims.sub, email: claims.email });
  await next();
});
