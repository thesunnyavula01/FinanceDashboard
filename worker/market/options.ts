import {
  MarketDataError,
  exchangeDate,
  type BarQuery,
  type DailyBar,
  type Quote,
} from "./provider.ts";
import { OPTION_MULTIPLIER, parseContract, underlyingOf } from "./symbols.ts";
import type { AlpacaConfig } from "./alpaca.ts";

/**
 * Alpaca options — v1beta1 data, v2 contracts.
 *
 * Enabled on the same paper key as everything else, with no extra subscription.
 * Prices come from `/v1beta1/options/snapshots` in the same shape the stock and
 * crypto adapters read; contract metadata comes from `/v2/options/contracts` on
 * the trading host, where every numeric arrives as a string.
 *
 * Four things about this feed were settled by calling it, and each one changes
 * the code rather than just the comments.
 *
 * **There are no greeks and no implied volatility on this key.** Not a missing
 * parameter: the fields are absent under the default feed and under
 * `feed=indicative`, and `feed=opra` answers 403 "OPRA agreement is not
 * signed". So the chain shows bid, ask, last and open interest, and nothing
 * pretends to a Δ it cannot compute. Adding those columns back needs a signed
 * OPRA agreement first, not a code change.
 *
 * **The midpoint beats the last print, inverting the equity rule.** On the
 * indicative feed the quote is live and the trade is not — a real contract in
 * this book quoted at 19:59:59Z with a print from 15:17Z, four hours stale. The
 * stock adapter prefers `latestTrade` because IEX prints are real and current;
 * here that same preference would settle a paper fill against lunchtime. So
 * `quoteFromOptionSnapshot()` reads the two-sided midpoint first, and keeps the
 * same uncrossed-book guard, which matters more on a chain than anywhere else:
 * option books are one-sided all day on the far wings.
 *
 * **One expiry is one request.** A whole AAPL chain is tens of thousands of
 * contracts; a single expiration is ~200 and comes back with a null page token
 * at `limit=1000`. That is why nothing here ever fetches "the chain" — it
 * fetches one expiration, which is also the only thing a member can look at.
 *
 * **`expiration_date_lte` defaults to next weekend.** Omit it and a request for
 * a year of expirations returns this Friday's, which looks like a working
 * endpoint returning a thin underlying. Every contracts call below sets the
 * range explicitly.
 *
 * `clock()`, `calendar()` and `assets()` are deliberately absent — options
 * follow the equity session and the equity calendar, and their universe is far
 * too large for the KV list. `router.ts` is what makes a whole `PriceProvider`
 * out of this and the stock adapter.
 */

const DATA_HOST = "https://data.alpaca.markets";
const TRADING_HOST = "https://paper-api.alpaca.markets";

/** Contracts per snapshot request. The URL is the only real ceiling. */
const SYMBOLS_PER_REQUEST = 100;

/** Rows per contracts page. One expiry fits inside this on every underlying. */
const CONTRACTS_LIMIT = 1000;

/** Pages to follow before giving up, for the calls that can page. */
const MAX_PAGES = 5;

/**
 * How far either side of spot to look when listing expirations.
 *
 * The expiration rail needs the *dates*, not the strikes, so it asks for one
 * narrow band of strikes across a long date range rather than every contract
 * across a short one. ±8% of spot catches at least one listed strike on every
 * expiration including LEAPS, where strikes are $10 apart, and keeps the answer
 * to a few dozen rows instead of tens of thousands.
 */
const EXPIRY_BAND = 0.08;

/** How far ahead to list expirations. Beyond this is not a school-club trade. */
const EXPIRY_HORIZON_DAYS = 400;

interface OptionBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface OptionTrade {
  t: string;
  p: number;
  s: number;
}

interface OptionQuote {
  t: string;
  ap: number;
  bp: number;
  as: number;
  bs: number;
}

export interface OptionSnapshot {
  latestTrade?: OptionTrade;
  latestQuote?: OptionQuote;
  minuteBar?: OptionBar;
  dailyBar?: OptionBar;
  prevDailyBar?: OptionBar;
}

