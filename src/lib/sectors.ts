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
  positions: number;
  /** Largest holding in the sector first. */
  symbols: string[];
}

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

export function sectorBreakdown(rows: ValuedPosition[]): SectorBreakdown {
  const buckets = new Map<string, SectorExposure & { holdings: ValuedPosition[] }>();

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
    .map(({ holdings, ...bucket }) => ({
      ...bucket,
      weight: gross === 0 ? 0 : (bucket.gross / gross) * 100,
      longShare: bucket.gross === 0 ? 0 : bucket.longMv / bucket.gross,
      symbols: holdings
        .sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue))
        .map((holding) => holding.symbol),
    }))
    .sort((a, b) => b.gross - a.gross);

  return {
    sectors,
    gross,
    concentrated: sectors.filter((sector) => sector.weight > CONCENTRATION_LIMIT),
  };
}
