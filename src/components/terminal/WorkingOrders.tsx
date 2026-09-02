import { useCancelOrder, useWorkingOrders } from "@/hooks/usePortfolio";
import { money, shares, stampET } from "@/lib/format";
import { hasStop } from "@/lib/api";
import type { OrderSide, WorkingOrder } from "@/lib/api";
import { DataGrid, type Column } from "./DataGrid";
import { Panel } from "./Panel";

/**
 * Orders waiting for the market.
 *
 * The screen that answers "did my Sunday order actually go in?". Everything
 * here is an instruction that has not traded yet: it holds buying power or
 * shares, it shows what it is waiting for, and it can be cancelled to get the
 * reservation back.
 *
 * Nothing in this list fills at a weekend. US equities trade 09:30-16:00 ET on
 * weekdays, so a queue built on Saturday comes to life at Monday's open — which
 * the "waiting for" column says in as many words rather than leaving a member
 * to wonder why their order has sat still for two days.
 */

const SIDE_COLOR: Record<OrderSide, string> = {
  BUY: "text-ink",
  SELL: "text-ink",
  SHORT: "text-loss",
  COVER: "text-gain",
};

const RESOLVED_TONE: Record<string, string> = {
  FILLED: "text-gain",
  CANCELLED: "text-ink-faint",
  EXPIRED: "text-ink-faint",
  REJECTED: "text-loss",
};

export function WorkingOrders({ marketOpen }: { marketOpen: boolean }) {
  const { resting, resolved, reservedCash, isLoading, isError } = useWorkingOrders(marketOpen);
  const cancel = useCancelOrder();

  const columns: Column<WorkingOrder>[] = [
    {
      key: "placedAt",
      header: "Placed ET",
      width: "7.5rem",
      sortValue: (order) => order.placedAt,
      render: (order) => <span className="num text-ink-dim">{stampET(order.placedAt)}</span>,
    },
    {
      key: "symbol",
      header: "Sym",
      width: "5rem",
      sortValue: (order) => order.symbol,
      render: (order) => <span className="num text-ink">{order.symbol}</span>,
    },
    {
      key: "side",
      header: "Side",
      width: "4.5rem",
      sortValue: (order) => order.side,
      render: (order) => (
        <span className={`num ${SIDE_COLOR[order.side] ?? "text-ink"}`}>{order.side}</span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      width: "6.5rem",
      sortValue: (order) => Number(order.qty ?? order.notional ?? 0),
      render: (order) => (
        <span className="num text-ink">
          {order.qty ? shares(order.qty) : `$${money(order.notional)}`}
        </span>
      ),
    },
    {
      key: "condition",
      header: "Waiting for",
      sortValue: (order) => order.orderType,
      render: (order) => {
        if (order.orderType === "MARKET") {
          return <span className="text-ink-dim">The market to open</span>;
        }

        // A limit waits for the price to come *to* it; a stop waits for the
        // price to go *through* it. Opposite directions for the same side, so
        // the wording has to come from the type and not just from the side —
        // this column is where a member checks they typed what they meant.
        const paying = order.side === "BUY" || order.side === "COVER";

        if (hasStop(order.orderType)) {
          // A triggered stop has stopped waiting for its stop. A STOP_LIMIT is
          // now waiting on its limit; anything else is waiting only for a fill.
          if (order.triggeredAt) {
            return order.orderType === "STOP_LIMIT" ? (
              <span className="text-ink-dim">
                <span className="text-accent">Triggered</span> · {order.symbol}{" "}
                {paying ? "at or below" : "at or above"}{" "}
                <span className="num text-ink">{money(order.limitPrice)}</span>
              </span>
            ) : (
              <span className="text-accent">Triggered — filling at the market</span>
            );
          }

          const through = paying ? "at or above" : "at or below";
          return (
            <span className="text-ink-dim">
              {order.symbol} {through}{" "}
              <span className="num text-ink">{money(order.stopPrice)}</span>
              {order.orderType === "TRAILING_STOP" && (
                <span className="text-ink-faint">
                  {" "}
                  · trails {order.trailPercent ? `${money(order.trailPercent)}%` : money(order.trailAmount)}
                </span>
              )}
            </span>
          );
        }

        return (
          <span className="text-ink-dim">
            {order.symbol} {paying ? "at or below" : "at or above"}{" "}
            <span className="num text-ink">{money(order.limitPrice)}</span>
          </span>
        );
      },
    },
    {
      key: "held",
      header: "Held",
      align: "right",
      width: "7rem",
      sortValue: (order) => Number(order.reservedCash),
      render: (order) =>
        Number(order.reservedCash) > 0 ? (
          <span className="num text-ink-dim">{money(order.reservedCash)}</span>
        ) : Number(order.reservedQty) > 0 ? (
          <span className="num text-ink-dim">{shares(order.reservedQty)} sh</span>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
    {
      key: "timeInForce",
      header: "Good for",
      width: "8rem",
      sortValue: (order) => order.timeInForce,
      render: (order) => (
        <span className="text-ink-faint">
          {order.timeInForce === "GTC"
            ? "Until cancelled"
            : order.expiresAt
              ? stampET(order.expiresAt)
              : "Next close"}
        </span>
      ),
    },
    {
      key: "cancel",
      header: "",
      align: "right",
      width: "5rem",
      render: (order) => (
        <button
          type="button"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(order.id)}
          className="keycap cursor-pointer transition-colors hover:border-loss hover:text-loss disabled:cursor-not-allowed disabled:text-ink-faint"
        >
          CANCEL
        </button>
      ),
    },
  ];

  return (
    <Panel
      title="Working orders"
      meta={
        isError ? (
          <span className="text-loss">Unavailable</span>
        ) : isLoading ? (
          <span className="pulse-dot">Loading</span>
        ) : resting.length === 0 ? null : (
          <span>
            {resting.length} waiting
            {reservedCash > 0 && (
              <>
                <span className="text-ink-faint"> · </span>
                {money(reservedCash)} held
              </>
            )}
            {!marketOpen && (
              <>
                <span className="text-ink-faint"> · </span>
                <span className="text-ink-dim">nothing fills until the open</span>
              </>
            )}
          </span>
        )
      }
      flush
    >
      <DataGrid
        columns={columns}
        rows={resting}
        rowKey={(order) => order.id}
        defaultSort="placedAt"
        empty="No working orders. An order placed while the market is shut waits here."
      />

      {cancel.error && (
        <p role="alert" className="border-t border-line px-2.5 py-1.5 text-loss">
          {cancel.error.message}
        </p>
      )}

      {/* Recently resolved, for the member who comes back on Monday wanting to
          know what became of Sunday's queue. Rejections carry their reason,
          which is the whole point of keeping them visible. */}
      {resolved.length > 0 && (
        <div className="border-t border-line">
          <div className="label px-2.5 py-1.5">Recently resolved</div>
          <ul className="pb-1">
            {resolved.slice(0, 6).map((order) => (
              <li key={order.id} className="row flex items-center gap-2 px-2.5">
                <span className="num w-14 shrink-0 text-ink-dim">{order.symbol}</span>
                <span className="num w-14 shrink-0 text-ink-faint">{order.side}</span>
                <span className={`label shrink-0 ${RESOLVED_TONE[order.status] ?? "text-ink-dim"}`}>
                  {order.status}
                </span>
                <span className="truncate text-ink-faint">
                  {order.rejectReason ??
                    (order.resolvedAt ? stampET(order.resolvedAt) : "")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
