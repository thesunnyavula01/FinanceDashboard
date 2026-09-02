import { useMemo, type ReactNode } from "react";
import { Panel } from "./Panel";
import { money, weight as formatWeight } from "@/lib/format";
import { ALL_SECTORS, CONCENTRATION_LIMIT, type SectorExposure } from "@/lib/sectors";
import type { PortfolioTotals, ValuedPosition } from "@/lib/portfolio";
import type { Security } from "@/lib/api";

/**
 * How concentrated the book actually is.
 *
 * The bars next door show where the money sits; these are the seven figures
 * that say whether that shape is one bet or several. Nothing here is a result,
 * so nothing here is green or red — amber appears in exactly one place, on the
 * top sector once it crosses the 40% line, which is the same rule the grid's
 * weight column follows.
 *
 * **Effective bets** is the one worth explaining, and the panel explains it in
 * place: the inverse Herfindahl index, `1 / Σ(wᵢ²)`, over the sector weights.
 * Six sectors where one of them is 80% is not six bets, and this is the number
 * that says so — it reads 1.5 rather than 6. Evenly split across those same six
 * it reads 6.0. That gap is the whole point of the screen, in one figure.
 */
export function Concentration({
  sectors,
  rows,
  totals,
  securities,
  note,
}: {
  sectors: SectorExposure[];
  rows: ValuedPosition[];
  totals: PortfolioTotals;
  securities: Record<string, Security>;
  note?: string | null;
}) {
  const stats = useMemo(
    () => summarise({ sectors, rows, totals, securities }),
    [sectors, rows, totals, securities],
  );

  return (
    <Panel title="Concentration">
      {note ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-ink-faint">
          {note}
        </div>
      ) : sectors.length === 0 ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-ink-faint">
          Nothing held yet.
        </div>
      ) : (
        // Scrolls rather than clips when the rail is shorter than seven
        // metrics. With an auto-height parent this resolves to auto and the
        // panel simply grows instead, which is the stacked case.
        <div className="flex h-full flex-col gap-1.5 overflow-auto">
          <Metric
            label="Top sector"
            value={formatWeight(stats.topWeight)}
            sub={stats.topSector}
            tone={stats.topWeight > CONCENTRATION_LIMIT ? "text-accent" : undefined}
          />

          <Metric
            label="Top three"
            value={formatWeight(stats.topThreeWeight)}
            sub={`of ${money(stats.gross)} gross exposure`}
          />

          <Metric
            label="Effective bets"
            value={stats.effectiveBets.toFixed(1)}
            sub={`${stats.sectorCount} sector${
              stats.sectorCount === 1 ? "" : "s"
            } held — evenly split it would read ${stats.sectorCount.toFixed(1)}`}
          />

          <Metric
            label="Largest position"
            value={formatWeight(stats.largestWeight)}
            sub={stats.largestLabel}
          />

          <Composition totals={totals} />

          <Metric
            label="Funds"
            value={stats.fundShare === null ? "—" : formatWeight(stats.fundShare)}
            sub={
              stats.fundShare === null
                ? "Waiting on security profiles"
                : `${stats.fundCount} of ${stats.classified} holdings are ETFs`
            }
          />

          <Metric
            label="Sectors held"
            value={`${stats.sectorCount} / ${ALL_SECTORS.length}`}
            sub="of every bucket a position can land in"
          />
        </div>
      )}
    </Panel>
  );
}

/**
 * Long, short and cash as one bar.
 *
 * The same amber-long / red-short language the exposure bars use one panel
 * over, with cash in the track's own grey because it is the part of the account
 * that is not doing anything. This is the only place the three appear against
 * each other rather than as separate cells on the stat strip.
 */
function Composition({ totals }: { totals: PortfolioTotals }) {
  const base = totals.longMv + totals.shortMv + Math.abs(totals.cash);
  const share = (part: number) => (base === 0 ? 0 : (Math.abs(part) / base) * 100);

  return (
    <div className="border-b border-line/60 pb-1.5 last:border-0">
      <span className="label">Long · short · cash</span>

      <div className="relative mt-1.5 h-2.5 w-full bg-panel-hi">
        <div className="absolute inset-0 flex">
          <div style={{ width: `${share(totals.longMv)}%` }} className="bg-accent" />
          <div style={{ width: `${share(totals.shortMv)}%` }} className="bg-loss" />
          <div style={{ width: `${share(totals.cash)}%` }} className="bg-line-hi" />
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-3 gap-1">
        <Leg swatch="bg-accent" label="Long" value={money(totals.longMv)} />
        <Leg swatch="bg-loss" label="Short" value={money(totals.shortMv)} />
        <Leg swatch="bg-line-hi" label={totals.cash < 0 ? "Debit" : "Cash"} value={money(totals.cash)} />
      </div>
    </div>
  );
}

function Leg({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="flex items-center gap-1">
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 ${swatch}`} />
        <span className="label truncate">{label}</span>
      </span>
      <span className="num block truncate text-ink-dim">{value}</span>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = "text-ink",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="border-b border-line/60 pb-1.5 last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">{label}</span>
        <span className={`num shrink-0 text-lede ${tone}`}>{value}</span>
      </div>
      {sub ? <p className="mt-0.5 truncate text-ink-faint">{sub}</p> : null}
    </div>
  );
}

interface Summary {
  gross: number;
  sectorCount: number;
  topSector: string;
  topWeight: number;
  topThreeWeight: number;
  effectiveBets: number;
  largestWeight: number;
  largestLabel: string;
  /** Null until at least one security profile has landed. */
  fundShare: number | null;
  fundCount: number;
  classified: number;
}

function summarise({
  sectors,
  rows,
  totals,
  securities,
}: {
  sectors: SectorExposure[];
  rows: ValuedPosition[];
  totals: PortfolioTotals;
  securities: Record<string, Security>;
}): Summary {
  const gross = totals.longMv + totals.shortMv;
  const top = sectors[0];

  // Weights are already shares of gross out of 100, so the sum of their squares
  // over 10,000 is the Herfindahl index and its reciprocal is the count of
  // equally-sized sectors this book behaves like.
  const herfindahl = sectors.reduce((sum, sector) => sum + (sector.weight / 100) ** 2, 0);

  const largest = rows.reduce<ValuedPosition | null>(
    (best, row) =>
      best === null || Math.abs(row.marketValue) > Math.abs(best.marketValue) ? row : best,
    null,
  );

  // Only positions whose profile has arrived can be classified. Counting an
  // unknown as a single name would drift the split every time a new ticker is
  // looked up behind the first response.
  let fundGross = 0;
  let knownGross = 0;
  let fundCount = 0;
  let classified = 0;

  for (const row of rows) {
    const assetType = securities[row.symbol]?.assetType;
    if (!assetType) continue;

    const magnitude = Math.abs(row.marketValue);
    knownGross += magnitude;
    classified += 1;
    if (assetType === "ETF") {
      fundGross += magnitude;
      fundCount += 1;
    }
  }

  return {
    gross,
    sectorCount: sectors.length,
    topSector: top?.sector ?? "—",
    topWeight: top?.weight ?? 0,
    topThreeWeight: sectors.slice(0, 3).reduce((sum, sector) => sum + sector.weight, 0),
    effectiveBets: herfindahl === 0 ? 0 : 1 / herfindahl,
    largestWeight: largest?.weight ?? 0,
    largestLabel: largest ? `${largest.symbol} · ${largest.name}` : "—",
    fundShare: classified === 0 || knownGross === 0 ? null : (fundGross / knownGross) * 100,
    fundCount,
    classified,
  };
}
