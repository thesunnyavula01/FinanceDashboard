/**
 * The market-data seam.
 *
 * Everything above this file — routes, the trading engine, the analytics
 * layer — speaks only in these types. Alpaca and Finnhub sit behind it, and
 * swapping either for a paid feed later means writing one new file that
 * implements one of these interfaces, not touching call sites.
 *
 * Two providers exist on purpose, and the split is about batching, not
 * features: Alpaca returns 100+ symbols per HTTP call, Finnhub returns one.
 * Prices are polled every 20 seconds; sectors are fetched once per ticker
 * ever. See DIRECTIONS.MD for the rate-limit arithmetic.
 */

export type SessionState = "OPEN" | "CLOSED" | "PRE" | "POST";

/**
 * Which field a quote's price actually came from. Carried all the way to the
 * UI because it is the difference between a live print and yesterday's close,
 * and a member looking at a P/L number deserves to know which one they have.
 */
export type PriceSource = "trade" | "quote" | "bar" | "prev-bar";

export interface Quote {
  symbol: string;
  /** Best available price, in dollars. Never zero — a symbol with no usable
   *  price is omitted from the result rather than reported as free. */
  price: number;
  source: PriceSource;
  /** Previous session's official close, the denominator of every day change. */
  prevClose: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  /** Today's bar. Null before the first print of the session. */
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  /** When the market printed this, not when we fetched it. */
  asOf: string | null;
}

export interface DailyBar {
  /** YYYY-MM-DD in exchange-local terms. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarQuery {
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  /** Inclusive, YYYY-MM-DD. Defaults to today. */
  end?: string;
  /** Hard ceiling on bars per symbol, mostly a guard against runaway paging. */
  limit?: number;
}

/**
 * One bar inside a session.
 *
 * Carries both the instant it opened and the session it belongs to, because
 * the two answer different questions and re-deriving one from the other at
 * every call site is how a chart ends up putting 16:00 on the wrong day. `at`
 * is the provider's own timestamp, verbatim, so it works as a map key that
 * lines up across symbols.
 */
