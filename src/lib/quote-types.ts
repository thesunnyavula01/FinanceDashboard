/** Price payload types without browser auth dependencies; also used in tests. */
export interface Quote {
  symbol: string;
  price: number;
  source: "trade" | "quote" | "bar" | "prev-bar";
  prevClose: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  /** When the market printed this price. */
  asOf: string | null;
  /** Display fallback only; never an execution price. */
  stale?: boolean;
  /** Last successful observation, preserved across failed refreshes. */
  receivedAt?: string;
}

export interface QuotesResponse {
  quotes: Record<string, Quote>;
  unknown: string[];
  rejected: string[];
  asOf: string;
  cache: { memory: number; edge: number; fetched: number };
  limit: number;
}
