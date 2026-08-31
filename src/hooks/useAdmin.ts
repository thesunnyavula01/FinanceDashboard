import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AdminOverview } from "@/lib/api";
import { PORTFOLIO_KEY, BLOTTER_KEY, WORKING_KEY } from "./usePortfolio";
import { STANDINGS_KEY } from "./useLeaderboard";

/**
 * The officers' console.
 *
 * One read and a set of mutations. The read is not polled: nothing on this
 * screen changes unless an officer changes it, and a member list that
 * re-sorted itself every twenty seconds while someone was reading down it
 * would be actively unhelpful.
 *
 * Every mutation invalidates broadly rather than patching the cache. An admin
 * action can change the season, the member list, someone else's cash and the
 * standings all at once — reconciling four caches against one response is how
 * a screen ends up disagreeing with itself, and these happen a few times a
 * season, not a few times a minute.
 */

export const ADMIN_KEY = ["admin"] as const;
export const ADMIN_TRADES_KEY = ["admin", "trades"] as const;

/**
 * `enabled` is off until the caller knows the reader is an officer. Every route
 * behind this hook answers 403 to anyone else, and firing that request to find
 * out what the app already knows just fills a member's console with a refusal.
 */
export function useAdminOverview(enabled = true) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ADMIN_KEY,
    queryFn: api.admin.overview,
    enabled,
    staleTime: 30_000,
    retry: 1,
  });

  return {
    overview: (data ?? null) as AdminOverview | null,
    activeSeason: data?.seasons.find((season) => season.isActive) ?? null,
    isLoading: isPending,
    isError,
    error,
  };
}

/** The club's fills, newest first. The list an officer corrects from. */
export function useAdminTrades(filters: { portfolio?: string; symbol?: string } = {}) {
  const { data, isPending, isError } = useQuery({
    queryKey: [...ADMIN_TRADES_KEY, filters.portfolio ?? "", filters.symbol ?? ""],
    queryFn: () => api.admin.trades(filters),
    staleTime: 15_000,
    retry: 1,
  });

  return {
    trades: data?.trades ?? [],
    note: data?.note ?? null,
    isLoading: isPending,
    isError,
  };
}

/**
 * Everything an officer action can invalidate.
 *
 * A void changes one member's cash and positions; a reset changes everyone's;
 * a new season changes which portfolio a member even has. Rather than work out
 * which of those applies per action, every mutation drops the lot — the cost is
 * a handful of refetches on an action taken a few times a season.
 */
function useAdminMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of [
        ADMIN_KEY,
        STANDINGS_KEY,
        PORTFOLIO_KEY,
        BLOTTER_KEY,
        WORKING_KEY,
        ["me"],
        ["history"],
      ]) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useCreateSeason() {
  return useAdminMutation((season: { name: string; startingCash: number }) =>
    api.admin.createSeason(season),
  );
}

export function useUpdateSeason() {
  return useAdminMutation(
    (input: {
      id: string;
      changes: { name?: string; startingCash?: number; tradingLocked?: boolean };
    }) => api.admin.updateSeason(input.id, input.changes),
  );
}

export function useResetSeason() {
  return useAdminMutation((input: { id: string; confirm: string }) =>
    api.admin.resetSeason(input.id, input.confirm),
  );
}

export function useRotateInvite() {
  return useAdminMutation((code?: string) => api.admin.rotateInvite(code));
}

export function useSetRole() {
  return useAdminMutation((input: { userId: string; role: "member" | "admin" }) =>
    api.admin.setRole(input.userId, input.role),
  );
}

export function useVoidTrade() {
  return useAdminMutation((id: string) => api.admin.voidTrade(id));
}

export function useAmendTrade() {
  return useAdminMutation((input: { id: string; qty?: number; price?: number }) =>
    api.admin.amendTrade(input.id, { qty: input.qty, price: input.price }),
  );
}

export function useSyncUniverse() {
  return useAdminMutation(() => api.admin.syncUniverse());
}

export function useForceSweep() {
  return useAdminMutation(() => api.admin.sweep());
}

export function useForceSnapshot() {
  return useAdminMutation(() => api.admin.snapshot());
}
