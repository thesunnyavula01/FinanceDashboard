import { Hono } from "hono";
import type { AppBindings, Env } from "./types.ts";
import { health } from "./routes/health.ts";
import { auth } from "./routes/auth.ts";
import { quotes } from "./routes/quotes.ts";
import { market } from "./routes/market.ts";
import { orders } from "./routes/orders.ts";
import { portfolio } from "./routes/portfolio.ts";
import { leaderboard } from "./routes/leaderboard.ts";
import { admin } from "./routes/admin.ts";
import { syncUniverse } from "./market/universe.ts";
import { sweepRestingOrders } from "./orders/sweep.ts";
import { snapshotSeason } from "./analytics/snapshot.ts";

/**
 * The cron expressions, matched against `event.cron` so the two schedules never
 * run each other's work. Both must stay identical to the entries in
 * wrangler.jsonc — a typo here is a job that silently never fires, so an
 * unrecognised expression is logged rather than quietly falling through to
 * whichever branch happens to be last.
 */
const SWEEP_CRON = "* 13-21 * * 1-5";
const NIGHTLY_CRON = "15 22 * * 1-5";

const app = new Hono<AppBindings>();

/**
 * Every API route lives under /api. wrangler.jsonc routes exactly that prefix
 * to the Worker via `run_worker_first`; all other paths are served straight
 * from the asset store and never invoke this script.
 */
app.route("/api/health", health);
app.route("/api/auth", auth);
app.route("/api/quotes", quotes);
app.route("/api/market", market);
app.route("/api/portfolio", portfolio);
app.route("/api/orders", orders);
app.route("/api/leaderboard", leaderboard);
app.route("/api/admin", admin);

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
   * Scheduled work (wrangler.jsonc `triggers.crons`).
   *
   * Two schedules, doing three jobs.
   *
   * The minute sweep turns a weekend queue into Monday's fills. The nightly
   * tick does the other two, and they are unrelated enough to be independent
   * promises: refreshing the tradable universe is a multi-megabyte download
   * that changes about as often as a company IPOs, and the snapshot is one row
   * per portfolio recording what the club was worth at the close. Neither
   * should be able to fail the other, so each carries its own catch.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    console.log(`Cron ${event.cron} fired at ${new Date(event.scheduledTime).toISOString()}`);

    // The minute-by-minute sweep. It runs on every weekday tick between 13:00
    // and 21:59 UTC and gates itself on the exchange calendar, so a holiday or
    // the hour either side of the session costs one cached clock lookup and
    // nothing else. This is what turns a weekend queue into Monday's fills.
    if (event.cron === SWEEP_CRON) {
      ctx.waitUntil(
        sweepRestingOrders(env, (p) => ctx.waitUntil(p))
          .then((result) => {
            // Only worth a log line when something actually happened; otherwise
            // this would write 540 "market closed" lines a day.
            if (result.filled || result.rejected || result.expired) {
              console.log(
                `Sweep: ${result.filled} filled, ${result.rejected} rejected, ` +
                  `${result.expired} expired, ${result.resting} still resting.`,
              );
            }
          })
          .catch((err) => console.error("Order sweep failed:", err)),
      );
      return;
    }

    if (event.cron !== NIGHTLY_CRON) {
      console.error(`Unrecognised cron ${event.cron}; wrangler.jsonc and index.ts have drifted.`);
      return;
    }

    ctx.waitUntil(
      syncUniverse(env)
        .then((meta) => console.log(`Universe synced: ${meta.count} tradable assets.`))
        .catch((err) => console.error("Universe sync failed:", err)),
    );

    // One portfolio_snapshots row per member plus SPY and QQQ closes, upserted
    // on the unique constraints so a re-run is harmless. It gates itself on
    // whether the exchange actually held a session, so holidays cost one bar
    // request and write nothing.
    ctx.waitUntil(
      snapshotSeason(env, (p) => ctx.waitUntil(p))
        .then((result) => {
          if (!result.ran) {
            console.log(`Snapshot skipped: ${result.reason ?? "nothing to record."}`);
            return;
          }
          console.log(
            `Snapshot ${result.asOf}: ${result.portfolios} portfolios, ` +
              `${result.benchmarks} benchmark closes, ${result.unpriced} positions at cost.`,
          );
        })
        .catch((err) => console.error("Snapshot failed:", err)),
    );
  },
} satisfies ExportedHandler<Env>;
