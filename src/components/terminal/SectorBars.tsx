import { CONCENTRATION_LIMIT, type SectorExposure } from "@/lib/sectors";
import { money, weight as formatWeight } from "@/lib/format";

/**
 * One sector's exposure, as a bar.
 *
 * The track is the whole portfolio, so a bar's length is its share of gross
 * exposure directly — no rescaling to the largest sector, which would make a
 * diversified book look concentrated and hide the one thing this chart is for.
 * A well-spread portfolio draws short bars. That is the correct picture.
 *
 * The bar is split rather than solid: amber for what is held long, loss-red for
 * what is held short. A sector can be both, and a single solid bar would say
 * "40% technology" without saying whether that is a bet on it or against it.
 *
 * The hairline at 40% is the concentration line. Drawing it on the track means
 * crossing it is something the eye catches at a glance, which is the only way a
 * threshold is any use on a screen someone looks at for two seconds.
 */
export function SectorBar({ sector }: { sector: SectorExposure }) {
  const longWidth = sector.weight * sector.longShare;
  const shortWidth = sector.weight - longWidth;
  const over = sector.weight > CONCENTRATION_LIMIT;

  return (
    <div
      className="relative h-2.5 w-full bg-panel-hi"
      role="img"
      aria-label={`${sector.sector}: ${formatWeight(sector.weight)} of gross exposure${
        over ? ", over the 40 percent concentration line" : ""
      }`}
    >
      {/*
        inset-0, not inset-y-0 + left-0. Without a right edge this box is
        shrink-to-fit, so the segments' percentage widths would resolve against
        an auto width that is itself derived from them — and every bar collapses
        to nothing. The percentages have to measure the whole track.
      */}
      <div className="absolute inset-0 flex">
        <div style={{ width: `${longWidth}%` }} className="bg-accent" />
        <div style={{ width: `${shortWidth}%` }} className="bg-loss" />
      </div>

      {/* The concentration line, always in the same place on every row. */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 w-px ${over ? "bg-loss" : "bg-line-hi"}`}
        style={{ left: `${CONCENTRATION_LIMIT}%` }}
      />
    </div>
  );
}

/**
 * Shown when one sector has passed 40% of gross exposure.
 *
 * Nothing is blocked and nothing should be — a member who wants to put
 * everything into semiconductors is allowed to, and finding out how that feels
 * is most of the point of a paper season. The banner names the sector and the
 * number and then gets out of the way.
 */
export function ConcentrationWarning({ sectors }: { sectors: SectorExposure[] }) {
  if (sectors.length === 0) return null;

  // Weights are shares of one gross total, so at most two sectors can be past
  // 40% and the second is worth naming rather than counting.
  const [worst, second] = sectors;

  return (
    // Same shape as the margin and trading-locked banners: an inline label and
    // a sentence on a desktop, a heading over a paragraph on a phone, where the
    // sentence was always going to wrap under the label anyway.
    <div
      role="status"
      className="shrink-0 border-b border-accent-dim bg-accent-wash px-3 py-1.5 sm:flex sm:items-baseline sm:gap-2"
    >
      <span className="label block shrink-0 text-accent sm:inline">Concentrated</span>
      <span className="block text-ink-dim">
        {formatWeight(worst!.weight)} of your exposure — {money(worst!.gross)} — is in{" "}
        {worst!.sector}
        {second && `, and another ${formatWeight(second.weight)} is in ${second.sector}`}. One
        sector moving takes the portfolio with it.
      </span>
    </div>
  );
}
