import { useMemo, useState } from "react";
import { Panel } from "@/components/terminal/Panel";
import { DataGrid, type Column } from "@/components/terminal/DataGrid";
import { MarginWarning, PortfolioStats } from "@/components/terminal/PortfolioStats";
import { ConcentrationWarning, SectorBar } from "@/components/terminal/SectorBars";
import { Concentration } from "@/components/terminal/Concentration";
import { ExposureMap } from "@/components/terminal/ExposureMap";
import { ReturnBar, returnScale } from "@/components/terminal/ReturnBar";
import { SectorHoldings } from "@/components/terminal/SectorHoldings";
import { Value } from "@/components/terminal/Value";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useQuotes, useSecurities } from "@/hooks/useQuotes";
import { money, moneySigned, percent, weight as formatWeight } from "@/lib/format";
import { CONCENTRATION_LIMIT, sectorBreakdown, type SectorExposure } from "@/lib/sectors";

/**
 * F4 — where the money actually sits.
 *
 * The positions grid answers "what do I own"; this answers "what am I exposed
 * to", which is a different question and usually a more uncomfortable one. Six
 * holdings that all turn out to be semiconductors is one bet, not six, and the
 * only screen that will ever say so is this one.
 *
 * Four panels asking that question at four resolutions. The **map** is the
 * shape of the book, read by area rather than by arithmetic. The
 * **concentration** rail is that shape as seven figures, including the one that
 * says how many bets the book really is. The **grid** is the numeric authority
 * and now carries the day's move against SPY. The **drill-down** goes one level
 * finer than a sector, into Finnhub's industry label, which is the only thing
 * on the screen that can tell six semiconductor names apart from a diversified
 * technology sleeve.
 *
 * Selecting a sector in the grid filters the drill-down and dims the rest of
 * the map. That replaces the old behaviour, where clicking a sector jumped
 * straight to the ticket on its largest holding — a guess about which symbol
 * the member meant. The trade is one click further away and lands on the symbol
 * they actually chose.
 *
 * Sectors come from Finnhub, looked up once per ticker and then kept in the
 * `securities` table forever. Everything else on this screen is arithmetic over
 * data the dashboard already holds, so the numbers tick with the prices and
 * there is still no endpoint behind this screen.
 */
