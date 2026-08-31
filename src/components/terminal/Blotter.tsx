import { useBlotter } from "@/hooks/usePortfolio";
import { money, moneySigned, shares, stampET } from "@/lib/format";
import type { OrderSide, Trade } from "@/lib/api";
import { DataGrid, type Column } from "./DataGrid";
import { Panel } from "./Panel";
import { Value } from "./Value";

/**
 * The trade blotter.
 *
 * A log of what happened, not a view of what is. Every number here was written
 * by place_order() at the moment of the fill and never moves again — which is
 * exactly why it is worth having next to the ticket: the positions grid shows a
 * P/L that changes every twenty seconds, and this shows the ones that are
 * settled.
 *
 * Realised P/L is blank on an opening fill rather than zero. A BUY does not
 * realise nothing; it does not realise at all, and a column of 0.00 down every
 * opening trade reads like a broken calculation.
 */

const SIDE_COLOR: Record<OrderSide, string> = {
  BUY: "text-ink",
  SELL: "text-ink",
  SHORT: "text-loss",
  COVER: "text-gain",
};

export function Blotter({ limit = 100 }: { limit?: number }) {
  const { trades, note, isLoading, isError } = useBlotter(limit);

  const columns: Column<Trade>[] = [
    {
      key: "executedAt",
      header: "Time ET",
      width: "7.5rem",
      sortValue: (trade) => trade.executedAt,
      render: (trade) => <span className="num text-ink-dim">{stampET(trade.executedAt)}</span>,
    },
    {
      key: "symbol",
      header: "Sym",
      width: "5rem",
      sortValue: (trade) => trade.symbol,
      render: (trade) => <span className="num text-ink">{trade.symbol}</span>,
    },
    {
      key: "side",
      header: "Side",
      width: "4.5rem",
      sortValue: (trade) => trade.side,
      render: (trade) => (
        <span className={`num ${SIDE_COLOR[trade.side] ?? "text-ink"}`}>{trade.side}</span>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      width: "5rem",
      sortValue: (trade) => Number(trade.qty),
      render: (trade) => <Value value={trade.qty}>{shares(trade.qty)}</Value>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      width: "6rem",
      sortValue: (trade) => Number(trade.price),
      render: (trade) => (
        <Value value={trade.price} dim>
          {money(trade.price)}
        </Value>
      ),
    },
    {
      key: "notional",
      header: "Value",
      align: "right",
      width: "7rem",
      sortValue: (trade) => Number(trade.notional),
      render: (trade) => <Value value={trade.notional}>{money(trade.notional)}</Value>,
    },
    {
      key: "realizedPnl",
      header: "Realised",
      align: "right",
      width: "6.5rem",
      sortValue: (trade) => Number(trade.realizedPnl),
      render: (trade) =>
        trade.side === "BUY" || trade.side === "SHORT" ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <Value value={trade.realizedPnl} colorBySign>
            {moneySigned(trade.realizedPnl)}
          </Value>
        ),
    },
  ];

  // Closing fills only — an opening trade realises nothing, so counting it
  // would make the total look diluted rather than large.
  const realised = trades
    .filter((trade) => trade.side === "SELL" || trade.side === "COVER")
    .reduce((sum, trade) => sum + Number(trade.realizedPnl), 0);

  return (
    <Panel
      title="Blotter"
      meta={
        isError ? (
          <span className="text-loss">Unavailable</span>
        ) : isLoading ? (
          <span className="pulse-dot">Loading</span>
        ) : trades.length === 0 ? null : (
          <span>
            {trades.length} fills
            <span className="text-ink-faint"> · </span>
            <span className={realised === 0 ? "text-ink-dim" : realised > 0 ? "text-gain" : "text-loss"}>
              {moneySigned(realised)} realised
            </span>
          </span>
        )
      }
      flush
    >
      <DataGrid
        columns={columns}
        rows={trades}
        rowKey={(trade) => trade.id}
        defaultSort="executedAt"
        empty={note ?? "No trades yet. Your first fill will appear here."}
      />
    </Panel>
  );
}
