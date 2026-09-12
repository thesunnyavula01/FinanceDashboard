import type { QueryClient } from "@tanstack/react-query";

interface OrderState {
  orders: { id: string; status: string }[];
}

/** Session tokens can refresh without changing owners; private data cannot cross owners. */
export function resetSessionCache(client: QueryClient, before: string | null, after: string | null): void {
  if (before !== after) client.clear();
}

/** All views affected by a fill, including one executed by the cron or another tab. */
export function invalidatePortfolioViews(client: QueryClient): void {
  for (const key of ["portfolio", "blotter", "history", "standings", "member-book", "me"]) {
    void client.invalidateQueries({ queryKey: [key] });
  }
}

export function workingOrdersInterval(data: OrderState | undefined, marketOpen: boolean): number {
  return marketOpen || data?.orders.some((order) => order.status === "PENDING") ? 20_000 : 60_000;
}

/** Ignore anchor/price ticks; a changed order status or list can change the book. */
export function workingOrdersChanged(before: OrderState | undefined, after: OrderState): boolean {
  if (!before) return false;
  const states = new Map(before.orders.map((order) => [order.id, order.status]));
  return before.orders.length !== after.orders.length
    || after.orders.some((order) => states.get(order.id) !== order.status);
}
