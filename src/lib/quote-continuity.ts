import type { Quote, QuotesResponse } from "./quote-types";
import type { QueryClient } from "@tanstack/react-query";

export const LAST_GOOD_QUOTES_KEY = ["last-good-quotes"] as const;

export function rememberQuotes(client: QueryClient, quotes: Record<string, Quote>): void {
  // This entry has no observer, so the normal five-minute garbage collection
  // would erase it during a prolonged outage. Auth changes still clear it.
  client.setQueryDefaults(LAST_GOOD_QUOTES_KEY, { gcTime: Infinity });
  client.setQueryData(LAST_GOOD_QUOTES_KEY, quotes);
}

// Successful HTTP responses can still contain no prices. Keep the most recently
// observed price per symbol through partial outages and changes to the symbol set.
// Stored in QueryClient (cleared on account change), never in module globals.
export function retainQuotes(
  symbols: string[], next: QuotesResponse, previous: Record<string, Quote>,
): QuotesResponse {
  const quotes: Record<string, Quote> = {};
  for (const symbol of symbols) {
    const fresh = next.quotes[symbol];
    const old = previous[symbol];
    if (fresh && !fresh.stale) {
      const receivedAt = fresh.receivedAt ?? next.asOf;
      quotes[symbol] = old && Date.parse(old.receivedAt ?? "") > Date.parse(receivedAt)
        ? { ...old, stale: true } : { ...fresh, receivedAt };
    }
    else {
      const saved = fresh && (!old || Date.parse(fresh.receivedAt ?? "") > Date.parse(old.receivedAt ?? ""))
        ? fresh : old ?? fresh;
      if (saved) quotes[symbol] = { ...saved, stale: true };
    }
  }
  return { ...next, quotes, unknown: symbols.filter((symbol) => !quotes[symbol]) };
}
