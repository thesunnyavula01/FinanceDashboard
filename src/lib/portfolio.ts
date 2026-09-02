import { hasLimit, hasStop } from "./api";
import type { OrderSide, OrderType, PositionRow, Quote, Security } from "./api";
import { multiplierFor, formatContract, underlyingOf } from "@/lib/symbols";

/**
 * Valuing a portfolio on screen.
 *
 * Positions and cash come from /api/portfolio and change only when someone
 * trades. Prices come from /api/quotes and change every twenty seconds. Holding
 * them apart and multiplying here is what lets the numbers tick without a
 * database read three times a minute.
 *
 * This is display arithmetic and nothing more. The same formulas exist in
 * place_order() and in worker/orders/engine.ts, and those are the ones that
 * decide whether an order fills — if a figure here ever disagrees with the one
 * an order comes back with, the order is right.
 *
 * There is no long/short branching anywhere below. A short is a negative `qty`,
 * so (price - avgCost) * qty already returns a gain when a short falls. Adding a
 * branch here is how sign bugs get in.
 */

export interface ValuedPosition extends PositionRow {
  name: string;
  sector: string;
  last: number;
  prevClose: number | null;
  marketValue: number;
  pnl: number;
  pnlPercent: number;
  dayPnl: number;
  /** Share of gross exposure, so a short counts toward the total it consumes. */
  weight: number;
  isShort: boolean;
  /** No live quote for this symbol; it is being shown at its average cost. */
  stale: boolean;
}

export interface PortfolioTotals {
  longMv: number;
  shortMv: number;
  equity: number;
  cash: number;
  marginHeld: number;
  buyingPower: number;
  /** Unclamped, so the UI can tell "nothing left" from "underwater". */
  netBuyingPower: number;
  totalPnl: number;
  totalPnlPercent: number;
  dayPnl: number;
  startingCash: number;
}

export const REG_T_MARGIN_MULTIPLIER = 1.5;

/**
 * Shares per unit for a position: 100 for an option contract.
 *
 * The stored value wins where there is one, and the symbol is the fallback,
 * so a row written before migration 0006 — every one of which is a stock — is
 * correct at 1 without a backfill. Mirrors contractSize() in the order engine.
 */
export function contractSize(position: Pick<PositionRow, "symbol" | "multiplier">): number {
  const stored = position.multiplier;
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0
    ? stored
    : multiplierFor(position.symbol);
}

export interface ValueInput {
  positions: PositionRow[];
  quotes: Record<string, Quote>;
  securities: Record<string, Security>;
  cash: number;
  startingCash: number;
}

export function valuePortfolio({
  positions,
  quotes,
  securities,
  cash,
  startingCash,
}: ValueInput): { rows: ValuedPosition[]; totals: PortfolioTotals } {
  let longMv = 0;
  let shortMv = 0;

  const priced = positions.map((position) => {
    const quote = quotes[position.symbol];
    // An option falls back to its underlying's row. The Worker writes a row
    // under the contract symbol carrying the underlying's sector, but that
    // arrives on a later poll, and a contract sitting in Unclassified for ten
    // seconds reads as a mapping someone forgot rather than as a pending fetch.
    const security =
      securities[position.symbol] ?? securities[underlyingOf(position.symbol) ?? ""];
    // A symbol the market data layer cannot price falls back to its average
    // cost, which values the position at exactly break-even and is flagged
    // rather than quietly shown as a real mark.
    const last = quote?.price ?? position.avgCost;

    // One contract is a hundred shares. A book holding stock, coins and
    // contracts is valued in one pass, exactly as the Worker values it.
    const value = Math.abs(position.qty) * contractSize(position) * last;
    if (position.qty > 0) longMv += value;
    else shortMv += value;

    return {
      position,
      last,
      quote,
      security,
      stale: !quote,
    };
  });

  const gross = longMv + shortMv;
  const equity = cash + longMv - shortMv;
  const marginHeld = REG_T_MARGIN_MULTIPLIER * shortMv;
  const netBuyingPower = cash - marginHeld;

  const rows: ValuedPosition[] = priced.map(({ position, last, quote, security, stale }) => {
    const size = contractSize(position);
    const isContract = size > 1;
    const marketValue = position.qty * size * last;
    const pnl = (last - position.avgCost) * position.qty * size;
    const costBasis = position.avgCost * Math.abs(position.qty) * size;
    const prevClose = quote?.prevClose ?? null;

    return {
      ...position,
      // A contract names itself. Its underlying's company name would be the
      // wrong answer twice over: it hides the strike and the expiry, and two
      // different contracts would print identically.
      name: isContract ? formatContract(position.symbol) : (security?.name ?? position.symbol),
      sector: security?.sector ?? "—",
      last,
      prevClose,
      marketValue,
      pnl,
      pnlPercent: costBasis === 0 ? 0 : (pnl / costBasis) * 100,
      // Before the first print of a session there is no previous close to
      // measure against, and zero is the honest answer rather than the whole
      // position's P/L masquerading as one day's move.
      dayPnl: prevClose === null ? 0 : (last - prevClose) * position.qty * size,
      weight: gross === 0 ? 0 : (Math.abs(marketValue) / gross) * 100,
      isShort: position.qty < 0,
      stale,
    };
  });

  const totalPnl = equity - startingCash;

  return {
    rows,
    totals: {
      longMv,
      shortMv,
      equity,
      cash,
      marginHeld,
      buyingPower: Math.max(0, netBuyingPower),
      netBuyingPower,
      totalPnl,
      totalPnlPercent: startingCash === 0 ? 0 : (totalPnl / startingCash) * 100,
      dayPnl: rows.reduce((sum, row) => sum + row.dayPnl, 0),
      startingCash,
    },
  };
}

