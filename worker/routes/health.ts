import { Hono } from "hono";
import type { AppBindings } from "../types.ts";
import { marketClock } from "../market/clock.ts";

export const health = new Hono<AppBindings>();

/**
 * Liveness plus market session. The dashboard polls this for the status rail,
 * which doubles as the proof that the SPA and the Worker are talking to each
 * other — if this route stops answering, the rail says so.
 *
 * Unauthenticated, so it stays useful when auth itself is what is broken. The
 * clock is cached in the isolate for 30 seconds, so a hundred members polling
 * it do not become a hundred calls to Alpaca.
 */
health.get("/", async (c) => {
  const clock = await marketClock(c.env);

  return c.json({
    ok: true,
    app: c.env.APP_NAME ?? "FINANCE CLUB TERMINAL",
    phase: 5,
    serverTime: new Date().toISOString(),
    session: {
      state: clock.state,
      label: clock.label,
      authoritative: clock.authoritative,
      nextOpen: clock.nextOpen,
      nextClose: clock.nextClose,
    },
  });
});
