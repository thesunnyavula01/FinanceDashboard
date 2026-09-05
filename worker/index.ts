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
import { research } from "./routes/research.ts";
import { syncUniverse } from "./market/universe.ts";
import { sweepRestingOrders } from "./orders/sweep.ts";
import { snapshotSeason } from "./analytics/snapshot.ts";
import { bookIsSettled, settleExpiries } from "./orders/expiry.ts";

/**
 * The cron expressions, matched against `event.cron` so the two schedules never
 * run each other's work. Both must stay identical to the entries in
 * wrangler.jsonc — a typo here is a job that silently never fires, so an
 * unrecognised expression is logged rather than quietly falling through to
 * whichever branch happens to be last.
 */
const SWEEP_CRON = "* * * * *";
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
app.route("/api/research", research);

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

    // The minute-by-minute sweep. It ticks every minute of every day now that
    // crypto is tradable, and gates each order on its own asset class: a stock
    // order at 3am on a Sunday stays resting, a coin order fills. The idle cost
    // is one indexed query for pending orders, which returns nothing and stops
    // there before the clock is even fetched. This is what turns a weekend
    // queue into Monday's fills.
    if (event.cron === SWEEP_CRON) {
      ctx.waitUntil(
        sweepRestingOrders(env, (p) => ctx.waitUntil(p))
          .then((result) => {
            // Only worth a log line when something actually happened; otherwise
            // this would write 540 "market closed" lines a day.
            // Deliberately not gated on `trailed`: a working trailing stop
            // ratchets on most ticks, and logging that would write a line a
            // minute forever. A trigger is an event and is worth one.
            if (result.filled || result.rejected || result.expired || result.triggered) {
              console.log(
                `Sweep: ${result.filled} filled, ${result.triggered} triggered, ` +
                  `${result.rejected} rejected, ${result.expired} expired, ` +
                  `${result.resting} still resting (${result.trailed} trails moved).`,
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

    // Expiry first, then the snapshot — chained rather than parallel, and this
    // is the one ordering in the file that is load-bearing. A long contract
    // expiring today is cash after the close, and `mergeSnapshots()` prefers a
    // stored snapshot to a replay forever, so a snapshot taken over a
    // half-settled book is a wrong number that never washes out. If anything
    // fails to settle, the night is skipped and the replay covers it.
    ctx.waitUntil(
      settleExpiries(env, (p) => ctx.waitUntil(p))
        .then((expiry) => {
          if (expiry.settled || expiry.skipped || expiry.failed) {
            console.log(
              `Expiry ${expiry.asOf}: ${expiry.settled} settled ` +
                `(${expiry.worthless} worthless, ${expiry.credited} credited to cash), ` +
                `${expiry.skipped} unpriced, ${expiry.failed} failed.`,
            );
          }

          if (!bookIsSettled(expiry)) {
            console.error(
              "Snapshot skipped: contracts expired today that could not be settled. " +
                "The equity curve falls back to the replay for tonight.",
            );
            return null;
          }

          return snapshotSeason(env, (p) => ctx.waitUntil(p));
        })
        .then((result) => {
          if (!result) return;
          if (!result.ran) {
            console.log(`Snapshot skipped: ${result.reason ?? "nothing to record."}`);
            return;
          }
          console.log(
            `Snapshot ${result.asOf}: ${result.portfolios} portfolios, ` +
              `${result.benchmarks} benchmark closes, ${result.unpriced} positions at cost.`,
          );
        })
        .catch((err) => console.error("Expiry or snapshot failed:", err)),
    );
  },
} satisfies ExportedHandler<Env>;
