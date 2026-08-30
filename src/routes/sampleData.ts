/**
 * SAMPLE DATA — not real, not fetched, not persisted.
 *
 * Phase 1 ships the design system with nothing behind it, so these rows exist
 * purely to prove the grid, the colour rules, and the signed-quantity maths
 * render correctly. Phase 4 deletes this file and the positions come from the
 * database.
 *
 * TSLA is intentionally short (negative qty) so the shared P/L formula gets
 * exercised in both directions from day one.
 */

export interface SamplePosition {
  symbol: string;
  name: string;
  sector: string;
  /** Negative means short. */
  qty: number;
  avgCost: number;
  last: number;
  prevClose: number;
}

export const SAMPLE_STARTING_CASH = 100_000;
export const SAMPLE_CASH = 27_551.1;

export const SAMPLE_POSITIONS: SamplePosition[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA Corp",
    sector: "Information Technology",
    qty: 40,
    avgCost: 176.2,
    last: 180.1,
    prevClose: 178.3,
  },
  {
    symbol: "AAPL",
    name: "Apple Inc",
    sector: "Information Technology",
    qty: 120,
    avgCost: 236.44,
    last: 234.25,
    prevClose: 236.9,
  },
  {
    symbol: "MSFT",
    name: "Microsoft Corp",
    sector: "Information Technology",
    qty: 30,
    avgCost: 410.1,
    last: 421.88,
    prevClose: 417.2,
  },
  {
    symbol: "JPM",
    name: "JPMorgan Chase & Co",
    sector: "Financials",
    qty: 55,
    avgCost: 221.05,
    last: 228.4,
    prevClose: 226.15,
  },
  {
    symbol: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    sector: "ETF / Fund",
    qty: 25,
    avgCost: 588.1,
    last: 594.22,
    prevClose: 592.05,
  },
  {
    symbol: "XOM",
    name: "Exxon Mobil Corp",
    sector: "Energy",
    qty: 80,
    avgCost: 112.4,
    last: 109.9,
    prevClose: 111.2,
  },
  {
    symbol: "TSLA",
    name: "Tesla Inc",
    sector: "Consumer Discretionary",
    qty: -15,
    avgCost: 242.8,
    last: 236.15,
    prevClose: 239.9,
  },
];

export interface DerivedPosition extends SamplePosition {
  marketValue: number;
  pnl: number;
  pnlPercent: number;
  dayPnl: number;
  weight: number;
  isShort: boolean;
}

export interface PortfolioTotals {
  longMv: number;
  shortMv: number;
  equity: number;
  marginHeld: number;
  buyingPower: number;
  totalPnl: number;
  totalPnlPercent: number;
  dayPnl: number;
}

/**
 * Derives everything the screens display from positions plus cash, using the
 * same formulas the Postgres layer will use in Phase 4. Note there is no
 * long/short branching anywhere: a negative qty carries the sign through.
 */
export function derive(positions: SamplePosition[], cash: number) {
  const longMv = positions
    .filter((p) => p.qty > 0)
    .reduce((sum, p) => sum + p.qty * p.last, 0);

  const shortMv = positions
    .filter((p) => p.qty < 0)
    .reduce((sum, p) => sum + Math.abs(p.qty) * p.last, 0);

  const gross = longMv + shortMv;
  const equity = cash + longMv - shortMv;
  const marginHeld = 1.5 * shortMv;

  const rows: DerivedPosition[] = positions.map((p) => {
    const marketValue = p.qty * p.last;
    const pnl = (p.last - p.avgCost) * p.qty;
    const costBasis = p.avgCost * Math.abs(p.qty);
    return {
      ...p,
      marketValue,
      pnl,
      pnlPercent: costBasis === 0 ? 0 : (pnl / costBasis) * 100,
      dayPnl: (p.last - p.prevClose) * p.qty,
      weight: gross === 0 ? 0 : (Math.abs(marketValue) / gross) * 100,
      isShort: p.qty < 0,
    };
  });

  const totalPnl = equity - SAMPLE_STARTING_CASH;

  const totals: PortfolioTotals = {
    longMv,
    shortMv,
    equity,
    marginHeld,
    buyingPower: Math.max(0, cash - marginHeld),
    totalPnl,
    totalPnlPercent: (totalPnl / SAMPLE_STARTING_CASH) * 100,
    dayPnl: rows.reduce((sum, r) => sum + r.dayPnl, 0),
  };

  return { rows, totals };
}
