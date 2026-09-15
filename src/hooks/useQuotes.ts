import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Quote, type Security } from "@/lib/api";
import { LAST_GOOD_QUOTES_KEY, rememberQuotes, retainQuotes } from "../lib/quote-continuity";

/**
 * Live prices.
 *
 * Two separate hooks for what looks like one thing, because prices and company
 * profiles have opposite refresh needs: a quote is stale after twenty seconds,
 * a sector is stale after never. Fetching them together would mean either
 * re-fetching sectors 180 times an hour or letting prices go cold.
 *
 * The 20s interval is deliberately the same as the Worker's cache TTL. A
 * hundred members on this interval still produce roughly six Alpaca requests a
 * minute across the whole club — see worker/market/quotes.ts.
 */

export const QUOTE_REFRESH_MS = 20_000;

/** Sorted and deduped, so [A,B] and [B,A] share one cache entry and one fetch. */
function cacheKey(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].sort();
}

export interface QuotesState {
  quotes: Record<string, Quote>;
  /** Symbols the market data layer could not price. */
  unknown: string[];
  /** When the Worker assembled this response. */
  asOf: string | null;
  isLoading: boolean;
  isError: boolean;
}

export function useQuotes(symbols: string[], enabled = true): QuotesState {
  const key = cacheKey(symbols);
  const client = useQueryClient();

  const { data, isPending, isError } = useQuery({
    queryKey: ["quotes", key],
    queryFn: async ({ signal }) => {
      const next = await api.quotes(key);
      // A logout can clear the cache while the network request is in flight.
      signal.throwIfAborted();
      const previous = client.getQueryData<Record<string, Quote>>(LAST_GOOD_QUOTES_KEY) ?? {};
      const retained = retainQuotes(key, next, previous);
      rememberQuotes(client, { ...previous, ...retained.quotes });
      return retained;
    },
    enabled: enabled && key.length > 0,
    refetchInterval: QUOTE_REFRESH_MS,
    // Pause hidden tabs; the query refreshes stale prices when visible again.
    refetchIntervalInBackground: false,
    staleTime: QUOTE_REFRESH_MS,
    // Show the last good prices while the next poll is in flight, so the grid
    // never blanks between refreshes.
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const saved = client.getQueryData<Record<string, Quote>>(LAST_GOOD_QUOTES_KEY) ?? {};
  const displayed: Record<string, Quote> = {};
  for (const symbol of key) {
    const quote = data?.quotes[symbol] ?? saved[symbol];
    if (quote) displayed[symbol] = isError || !data?.quotes[symbol] ? { ...quote, stale: true } : quote;
  }
  return {
    quotes: displayed,
    unknown: data?.unknown ?? [],
    asOf: data?.asOf ?? null,
    isLoading: isPending && key.length > 0,
    isError,
  };
}

export interface SecuritiesState {
  securities: Record<string, Security>;
  isLoading: boolean;
}

/**
 * Names and sectors. Effectively immutable once fetched, so this is cached for
 * the session — but it refetches while symbols are still `pending`, because a
 * ticker nobody in the club has traded before is looked up behind the first
 * response and only lands on the second.
 */
export function useSecurities(symbols: string[], enabled = true): SecuritiesState {
  const key = cacheKey(symbols);

  const { data, isPending } = useQuery({
    queryKey: ["securities", key],
    queryFn: () => api.securities(key),
    enabled: enabled && key.length > 0,
    staleTime: 60 * 60_000,
    refetchInterval: (query) =>
      (query.state.data?.pending.length ?? 0) > 0 ? QUOTE_REFRESH_MS : false,
    retry: 1,
  });

  return {
    securities: data?.securities ?? {},
    isLoading: isPending && key.length > 0,
  };
}
