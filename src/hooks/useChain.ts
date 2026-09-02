import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EQUITY_SYMBOL } from "@/lib/symbols";

/**
 * One underlying's option chain.
 *
 * Polls on the quote interval, because a chain and the positions grid are read
 * together and a member should not have to wonder which of two prices on screen
 * is the newer one. The Worker caches the same twenty seconds, so a whole club
 * watching one expiry is still two upstream requests a minute.
 *
 * **The chosen expiration is stored with the underlying it belongs to, and
 * derived back out.** Last week's date on a newly typed ticker is not a
 * selection, it is a leftover — the route would fall back to the front month
 * anyway, and the rail would then highlight a date that is not the one drawn.
 * Storing the pair and comparing is what makes that impossible; resetting the
 * date in a render-phase update was the first attempt and it is a worse
 * mechanism, because the reset is a fact about the current props rather than an
 * event.
 */
export function useChain(underlying: string, enabled = true) {
  const symbol = underlying.trim().toUpperCase();

  // A chain is two upstream calls, so it waits for the typing to stop. "AAPL"
  // typed a letter at a time would otherwise fetch A, AA and AAP on the way —
  // three chains nobody asked for, two of which are real tickers.
  const [debounced, setDebounced] = useState(symbol);
  const [selection, setSelection] = useState<{ underlying: string; expiration: string }>({
    underlying: symbol,
    expiration: "",
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(symbol), 300);
    return () => clearTimeout(timer);
  }, [symbol]);

  // Only honoured while it is still this underlying's date.
  const asked = selection.underlying === debounced ? selection.expiration : "";
  const valid = EQUITY_SYMBOL.test(debounced);

  const query = useQuery({
    queryKey: ["chain", debounced, asked],
    queryFn: () => api.chain(debounced, asked || undefined),
    enabled: enabled && valid,
    refetchInterval: 20_000,
    staleTime: 10_000,
    // A chain that has loaded once should not blank out while the next
    // expiration arrives — the ladder jumping to an empty panel and back reads
    // as a fault rather than as a fetch.
    placeholderData: (previous) => previous,
    retry: false,
  });

  return {
    chain: query.data ?? null,
    /** What the server actually drew, which may not be what was asked for. */
    expiration: query.data?.expiration ?? null,
    setExpiration: (expiration: string) => setSelection({ underlying: debounced, expiration }),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
