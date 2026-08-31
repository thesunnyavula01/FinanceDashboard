import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CurveRange, type HistoryResponse } from "@/lib/api";

/**
 * The equity curve.
 *
 * Slow on purpose. Every other number on the terminal moves on the 20-second
 * quote poll, but a curve is one point per session: the whole of it is settled
 * history except the last point, and re-fetching a year of daily bars three
 * times a minute to nudge one pixel would be the most expensive thing in the
 * app for the least visible change.
 *
 * Five minutes, and the ranges share nothing — each is its own query key, so
 * flipping 3M -> 1W -> 3M is instant the second time. The Worker caches the
 * bars behind all of them anyway, so the switch is cheap on both sides.
 */

const HISTORY_REFRESH_MS = 5 * 60_000;

export interface HistoryState {
  history: HistoryResponse | null;
  range: CurveRange;
  setRange: (range: CurveRange) => void;
  isLoading: boolean;
  isError: boolean;
}

export function useHistory(initial: CurveRange = "ALL"): HistoryState {
  const [range, setRange] = useState<CurveRange>(initial);

  const { data, isPending, isError } = useQuery({
    queryKey: ["history", range],
    queryFn: () => api.history(range),
    refetchInterval: HISTORY_REFRESH_MS,
    staleTime: HISTORY_REFRESH_MS,
    // Keep the old curve on screen while the new range loads, so switching
    // ranges redraws rather than blanking and redrawing.
    placeholderData: (previous) => previous,
    retry: 1,
  });

  return {
    history: data ?? null,
    range,
    setRange,
    isLoading: isPending,
    isError,
  };
}
