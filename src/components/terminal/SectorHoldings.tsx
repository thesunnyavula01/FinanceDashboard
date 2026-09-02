import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Panel } from "./Panel";
import { DataGrid, type Column } from "./DataGrid";
import { Value } from "./Value";
import { money, moneySigned, percent, signColor, weight as formatWeight } from "@/lib/format";
import { positionDayReturn, type SectorExposure } from "@/lib/sectors";
import type { ValuedPosition } from "@/lib/portfolio";
import type { Security } from "@/lib/api";

/**
 * What is actually inside a sector.
 *
 * This is the panel that answers the question the rest of the screen keeps
 * raising and cannot settle. "Information Technology, 42%" is one bar whether
 * it is six semiconductor names or a semiconductor, a payments network and a
 * database company — and those are not the same bet at all. Finnhub's finer
 * `industry` label is the thing that separates them. It has been arriving in
 * the browser on every securities lookup since Phase 3 and has never been drawn
 * anywhere until now.
 *
 * With nothing selected it lists the whole book by size and the column shows
 * the sector, because that is the useful label when you are looking across
 * sectors. Selecting one swaps it to the industry, because by then the sector
 * is a constant and is written in the panel title.
 */
export function SectorHoldings({
  sector,
  rows,
  securities,
  onClear,
  note,
}: {
  /** The selected sector, or null for the whole book. */
  sector: SectorExposure | null;
  rows: ValuedPosition[];
  securities: Record<string, Security>;
  onClear: () => void;
  note?: string | null;
}) {
  const navigate = useNavigate();
  const filtered = sector !== null;

  const holdings = useMemo(
    () =>
      filtered
        ? sector.holdings
        : [...rows].sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue)),
    [filtered, sector, rows],
  );

  const columns: Column<ValuedPosition>[] = [
    {
      key: "symbol",
      header: "Sym",
      width: "4.75rem",
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
      // One column, two jobs. Across the whole book the sector is the label
      // worth reading; inside one sector it is a constant already written in
      // the title, and the industry is the only thing that tells two holdings
      // in the same bucket apart.
      key: "class",
      header: filtered ? "Industry" : "Sector",
      sortValue: (r) => classify(r, securities, filtered),
      render: (r) => (
        <span className="truncate text-ink-faint">{classify(r, securities, filtered)}</span>
      ),
    },
    {
      key: "marketValue",
      header: "Value",
      align: "right",
      width: "6rem",
      sortValue: (r) => Math.abs(r.marketValue),
      render: (r) => <Value value={r.marketValue}>{money(r.marketValue)}</Value>,
    },
    {
      key: "dayReturn",
      header: "Day %",
      align: "right",
      width: "4.75rem",
      sortValue: (r) => positionDayReturn(r) ?? 0,
      // The same figure the map colours its tiles by. The two are on screen
      // together, so they are computed in one place — see positionDayReturn.
      render: (r) => {
        const day = positionDayReturn(r);
        return day === null ? (
          <span className="num text-ink-faint" title="No previous close yet this session">
            —
          </span>
        ) : (
          <Value value={day} colorBySign>
            {percent(day)}
          </Value>
        );
      },
    },
    {
      key: "pnl",
      header: "P/L",
      align: "right",
      width: "6rem",
      sortValue: (r) => r.pnl,
      render: (r) => (
        <Value value={r.pnl} colorBySign>
          {moneySigned(r.pnl)}
        </Value>
      ),
    },
  ];

  return (
    <Panel
      title={filtered ? `Holdings · ${sector.sector}` : "Holdings"}
      meta={
        <span className="flex flex-wrap items-center gap-2">
          {filtered ? (
            <>
              {/* Deliberately terse. The panel is a rail, its title already
                  carries the sector name, and the gross figure is in the grid
                  immediately to the left — spelling both out again wraps this
                  header onto a second line and breaks the 28px row. */}
              <span className="text-ink-dim">{formatWeight(sector.weight)} of gross</span>
              <span className={signColor(sector.dayPnl)}>{moneySigned(sector.dayPnl)}</span>
              <button
                type="button"
                onClick={onClear}
                className="cursor-pointer uppercase text-accent hover:underline"
              >
                Show all
              </button>
            </>
          ) : (
            <span className="text-ink-faint">
              {holdings.length} holding{holdings.length === 1 ? "" : "s"} · select a sector to
              filter
            </span>
          )}
        </span>
      }
      flush
    >
      {note ? (
        <div className="flex h-24 items-center justify-center px-4 text-center text-ink-faint">
          {note}
        </div>
      ) : (
        <DataGrid
          columns={columns}
          rows={holdings}
          rowKey={(r) => r.symbol}
          defaultSort="marketValue"
          // The precise version of what the sector grid used to do. Clicking a
          // sector opened the ticket on its largest holding, which was a guess;
          // here the member picks the symbol themselves.
          onRowClick={(r) => navigate("/trade", { state: { order: { symbol: r.symbol } } })}
          empty="No positions yet. Press F2 to place your first trade."
        />
      )}
    </Panel>
  );
}

function classify(
  row: ValuedPosition,
  securities: Record<string, Security>,
  filtered: boolean,
): string {
  if (!filtered) return row.sector;
  // An ETF has no industry and a freshly-traded ticker has not been enriched
  // yet. Falling back to the sector says something true in both cases.
  return securities[row.symbol]?.industry ?? row.sector;
}
