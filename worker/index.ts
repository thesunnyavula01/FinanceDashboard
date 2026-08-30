import { Hono } from "hono";
import type { AppBindings, Env } from "./types";
import { health } from "./routes/health";
import { auth } from "./routes/auth";

const app = new Hono<AppBindings>();

/**
 * Every API route lives under /api. wrangler.jsonc routes exactly that prefix
 * to the Worker via `run_worker_first`; all other paths are served straight
 * from the asset store and never invoke this script.
 */
app.route("/api/health", health);
app.route("/api/auth", auth);

// Unknown API paths must answer with JSON. Without this they would fall through
// to the SPA shell and the client would try to parse HTML as JSON.
app.all("/api/*", (c) => c.json({ error: `No such endpoint: ${c.req.path}` }, 404));

// Defensive fallback. Under the production asset routing this is unreachable,
// but it keeps the Worker correct if it is ever invoked for a page request.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal error" }, 500);
});

export default {
  fetch: app.fetch,

  /**
   * Nightly snapshot job (wrangler.jsonc `triggers.crons`).
   * Phase 7 fills this in: one portfolio_snapshots row per portfolio plus SPY
   * and QQQ closes, idempotent on (portfolio_id, as_of).
   */
  async scheduled(event: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    console.log(`Cron ${event.cron} fired at ${new Date(event.scheduledTime).toISOString()}`);
    console.log("Snapshot job is not implemented until Phase 7.");
  },
} satisfies ExportedHandler<Env>;
