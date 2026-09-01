import {
  MarketConfigError,
  MarketDataError,
  exchangeDate,
  type BarQuery,
  type CalendarDay,
  type DailyBar,
  type IntradayBar,
  type IntradayQuery,
  type MarketClock,
  type PriceProvider,
  type Quote,
  type SessionState,
  type TradableAsset,
} from "./provider.ts";

/**
 * Alpaca — every price in this app.
 *
 * Chosen for one reason: it batches. A hundred symbols go out in one request,
 * which is what keeps a club of a hundred members polling every 20 seconds
 * inside a 200 request/minute free tier. See CLAUDE.md for the arithmetic.
 *
 * Free-tier nuance that shapes the code below: `dailyBar` and `prevDailyBar`
 * in a snapshot are the full consolidated tape, identical to what paying
 * customers get. Only `latestTrade`, `latestQuote` and `minuteBar` are limited
 * to IEX's slice of volume. So the previous close and the day change are
 * exact; only the intraday last tick can trail on a thin name.
 */

const DATA_HOST = "https://data.alpaca.markets";
const TRADING_HOST = "https://paper-api.alpaca.markets";

/**
 * Symbols per snapshot request. The real limit is a ~16KB URL, which is well
 * over 1,000 tickers; 100 is a deliberately conservative round number that
 * keeps any single response small enough to parse cheaply inside a Worker.
 */
const SYMBOLS_PER_REQUEST = 100;

/** Pages of daily bars to follow before giving up. 10,000 bars is ~40 years. */
const MAX_BAR_PAGES = 10;

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  /** "iex" on the free plan, "sip" once someone is paying. */
  feed: string;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaTrade {
  t: string;
  p: number;
  s: number;
}

interface AlpacaQuote {
  t: string;
  ap: number;
  bp: number;
  as: number;
  bs: number;
}

