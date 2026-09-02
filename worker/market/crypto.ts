import {
  MarketDataError,
  exchangeDate,
  type BarQuery,
  type DailyBar,
  type IntradayBar,
  type IntradayQuery,
  type Quote,
  type TradableAsset,
} from "./provider.ts";
import type { AlpacaConfig } from "./alpaca.ts";

/**
 * Alpaca crypto — v1beta3.
 *
 * Free on the same Basic key the equity side uses, with no `feed` parameter and
 * no separate subscription: crypto sits outside the market-data plan entirely.
 * The snapshot payload is shaped like the stock one — `latestTrade`,
 * `latestQuote`, `minuteBar`, `dailyBar`, `prevDailyBar` — which is why this
 * file is short.
 *
 * Three things genuinely differ, and each is handled below rather than
 * papered over.
 *
 * **There is no session.** No calendar, no holidays, no bell. So the whole
 * `dailyIsToday` dance in `quoteFromSnapshot` — which exists to stop a thin
 * after-hours print setting an overnight valuation — has nothing to protect
 * against here. The latest trade is simply the price, always.
 *
 * **The daily bar rolls at midnight UTC, and that is not the exchange day.**
 * Alpaca documents 05:00Z in a snapshot example from the v1beta1 era, which
 * would have made `exchangeDate()` right. The live v1beta3 feed stamps 00:00Z,
 * which `exchangeDate()` reads as 20:00 the previous evening — every crypto
 * close a day early, silently. So a crypto daily bar is dated from its own UTC
 * timestamp and nothing else. This was settled by calling the API, not by
 * reading about it, and `crypto.test.ts` calls it again on every run.
 *
 * **A bar can be built from quotes.** If no trade printed in a bucket, volume
 * is zero but the OHLC still carries the quote mid. So volume is never used as
 * a proxy for "did this trade".
 *
 * `clock()`, `calendar()` and `intradayBars()` are deliberately absent — this
 * is not a `PriceProvider`. It is one half of one, and `router.ts` is what
 * makes a whole one out of it and the equity provider.
 */

const DATA_HOST = "https://data.alpaca.markets";
const TRADING_HOST = "https://paper-api.alpaca.markets";

/**
 * Alpaca's own venue set. The alternatives (`us-1` Kraken US, `eu-1` Kraken EU)
 * are different books, and mixing them would mean a position marked on one
 * exchange and filled against another.
 */
const LOCATION = "us";

/** Pairs per request. Bounded only by URL length, but a round number is kind. */
const SYMBOLS_PER_REQUEST = 50;

/** Pages of bars to follow before giving up. */
const MAX_BAR_PAGES = 10;

interface CryptoBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CryptoTrade {
  t: string;
  p: number;
  s: number;
}

interface CryptoQuote {
  t: string;
  ap: number;
  bp: number;
  as: number;
  bs: number;
}

export interface CryptoSnapshot {
  latestTrade?: CryptoTrade;
  latestQuote?: CryptoQuote;
  minuteBar?: CryptoBar;
  dailyBar?: CryptoBar;
  prevDailyBar?: CryptoBar;
}

