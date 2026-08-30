import { useMemo } from "react";
import { Panel } from "@/components/terminal/Panel";
import { DataGrid, type Column } from "@/components/terminal/DataGrid";
import { StatStrip, type Stat } from "@/components/terminal/StatStrip";
import { Value } from "@/components/terminal/Value";
import { money, moneySigned, percent, shares, signColor, weight } from "@/lib/format";
import {
  derive,
  SAMPLE_CASH,
  SAMPLE_POSITIONS,
  type DerivedPosition,
} from "./sampleData";

export function Positions() {
  const { rows, totals } = useMemo(() => derive(SAMPLE_POSITIONS, SAMPLE_CASH), []);

  const stats: Stat[] = [
    {
      label: "Net asset value",
      hero: true,
      value: <Value value={totals.equity}>{money(totals.equity)}</Value>,
      sub: (
        <Value value={totals.totalPnl} colorBySign>
          {`${moneySigned(totals.totalPnl)}  ${percent(totals.totalPnlPercent)}`}
        </Value>
      ),
    },
    {
      label: "Day P/L",
      value: (
        <Value value={totals.dayPnl} colorBySign>
          {moneySigned(totals.dayPnl)}
        </Value>
      ),
    },
    {
      label: "Cash",
      value: <Value value={SAMPLE_CASH}>{money(SAMPLE_CASH)}</Value>,
    },
    {
      label: "Buying power",
      value: <Value value={totals.buyingPower}>{money(totals.buyingPower)}</Value>,
      sub: <span className="label label-ink">{money(totals.marginHeld)} margin held</span>,
    },
    {
      label: "Long / Short",
      value: (
        <span className="num">
          {money(totals.longMv)}
          <span className="text-ink-faint"> / </span>
          {money(totals.shortMv)}
        </span>
      ),
    },
    {
      label: "Positions",
      value: <span className="num">{rows.length}</span>,
    },
  ];

  const columns: Column<DerivedPosition>[] = [
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
      key: "name",
      header: "Name",
      width: "18rem",
      sortValue: (r) => r.name,
      render: (r) => <span className="truncate text-ink-dim">{r.name}</span>,
    },
    {
      // Fills the slack between the name and the numbers with something worth
      // reading. It is also the column Phase 5's sector breakdown is built on.
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

  return (
    <div className="flex h-full flex-col">
      <StatStrip stats={stats} />

      <div className="border-b border-line bg-accent-wash px-3 py-1.5">
        <span className="label text-accent">Sample data</span>
        <span className="ml-2 text-ink-dim">
          These positions are hard-coded to demonstrate the design system. Live prices arrive in
          Phase 3, real trading in Phase 4.
        </span>
      </div>

      <div className="min-h-0 flex-1 p-2.5">
        <Panel
          title="Positions"
          meta={
            <span className={signColor(totals.dayPnl)}>
              {rows.length} holdings · {moneySigned(totals.dayPnl)} today
            </span>
          }
          flush
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.symbol}
            defaultSort="marketValue"
            empty="No positions yet. Press F2 to place your first trade."
          />
        </Panel>
      </div>
    </div>
  );
}
