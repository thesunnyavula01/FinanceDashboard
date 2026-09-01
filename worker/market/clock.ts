import { alpacaFromEnv } from "./alpaca.ts";
import { MarketConfigError, type CalendarDay, type MarketClock } from "./provider.ts";
import { estimateSession } from "./session.ts";

/**
 * The market clock, cached and never allowed to fail.
 *
 * Whether the market is open decides whether an order is accepted, so this is
 * on the hot path of both the status rail and every trade. It is also the same
 * answer for every member in the club for the next several seconds, so it is
 * cached in isolate memory rather than fetched per request.
 *
 * When Alpaca is unreachable or unconfigured it degrades to the New York
 * wall-clock estimate with `authoritative: false`, which the UI labels as an
 * estimate. Phase 4 will refuse to execute an order on a non-authoritative
 * clock — guessing that the market is open is a much worse failure than
 * telling a member to try again in a minute.
 */

const TTL_MS = 30_000;

let cached: { clock: MarketClock; at: number } | null = null;

interface ClockEnv {
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
}

function estimated(): MarketClock {
  const session = estimateSession();
  return {
    state: session.state,
    isOpen: session.state === "OPEN",
    label: session.label,
    nextOpen: null,
    nextClose: null,
    authoritative: false,
  };
}

export async function marketClock(env: ClockEnv): Promise<MarketClock> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.clock;

  try {
    const clock = await alpacaFromEnv(env).clock();
    cached = { clock, at: Date.now() };
    return clock;
  } catch (err) {
    if (!(err instanceof MarketConfigError)) {
      console.error("Market clock unavailable, falling back to estimate:", err);
    }
    // Deliberately not cached: an estimate should be replaced by the real
    // thing the moment Alpaca answers again.
    return estimated();
  }
}

/**
 * The exchange calendar over a range, cached for an hour.
 *
 * A much longer TTL than the clock's thirty seconds, and it should be: the
 * clock changes twice a day, but which days the exchange opened and when it
 * closed is settled history for every date but today, and today's row is fixed
 * before the bell. An hour costs at most one request per isolate per hour and
 * is never wrong.
 *
 * Returned as a map because every caller is asking "what were the hours on this
 * date", and a date the exchange did not open is simply absent.
 *
 * Failure is empty, not an error. The 1D chart falls back to regular hours,
 * which is right on every day but the three half days a year — a worse answer
 * than the calendar's and a much better one than no chart.
 */
const CALENDAR_TTL_MS = 60 * 60_000;

let calendarCache: { key: string; days: Map<string, CalendarDay>; at: number } | null = null;

export async function marketCalendar(
  env: ClockEnv,
  start: string,
  end: string,
): Promise<Map<string, CalendarDay>> {
  const key = `${start}/${end}`;
  if (calendarCache && calendarCache.key === key && Date.now() - calendarCache.at < CALENDAR_TTL_MS) {
    return calendarCache.days;
  }

  try {
    const days = new Map(
      (await alpacaFromEnv(env).calendar(start, end)).map((day) => [day.date, day]),
    );
    calendarCache = { key, days, at: Date.now() };
    return days;
  } catch (err) {
    if (!(err instanceof MarketConfigError)) {
      console.error("Exchange calendar unavailable:", err);
    }
    // Deliberately not cached, for the same reason an estimated clock is not.
    return new Map();
  }
}

/** Drops the cached calendar. Tests only. */
export function forgetCalendar(): void {
  calendarCache = null;
}
