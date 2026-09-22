import type { Quote, QuotesResponse } from "./quote-types";
import type { QueryClient } from "@tanstack/react-query";

export const LAST_GOOD_QUOTES_KEY = ["last-good-quotes"] as const;

function observedAt(quote: Quote): number {
  const value = Date.parse(quote.receivedAt ?? quote.asOf ?? "");
  return Number.isFinite(value) ? value : -Infinity;
}

function usable(quote: Quote | undefined): quote is Quote {
  return Boolean(quote && Number.isFinite(quote.price) && quote.price > 0);
}

/** Overlapping query keys must display the newest known observation of a symbol. */
export function displayedQuotes(
  symbols: string[], current: Record<string, Quote> | undefined,
  saved: Record<string, Quote>, failed: boolean,
): Record<string, Quote> {
  const displayed: Record<string, Quote> = {};
  for (const symbol of symbols) {
    const response = usable(current?.[symbol]) ? current[symbol] : undefined;
    const remembered = usable(saved[symbol]) ? saved[symbol] : undefined;
    const quote = remembered && (!response || observedAt(remembered) > observedAt(response))
      ? remembered : response;
    if (quote) displayed[symbol] = failed || quote !== response ? { ...quote, stale: true } : quote;
  }
  return displayed;
}

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
    const fresh = usable(next.quotes[symbol]) ? next.quotes[symbol] : undefined;
    const old = usable(previous[symbol]) ? previous[symbol] : undefined;
    if (fresh && !fresh.stale) {
      const receivedAt = fresh.receivedAt ?? next.asOf;
      quotes[symbol] = old && observedAt(old) > Date.parse(receivedAt)
        ? { ...old, stale: true } : { ...fresh, receivedAt };
    }
    else {
      const saved = fresh && (!old || observedAt(fresh) > observedAt(old))
        ? fresh : old ?? fresh;
      if (saved) quotes[symbol] = { ...saved, stale: true };
    }
  }
  return { ...next, quotes, unknown: symbols.filter((symbol) => !quotes[symbol]) };
}
