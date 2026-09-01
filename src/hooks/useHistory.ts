import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CurveRange, type HistoryResponse } from "@/lib/api";

/**
 * The equity curve.
 *
 * Two cadences, because the two charts behind this hook age at different
 * speeds. A session curve is one point per day: the whole of it is settled
 * history except the last point, and re-fetching a year of daily bars three
 * times a minute to nudge one pixel would be the most expensive thing in the
 * app for the least visible change. Five minutes.
 *
 * 1D is one point per five-minute bar and the newest of them is still being
 * written, so a minute is the honest interval — any slower and the chart lags
 * the positions grid beside it, which polls quotes every twenty seconds. It
 * stays affordable because the Worker caches intraday bars per *symbol* for
 * sixty seconds: a hundred members watching a hundred overlapping tickers are
 * still the same two or three upstream requests a minute.
 *
 * The ranges share nothing — each is its own query key, so flipping 3M -> 1W ->
 * 3M is instant the second time. The Worker caches the bars behind all of them
 * anyway, so the switch is cheap on both sides.
 */

const SESSION_REFRESH_MS = 5 * 60_000;
const INTRADAY_REFRESH_MS = 60_000;

export interface HistoryState {
  history: HistoryResponse | null;
  range: CurveRange;
  setRange: (range: CurveRange) => void;
  isLoading: boolean;
  isError: boolean;
}

export function useHistory(initial: CurveRange = "1D"): HistoryState {
  const [range, setRange] = useState<CurveRange>(initial);
  const refresh = range === "1D" ? INTRADAY_REFRESH_MS : SESSION_REFRESH_MS;

  const { data, isPending, isError } = useQuery({
    queryKey: ["history", range],
    queryFn: () => api.history(range),
    refetchInterval: refresh,
    staleTime: refresh,
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
