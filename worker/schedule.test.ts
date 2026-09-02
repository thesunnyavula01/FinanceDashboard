import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The cron schedule, pinned across the two files that have to agree about it.
 *
 * `scheduled()` dispatches on `event.cron`, matching the string Cloudflare
 * hands it against a constant in worker/index.ts. If wrangler.jsonc is edited
 * and the constant is not, the failure is silent in the worst way: the trigger
 * still fires, the handler falls through every branch, and a job that looks
 * scheduled simply never runs. Nothing about the deployment is broken enough to
 * notice — the snapshots just stop, and the first sign of it is a chart with a
 * flat week in it a month later.
 *
 * There is no Cloudflare here to ask, so the check is textual, which is all it
 * needs to be: the two files either contain the same expressions or they do
 * not.
 */

const ROOT = new URL("../", import.meta.url);

const WRANGLER = readFileSync(fileURLToPath(new URL("wrangler.jsonc", ROOT)), "utf8");
const INDEX = readFileSync(fileURLToPath(new URL("worker/index.ts", ROOT)), "utf8");

/** wrangler.jsonc is JSON with `//` comments, all of which sit on their own lines. */
function crons(): string[] {
  const stripped = WRANGLER.split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  const config = JSON.parse(stripped) as { triggers?: { crons?: string[] } };
  return config.triggers?.crons ?? [];
}

/** The cron expressions index.ts dispatches on, in declaration order. */
function dispatched(): string[] {
  return [...INDEX.matchAll(/_CRON = "([^"]+)"/g)].map((match) => match[1]!);
}

test("every scheduled trigger is one the handler recognises", () => {
  const scheduled = crons();
  const handled = dispatched();

  assert.ok(scheduled.length > 0, "wrangler.jsonc declares no cron triggers");

  for (const cron of scheduled) {
    assert.ok(
      handled.includes(cron),
      `wrangler.jsonc schedules "${cron}" but worker/index.ts dispatches on ${JSON.stringify(handled)}`,
    );
  }
});

test("every cron the handler dispatches on is actually scheduled", () => {
  // The other direction, which is the one that fails quietly: a constant with
  // no trigger behind it is a job nobody will ever notice is not running.
  const scheduled = crons();

  for (const cron of dispatched()) {
    assert.ok(
      scheduled.includes(cron),
      `worker/index.ts dispatches on "${cron}", which wrangler.jsonc does not schedule`,
    );
  }
});

test("the nightly job runs after the close, in either offset", () => {
  const nightly = dispatched().find((cron) => !cron.startsWith("*"));
  assert.ok(nightly, "no nightly cron found");

  const [minute, hour] = nightly.split(" ");
  const utcMinutes = Number(hour) * 60 + Number(minute);

  // 16:00 ET is 21:00 UTC under EST, which is the later of the two closes. The
  // snapshot prices the club at daily bars, so it has to run after the bars for
  // that session exist.
  assert.ok(utcMinutes > 21 * 60, `${nightly} runs before the winter close`);

  // And before midnight UTC, because the row is stamped with the exchange date
  // and 00:15 UTC is the *next* day in ET terms — 19:15 the previous evening.
  // A job that crossed midnight would snapshot Monday and label it Tuesday.
  assert.ok(utcMinutes < 24 * 60, `${nightly} crosses into the next UTC day`);
});

/**
 * The sweep used to be scheduled around the nightly job so the two never shared
 * a minute. That stopped being possible when crypto arrived: a coin has no bell,
 * so a queued limit has to be fillable at 3am on a Sunday, and the sweep runs
 * continuously.
 *
 * The assertion that replaced it is the reason the overlap is safe. Two crons
 * firing in the same minute are two separate invocations, and scheduled() must
 * keep dispatching them as independent promises — a shared `await` chain would
 * mean a slow sweep delaying the snapshot past the exchange date it is stamped
 * with, which is the thing the old spacing was really protecting.
 */
test("the sweep covers every day, because one of the markets never closes", () => {
  const sweep = dispatched().find((cron) => cron.startsWith("*"));
  assert.ok(sweep, "no sweep cron found");

  const [, hours, , , weekdays] = sweep.split(" ");
  assert.equal(hours, "*", `the sweep must cover every hour, not "${hours}" — crypto has no bell`);
  assert.equal(weekdays, "*", `the sweep must cover every day, not "${weekdays}"`);
});

test("the nightly job and the sweep are dispatched independently", () => {
  const handler = INDEX;

  // They now collide once a day, at 22:15 UTC. Each branch has to own its
  // failure: a sweep that throws must not take the snapshot with it, and
  // neither should wait on the other.
  const waitUntils = handler.match(/ctx\.waitUntil\(/g) ?? [];
  assert.ok(
    waitUntils.length >= 3,
    "the sweep and both nightly jobs should each be their own waitUntil",
  );

  assert.doesNotMatch(
    handler,
    /await\s+sweepRestingOrders\(/,
    "awaiting the sweep inside scheduled() would let it delay the nightly snapshot",
  );
});