interface CryptoAsset {
  symbol: string;
  name?: string;
  status?: string;
  tradable?: boolean;
  fractionable?: boolean;
  min_order_size?: string;
  min_trade_increment?: string;
  price_increment?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A snapshot to a quote, with no session to reason about.
 *
 * The precedence is the equity one with the branch removed: the last trade, a
 * two-sided quote midpoint, then the day's close, then the previous one. The
 * midpoint rule is kept exactly — both sides quoted and uncrossed — because a
 * one-sided book halves the price here for the same reason it does on IEX.
 *
 * Exported for tests.
 */
export function quoteFromCryptoSnapshot(symbol: string, snapshot: CryptoSnapshot): Quote | null {
  const { latestTrade, latestQuote, dailyBar, prevDailyBar } = snapshot;

  const midpoint =
    latestQuote && latestQuote.bp > 0 && latestQuote.ap > 0 && latestQuote.ap >= latestQuote.bp
      ? (latestQuote.bp + latestQuote.ap) / 2
      : null;

  const tradePrice = latestTrade && latestTrade.p > 0 ? latestTrade.p : null;
  const todayClose = dailyBar && dailyBar.c > 0 ? dailyBar.c : null;
  const priorClose = prevDailyBar && prevDailyBar.c > 0 ? prevDailyBar.c : null;

  const candidates: Array<[number | null, Quote["source"], string | null]> = [
    [tradePrice, "trade", latestTrade?.t ?? null],
    [midpoint, "quote", latestQuote?.t ?? null],
    [todayClose, "bar", dailyBar?.t ?? null],
    [priorClose, "prev-bar", prevDailyBar?.t ?? null],
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
    // The "day" is the 05:00-UTC-to-05:00-UTC window Alpaca stamps the bar
    // with, which is a New York day. There is no other day to mean.
    dayOpen: dailyBar ? dailyBar.o : null,
    dayHigh: dailyBar ? dailyBar.h : null,
    dayLow: dailyBar ? dailyBar.l : null,
    dayVolume: dailyBar ? dailyBar.v : null,
    asOf,
  };
}

/** A decimal string from Alpaca, or undefined if it is not a usable number. */
function decimal(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export class AlpacaCryptoProvider {
  readonly name = "alpaca-crypto";
  #config: AlpacaConfig;

  constructor(config: AlpacaConfig) {
    this.#config = config;
  }

  #headers(): HeadersInit {
    // The docs disagree with themselves about whether crypto data needs
    // authentication. The OpenAPI reference says it does, so the keys go on
    // every call rather than relying on an undocumented edge.
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
      throw new MarketDataError("alpaca-crypto", `Could not reach Alpaca: ${String(cause)}`, 502);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new MarketDataError(
        "alpaca-crypto",
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

    const responses = await Promise.all(
      chunk(symbols, SYMBOLS_PER_REQUEST).map((batch) => {
        // URLSearchParams percent-encodes the slash in `BTC/USD`. Alpaca
        // accepts either form in a query string; what must never happen is a
        // symbol reaching a *path* segment unencoded, which is why nothing here
        // interpolates one.
        const params = new URLSearchParams({ symbols: batch.join(",") });
        return this.#get<{ snapshots?: Record<string, CryptoSnapshot> }>(
          `${DATA_HOST}/v1beta3/crypto/${LOCATION}/snapshots?${params}`,
        );
      }),
    );

    for (const body of responses) {
      const map = (body.snapshots ?? body) as Record<string, CryptoSnapshot>;
      for (const [symbol, snapshot] of Object.entries(map)) {
        if (!snapshot || typeof snapshot !== "object") continue;
        const quote = quoteFromCryptoSnapshot(symbol, snapshot);
        if (quote) out.set(symbol, quote);
      }
    }

    return out;
  }

  async dailyBars(symbols: string[], query: BarQuery): Promise<Map<string, DailyBar[]>> {
    return this.#bars(symbols, "1Day", query.start, query.end, query.limit);
  }

  async intradayBars(symbols: string[], query: IntradayQuery): Promise<Map<string, IntradayBar[]>> {
    const bars = await this.#rawBars(symbols, query.timeframe, query.start, query.end, query.limit);
    const out = new Map<string, IntradayBar[]>();

    for (const [symbol, rows] of bars) {
      out.set(
        symbol,
        rows.map((bar) => ({
          at: bar.t,
          date: exchangeDate(bar.t),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        })),
      );
    }

    return out;
  }

  async #bars(
    symbols: string[],
    timeframe: string,
    start: string,
    end: string | undefined,
    limit: number | undefined,
  ): Promise<Map<string, DailyBar[]>> {
    const raw = await this.#rawBars(symbols, timeframe, start, end, limit);
    const out = new Map<string, DailyBar[]>();

    for (const [symbol, rows] of raw) {
      out.set(
        symbol,
        rows.map((bar) => ({
          // A crypto daily bar runs midnight to midnight UTC, so its date is
          // the UTC date of its own timestamp — NOT the exchange date.
          //
          // This is the one place a crypto bar must not go through
          // `exchangeDate()`, and it is worth being blunt about why. A bar
          // stamped 2026-09-02T00:00:00Z is 20:00 ET on the 1st, so the
          // exchange-date reading calls today's bar yesterday's, and every
          // crypto close on the equity curve lands one session early. It fails
          // silently: the chart still draws, with the wrong number.
          //
          // Alpaca's own docs show 05:00Z in a snapshot example from the
          // v1beta1 era, which would have been midnight New York and would have
          // made `exchangeDate()` correct. The live v1beta3 feed returns 00:00Z.
          // Verified against the API rather than the documentation, and pinned
          // in crypto.test.ts.
          date: bar.t.slice(0, 10),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        })),
      );
    }

    return out;
  }

  async #rawBars(
    symbols: string[],
    timeframe: string,
    start: string,
    end: string | undefined,
    limit: number | undefined,
  ): Promise<Map<string, CryptoBar[]>> {
    const out = new Map<string, CryptoBar[]>();
    if (symbols.length === 0) return out;

    for (const batch of chunk(symbols, SYMBOLS_PER_REQUEST)) {
      let pageToken: string | null = null;
      let page = 0;

      do {
        const params = new URLSearchParams({
          symbols: batch.join(","),
          timeframe,
          start,
          limit: String(Math.min(limit ?? 10_000, 10_000)),
        });
        if (end) params.set("end", end);
        if (pageToken) params.set("page_token", pageToken);

        const body: { bars?: Record<string, CryptoBar[]>; next_page_token?: string | null } =
          await this.#get(`${DATA_HOST}/v1beta3/crypto/${LOCATION}/bars?${params}`);

        for (const [symbol, bars] of Object.entries(body.bars ?? {})) {
          const existing = out.get(symbol);
          if (existing) existing.push(...bars);
          else out.set(symbol, [...bars]);
        }

        pageToken = body.next_page_token ?? null;
        page += 1;
      } while (pageToken && page < MAX_BAR_PAGES);
    }

    return out;
  }

  /**
   * The tradable pairs. Around sixty rows, which is small enough to sit in the
   * same KV shards as the thirteen thousand equities without anyone noticing.
   */
  async assets(): Promise<TradableAsset[]> {
    const body = await this.#get<CryptoAsset[]>(
      `${TRADING_HOST}/v2/assets?status=active&asset_class=crypto`,
    );

    const out: TradableAsset[] = [];
    for (const asset of body) {
      if (!asset.tradable) continue;
      // The legacy unslashed form is still served for backwards compatibility.
      // Carrying both would put the same coin in the universe twice, and only
      // one of them prices against v1beta3.
      if (!asset.symbol.includes("/")) continue;

      out.push({
        symbol: asset.symbol,
        name: asset.name ?? asset.symbol,
        exchange: "CRYPTO",
        // Every pair is fractionable; that is most of the point of a coin.
        fractionable: asset.fractionable !== false,
        // No borrow, no locate, no margin model. See allowsShort() in symbols.ts.
        shortable: false,
        easyToBorrow: false,
        minOrderSize: decimal(asset.min_order_size),
      });
    }
    return out;
  }
}
