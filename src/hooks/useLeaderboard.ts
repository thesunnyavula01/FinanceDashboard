import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type StandingsResponse } from "@/lib/api";
import { valuePortfolio } from "@/lib/portfolio";
import { useQuotes, useSecurities } from "./useQuotes";

/**
 * The standings, and one member's book behind them.
 *
 * Slower than the quote poll on purpose. The Worker rebuilds the ranking once
 * every twenty seconds and serves the same payload to everyone in between, so
 * asking three times a minute would return the identical bytes twice. Thirty
 * seconds keeps the screen alive without the club generating a request storm
 * on the one endpoint that reads every portfolio.
 */

const STANDINGS_REFRESH_MS = 30_000;

export const STANDINGS_KEY = ["standings"] as const;

export interface StandingsState {
  standings: StandingsResponse | null;
  /** The signed-in member's own row, for the "you" strip. */
  mine: StandingsResponse["rows"][number] | null;
  note: string | null;
  isLoading: boolean;
  isError: boolean;
}

export function useStandings(userId: string | undefined): StandingsState {
  const { data, isPending, isError } = useQuery({
    queryKey: STANDINGS_KEY,
    queryFn: api.standings,
    refetchInterval: STANDINGS_REFRESH_MS,
    staleTime: STANDINGS_REFRESH_MS,
    // Keep the last standings on screen while the next poll is in flight, so
    // the table never blanks and re-sorts under the reader's eyes.
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const mine = useMemo(
    () => data?.rows.find((row) => row.userId === userId) ?? null,
    [data, userId],
  );

  return {
    standings: data ?? null,
    mine,
    note: data?.note ?? null,
    isLoading: isPending,
    isError,
  };
}

/**
 * Another member's positions and fills, valued in the browser.
 *
 * The same `valuePortfolio()` that draws the member's own grid, against the
 * same quote cache — which is the point of the endpoint being unpriced. Two
 * screens showing the same position at two different prices, because one was
 * valued on the server and one in the browser, is the failure this avoids.
 */
export function useMemberBook(portfolioId: string | null) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["member-book", portfolioId],
    queryFn: () => api.memberBook(portfolioId!),
    enabled: Boolean(portfolioId),
    staleTime: 30_000,
  });

  const positions = data?.positions ?? [];
  const symbols = useMemo(() => positions.map((p) => p.symbol), [positions]);

  const { quotes } = useQuotes(symbols, Boolean(portfolioId));
  const { securities } = useSecurities(symbols, Boolean(portfolioId));

  const { rows, totals } = useMemo(
    () =>
      valuePortfolio({
        positions,
        quotes,
        securities,
        cash: data?.cash ?? 0,
        startingCash: data?.startingCash ?? 0,
      }),
    [positions, quotes, securities, data?.cash, data?.startingCash],
  );

  return {
    displayName: data?.member.displayName ?? null,
    role: data?.member.role ?? "member",
    rows,
    totals,
    trades: data?.trades ?? [],
    isLoading: isPending && Boolean(portfolioId),
    isError,
  };
}
