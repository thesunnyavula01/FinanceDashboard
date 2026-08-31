import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type OrderRequest, type PortfolioResponse } from "@/lib/api";
import { valuePortfolio, type PortfolioTotals, type ValuedPosition } from "@/lib/portfolio";
import { QUOTE_REFRESH_MS, useQuotes, useSecurities } from "./useQuotes";

/**
 * The member's own portfolio, valued at live prices.
 *
 * Three queries on three different schedules, which is the whole point of
 * keeping them apart: holdings change only when someone trades, prices change
 * every twenty seconds, and names and sectors never change at all. Merging them
 * into one endpoint would mean re-reading the database on the price interval.
 *
 * The valuation is recomputed in `useMemo` from whichever of the three has
 * arrived, so a price tick re-renders the grid without refetching anything else.
 */

export const PORTFOLIO_KEY = ["portfolio"] as const;
export const BLOTTER_KEY = ["blotter"] as const;
export const WORKING_KEY = ["working-orders"] as const;

export interface PortfolioState {
  rows: ValuedPosition[];
  totals: PortfolioTotals;
  positions: PortfolioResponse["positions"];
  season: NonNullable<PortfolioResponse["portfolio"]>["season"] | null;
  /** Why there is no portfolio, when there is not one. */
  note: string | null;
  symbols: string[];
  /** When the Worker assembled the price response behind these numbers. */
  asOf: string | null;
  /** Every position is showing an official close rather than a live print. */
  atLastClose: boolean;
  isLoading: boolean;
  isError: boolean;
  /** Prices failed; the grid is showing average costs, not marks. */
  pricesUnavailable: boolean;
}

export function usePortfolio(): PortfolioState {
  const {
    data,
    isPending,
    isError: portfolioError,
  } = useQuery({
    queryKey: PORTFOLIO_KEY,
    queryFn: api.portfolio,
    // Holdings only change when this member trades, and placing an order
    // invalidates this key directly. The slow poll is a safety net for a trade
    // placed in another tab, not the mechanism.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const positions = data?.positions ?? [];
  const symbols = useMemo(() => positions.map((p) => p.symbol), [positions]);

  const { quotes, asOf, isError: quotesError } = useQuotes(symbols);
  const { securities } = useSecurities(symbols);

  const cash = data?.portfolio?.cash ?? 0;
  // This member's own baseline, not the season's default. An officer raising
  // the starting cash for new joiners must not restate everyone else's return.
  const startingCash = data?.portfolio?.startingCash ?? 0;

  const { rows, totals } = useMemo(
    () => valuePortfolio({ positions, quotes, securities, cash, startingCash }),
    [positions, quotes, securities, cash, startingCash],
  );

  // Every quote sourced from a completed bar means the session is over and
  // these are official closes rather than live ticks — worth saying, instead of
  // letting a member wonder why nothing is moving.
  const liveCount = symbols.filter((symbol) => quotes[symbol]).length;
  const atLastClose =
    liveCount > 0 &&
    symbols.every((symbol) => {
      const source = quotes[symbol]?.source;
      return source === undefined || source === "bar" || source === "prev-bar";
    });

  return {
    rows,
    totals,
    positions,
    season: data?.portfolio?.season ?? null,
    note: data?.note ?? null,
    symbols,
    asOf,
    atLastClose,
    isLoading: isPending,
    isError: portfolioError,
    pricesUnavailable: quotesError && symbols.length > 0,
  };
}

/** The trade blotter. A log, so it only changes when an order fills. */
export function useBlotter(limit = 100) {
  const { data, isPending, isError } = useQuery({
    queryKey: [...BLOTTER_KEY, limit],
    queryFn: () => api.blotter(limit),
    staleTime: 30_000,
  });

  return {
    trades: data?.trades ?? [],
    note: data?.note ?? null,
    isLoading: isPending,
    isError,
  };
}

/**
 * Place an order.
 *
 * On a fill, every view of the portfolio is invalidated rather than patched.
 * The response does carry the balances the database computed, and they are the
 * authoritative ones — but a fill also changes the position list, the blotter,
 * and the set of symbols being priced, and hand-reconciling four caches against
 * one response is how a screen ends up disagreeing with itself. A refetch costs
 * one round trip on an action that happens a few times a week.
 */
export function usePlaceOrder() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (order: OrderRequest) => api.placeOrder(order),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: PORTFOLIO_KEY });
      void client.invalidateQueries({ queryKey: BLOTTER_KEY });
      // A queued order changes nothing but the working list and the reserved
      // buying power — but the same call can also come back FILLED, so both
      // are refreshed rather than guessed at from the response shape.
      void client.invalidateQueries({ queryKey: WORKING_KEY });
      // /auth/me carries the cash balance shown in the status rail.
      void client.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/**
 * Orders waiting for the market.
 *
 * Polled on the quote interval while the market is open, because the sweep runs
 * once a minute and a member watching a limit order wants to see it go. Outside
 * a session nothing can change it — no session, no fills — so the poll stops
 * and the list is only refetched when the member does something.
 */
export function useWorkingOrders(marketOpen = false) {
  const { data, isPending, isError } = useQuery({
    queryKey: WORKING_KEY,
    queryFn: api.workingOrders,
    refetchInterval: marketOpen ? QUOTE_REFRESH_MS : false,
    staleTime: 10_000,
  });

  const orders = data?.orders ?? [];

  return {
    /** Still waiting on the market. */
    resting: orders.filter((order) => order.status === "PENDING"),
    /** Filled, cancelled, expired or rejected — kept for context under the list. */
    resolved: orders.filter((order) => order.status !== "PENDING"),
    /** Buying power currently held by resting orders. */
    reservedCash: orders
      .filter((order) => order.status === "PENDING")
      .reduce((sum, order) => sum + Number(order.reservedCash), 0),
    note: data?.note ?? null,
    isLoading: isPending,
    isError,
  };
}

/** Cancel a resting order. The reservation comes back with it. */
export function useCancelOrder() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.cancelOrder(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: WORKING_KEY });
      void client.invalidateQueries({ queryKey: PORTFOLIO_KEY });
    },
  });
}
