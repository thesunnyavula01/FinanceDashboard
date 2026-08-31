import { useNavigate } from "react-router-dom";
import { Panel } from "@/components/terminal/Panel";
import { DataGrid, type Column } from "@/components/terminal/DataGrid";
import { MarginWarning, PortfolioStats } from "@/components/terminal/PortfolioStats";
import { Value } from "@/components/terminal/Value";
import { EquityCurve } from "@/components/charts/EquityCurve";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useHistory } from "@/hooks/useHistory";
import { clockET, money, moneySigned, percent, shares, signColor, weight } from "@/lib/format";
import type { ValuedPosition } from "@/lib/portfolio";

/**
 * F1 — the portfolio.
 *
 * The curve on top and the grid underneath answer the two halves of the same
 * question: how the season has gone, and what is carrying it right now. They
 * are stacked rather than tabbed because a member checking one almost always
 * wants a glance at the other, and a tab would cost a click to find out that
 * today's loss is one position.
 *
 * Everything here is real: holdings from the database, prices from the quote
 * cache, sectors from the securities table, and the curve replayed from the
 * blotter against each session's official close. Clicking a row opens the order
 * ticket on that symbol, which is the path most members take to a trade.
 */
export function Positions() {
  const navigate = useNavigate();
  const { rows, totals, note, asOf, atLastClose, isLoading, isError, pricesUnavailable } =
    usePortfolio();

  const {
    history,
    range,
    setRange,
    isLoading: historyLoading,
    isError: historyError,
  } = useHistory("ALL");

  const columns: Column<ValuedPosition>[] = [
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
          {r.stale && (
            <span className="label" title="No live price; shown at average cost">
              ?
            </span>
          )}
        </span>
      ),
    },
    {
      key: "name",
      header: "Name",
      width: "18rem",
      sortValue: (r) => r.name,
      render: (r) => <span className="truncate text-ink-dim">{r.name}</span>,
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
      key: "avgCost",
      header: "Avg cost",
      align: "right",
      width: "6rem",
      sortValue: (r) => r.avgCost,
      render: (r) => (
        <Value value={r.avgCost} dim>
          {money(r.avgCost)}
        </Value>
      ),
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
      key: "dayPnl",
      header: "Day",
      align: "right",
      width: "6rem",
      sortValue: (r) => r.dayPnl,
      render: (r) => (
        <Value value={r.dayPnl} colorBySign>
          {moneySigned(r.dayPnl)}
        </Value>
      ),
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
      key: "pnlPercent",
      header: "P/L %",
      align: "right",
      width: "5.5rem",
      sortValue: (r) => r.pnlPercent,
      render: (r) => (
        <Value value={r.pnlPercent} colorBySign>
          {percent(r.pnlPercent)}
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

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label pulse-dot">Loading your portfolio</span>
      </div>
    );
  }

  if (note) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-ink-dim">{note}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PortfolioStats totals={totals} positionCount={rows.length} />
      <MarginWarning totals={totals} />

      {/*
        Curve on top, grid underneath, in a fixed ratio at every width. The two
        answer the halves of one question — how the season has gone, and what is
        carrying it right now — and a member checking either usually wants a
        glance at the other, which is what a tab here would cost them.
      */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(19rem,1fr)_minmax(14rem,1fr)] gap-2.5 p-2.5">
        <EquityCurve
          history={history}
          range={range}
          onRangeChange={setRange}
          isLoading={historyLoading}
          isError={historyError}
        />

        <Panel
          title="Positions"
          meta={
            <span className="flex items-center gap-2">
              {rows.length > 0 && (
                <>
                  <span className={signColor(totals.dayPnl)}>
                    {rows.length} holdings · {moneySigned(totals.dayPnl)} today
                  </span>
                  <span className="text-ink-faint">·</span>
                </>
              )}
              {isError ? (
                <span className="text-loss">Portfolio unavailable</span>
              ) : pricesUnavailable ? (
                <span className="text-loss">Prices unavailable — showing cost basis</span>
              ) : rows.length === 0 ? null : (
                <span className="text-ink-dim">
                  {atLastClose ? "At last close" : "Live"}
                  {asOf && ` ${clockET(new Date(asOf))} ET`}
                </span>
              )}
            </span>
          }
          flush
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.symbol}
            defaultSort="marketValue"
            // The grid is the fastest route to the ticket: a member looking at
            // a position that has moved wants to act on that position.
            onRowClick={(r) =>
              navigate("/trade", { state: { order: { symbol: r.symbol } } })
            }
            empty="No positions yet. Press F2 to place your first trade."
          />
        </Panel>
      </div>
    </div>
  );
}