/**
 * Head-room the Worker holds on a market order entered in shares. Mirrors
 * MARKET_ORDER_BUFFER in worker/orders/engine.ts, which is the authority — this
 * copy exists only so the ticket can show the number before it asks.
 */
export const MARKET_ORDER_BUFFER = 0.05;

/**
 * Has the market reached this order's price?
 *
 * Display only: the Worker decides, and it decides again on every sweep. This
 * is what lets the ticket say "this will rest until NVDA reaches 170" while the
 * member is still typing, instead of after a round trip.
 *
 * A market order is marketable whenever there is a session. On a weekend there
 * is none — US equities trade 09:30-16:00 ET on weekdays — so the caller checks
 * the clock first and this never gets to claim otherwise.
 */
export function isMarketable(
  side: OrderSide,
  orderType: OrderType,
  limitPrice: number | null,
  price: number,
): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  // A stop is never immediate. Its trigger sits on the far side of the market
  // by construction — the Worker refuses one placed where it would fire at
  // once — so a stop always rests and the sweep decides. Saying so here is what
  // makes the ticket read "QUEUE" rather than "BUY" the moment a stop type is
  // picked, which is the honest label.
  if (hasStop(orderType)) return false;
  if (orderType === "MARKET") return true;
  if (!Number.isFinite(limitPrice) || (limitPrice as number) <= 0) return false;

  // BUY and COVER are paying, so they want the price at or below their limit.
  // SELL and SHORT are receiving, so at or above.
  return side === "BUY" || side === "COVER"
    ? price <= (limitPrice as number)
    : price >= (limitPrice as number);
}

/**
 * What will be held while the order rests. Mirrors reserveFor() in
 * worker/orders/engine.ts; the Worker's number is the one that binds.
 *
 * Worth showing, because "why is $1,890 held for a $1,800 order" is otherwise a
 * fair question. The answer is that a market order in shares has no cost until
 * it fills, and Monday need not open where Friday closed.
 */
export function estimateReservation(input: {
  side: OrderSide;
  orderType: OrderType;
  limitPrice: number | null;
  /** The trigger, for the three stop types. Null otherwise. */
  stopPrice?: number | null;
  qty?: number;
  notional?: number;
  referencePrice: number;
}): { cash: number; qty: number; buffered: boolean } {
  const { side, orderType, limitPrice, referencePrice } = input;
  const stopPrice = input.stopPrice ?? null;

  if (side === "SELL" || side === "COVER") {
    return { cash: 0, qty: input.qty ?? 0, buffered: false };
  }

  if (input.notional !== undefined) {
    // A dollar order spends exactly what it says, whatever the price does.
    const cash = side === "SHORT" ? input.notional * (REG_T_MARGIN_MULTIPLIER - 1) : input.notional;
    return { cash, qty: 0, buffered: false };
  }

  const qty = input.qty ?? 0;
  // A BUY limit cannot fill above its price, so it needs no head-room. A SHORT
  // limit fills at its price *or higher*, so it does. A stop-limit is capped the
  // same way: the stop decides *when*, the limit still caps *what*.
  const capped = hasLimit(orderType) && side === "BUY";
  // A BUY stop sits above the market by definition and becomes a market order
  // when it gets there, so the last price understates it by the whole distance
  // to the trigger.
  const basis = hasLimit(orderType)
    ? (limitPrice ?? 0)
    : hasStop(orderType) && stopPrice !== null
      ? Math.max(stopPrice, referencePrice)
      : referencePrice;
  const worst = qty * basis * (capped ? 1 : 1 + MARKET_ORDER_BUFFER);

  return {
    cash: side === "SHORT" ? worst * (REG_T_MARGIN_MULTIPLIER - 1) : worst,
    qty: 0,
    buffered: !capped,
  };
}

/**
 * Which sides make sense for a symbol right now.
 *
 * The order ticket disables the rest rather than hiding them, because the four
 * sides are the vocabulary a member is here to learn — a greyed-out COVER that
 * says why teaches more than a COVER that is not there.
 */
export function availableSides(position: PositionRow | undefined): {
  BUY: string | null;
  SELL: string | null;
  SHORT: string | null;
  COVER: string | null;
} {
  const qty = position?.qty ?? 0;

  if (qty > 0) {
    return {
      BUY: null,
      SELL: null,
      SHORT: "You hold this long. Sell it first to go short.",
      COVER: "You hold this long, so there is nothing to cover.",
    };
  }
  if (qty < 0) {
    return {
      BUY: "You are short this. Cover it to close the position.",
      SELL: "You are short this. Cover it, or short more.",
      SHORT: null,
      COVER: null,
    };
  }
  return {
    BUY: null,
    SELL: "You do not hold any of this yet.",
    SHORT: null,
    COVER: "You have no short position in this to cover.",
  };
}
