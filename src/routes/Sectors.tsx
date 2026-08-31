import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Panel } from "@/components/terminal/Panel";
import { DataGrid, type Column } from "@/components/terminal/DataGrid";
import { MarginWarning, PortfolioStats } from "@/components/terminal/PortfolioStats";
import { ConcentrationWarning, SectorBar } from "@/components/terminal/SectorBars";
import { Value } from "@/components/terminal/Value";
import { usePortfolio } from "@/hooks/usePortfolio";
import { money, moneySigned, weight as formatWeight } from "@/lib/format";
import { CONCENTRATION_LIMIT, sectorBreakdown, type SectorExposure } from "@/lib/sectors";

/**
 * F4 — where the money actually sits.
 *
 * The positions grid answers "what do I own"; this answers "what am I exposed
 * to", which is a different question and usually a more uncomfortable one. Six
 * holdings that all turn out to be semiconductors is one bet, not six, and the
 * only screen that will ever say so is this one.
 *
 * Sectors come from Finnhub, looked up once per ticker and then kept in the
 * `securities` table forever. Everything else on this screen is arithmetic over
 * data the dashboard already holds, so the numbers tick with the prices.
 */
export function Sectors() {
  const navigate = useNavigate();
  const { rows, totals, note, isLoading, isError, pricesUnavailable } = usePortfolio();

  const { sectors, gross, concentrated } = useMemo(() => sectorBreakdown(rows), [rows]);

  const columns: Column<SectorExposure>[] = [
    {
      key: "sector",
      header: "Sector",
      width: "12rem",
      sortValue: (s) => s.sector,
      render: (s) => <span className="truncate text-ink">{s.sector}</span>,
    },
    {
      key: "bar",
      header: "Exposure",
      sortValue: (s) => s.gross,
      render: (s) => <SectorBar sector={s} />,
    },
    {
      key: "weight",
      header: "Wt",
      align: "right",
      width: "5rem",
      sortValue: (s) => s.weight,
      // Not a <Value>: the concentration colour would collide with the one
      // Value picks for itself, and which of two text-* classes wins depends on
      // stylesheet order rather than on anything visible here.
      render: (s) => (
        <span className={`num ${s.weight > CONCENTRATION_LIMIT ? "text-accent" : "text-ink"}`}>
          {formatWeight(s.weight)}
        </span>
      ),
    },
    {
      key: "gross",
      header: "Exposure $",
      align: "right",
      width: "8rem",
      sortValue: (s) => s.gross,
      render: (s) => <Value value={s.gross}>{money(s.gross)}</Value>,
    },
    {
      key: "net",
      header: "Net",
      align: "right",
      width: "8rem",
      sortValue: (s) => s.net,
      // Deliberately not coloured by sign. A negative net means net *short*,
      // which is a direction, not a loss, and colouring it red would put it in
      // the same visual language as a P/L figure two columns over.
      render: (s) => (
        <span className="num text-ink-dim">
          {s.net < 0 ? `(${money(Math.abs(s.net))})` : money(s.net)}
        </span>
      ),
    },
    {
      key: "dayPnl",
      header: "Day",
      align: "right",
      width: "6.5rem",
      sortValue: (s) => s.dayPnl,
      render: (s) => (
        <Value value={s.dayPnl} colorBySign>
          {moneySigned(s.dayPnl)}
        </Value>
      ),
    },
    {
      key: "pnl",
      header: "P/L",
      align: "right",
      width: "7.5rem",
      sortValue: (s) => s.pnl,
      render: (s) => (
        <Value value={s.pnl} colorBySign>
          {moneySigned(s.pnl)}
        </Value>
      ),
    },
    {
      key: "symbols",
      header: "Holdings",
      width: "14rem",
      sortValue: (s) => s.positions,
      render: (s) => (
        <span className="num truncate text-ink-faint">
          {s.symbols.slice(0, 4).join(" ")}
          {s.symbols.length > 4 && ` +${s.symbols.length - 4}`}
        </span>
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

  // Cash is not exposure, so it is not a bar — but a member who is 60% cash
  // should see that here rather than conclude they are fully invested in the
  // three sectors that are drawn.
  const cashShare = totals.equity === 0 ? 0 : (totals.cash / totals.equity) * 100;

  return (
    <div className="flex h-full flex-col">
      <PortfolioStats totals={totals} positionCount={rows.length} />
      <MarginWarning totals={totals} />
      <ConcentrationWarning sectors={concentrated} />

      <div className="min-h-0 flex-1 p-2.5">
        <Panel
          title="Sector exposure"
          meta={
            <span className="flex items-center gap-2">
              {isError ? (
                <span className="text-loss">Portfolio unavailable</span>
              ) : pricesUnavailable ? (
                <span className="text-loss">Prices unavailable — showing cost basis</span>
              ) : sectors.length > 0 ? (
                <>
                  <span className="text-ink-dim">
                    {money(gross)} gross across {sectors.length} sector
                    {sectors.length > 1 ? "s" : ""}
                  </span>
                  <span className="text-ink-faint">·</span>
                  <span className="text-ink-faint">
                    {formatWeight(cashShare)} cash · bar shows share of gross, line at 40%
                  </span>
                </>
              ) : null}
            </span>
          }
          flush
        >
          <DataGrid
            columns={columns}
            rows={sectors}
            rowKey={(s) => s.sector}
            defaultSort="gross"
            // Clicking a sector opens the ticket on its largest holding, which
            // is almost always the position a member is reacting to.
            onRowClick={(s) =>
              s.symbols[0] &&
              navigate("/trade", { state: { order: { symbol: s.symbols[0] } } })
            }
            empty="No positions yet. Press F2 to place your first trade."
          />
        </Panel>
      </div>
    </div>
  );
}
