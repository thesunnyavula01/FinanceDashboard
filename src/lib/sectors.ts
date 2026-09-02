import type { ValuedPosition } from "./portfolio";

/**
 * Sector exposure, from positions the client already has.
 *
 * There is no endpoint behind this and there should not be one. The positions
 * come from /api/portfolio, the prices from /api/quotes, and the sector labels
 * from /api/market/securities — three things the dashboard is already holding.
 * Grouping them is a fold over a few dozen rows, so it happens here and ticks
 * with the prices instead of waiting on a round trip.
 *
 * Exposure is measured **gross**: a short counts by its absolute value, not
 * against the longs. A member who is $10k long energy and $10k short energy is
 * not un-exposed to energy — they have two positions that can both go wrong,
 * and a netted bar of zero would say the opposite. The net is reported too,
 * because the direction of the bet is the other half of the picture.
 */

export interface SectorExposure {
  sector: string;
  /** Long + |short|. This is what the bar measures and what `weight` divides. */
  gross: number;
  longMv: number;
  /** Positive magnitude of the short side. */
  shortMv: number;
  /** Signed: negative when the member is net short this sector. */
  net: number;
  /** Share of the portfolio's gross exposure, 0-100. */
  weight: number;
  /** Fraction of this sector's own bar that is long, 0-1. Drives the split bar. */
  longShare: number;
  dayPnl: number;
  pnl: number;
  /**
   * The day's move as a return on the sector's own gross exposure, in percent.
   * Defined once, here, because the grid prints this number and the exposure
   * map colours its tiles by the per-position version of it — two things on
   * screen together that must not disagree about which way a sector went.
   */
  dayReturn: number;
  positions: number;
  /** Largest holding in the sector first. */
  symbols: string[];
  /** The rows themselves, largest first. What the map and the drill-down draw. */
  holdings: ValuedPosition[];
}

/**
 * Every bucket a position can land in.
 *
 * Duplicated from `worker/market/sectors.ts`, which is the authority and cannot
 * be imported here — `tsconfig.app.json` includes only `src`, and worker modules
 * import each other with explicit `.ts` extensions. The client already keeps its
 * own copy of the "Unclassified" literal a few lines down for the same reason.
 * Used only to say how many of the possible buckets a member is actually in.
 */
export const ALL_SECTORS = [
  "Information Technology",
  "Health Care",
  "Financials",
  "Consumer Discretionary",
  "Communication Services",
  "Industrials",
  "Consumer Staples",
  "Energy",
  "Utilities",
  "Real Estate",
  "Materials",
  "ETF / Fund",
  "Crypto",
  "Unclassified",
] as const;

/**
 * Where a club stops being diversified and starts having a view.
 *
 * Not a rule — nothing is blocked at 40% and nothing should be. It is the
 * number a beginner needs a prompt at, and the chart draws it as a line on the
 * track so crossing it is something you see rather than something you compute.
 */
export const CONCENTRATION_LIMIT = 40;

export interface SectorBreakdown {
  sectors: SectorExposure[];
  /** Total gross exposure. Cash is not in here — this is what is at risk. */
  gross: number;
  /** Sectors past the concentration line, largest first. */
  concentrated: SectorExposure[];
}

/**
 * One position's move today, as a return on what it is worth.
 *
 * Not the price's day change. A short is a negative `qty`, so `dayPnl` is
 * already positive when the price falls, and dividing by the magnitude of the
 * market value keeps that sign — a winning short reads green here exactly as it
 * does in the P/L column. Colouring by the price's own move would paint it red.
 *
 * `null` means the session has no previous close to measure against yet, which
 * is a different thing from a flat day and has to look different on screen.
 */
export function positionDayReturn(row: ValuedPosition): number | null {
  if (row.prevClose === null) return null;
  const magnitude = Math.abs(row.marketValue);
  return magnitude === 0 ? 0 : (row.dayPnl / magnitude) * 100;
}

export function sectorBreakdown(rows: ValuedPosition[]): SectorBreakdown {
  const buckets = new Map<string, SectorExposure>();

  for (const row of rows) {
    // A position with no sector yet is its own bucket rather than being folded
    // into a real one. "Unclassified" showing up on screen is the prompt to add
    // a mapping in worker/market/sectors.ts; silently landing in Industrials
    // would skew the chart and never be noticed.
    const sector = row.sector && row.sector !== "—" ? row.sector : "Unclassified";

    const bucket = buckets.get(sector) ?? {
      sector,
      gross: 0,
      longMv: 0,
      shortMv: 0,
      net: 0,
      weight: 0,
      longShare: 0,
      dayPnl: 0,
      pnl: 0,
      dayReturn: 0,
      positions: 0,
      symbols: [],
      holdings: [],
    };

    const magnitude = Math.abs(row.marketValue);
    bucket.gross += magnitude;
    bucket.net += row.marketValue;
    if (row.qty > 0) bucket.longMv += magnitude;
    else bucket.shortMv += magnitude;
    bucket.dayPnl += row.dayPnl;
    bucket.pnl += row.pnl;
    bucket.positions += 1;
    bucket.holdings.push(row);

    buckets.set(sector, bucket);
  }

  const gross = [...buckets.values()].reduce((sum, bucket) => sum + bucket.gross, 0);

  const sectors = [...buckets.values()]
    .map((bucket) => {
      // Sorted in place once, so `symbols` and `holdings` are the same order —
      // the drill-down lists what the map draws, top-left first.
      const holdings = [...bucket.holdings].sort(
        (a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue),
      );

      return {
        ...bucket,
        weight: gross === 0 ? 0 : (bucket.gross / gross) * 100,
        longShare: bucket.gross === 0 ? 0 : bucket.longMv / bucket.gross,
        dayReturn: bucket.gross === 0 ? 0 : (bucket.dayPnl / bucket.gross) * 100,
        holdings,
        symbols: holdings.map((holding) => holding.symbol),
      };
    })
    .sort((a, b) => b.gross - a.gross);

  return {
    sectors,
    gross,
    concentrated: sectors.filter((sector) => sector.weight > CONCENTRATION_LIMIT),
  };
}
