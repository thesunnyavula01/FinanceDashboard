import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isTradableSymbol, normalise, underlyingOf } from "@/lib/symbols";

/**
 * Research changes on a news clock, not a quote clock. The caller passes only
 * a committed symbol, so typing TSLA never researches T, TS and TSL on the way.
 * An option shares its underlying's query and the Worker's five-minute cache.
 */
export function useResearch(committed: string) {
  const raw = normalise(committed);
  const symbol = underlyingOf(raw) ?? raw;
  const query = useQuery({
    // Relevance rules changed: discard pre-filter results retained during HMR.
    queryKey: ["research", 2, symbol],
    queryFn: () => api.research(symbol),
    enabled: isTradableSymbol(raw),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    // A cached TSLA response must never appear under a newly selected AAPL
    // heading. TanStack keeps same-symbol data during refresh without needing
    // cross-key placeholderData.
    retry: false,
  });

  return {
    research: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
