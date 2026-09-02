import { AlpacaProvider, alpacaConfigFromEnv } from "./alpaca.ts";
import { AlpacaCryptoProvider } from "./crypto.ts";
import { AlpacaOptionsProvider } from "./options.ts";
import { classify, type AssetClass } from "./symbols.ts";
import type {
  BarQuery,
  CalendarDay,
  DailyBar,
  IntradayBar,
  IntradayQuery,
  MarketClock,
  PriceProvider,
  Quote,
  TradableAsset,
} from "./provider.ts";

/**
 * One `PriceProvider` over three asset classes.
 *
 * This is what `provider.ts` was built for. Every caller — the quote cache, the
 * bar cache, the curve, the nightly snapshot — asks for a list of symbols and
 * gets back a map. None of them needs to know that BTC/USD came from a
 * different host than NVDA, so none of them is told: the split happens here and
 * the results are merged before they leave.
 *
 * The consequence worth stating is that the three-tier cache in `quotes.ts` did
 * not have to change at all. A hundred members holding a mix of stock, coins
 * and contracts still produce one batched upstream request per class per
 * interval, because the cache sees one provider and one flat symbol list.
 *
 * **A failing class must not take the others down.** `Promise.allSettled`, not
 * `Promise.all`: if the options endpoint is having a bad afternoon, the equity
 * and crypto quotes still arrive, and the symbols that failed are simply absent
 * from the map — which is the same shape the cache already handles for a symbol
 * nothing can price. An outage in one venue degrades one venue.
 *
 * The exchange calendar is deliberately NOT routed. There is one clock in this
 * app and it is the New York equity session: it decides when orders fill, when
 * the sweep runs, and what the x-axis of every chart is. Crypto opts out of it
 * per order, in `tradingWindow()`, rather than by having a second calendar.
 */

/** The per-class halves this stitches together. */
export interface ClassProviders {
  equity: AlpacaProvider;
  crypto: AlpacaCryptoProvider;
  options: AlpacaOptionsProvider;
}

type SymbolFetcher<T> = (symbols: string[]) => Promise<Map<string, T>>;

/** Split a symbol list by class, dropping the classes nobody asked about. */
export function partitionByClass(symbols: string[]): Map<AssetClass, string[]> {
  const out = new Map<AssetClass, string[]>();
  for (const symbol of symbols) {
    const key = classify(symbol);
    const bucket = out.get(key);
    if (bucket) bucket.push(symbol);
    else out.set(key, [symbol]);
  }
  return out;
}

/**
 * Run each class's fetcher over its own symbols and merge what comes back.
 *
 * Exported because the bar caches route the same way and there is no reason for
 * two copies of this loop.
 */
export async function fanOut<T>(
  symbols: string[],
  fetchers: Partial<Record<AssetClass, SymbolFetcher<T>>>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  if (symbols.length === 0) return out;

  const jobs: Promise<Map<string, T>>[] = [];

  for (const [assetClass, batch] of partitionByClass(symbols)) {
    const fetcher = fetchers[assetClass];
    // A class with no fetcher is not an error: asking for an option quote
    // before the options provider exists should leave it unpriced, which the
    // caller already knows how to render, rather than throwing.
    if (fetcher) jobs.push(fetcher(batch));
  }

  for (const settled of await Promise.allSettled(jobs)) {
    if (settled.status !== "fulfilled") {
      // Logged, not rethrown. One venue failing is not every venue failing, and
      // the caller distinguishes "no price" perfectly well already.
      console.error("Market data class failed:", settled.reason);
      continue;
    }
    for (const [symbol, value] of settled.value) out.set(symbol, value);
  }

  return out;
}

export class RoutingProvider implements PriceProvider {
  readonly name = "routing";
  #providers: ClassProviders;

  constructor(providers: ClassProviders) {
    this.#providers = providers;
  }

  quotes(symbols: string[]): Promise<Map<string, Quote>> {
    return fanOut(symbols, {
      EQUITY: (batch) => this.#providers.equity.quotes(batch),
      CRYPTO: (batch) => this.#providers.crypto.quotes(batch),
      OPTION: (batch) => this.#providers.options.quotes(batch),
    });
  }

  dailyBars(symbols: string[], query: BarQuery): Promise<Map<string, DailyBar[]>> {
    return fanOut(symbols, {
      EQUITY: (batch) => this.#providers.equity.dailyBars(batch, query),
      CRYPTO: (batch) => this.#providers.crypto.dailyBars(batch, query),
      OPTION: (batch) => this.#providers.options.dailyBars(batch, query),
    });
  }

  /**
   * Options have no intraday route.
   *
   * The 1D chart draws the account against SPY and QQQ, and an option position
   * inside it is carried forward at its last daily close by `replayIntraday()`
   * — which is what already happens to any symbol with no bar in a bucket. A
   * five-minute chain would be a hundred sparse series to draw one line that
   * moves in steps anyway.
   */
  intradayBars(symbols: string[], query: IntradayQuery): Promise<Map<string, IntradayBar[]>> {
    return fanOut(symbols, {
      EQUITY: (batch) => this.#providers.equity.intradayBars(batch, query),
      CRYPTO: (batch) => this.#providers.crypto.intradayBars(batch, query),
    });
  }

  /** The provider behind the chain panel, which routes by underlying not symbol. */
  get options(): AlpacaOptionsProvider {
    return this.#providers.options;
  }

  /** One calendar, and it is the exchange's. See the header. */
  clock(): Promise<MarketClock> {
    return this.#providers.equity.clock();
  }

  calendar(start: string, end: string): Promise<CalendarDay[]> {
    return this.#providers.equity.calendar(start, end);
  }

  /**
   * The tradable universe, both classes at once.
   *
   * Crypto is around sixty rows against thirteen thousand equities, so it rides
   * in the same nightly sync and the same KV shards. Options do not and cannot:
   * the contract universe is hundreds of thousands of rows, past KV's per-value
   * ceiling and useless for autocomplete, so a chain is fetched per underlying
   * on demand instead.
   *
   * A crypto failure must not cost the equity universe. `syncUniverse()` writes
   * every shard including the empty ones, so half a universe written over a
   * whole one would delete thirteen thousand tickers — hence the throw.
   */
  async assets(): Promise<TradableAsset[]> {
    const [equity, crypto] = await Promise.allSettled([
      this.#providers.equity.assets(),
      this.#providers.crypto.assets(),
    ]);

    if (equity.status !== "fulfilled") throw equity.reason;

    if (crypto.status !== "fulfilled") {
      console.error("Crypto asset list failed; syncing equities only:", crypto.reason);
      return equity.value;
    }

    return [...equity.value, ...crypto.value];
  }
}

export interface RouterEnv {
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
}

/**
 * Build the routed provider from the environment.
 *
 * One Alpaca key covers stocks, crypto and options — there is no second
 * subscription and no second secret — so this reads the same three variables
 * `alpacaFromEnv()` always did.
 */
export function providerFromEnv(env: RouterEnv): RoutingProvider {
  const config = alpacaConfigFromEnv(env);
  return new RoutingProvider({
    equity: new AlpacaProvider(config),
    crypto: new AlpacaCryptoProvider(config),
    options: new AlpacaOptionsProvider(config),
  });
}
