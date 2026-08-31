import { alpacaFromEnv } from "./alpaca.ts";
import { MarketConfigError, type MarketClock } from "./provider.ts";
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
