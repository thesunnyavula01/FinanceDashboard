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
 * ever. See CLAUDE.md for the rate-limit arithmetic.
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
}

export interface SecurityProfile {
  symbol: string;
  name: string | null;
  /** One of the 11 GICS sectors, or "ETF / Fund", or "Unclassified". */
  sector: string;
  /** The provider's own, finer-grained label, kept for display and debugging. */
  industry: string | null;
  assetType: "STOCK" | "ETF";
  logoUrl: string | null;
}

/** Prices, bars, the exchange calendar, and the tradable universe. */
export interface PriceProvider {
  readonly name: string;
  /** Batched. Symbols with no usable price are absent from the result. */
  quotes(symbols: string[]): Promise<Map<string, Quote>>;
  dailyBars(symbols: string[], query: BarQuery): Promise<Map<string, DailyBar[]>>;
  clock(): Promise<MarketClock>;
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