/** One contract, as `/v2/options/contracts` describes it. */
export interface ContractMeta {
  symbol: string;
  underlying: string;
  expiration: string;
  type: "CALL" | "PUT";
  strike: number;
  /** Shares per contract. 100 except after a split, which is why it is read. */
  multiplier: number;
  openInterest: number | null;
  tradable: boolean;
}

/** One row of the chain: the contract, plus whatever it is worth right now. */
export interface ChainQuote extends ContractMeta {
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** The mark an order would fill against — the midpoint where there is one. */
  mark: number | null;
}

interface RawContract {
  symbol?: string;
  underlying_symbol?: string;
  expiration_date?: string;
  type?: string;
  strike_price?: string;
  multiplier?: string;
  size?: string;
  open_interest?: string;
  tradable?: boolean;
  status?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A decimal string from Alpaca. Contracts send every number as text. */
function decimal(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * A date `offsetDays` from today, counted on the exchange calendar.
 *
 * `new Date().toISOString()` would count in UTC, which is a different day for
 * the five hours after 19:00 ET — so all evening the "from today" bound would
 * silently mean tomorrow, and today's expiry would vanish from the rail. An
 * expiration list is exactly where that kind of off-by-one hides: nineteen
 * dates where there should be twenty reads as a thin underlying, not as a bug.
 */
function isoDate(offsetDays: number): string {
  const at = new Date(`${exchangeDate()}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + offsetDays);
  return at.toISOString().slice(0, 10);
}

/**
 * A snapshot to a quote, with the midpoint promoted over the print.
 *
 * The session branch is kept — options follow the equity calendar, so an
 * after-hours quote must not move an overnight valuation any more than an
 * after-hours IEX trade may — but inside the session the order is
 * midpoint → print → today's close, rather than the stock adapter's
 * print → midpoint → close. See the header for why.
 *
 * Exported for tests.
 */
export function quoteFromOptionSnapshot(
  symbol: string,
  snapshot: OptionSnapshot,
  today = exchangeDate(),
): Quote | null {
  const { latestTrade, latestQuote, dailyBar, prevDailyBar } = snapshot;

  // Both sides quoted and uncrossed, or nothing. A chain publishes one-sided
  // books on the wings all day, and averaging a real offer against a zero bid
  // halves the premium on exactly the contracts nobody is watching.
  const midpoint =
    latestQuote && latestQuote.bp > 0 && latestQuote.ap > 0 && latestQuote.ap >= latestQuote.bp
      ? (latestQuote.bp + latestQuote.ap) / 2
      : null;

  const tradePrice = latestTrade && latestTrade.p > 0 ? latestTrade.p : null;

  // The same trap the stock adapter documents: before the bell `dailyBar` still
  // holds the last completed session, so "today's close" has to be checked
  // against the calendar rather than assumed.
  const dailyIsToday = dailyBar !== undefined && exchangeDate(dailyBar.t) === today;
  const todayClose = dailyIsToday && dailyBar.c > 0 ? dailyBar.c : null;
  const priorClose = dailyIsToday
    ? prevDailyBar && prevDailyBar.c > 0
      ? prevDailyBar.c
      : null
    : dailyBar && dailyBar.c > 0
      ? dailyBar.c
      : null;

  const candidates: Array<[number | null, Quote["source"], string | null]> = dailyIsToday
    ? [
        [midpoint, "quote", latestQuote?.t ?? null],
        [tradePrice, "trade", latestTrade?.t ?? null],
        [todayClose, "bar", dailyBar?.t ?? null],
        [priorClose, "prev-bar", prevDailyBar?.t ?? null],
      ]
    : // Outside the session the official close is the price and the live book is
      // ignored, exactly as it is for a stock. An order cannot reach this
      // contract now anyway.
      [
        [priorClose, "bar", dailyBar?.t ?? null],
        [midpoint, "quote", latestQuote?.t ?? null],
      ];

  const chosen = candidates.find(([price]) => price !== null);
  if (!chosen) return null;

  const [price, source, asOf] = chosen as [number, Quote["source"], string | null];
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
    dayOpen: dailyIsToday ? dailyBar.o : null,
    dayHigh: dailyIsToday ? dailyBar.h : null,
    dayLow: dailyIsToday ? dailyBar.l : null,
    dayVolume: dailyIsToday ? dailyBar.v : null,
    asOf,
  };
}

/**
 * A contracts row to a `ContractMeta`, or null if it is not usable.
 *
 * Everything is validated against the OCC symbol rather than trusted from the
 * payload, because the symbol is what settles the money: a row whose
 * `strike_price` disagreed with its own symbol would misprice an expiry.
 *
 * Exported for tests.
 */
export function toContractMeta(raw: RawContract): ContractMeta | null {
  const symbol = raw.symbol?.trim().toUpperCase();
  if (!symbol) return null;

  const parsed = parseContract(symbol);
  if (!parsed) return null;

  const multiplier = decimal(raw.multiplier) ?? decimal(raw.size) ?? OPTION_MULTIPLIER;

  return {
    symbol: parsed.symbol,
    underlying: parsed.underlying,
    expiration: parsed.expiration,
    type: parsed.type,
    strike: parsed.strike,
    multiplier: multiplier > 0 ? multiplier : OPTION_MULTIPLIER,
    openInterest: decimal(raw.open_interest),
    // `status` is "active" on everything the query asked for; `tradable` is the
    // field that goes false on a contract in a halted or delisted underlying.
    tradable: raw.tradable !== false && (raw.status ?? "active") === "active",
  };
}

export class AlpacaOptionsProvider {
  readonly name = "alpaca-options";
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
      throw new MarketDataError("alpaca-options", `Could not reach Alpaca: ${String(cause)}`, 502);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new MarketDataError(
        "alpaca-options",
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

    const today = exchangeDate();
    const responses = await Promise.all(
      chunk(symbols, SYMBOLS_PER_REQUEST).map((batch) => {
        const params = new URLSearchParams({ symbols: batch.join(",") });
        return this.#get<{ snapshots?: Record<string, OptionSnapshot> }>(
          `${DATA_HOST}/v1beta1/options/snapshots?${params}`,
        );
      }),
    );

    for (const body of responses) {
      for (const [symbol, snapshot] of Object.entries(body.snapshots ?? {})) {
        if (!snapshot || typeof snapshot !== "object") continue;
        const quote = quoteFromOptionSnapshot(symbol, snapshot, today);
        if (quote) out.set(symbol, quote);
      }
    }

    return out;
  }

  async dailyBars(symbols: string[], query: BarQuery): Promise<Map<string, DailyBar[]>> {
    const out = new Map<string, DailyBar[]>();
    if (symbols.length === 0) return out;

    for (const batch of chunk(symbols, SYMBOLS_PER_REQUEST)) {
      let token: string | null = null;
      let page = 0;

      do {
        const params = new URLSearchParams({
          symbols: batch.join(","),
          timeframe: "1Day",
          start: query.start,
        });
        if (query.end) params.set("end", query.end);
        if (query.limit) params.set("limit", String(query.limit));
        if (token) params.set("page_token", token);

        const body: { bars?: Record<string, OptionBar[]>; next_page_token?: string | null } =
          await this.#get(`${DATA_HOST}/v1beta1/options/bars?${params}`);

        for (const [symbol, rows] of Object.entries(body.bars ?? {})) {
          const mapped = rows.map((bar) => ({
            // 04:00Z is exchange midnight, so unlike a crypto bar this one reads
            // correctly through the calendar.
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

        token = body.next_page_token ?? null;
      } while (token && ++page < MAX_PAGES);
    }

    return out;
  }

  /**
   * Every contract in one expiration of one underlying.
   *
   * One request: ~200 rows for a liquid name, and Alpaca returns a null page
   * token at `limit=1000`. The paging loop is kept for the handful of
   * underlyings that list more, not because the common case needs it.
   */
  async contracts(underlying: string, expiration: string): Promise<ContractMeta[]> {
    const out: ContractMeta[] = [];
    let token: string | null = null;
    let page = 0;

    do {
      const params = new URLSearchParams({
        underlying_symbols: underlying.trim().toUpperCase(),
        status: "active",
        expiration_date: expiration,
        limit: String(CONTRACTS_LIMIT),
      });
      if (token) params.set("page_token", token);

      const body: { option_contracts?: RawContract[]; next_page_token?: string | null } =
        await this.#get(`${TRADING_HOST}/v2/options/contracts?${params}`);

      for (const raw of body.option_contracts ?? []) {
        const meta = toContractMeta(raw);
        if (meta) out.push(meta);
      }

      token = body.next_page_token ?? null;
    } while (token && ++page < MAX_PAGES);

    return out.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
  }

  /**
   * The expirations a member can pick from, soonest first.
   *
   * Asked as one narrow band of strikes across a long date range rather than
   * the other way round — the rail wants dates, and a whole underlying's
   * contracts is a five-figure payload. `spot` narrows the band; without it the
   * band is dropped and the horizon shortened, which still answers but costs
   * more.
   */
  async expirations(underlying: string, spot: number | null): Promise<string[]> {
    const params = new URLSearchParams({
      underlying_symbols: underlying.trim().toUpperCase(),
      status: "active",
      // One side is enough: a listed expiration lists both.
      type: "call",
      expiration_date_gte: isoDate(0),
      // Without this the API answers with next weekend only, which reads as a
      // thin underlying rather than as a missing parameter.
      expiration_date_lte: isoDate(spot === null ? 120 : EXPIRY_HORIZON_DAYS),
      limit: String(CONTRACTS_LIMIT),
    });

    if (spot !== null && spot > 0) {
      params.set("strike_price_gte", (spot * (1 - EXPIRY_BAND)).toFixed(2));
      params.set("strike_price_lte", (spot * (1 + EXPIRY_BAND)).toFixed(2));
    }

    const body: { option_contracts?: RawContract[] } = await this.#get(
      `${TRADING_HOST}/v2/options/contracts?${params}`,
    );

    const dates = new Set<string>();
    for (const raw of body.option_contracts ?? []) {
      if (raw.expiration_date) dates.add(raw.expiration_date);
    }

    return [...dates].sort();
  }

  /**
   * One expiration, priced. This is the chain panel's whole payload.
   *
   * Two upstream calls, deliberately: the contracts endpoint is the only source
   * of open interest and of the multiplier, and the data endpoint is the only
   * source of a price. Neither carries the other's fields.
   */
  async chain(underlying: string, expiration: string): Promise<ChainQuote[]> {
    const metas = await this.contracts(underlying, expiration);
    if (metas.length === 0) return [];

    const today = exchangeDate();
    const prices = new Map<string, OptionSnapshot>();

    // The chain is fetched by underlying rather than by symbol list: it is one
    // request per expiration instead of three, and the server-side filter is
    // the same one the contracts call just used.
    const params = new URLSearchParams({
      expiration_date: expiration,
      limit: String(CONTRACTS_LIMIT),
    });
    const body = await this.#get<{ snapshots?: Record<string, OptionSnapshot> }>(
      `${DATA_HOST}/v1beta1/options/snapshots/${encodeURIComponent(
        underlying.trim().toUpperCase(),
      )}?${params}`,
    );
    for (const [symbol, snapshot] of Object.entries(body.snapshots ?? {})) {
      if (snapshot && typeof snapshot === "object") prices.set(symbol, snapshot);
    }

    return metas.map((meta) => {
      const snapshot = prices.get(meta.symbol);
      const quote = snapshot ? quoteFromOptionSnapshot(meta.symbol, snapshot, today) : null;
      const bid = snapshot?.latestQuote?.bp;
      const ask = snapshot?.latestQuote?.ap;
      const last = snapshot?.latestTrade?.p;

      return {
        ...meta,
        bid: bid !== undefined && bid > 0 ? bid : null,
        ask: ask !== undefined && ask > 0 ? ask : null,
        last: last !== undefined && last > 0 ? last : null,
        mark: quote?.price ?? null,
      };
    });
  }

  /**
   * Contract metadata for one OCC symbol, for the orders route.
   *
   * `lookupSymbol()` cannot answer this — the option universe is hundreds of
   * thousands of contracts and is not in KV. This is the validation path
   * instead: the symbol parses, the contract exists, and it is tradable.
   */
  async contract(symbol: string): Promise<ContractMeta | null> {
    const parsed = parseContract(symbol);
    if (!parsed) return null;

    const underlying = underlyingOf(parsed.symbol);
    if (!underlying) return null;

    const all = await this.contracts(underlying, parsed.expiration);
    return all.find((meta) => meta.symbol === parsed.symbol) ?? null;
  }
}