export interface AlpacaSnapshot {
  latestTrade?: AlpacaTrade;
  latestQuote?: AlpacaQuote;
  minuteBar?: AlpacaBar;
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

interface AlpacaAsset {
  symbol: string;
  name?: string;
  exchange?: string;
  status?: string;
  tradable?: boolean;
  shortable?: boolean;
  fractionable?: boolean;
  easy_to_borrow?: boolean;
}

interface AlpacaClockResponse {
  timestamp?: string;
  is_open?: boolean;
  next_open?: string;
  next_close?: string;
}

interface AlpacaCalendarDay {
  date: string;
  open: string;
  close: string;
}

/**
 * Pink-sheet names are tradable on Alpaca but have no reliable quote and no
 * Finnhub profile, which makes them a bad fit for a teaching simulation. The
 * autocomplete only offers listed venues.
 */
const LISTED_EXCHANGES = new Set(["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS"]);

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Minutes past midnight, New York. */
function exchangeMinutes(at: Date): number {
  const parts = ET_TIME.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return (get("hour") % 24) * 60 + get("minute");
}

/** "09:30" -> 570. Returns null for anything that is not a wall-clock time. */
function parseClockTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const PRE_MARKET_OPENS = 4 * 60; // 04:00 ET
const AFTER_HOURS_ENDS = 20 * 60; // 20:00 ET

const SESSION_LABELS: Record<SessionState, string> = {
  OPEN: "Market open",
  PRE: "Pre-market",
  POST: "After hours",
  CLOSED: "Market closed",
};

/**
 * Turn one snapshot into a quote.
 *
 * Exported for tests, because the ordering below is the single most
 * error-prone thing in this file.
 *
 * The trap: `dailyBar` is *not* always today. Before the opening bell it still
 * holds the last completed session, and `prevDailyBar` holds the one before
 * that. Reading `prevDailyBar.c` as "yesterday's close" at 8am would therefore
 * be off by a whole session and every day-change figure on the dashboard would
 * be wrong. So the session date is checked first, and everything else follows
 * from it:
 *
 *   - During today's session, the latest print is the truth.
 *   - Outside it, the official close is the truth. Extended-hours prints on
 *     IEX are thin enough that letting one set an overnight valuation would
 *     make P/L jump for no real reason, and orders are rejected outside market
 *     hours anyway, so nothing is lost by ignoring them.
 */
export function quoteFromSnapshot(
  symbol: string,
  snapshot: AlpacaSnapshot,
  now: Date = new Date(),
): Quote | null {
  const { latestTrade, latestQuote, dailyBar, prevDailyBar } = snapshot;

  const dailyIsToday = Boolean(dailyBar && exchangeDate(dailyBar.t) === exchangeDate(now));

  // A midpoint is only meaningful with both sides quoted. Outside regular
  // hours IEX often publishes a one-sided or zeroed book, which would
  // otherwise halve the price.
  const midpoint =
    latestQuote && latestQuote.bp > 0 && latestQuote.ap > 0 && latestQuote.ap >= latestQuote.bp
      ? (latestQuote.bp + latestQuote.ap) / 2
      : null;

  const tradePrice = latestTrade && latestTrade.p > 0 ? latestTrade.p : null;
  const todayClose = dailyIsToday && dailyBar && dailyBar.c > 0 ? dailyBar.c : null;
  const lastSessionClose = !dailyIsToday && dailyBar && dailyBar.c > 0 ? dailyBar.c : null;
  const priorClose = prevDailyBar && prevDailyBar.c > 0 ? prevDailyBar.c : null;

  const candidates: Array<[number | null, Quote["source"], string | null]> = dailyIsToday
    ? [
        [tradePrice, "trade", latestTrade?.t ?? null],
        [midpoint, "quote", latestQuote?.t ?? null],
        [todayClose, "bar", dailyBar?.t ?? null],
        [priorClose, "prev-bar", prevDailyBar?.t ?? null],
      ]
    : [
        [lastSessionClose, "bar", dailyBar?.t ?? null],
        [priorClose, "prev-bar", prevDailyBar?.t ?? null],
        [tradePrice, "trade", latestTrade?.t ?? null],
        [midpoint, "quote", latestQuote?.t ?? null],
      ];

  const chosen = candidates.find(([price]) => price !== null);
  if (!chosen) return null;

  const [price, source, asOf] = chosen as [number, Quote["source"], string | null];

  // `prevDailyBar` is the session before `dailyBar` whichever one that is, so
  // it is the right baseline in both cases without a branch. During the
  // session that makes the day change today's move; outside it, the price is
  // the last close, so the same subtraction yields the last session's move —
  // which is what a member expects to see on a Saturday.
  const dayChange = priorClose === null ? null : price - priorClose;

  return {
    symbol,
    price,
    source,
    prevClose: priorClose,
    dayChange,
    dayChangePercent:
      dayChange === null || priorClose === null || priorClose === 0
        ? null
        : (dayChange / priorClose) * 100,
    dayOpen: dailyIsToday && dailyBar ? dailyBar.o : null,
    dayHigh: dailyIsToday && dailyBar ? dailyBar.h : null,
    dayLow: dailyIsToday && dailyBar ? dailyBar.l : null,
    dayVolume: dailyIsToday && dailyBar ? dailyBar.v : null,
    asOf,
  };
}

export class AlpacaProvider implements PriceProvider {
  readonly name = "alpaca";
  #config: AlpacaConfig;

  constructor(config: AlpacaConfig) {
    this.#config = config;
  }

  #headers(): HeadersInit {
    return {
      "APCA-API-KEY-ID": this.#config.keyId,
      "APCA-API-SECRET-KEY": this.#config.secretKey,
      accept: "application/json",
    };
  }

