import { useEffect } from "react";
import { Panel } from "./Panel";
import { DataGrid, type Column } from "./DataGrid";
import { Value } from "./Value";
import { useMemberBook } from "@/hooks/useLeaderboard";
import type { StandingsRow, Trade } from "@/lib/api";
import { money, moneySigned, percent, shares, signColor, stampET, weight } from "@/lib/format";
import type { ValuedPosition } from "@/lib/portfolio";

/**
 * Another member's book, opened from the standings.
 *
 * Every position and every fill, read-only. Members can already read each
 * other's holdings — that is deliberate, and the whole reason a club is worth
 * running: the useful part of a paper season is finding out what the person
 * two places above you actually bought.
 *
 * What is NOT here is their resting orders. Everything else is open on
 * purpose; a working order is intent rather than history, and publishing it
 * would invite the rest of the club to trade in front of it.
 */
export function MemberBook({
  row,
  onClose,
}: {
  row: StandingsRow;
  onClose: () => void;
}) {
  const { rows, totals, trades, isLoading, isError } = useMemberBook(row.portfolioId);

  // Escape closes, the way it does everywhere else in the terminal.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const positionColumns: Column<ValuedPosition>[] = [
    {
      key: "symbol",
      header: "Sym",
      width: "5.5rem",
      sortValue: (r) => r.symbol,
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <span className="num font-medium text-ink">{r.symbol}</span>
          {r.isShort && (
            <span className="label text-loss" title="Short position">
              S
            </span>
          )}
        </span>
      ),
    },
    {
      key: "sector",
      header: "Sector",
      sortValue: (r) => r.sector,
      render: (r) => <span className="truncate text-ink-faint">{r.sector}</span>,
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      width: "5rem",
      sortValue: (r) => r.qty,
      render: (r) => <Value value={r.qty}>{shares(r.qty)}</Value>,
    },
    {
      key: "last",
      header: "Last",
      align: "right",
      width: "6rem",
      sortValue: (r) => r.last,
      render: (r) => (
        <Value value={r.last} flash>
          {money(r.last)}
        </Value>
      ),
    },
    {
      key: "marketValue",
      header: "Market value",
      align: "right",
      width: "7.5rem",
      sortValue: (r) => Math.abs(r.marketValue),
      render: (r) => <Value value={r.marketValue}>{money(r.marketValue)}</Value>,
    },
    {
      key: "pnl",
      header: "P/L",
      align: "right",
      width: "7rem",
      sortValue: (r) => r.pnl,
      render: (r) => (
        <Value value={r.pnl} colorBySign>
          {moneySigned(r.pnl)}
        </Value>
      ),
    },
    {
      key: "weight",
      header: "Wt",
      align: "right",
      width: "4.5rem",
      sortValue: (r) => r.weight,
      render: (r) => (
        <Value value={r.weight} dim>
          {weight(r.weight)}
        </Value>
      ),
    },
  ];

  const tradeColumns: Column<Trade>[] = [
    {
      key: "executedAt",
      header: "Time",
      width: "7rem",
      sortValue: (t) => t.executedAt,
      render: (t) => <span className="num text-ink-faint">{stampET(t.executedAt)}</span>,
    },
    {
      key: "side",
      header: "Side",
      width: "4.5rem",
      sortValue: (t) => t.side,
      render: (t) => (
        <span
          className={`num ${t.side === "BUY" || t.side === "COVER" ? "text-ink" : "text-ink-dim"}`}
        >
          {t.side}
        </span>
      ),
    },
    {
      key: "symbol",
      header: "Sym",
      width: "5rem",
      sortValue: (t) => t.symbol,
      render: (t) => <span className="num text-ink">{t.symbol}</span>,
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      width: "5rem",
      sortValue: (t) => Number(t.qty),
      render: (t) => <Value value={t.qty}>{shares(t.qty)}</Value>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      width: "6rem",
      sortValue: (t) => Number(t.price),
      render: (t) => <Value value={t.price}>{money(t.price)}</Value>,
    },
    {
      key: "realizedPnl",
      header: "Realized",
      align: "right",
      width: "6.5rem",
      sortValue: (t) => Number(t.realizedPnl),
      render: (t) =>
        Number(t.realizedPnl) === 0 ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <Value value={t.realizedPnl} colorBySign>
            {moneySigned(t.realizedPnl)}
          </Value>
        ),
    },
  ];

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[1fr_1fr] gap-2.5 p-2.5">
      <Panel
        title={`#${row.rank} ${row.displayName}`}
        meta={
          <span className="flex items-center gap-2">
            <span className="text-ink-dim">{money(row.equity)}</span>
            <span className={signColor(row.totalReturn)}>{percent(row.totalReturn)}</span>
            <span className="text-ink-faint">·</span>
            <button
              type="button"
              onClick={onClose}
              className="keycap cursor-pointer transition-colors hover:border-accent hover:bg-accent hover:text-black"
            >
              ESC
            </button>
          </span>
        }
        flush
      >
        {isError ? (
          <div className="flex h-24 items-center justify-center text-loss">
            Could not load this member's positions.
          </div>
        ) : isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <span className="label pulse-dot">Loading</span>
          </div>
        ) : (
          <DataGrid
            columns={positionColumns}
            rows={rows}
            rowKey={(r) => r.symbol}
            defaultSort="marketValue"
            empty={`${row.displayName} holds nothing right now — it is all cash.`}
          />
        )}
      </Panel>

      <Panel
        title="Fills"
        meta={
          <span className="text-ink-faint">
            {trades.length > 0
              ? `${trades.length} most recent · ${money(totals.cash)} cash`
              : `${money(totals.cash)} cash`}
          </span>
        }
        flush
      >
        <DataGrid
          columns={tradeColumns}
          rows={trades}
          rowKey={(t) => t.id}
          defaultSort="executedAt"
          empty={`${row.displayName} has not traded yet.`}
        />
      </Panel>
    </div>
  );
}
