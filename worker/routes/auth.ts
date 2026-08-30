import { Hono } from "hono";
import type { Env } from "../types";
import { ConfigError, serviceClient } from "../lib/supabase";
import { requireAuth, type AuthedBindings } from "../middleware/auth";

export const auth = new Hono<{ Bindings: Env }>();

/** Comparison that does not reveal how much of the code was correct. */
function secretEquals(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

interface SignupBody {
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
  inviteCode?: unknown;
}

/**
 * POST /api/auth/signup
 *
 * The only way to create an account. Signup runs entirely server-side because
 * three things have to be true together: the invite code is right, the auth
 * user exists, and a profile plus a funded portfolio exist. The client cannot
 * be trusted with any of that, and a half-finished signup would leave a member
 * who can log in but has no portfolio.
 */
auth.post("/signup", async (c) => {
  const expectedCode = c.env.CLUB_INVITE_CODE;
  if (!expectedCode) {
    return c.json({ error: "Signup is not configured on the server." }, 503);
  }

  let body: SignupBody;
  try {
    body = await c.req.json<SignupBody>();
  } catch {
    return c.json({ error: "Expected a JSON body." }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "Enter a valid email address." }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters." }, 400);
  }
  if (displayName.length < 1 || displayName.length > 40) {
    return c.json({ error: "Display name must be 1 to 40 characters." }, 400);
  }
  if (!secretEquals(inviteCode, expectedCode)) {
    return c.json({ error: "That invite code is not valid. Ask a club officer." }, 403);
  }

  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  // email_confirm: true marks the address confirmed without sending mail, which
  // is what makes signup instant. The invite code is the gate instead.
  const created = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });

  if (created.error || !created.data.user) {
    const message = created.error?.message ?? "Could not create the account.";
    const alreadyExists = /already|registered|exists/i.test(message);
    return c.json(
      {
        error: alreadyExists
          ? "An account with that email already exists. Sign in instead."
          : message,
      },
      alreadyExists ? 409 : 400,
    );
  }

  const userId = created.data.user.id;

  // Profile + portfolio in one transaction. If it fails the auth user would be
  // able to sign in with no portfolio, so remove it and report the real reason.
  const bootstrap = await supabase.rpc("bootstrap_member", {
    p_user_id: userId,
    p_display_name: displayName,
  });

  if (bootstrap.error) {
    await supabase.auth.admin.deleteUser(userId);
    console.error("bootstrap_member failed:", bootstrap.error);
    return c.json(
      {
        error:
          bootstrap.error.code === "P0002"
            ? "There is no active season yet. Ask a club officer to start one."
            : "Could not set up your portfolio. Nothing was created; try again.",
      },
      409,
    );
  }

  const row = Array.isArray(bootstrap.data) ? bootstrap.data[0] : bootstrap.data;

  return c.json({
    ok: true,
    role: row?.role ?? "member",
    startingCash: row?.starting_cash ?? null,
  });
});

/**
 * GET /api/auth/me — the signed-in member's profile and portfolio.
 * Identity comes from the verified token, never from the request.
 */
const me = new Hono<AuthedBindings>();

me.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, display_name, role, created_at")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("profile lookup failed:", error);
    return c.json({ error: "Could not load your profile." }, 500);
  }
  if (!profile) {
    return c.json({ error: "This account has no profile. Ask a club officer." }, 404);
  }

  const { data: portfolio } = await supabase
    .from("portfolios")
    .select("id, cash, season_id, seasons(name, starting_cash, trading_locked, is_active)")
    .eq("user_id", user.id)
    .maybeSingle();

  return c.json({
    id: profile.id,
    email: user.email ?? null,
    displayName: profile.display_name,
    role: profile.role,
    portfolio: portfolio ?? null,
  });
});

auth.route("/me", me);