export interface IntradayBar {
  /** RFC-3339 instant at the start of the bar, exactly as the provider sent it. */
  at: string;
  /** Exchange-local session date, YYYY-MM-DD. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type BarTimeframe = "1Min" | "5Min" | "15Min";

/**
 * One session on the exchange calendar, in minutes past midnight ET.
 *
 * The 1D chart's bounds. Intraday bars arrive with pre-market and after-hours
 * buckets in them, and this app has never treated those as the market being
 * open — a quote does not come from them and an order cannot reach them, so a
 * chart must not draw them either. Minutes rather than "09:30" because the only
 * thing anyone does with these is compare, and a half day closing at 780 rather
 * than 960 then needs no special case anywhere.
 */
export interface CalendarDay {
  /** YYYY-MM-DD. */
  date: string;
  /** 570 on an ordinary day: 09:30 ET. */
  openMinute: number;
  /** 960 on an ordinary day, 780 on a half day: 16:00 and 13:00 ET. */
  closeMinute: number;
}

/** The regular session, when the exchange calendar cannot be reached. */
export const DEFAULT_SESSION: Omit<CalendarDay, "date"> = {
  openMinute: 9 * 60 + 30,
  closeMinute: 16 * 60,
};

export interface IntradayQuery {
  /** Inclusive. YYYY-MM-DD, or an RFC-3339 instant. */
  start: string;
  /** Omit for "up to now", which is what an intraday chart always wants. */
  end?: string;
  timeframe: BarTimeframe;
  /** Hard ceiling on bars per request, mostly a guard against runaway paging. */
  limit?: number;
}

export interface MarketClock {
  state: SessionState;
  /** Regular trading hours only. Pre-market and after-hours are not "open". */
  isOpen: boolean;
  label: string;
  nextOpen: string | null;
  nextClose: string | null;
  /**
   * True when this came from the exchange calendar, so it knows about
   * holidays and half-days. False when it is a guess from New York wall-clock
   * hours, which the UI labels as an estimate rather than quietly showing a
   * wrong answer on Thanksgiving.
   */
  authoritative: boolean;
}

export interface TradableAsset {
  symbol: string;
  name: string;
  exchange: string;
  fractionable: boolean;
  shortable: boolean;
  easyToBorrow: boolean;
  /**
   * The smallest order the venue will take, where the venue says. Alpaca
   * publishes it per crypto pair and not at all for equities, where one share
   * is the floor and `fractionable` already carries that.
   */
  minOrderSize?: number;
}

export interface SecurityProfile {
  symbol: string;
  name: string | null;
  /** One of the 11 GICS sectors, or "ETF / Fund", or "Unclassified". */
  sector: string;
  /** The provider's own, finer-grained label, kept for display and debugging. */
  industry: string | null;
  assetType: "STOCK" | "ETF" | "CRYPTO" | "OPTION";
  logoUrl: string | null;
}

/** Prices, bars, the exchange calendar, and the tradable universe. */
export interface PriceProvider {
  readonly name: string;
  /** Batched. Symbols with no usable price are absent from the result. */
  quotes(symbols: string[]): Promise<Map<string, Quote>>;
  dailyBars(symbols: string[], query: BarQuery): Promise<Map<string, DailyBar[]>>;
  /** Bars inside a session, for the 1D chart. Batched like everything else. */
  intradayBars(symbols: string[], query: IntradayQuery): Promise<Map<string, IntradayBar[]>>;
  clock(): Promise<MarketClock>;
  /** Which days the exchange held a session, and the hours it kept. */
  calendar(start: string, end: string): Promise<CalendarDay[]>;
  assets(): Promise<TradableAsset[]>;
}

/** Company fundamentals. One symbol per call, so callers must cache forever. */
export interface ProfileProvider {
  readonly name: string;
  /** Null when the provider has never heard of the symbol. */
  profile(symbol: string): Promise<SecurityProfile | null>;
}

/** An upstream provider answered with an error, or did not answer at all. */
export class MarketDataError extends Error {
  status: number;
  provider: string;

  constructor(provider: string, message: string, status = 502) {
    super(message);
    this.name = "MarketDataError";
    this.provider = provider;
    this.status = status;
  }
}

/** A required API key is missing. Routes turn this into 503, not 500. */
export class MarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketConfigError";
  }
}

/**
 * Turn a provider failure into something a route can return.
 *
 * A missing API key is 503 and says which key. An upstream rate limit is 429
 * so the client backs off instead of retrying immediately. Everything else is
 * 502: the failure is upstream, not in the request, and the member should be
 * told to try again rather than shown a stack trace.
 */
export function describeMarketError(err: unknown): { message: string; status: 429 | 502 | 503 } {
  if (err instanceof MarketConfigError) return { message: err.message, status: 503 };
  if (err instanceof MarketDataError) {
    return { message: err.message, status: err.status === 429 ? 429 : 502 };
  }
  return { message: "Market data is temporarily unavailable.", status: 502 };
}

const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The exchange's calendar date for an instant, as YYYY-MM-DD.
 *
 * Used to decide whether a "daily bar" belongs to the session in progress or
 * to the last one that finished — the single most error-prone part of reading
 * a snapshot, because before the opening bell the field still holds yesterday.
 */
export function exchangeDate(at: Date | string | number = new Date()): string {
  const date = at instanceof Date ? at : new Date(at);
  return ET_DATE.format(date);
}

const ET_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * The exchange's wall-clock time for an instant, as HH:MM.
 *
 * This is the 1D chart's x-axis, and it is formatted here rather than in the
 * browser on purpose: a member opening the terminal from a different timezone
 * must still see the session run 09:30 to 16:00. The market's hours are the
 * market's, not the viewer's.
 */
export function exchangeTime(at: Date | string | number = new Date()): string {
  const date = at instanceof Date ? at : new Date(at);
  const parts = ET_CLOCK.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return `${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}`;
}