  async #get<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { headers: this.#headers() });
    } catch (cause) {
      throw new MarketDataError("alpaca", `Could not reach Alpaca: ${String(cause)}`, 502);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new MarketDataError(
        "alpaca",
        response.status === 429
          ? "Alpaca rate limit reached. Try again in a moment."
          : `Alpaca returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        response.status === 429 ? 429 : 502,
      );
    }

    return (await response.json()) as T;
  }

  async quotes(symbols: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    if (symbols.length === 0) return out;

    const now = new Date();
    const batches = chunk(symbols, SYMBOLS_PER_REQUEST);

    const responses = await Promise.all(
      batches.map((batch) => {
        const params = new URLSearchParams({
          symbols: batch.join(","),
          feed: this.#config.feed,
        });
        // Alpaca has shipped this payload both as a bare symbol map and
        // wrapped in `snapshots`. Accept either rather than break on a
        // provider-side change we cannot control.
        return this.#get<Record<string, unknown>>(
          `${DATA_HOST}/v2/stocks/snapshots?${params}`,
        );
      }),
    );

    for (const body of responses) {
      const wrapped = body.snapshots;
      const map = (
        wrapped && typeof wrapped === "object" ? wrapped : body
      ) as Record<string, AlpacaSnapshot>;

      for (const [symbol, snapshot] of Object.entries(map)) {
        if (!snapshot || typeof snapshot !== "object") continue;
        const quote = quoteFromSnapshot(symbol, snapshot, now);
        if (quote) out.set(symbol, quote);
      }
    }

    return out;
  }

  async dailyBars(symbols: string[], query: BarQuery): Promise<Map<string, DailyBar[]>> {
    const out = new Map<string, DailyBar[]>();
    if (symbols.length === 0) return out;

    for (const batch of chunk(symbols, SYMBOLS_PER_REQUEST)) {
      let pageToken: string | null = null;
      let page = 0;

      do {
        const params = new URLSearchParams({
          symbols: batch.join(","),
          timeframe: "1Day",
          start: query.start,
          // Split- and dividend-adjusted, so a curve drawn across a split does
          // not show a phantom 90% crash.
          adjustment: "all",
          feed: this.#config.feed,
          limit: String(Math.min(query.limit ?? 10_000, 10_000)),
        });
        if (query.end) params.set("end", query.end);
        if (pageToken) params.set("page_token", pageToken);

        const body: { bars?: Record<string, AlpacaBar[]>; next_page_token?: string | null } =
          await this.#get(`${DATA_HOST}/v2/stocks/bars?${params}`);

        for (const [symbol, bars] of Object.entries(body.bars ?? {})) {
          const mapped = bars.map((bar) => ({
            date: exchangeDate(bar.t),
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v,
          }));
          const existing = out.get(symbol);
          if (existing) existing.push(...mapped);
          else out.set(symbol, mapped);
        }

        pageToken = body.next_page_token ?? null;
        page += 1;
      } while (pageToken && page < MAX_BAR_PAGES);
    }

    return out;
  }

  /**
   * Bars inside a session, for the 1D chart.
   *
   * The same endpoint as `dailyBars` with a finer timeframe, and the same
   * paging, so a club whose members hold sixty symbols between them is still a
   * single request per hundred.
   *
   * Two free-tier facts shape the caller rather than this method. Intraday
   * bars come from the IEX feed, which is a slice of the tape rather than the
   * whole of it, so a thin name simply has no bar in some five-minute buckets —
   * the replay carries the last print forward instead of reading the gap as a
   * price. And unlike the daily bars, these are *not* the consolidated tape, so
   * they are right for drawing the shape of a day and wrong for anything that
   * settles money. Nothing in the order path touches them.
   */
  async intradayBars(
    symbols: string[],
    query: IntradayQuery,
  ): Promise<Map<string, IntradayBar[]>> {
    const out = new Map<string, IntradayBar[]>();
    if (symbols.length === 0) return out;

    for (const batch of chunk(symbols, SYMBOLS_PER_REQUEST)) {
      let pageToken: string | null = null;
      let page = 0;

      do {
        const params = new URLSearchParams({
          symbols: batch.join(","),
          timeframe: query.timeframe,
          start: query.start,
          adjustment: "all",
          feed: this.#config.feed,
          limit: String(Math.min(query.limit ?? 10_000, 10_000)),
        });
        if (query.end) params.set("end", query.end);
        if (pageToken) params.set("page_token", pageToken);

        const body: { bars?: Record<string, AlpacaBar[]>; next_page_token?: string | null } =
          await this.#get(`${DATA_HOST}/v2/stocks/bars?${params}`);

        for (const [symbol, bars] of Object.entries(body.bars ?? {})) {
          const mapped = bars.map((bar) => ({
            at: bar.t,
            date: exchangeDate(bar.t),
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v,
          }));
          const existing = out.get(symbol);
          if (existing) existing.push(...mapped);
          else out.set(symbol, mapped);
        }

        pageToken = body.next_page_token ?? null;
        page += 1;
      } while (pageToken && page < MAX_BAR_PAGES);
    }

    return out;
  }

  /**
   * Open or closed, straight from the exchange calendar.
   *
   * Alpaca's /v2/clock answers only for regular hours, so the calendar row for
   * today is fetched alongside it. That row is what separates "closed because
   * the session ended" from "closed because today is Thanksgiving", and it
   * carries the real open and close times, so a 13:00 half-day is handled
   * without a special case.
   */
  async clock(): Promise<MarketClock> {
    const now = new Date();
    const today = exchangeDate(now);

    const [clock, calendar] = await Promise.all([
      this.#get<AlpacaClockResponse>(`${TRADING_HOST}/v2/clock`),
      this.#get<AlpacaCalendarDay[]>(
        `${TRADING_HOST}/v2/calendar?start=${today}&end=${today}`,
      ).catch(() => [] as AlpacaCalendarDay[]),
    ]);

    const isOpen = clock.is_open === true;
    const tradingToday = calendar.find((day) => day.date === today) ?? null;
    const state = resolveSessionState(now, isOpen, tradingToday);

    return {
      state,
      isOpen,
      label: SESSION_LABELS[state],
      nextOpen: clock.next_open ?? null,
      nextClose: clock.next_close ?? null,
      authoritative: true,
    };
  }

  /**
   * The exchange calendar over a date range.
   *
   * `clock()` already reads one row of this to tell a holiday from an evening.
   * The 1D chart needs several, because it draws whichever session last
   * happened and that may be days ago — and it needs the hours, because a bar
   * feed does not distinguish 09:35 from 06:35 and this app has never counted
   * pre-market as the market being open.
   *
   * A day the exchange did not open is absent from the result rather than
   * present with zero hours, so "was there a session" and "when did it end" are
   * the same lookup.
   */
  async calendar(start: string, end: string): Promise<CalendarDay[]> {
    const days = await this.#get<AlpacaCalendarDay[]>(
      `${TRADING_HOST}/v2/calendar?start=${start}&end=${end}`,
    );

    const out: CalendarDay[] = [];
    for (const day of days) {
      const openMinute = parseClockTime(day.open);
      const closeMinute = parseClockTime(day.close);
      if (openMinute === null || closeMinute === null) continue;
      out.push({ date: day.date, openMinute, closeMinute });
    }

    return out;
  }

  async assets(): Promise<TradableAsset[]> {
    const body = await this.#get<AlpacaAsset[]>(
      `${TRADING_HOST}/v2/assets?status=active&asset_class=us_equity`,
    );

    const out: TradableAsset[] = [];
    for (const asset of body) {
      if (!asset.tradable) continue;
      if (!asset.exchange || !LISTED_EXCHANGES.has(asset.exchange)) continue;

      out.push({
        symbol: asset.symbol,
        name: asset.name ?? asset.symbol,
        exchange: asset.exchange,
        fractionable: asset.fractionable === true,
        shortable: asset.shortable === true,
        easyToBorrow: asset.easy_to_borrow === true,
      });
    }
    return out;
  }
}

/**
 * Exported for tests. Splits "closed" into the three states a member actually
 * cares about, using today's calendar row as the arbiter of whether the market
 * was ever going to trade today at all.
 */
export function resolveSessionState(
  now: Date,
  isOpen: boolean,
  tradingToday: { open: string; close: string } | null,
): SessionState {
  if (isOpen) return "OPEN";
  if (!tradingToday) return "CLOSED";

  const minutes = exchangeMinutes(now);
  const opensAt = parseClockTime(tradingToday.open);
  const closesAt = parseClockTime(tradingToday.close);
  if (opensAt === null || closesAt === null) return "CLOSED";

  if (minutes >= PRE_MARKET_OPENS && minutes < opensAt) return "PRE";
  if (minutes >= closesAt && minutes < AFTER_HOURS_ENDS) return "POST";
  return "CLOSED";
}

/**
 * Build a provider from the environment, or explain what is missing.
 *
 * Every route calls this rather than reading the keys itself, so a missing
 * secret produces one consistent 503 with an actionable message instead of a
 * 500 from a fetch against `undefined`.
 */
export function alpacaFromEnv(env: {
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
}): AlpacaProvider {
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) {
    throw new MarketConfigError(
      "Market data is not configured. Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY.",
    );
  }

  return new AlpacaProvider({
    keyId: env.ALPACA_API_KEY_ID,
    secretKey: env.ALPACA_API_SECRET_KEY,
    feed: env.ALPACA_DATA_FEED || "iex",
  });
}
