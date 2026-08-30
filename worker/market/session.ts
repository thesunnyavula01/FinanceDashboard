/**
 * Market session estimate.
 *
 * TEMPORARY. This reads New York wall-clock time and knows nothing about
 * holidays or half-days, so it will happily report OPEN on Thanksgiving.
 *
 * Phase 3 replaces it with Alpaca's /v2/clock, which is authoritative and free.
 * Until then every response carries `authoritative: false` so the UI can label
 * the estimate honestly rather than quietly showing a wrong answer.
 */

export type SessionState = "OPEN" | "CLOSED" | "PRE" | "POST";

export interface Session {
  state: SessionState;
  label: string;
  authoritative: boolean;
}

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Minutes past midnight in New York, plus the weekday. */
function newYorkClock(at: Date): { minutes: number; weekday: string } {
  const parts = NY_PARTS.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";

  // Intl renders midnight as "24" in some ICU builds with hour12:false.
  const hour = Number(get("hour")) % 24;
  return {
    minutes: hour * 60 + Number(get("minute")),
    weekday: get("weekday"),
  };
}

const OPEN_AT = 9 * 60 + 30; // 09:30 ET
const CLOSE_AT = 16 * 60; // 16:00 ET
const PRE_AT = 4 * 60; // 04:00 ET
const POST_UNTIL = 20 * 60; // 20:00 ET

export function estimateSession(at: Date = new Date()): Session {
  const { minutes, weekday } = newYorkClock(at);
  const isWeekend = weekday === "Sat" || weekday === "Sun";

  if (isWeekend) {
    return { state: "CLOSED", label: "Market closed", authoritative: false };
  }
  if (minutes >= OPEN_AT && minutes < CLOSE_AT) {
    return { state: "OPEN", label: "Market open", authoritative: false };
  }
  if (minutes >= PRE_AT && minutes < OPEN_AT) {
    return { state: "PRE", label: "Pre-market", authoritative: false };
  }
  if (minutes >= CLOSE_AT && minutes < POST_UNTIL) {
    return { state: "POST", label: "After hours", authoritative: false };
  }
  return { state: "CLOSED", label: "Market closed", authoritative: false };
}