export function Sectors() {
  const { rows, totals, symbols, note, isLoading, isError, pricesUnavailable } = usePortfolio();

  // Both of these hit cache entries usePortfolio has already primed — useQuotes
  // and useSecurities sort and dedupe the symbol list into the query key, so
  // asking again for the same set costs nothing.
  const { securities } = useSecurities(symbols);

  // SPY is the one genuinely extra request on this screen: its own small cache
  // entry, for the hairline the sector day-move bars are measured against.
  const { quotes: benchmarkQuotes } = useQuotes(BENCHMARK);
  const spyDayPercent = benchmarkQuotes.SPY?.dayChangePercent ?? null;

  const { sectors, gross, concentrated } = useMemo(() => sectorBreakdown(rows), [rows]);

  const [selected, setSelected] = useState<string | null>(null);
  // Derived rather than synchronised. A member who closes their last energy
  // position while the sector is selected simply has no selection again, with
  // no effect to clean up after them.
  const selectedSector = sectors.find((s) => s.sector === selected) ?? null;

  const dayScale = useMemo(
    () => returnScale(sectors.map((s) => s.dayReturn), spyDayPercent),
    [sectors, spyDayPercent],
  );

  const columns: Column<SectorExposure>[] = [
    {
      key: "sector",
      header: "Sector",
      width: "8.5rem",
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
      width: "4rem",
      // Not a <Value>: the concentration colour would collide with the one
      // Value picks for itself, and which of two text-* classes wins depends on
      // stylesheet order rather than on anything visible here.
      sortValue: (s) => s.weight,
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
      width: "6.5rem",
      sortValue: (s) => s.gross,
      render: (s) => <Value value={s.gross}>{money(s.gross)}</Value>,
    },
    {
      key: "net",
      header: "Net",
      align: "right",
      width: "6.5rem",
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
      key: "dayBar",
      header: "Day vs SPY",
      width: "6.5rem",
      sortValue: (s) => s.dayReturn,
      render: (s) => (
        <ReturnBar value={s.dayReturn} scale={dayScale} benchmark={spyDayPercent} isMe />
      ),
    },
    {
      key: "dayReturn",
      header: "Day %",
      align: "right",
      width: "4.75rem",
      sortValue: (s) => s.dayReturn,
      render: (s) => (
        <Value value={s.dayReturn} colorBySign>
          {percent(s.dayReturn)}
        </Value>
      ),
    },
    {
      key: "pnl",
      header: "P/L",
      align: "right",
      width: "6.5rem",
      sortValue: (s) => s.pnl,
      render: (s) => (
        <Value value={s.pnl} colorBySign>
          {moneySigned(s.pnl)}
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

  // Cash is not exposure, so it is not a bar — but a member who is 60% cash
  // should see that here rather than conclude they are fully invested in the
  // three sectors that are drawn. The map draws it as a tile for the same
  // reason.
  const cashShare = totals.equity === 0 ? 0 : (totals.cash / totals.equity) * 100;

  const problem = isError
    ? "Portfolio unavailable"
    : pricesUnavailable
      ? "Prices unavailable — showing cost basis"
      : null;

  return (
    /*
      Two height regimes, and the screen is broken without both.

      At xl the height must be *definite*, because a column flex container whose
      own height is auto sizes a `flex-1` child to its max-content — so the
      concentration rail's seven metrics would set the height of the map, the
      grid and the drill-down, and the page would run to twice the viewport.
      `min-h-0` does not help: that is a minimum, and this is max-content sizing.

      Below xl the columns stack into four full-width panels, and holding those
      to the viewport would crush every one of them. So the height goes back to
      a floor, the rows size to their content, and <main> — already
      `min-h-0 flex-1 overflow-auto` — scrolls. Admin.tsx takes the same view.
    */
    <div className="flex min-h-full flex-col xl:h-full">
      <PortfolioStats totals={totals} positionCount={rows.length} />
      <MarginWarning totals={totals} />
      <ConcentrationWarning sectors={concentrated} />

      {/*
        The row ratio is an xl-and-up rule, and so is every column split below
        it, and so is min-h-0. At xl the grid is exactly the space left under
        the strip, the two rows divide it, and the screen fits with no page
        scroll. Once the panels stack there are four of them in a column, and
        holding them to the viewport would crush every one — so below xl the
        rows size to content, the flex item's own `min-height: auto` lets the
        page grow, and <main> scrolls. Same reasoning as Admin.tsx.
      */}
      <div className="grid flex-1 gap-2.5 p-2.5 xl:min-h-0 xl:grid-rows-[minmax(15rem,1.15fr)_minmax(14rem,1fr)]">
        <div className="grid min-h-0 gap-2.5 xl:grid-cols-[1fr_minmax(17rem,20rem)]">
          <ExposureMap
            sectors={sectors}
            cash={totals.cash}
            selected={selected}
            onSelect={setSelected}
            note={problem}
          />
          <Concentration
            sectors={sectors}
            rows={rows}
            totals={totals}
            securities={securities}
            note={problem}
          />
        </div>

        <div className="grid min-h-0 gap-2.5 xl:grid-cols-[1fr_minmax(22rem,28rem)]">
          <Panel
            title="Sector exposure"
            meta={
              <span className="flex flex-wrap items-center gap-2">
                {problem ? (
                  <span className="text-loss">{problem}</span>
                ) : sectors.length > 0 ? (
                  <>
                    <span className="text-ink-dim">
                      {money(gross)} gross · {formatWeight(cashShare)} cash
                    </span>
                    <span className="text-ink-faint">·</span>
                    <span className="text-ink-faint">
                      bar shows share of gross, line at 40%
                    </span>
                    {spyDayPercent !== null && (
                      <>
                        <span className="text-ink-faint">·</span>
                        {/* The grey hairline in the day column. A benchmark
                            nothing names is a mark nobody can read. */}
                        <span className="text-ink-faint">
                          SPY {percent(spyDayPercent)} today
                        </span>
                      </>
                    )}
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
              selectedKey={selected ?? undefined}
              // Selecting rather than navigating. The drill-down beside this
              // grid is where a trade starts now, on the symbol the member
              // picked instead of on this sector's largest holding.
              onRowClick={(s) => setSelected((current) => (current === s.sector ? null : s.sector))}
              empty="No positions yet. Press F2 to place your first trade."
            />
          </Panel>

          <SectorHoldings
            sector={selectedSector}
            rows={rows}
            securities={securities}
            onClear={() => setSelected(null)}
            note={problem}
          />
        </div>
      </div>
    </div>
  );
}

/** Its own query key, so it never disturbs the portfolio's shared quote entry. */
const BENCHMARK = ["SPY"];
