import { useBlotter } from "@/hooks/usePortfolio";
import { money, moneySigned, shares, stampET } from "@/lib/format";
import type { Trade, TradeSide } from "@/lib/api";
import { formatContract } from "@/lib/symbols";
import { DataGrid, type Column } from "./DataGrid";
import { Panel, type PanelTab } from "./Panel";
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

const SIDE_COLOR: Record<TradeSide, string> = {
  BUY: "text-ink",
  SELL: "text-ink",
  SHORT: "text-loss",
  COVER: "text-gain",
  // Dimmed, because nobody placed it. An expiry is something that happened to
  // the member rather than something they did, and the blotter should read
  // that way at a glance.
  EXPIRE: "text-ink-dim",
};

export function Blotter({
  limit = 100,
  tabs,
  activeTab,
  onTabChange,
}: {
  limit?: number;
  /** Present when the blotter shares its panel with another view — see F2. */
  tabs?: PanelTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
}) {
  const { trades, note, isLoading, isError } = useBlotter(limit);

  const columns: Column<Trade>[] = [
    {
      // The blotter is ordered by time and read newest-first, so on a phone
      // the position in the list is most of what the stamp was saying.
      key: "executedAt",
      header: "Time ET",
      width: "7.5rem",
      hideOnMobile: true,
      sortValue: (trade) => trade.executedAt,
      render: (trade) => <span className="num text-ink-dim">{stampET(trade.executedAt)}</span>,
    },
    {
      key: "symbol",
      header: "Sym",
      width: "9.5rem",
      sortValue: (trade) => trade.symbol,
      // A contract is shown as a contract. The raw OCC symbol is what settles
      // the money and what the API takes, so it stays one hover away rather
      // than being lost.
      // `whitespace-nowrap` for the same reason F1's grid carries it: the
      // pretty contract form is the one value here with spaces in it, and in a
      // narrow column it wraps out of a fixed-height row.
      render: (trade) => (
        <span className="num whitespace-nowrap text-ink" title={trade.symbol}>
          {formatContract(trade.symbol)}
        </span>
      ),
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
      // Qty times price, on a row that already carries both.
      key: "notional",
      header: "Value",
      align: "right",
      width: "7rem",
      hideOnMobile: true,
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
  // would make the total look diluted rather than large. An expiry closes a
  // position as surely as a sale does, and a contract that expired worthless is
  // the one loss a member most needs counted.
  const realised = trades
    .filter((trade) => trade.side !== "BUY" && trade.side !== "SHORT")
    .reduce((sum, trade) => sum + Number(trade.realizedPnl), 0);

  return (
    <Panel
      title="Blotter"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={onTabChange}
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
