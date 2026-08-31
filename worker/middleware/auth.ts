import { createMiddleware } from "hono/factory";
import type { Env } from "../types.ts";
import { TokenError, verifySessionToken, type SessionClaims } from "../lib/jwt.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";

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

/**
 * Rejects anyone who is not an admin. Chains after requireAuth.
 *
 * The role is read from the database on every call rather than trusted from
 * the token, because a session token is minted at sign-in and would keep
 * asserting "admin" for an hour after the role was revoked.
 */
export const requireAdmin = createMiddleware<AuthedBindings>(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Sign in to continue." }, 401);

  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("role lookup failed:", error);
    return c.json({ error: "Could not verify your permissions." }, 500);
  }
  if (data?.role !== "admin") {
    return c.json({ error: "This action is for club officers only." }, 403);
  }

  await next();
});
