import { Hono } from "hono";
import type { AppBindings } from "../types";
import { estimateSession } from "../market/session";

export const health = new Hono<AppBindings>();

/**
 * Liveness plus market session. The dashboard polls this for the status rail,
 * which doubles as the proof that the SPA and the Worker are talking to each
 * other — if this route stops answering, the rail says so.
 */
health.get("/", (c) => {
  const session = estimateSession();

  return c.json({
    ok: true,
    app: c.env.APP_NAME ?? "FINANCE CLUB TERMINAL",
    phase: 1,
    serverTime: new Date().toISOString(),
    session,
  });
});
