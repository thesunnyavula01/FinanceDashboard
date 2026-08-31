import type { MarketClock } from "../market/provider.ts";

/**
 * The order rules, in TypeScript.
 *
 * `place_order()` in supabase/migrations/0002_trading.sql is the authority:
 * it runs inside a transaction holding a row lock on the portfolio, and it is
 * the only thing permitted to move money. This file exists for the two jobs
 * that authority cannot do.
 *
 *   1. It can be unit tested. `npm test` is `node --test` over the Worker with
 *      no database anywhere near it, and the behaviours Phase 4 has to get
 *      right — a short that profits when the price falls, a partial cover, an
 *      oversell, a Reg T rejection — are exactly the ones worth pinning.
 *   2. It runs before the round trip. The route checks an order here first, so
 *      a member who tries to sell more than they hold gets a sentence about
 *      their position instead of a database error.
 *
 * The duplication is deliberate and one-directional: this file may reject an
 * order the database would have accepted (it is working from a read taken a
 * moment earlier, outside the lock), but it must never accept one the database
 * would reject on the same state. Where the two disagree, the database wins and
 * the member sees its message. `engine.test.ts` reads the SQL and asserts they
 * still agree on the constants.
 *
 * Note on rule 5 in CLAUDE.md — money is numeric, never float. Nothing computed
 * here is ever written to the database; these are preview figures and a
 * pre-flight opinion. The one place a total accumulates is `marketValues()`,
 * over a member's few dozen positions, and its result is used to decide a
 * comparison, not to persist a balance.
 */

/** Reg T. Pinned against reg_t_margin_multiplier() in the migration. */
export const REG_T_MARGIN_MULTIPLIER = 1.5;

export const ORDER_SIDES = ["BUY", "SELL", "SHORT", "COVER"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

/** The sides that open or add to exposure, and so have to be paid for. */
const OPENING_SIDES: readonly OrderSide[] = ["BUY", "SHORT"];

/**
 * Rejection codes, mirroring the SQLSTATEs place_order() raises. The route maps
 * both to the same HTTP statuses, so a rejection reads identically whether it
 * came from here or from the database.
 */
export type RejectCode =
  | "INSUFFICIENT_BUYING_POWER" // FC001
  | "POSITION_TOO_SMALL" // FC002
  | "WRONG_SIDE" // FC003
  | "TRADING_LOCKED" // FC004
  | "NO_PORTFOLIO" // FC005
  | "INVALID_ORDER" // FC006
  | "MARKET_CLOSED";

export interface Rejection {
  ok: false;
  code: RejectCode;
  /** Written to be shown to a member verbatim. */
  message: string;
}

export interface Position {
  symbol: string;
  /** Signed: negative is short. */
  qty: number;
  avgCost: number;
}

export interface Fill {
  ok: true;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  notional: number;
  realizedPnl: number;
  /** Signed change to cash: negative for BUY and COVER. */
  cashDelta: number;
  /** The position as it stands after the fill. Null when it closed out. */
  position: Position | null;
}

export type OrderOutcome = Fill | Rejection;

function reject(code: RejectCode, message: string): Rejection {
  return { ok: false, code, message };
}

/**
 * Decimal rounding that does not trip over binary representation.
 *
 * `Math.round(1.005 * 100) / 100` is 1, because 1.005 is really 1.00499…
 * Going through the exponent form re-parses the decimal literal and gets 1.01,
 * which is what Postgres `round(1.005, 2)` returns and therefore what the
 * preview has to show.
 */
export function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const shifted = Number(`${value}e${decimals}`);
  if (!Number.isFinite(shifted)) return value;
  return Number(`${Math.round(shifted)}e${-decimals}`);
}

/** Cash and notionals carry two decimals, matching numeric(20,2). */
const money = (value: number) => round(value, 2);
/** Quantities and prices carry six, matching numeric(20,6). */
const units = (value: number) => round(value, 6);

/**
 * What one fill does to one position.
 *
 * `position` is the holding before the order, or null for a symbol the member
 * does not hold. This deliberately knows nothing about cash balances or other
 * positions — whether the member can *afford* it is `buyingPowerAfter()`.
 */
export function applyFill(
  position: Position | null,
  symbol: string,
  side: OrderSide,
  qty: number,
  price: number,
): OrderOutcome {
  if (!ORDER_SIDES.includes(side)) {
    return reject("INVALID_ORDER", `Unknown order side: ${side}.`);
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return reject("INVALID_ORDER", "Order quantity must be greater than zero.");
  }
  if (!Number.isFinite(price) || price <= 0) {
    return reject("INVALID_ORDER", `No usable price for ${symbol}.`);
  }

  const prevQty = position?.qty ?? 0;
  const prevAvg = position?.avgCost ?? 0;
  const notional = money(qty * price);

  // No accidental flips. Netting a BUY through a short down to a long would be
  // arithmetically tidy and a terrible thing to do to someone who typed the
  // wrong verb, so each side refuses to cross zero and names the one that does
  // what they meant.
  switch (side) {
    case "BUY": {
      if (prevQty < 0) {
        return reject(
          "WRONG_SIDE",
          `You are short ${formatQty(-prevQty)} ${symbol}. Use COVER to close a short position.`,
        );
      }
      const newQty = units(prevQty + qty);
      return {
        ok: true,
        symbol,
        side,
        qty,
        price,
        notional,
        realizedPnl: 0,
        cashDelta: -notional,
        position: {
          symbol,
          qty: newQty,
          avgCost: units((prevQty * prevAvg + qty * price) / newQty),
        },
      };
    }

    case "SELL": {
      if (prevQty < 0) {
        return reject(
          "WRONG_SIDE",
          `You are short ${symbol}. Use COVER to close it, or SHORT to add to it.`,
        );
      }
      if (prevQty === 0) {
        return reject("POSITION_TOO_SMALL", `You do not hold any ${symbol}.`);
      }
      if (qty > prevQty) {
        return reject(
          "POSITION_TOO_SMALL",
          `You hold ${formatQty(prevQty)} ${symbol}, so you cannot sell ${formatQty(qty)}.`,
        );
      }
      const newQty = units(prevQty - qty);
      return {
        ok: true,
        symbol,
        side,
        qty,
        price,
        notional,
        // Selling part of a holding does not change what the rest cost, so the
        // average is carried through untouched and the difference is booked.
        realizedPnl: money((price - prevAvg) * qty),
        cashDelta: notional,
        position: newQty === 0 ? null : { symbol, qty: newQty, avgCost: prevAvg },
      };
    }

    case "SHORT": {
      if (prevQty > 0) {
        return reject(
          "WRONG_SIDE",
          `You hold ${formatQty(prevQty)} ${symbol}. Use SELL to reduce a long position.`,
        );
      }
      const newQty = units(prevQty - qty);
      return {
        ok: true,
        symbol,
        side,
        qty,
        price,
        notional,
        realizedPnl: 0,
        // The proceeds are credited in full. What the short actually costs is
        // the margin held against it, which buyingPowerAfter() accounts for.
        cashDelta: notional,
        position: {
          symbol,
          qty: newQty,
          avgCost: units((Math.abs(prevQty) * prevAvg + qty * price) / Math.abs(newQty)),
        },
      };
    }

    case "COVER": {
      if (prevQty > 0) {
        return reject("WRONG_SIDE", `You hold ${symbol} long. Use SELL to reduce a long position.`);
      }
      if (prevQty === 0) {
        return reject("POSITION_TOO_SMALL", `You have no short position in ${symbol} to cover.`);
      }
      if (qty > Math.abs(prevQty)) {
        return reject(
          "POSITION_TOO_SMALL",
          `You are short ${formatQty(-prevQty)} ${symbol}, so you cannot cover ${formatQty(qty)}.`,
        );
      }
      const newQty = units(prevQty + qty);
      return {
        ok: true,
        symbol,
        side,
        qty,
        price,
        notional,
        // The mirror of SELL: a short gains when the price falls, so the
        // subtraction runs the other way round. This is the one place the
        // signed-qty convention does not carry the direction for us, because
        // `qty` on an order is always positive.
        realizedPnl: money((prevAvg - price) * qty),
        cashDelta: -notional,
        position: newQty === 0 ? null : { symbol, qty: newQty, avgCost: prevAvg },
      };
    }
  }
}

export interface Valuation {
  longMv: number;
  shortMv: number;
  equity: number;
  marginHeld: number;
  /** Clamped at zero, matching the formula in CLAUDE.md. */
  buyingPower: number;
  /** Unclamped, so a caller can tell "exactly nothing left" from "underwater". */
  netBuyingPower: number;
}

/**
 * Value a set of positions at a set of marks.
 *
 * A symbol with no mark falls back to its average cost, which is the same
 * fallback the SQL takes. It understates the margin on a short that has moved
 * against the member, so the Worker sends a mark for every position it can
 * price and this is only the degraded path.
 */
export function marketValues(
  positions: Position[],
  marks: Record<string, number>,
  cash: number,
): Valuation {
  let longMv = 0;
  let shortMv = 0;

  for (const position of positions) {
    const mark = marks[position.symbol];
    const price = Number.isFinite(mark) && mark > 0 ? mark : position.avgCost;
    if (position.qty > 0) longMv += position.qty * price;
    else shortMv += Math.abs(position.qty) * price;
  }

  longMv = money(longMv);
  shortMv = money(shortMv);

  const marginHeld = money(REG_T_MARGIN_MULTIPLIER * shortMv);
  const netBuyingPower = money(cash - marginHeld);

  return {
    longMv,
    shortMv,
    equity: money(cash + longMv - shortMv),
    marginHeld,
    buyingPower: Math.max(0, netBuyingPower),
    netBuyingPower,
  };
}

/**
 * The portfolio as it would stand if a fill went through, and whether the
 * member can afford it.
 *
 * Only BUY and SHORT are ever refused. A SELL adds its notional to cash and
 * releases no margin, and a COVER pays out its notional but releases 1.5x that
 * in margin, so both can only improve buying power — refusing them would trap a
 * member inside the position they are trying to escape. There is no forced
 * liquidation in v1, so the exit stays open.
 */
export function buyingPowerAfter(
  positions: Position[],
  cash: number,
  fill: Fill,
  marks: Record<string, number>,
): { valuation: Valuation; rejection: Rejection | null } {
  const after = positions.filter((p) => p.symbol !== fill.symbol);
  if (fill.position) after.push(fill.position);

  const valuation = marketValues(after, { ...marks, [fill.symbol]: fill.price }, money(cash + fill.cashDelta));

  if (!OPENING_SIDES.includes(fill.side) || valuation.netBuyingPower >= 0) {
    return { valuation, rejection: null };
  }

  // A short only consumes half its notional, because the proceeds land in cash
  // and only the 0.5x excess of the margin is new. Quoting the full notional
  // here would tell a member they need twice what they actually do.
  const needed = fill.side === "SHORT" ? money(fill.notional / 2) : fill.notional;
  const before = marketValues(positions, marks, cash);

  return {
    valuation,
    rejection: reject(
      "INSUFFICIENT_BUYING_POWER",
      `Not enough buying power. ${fill.side} ${fill.symbol} needs ${dollars(needed)}, ` +
        `and you have ${dollars(before.buyingPower)}.`,
    ),
  };
}

/**
 * Whether the market is open enough to fill an order.
 *
 * An estimated clock is refused as firmly as a closed one. The estimate comes
 * from New York wall-clock hours and does not know about Thanksgiving, so
 * trusting it means filling orders on a day the exchange never opened. Telling
 * a member to try again in a minute is a far cheaper failure than a trade that
 * should not exist.
 */
export function tradingWindow(clock: MarketClock): Rejection | null {
  if (!clock.authoritative) {
    return reject(
      "MARKET_CLOSED",
      "The market calendar is unreachable, so we cannot confirm the market is open. Try again in a moment.",
    );
  }
  if (!clock.isOpen) {
    return reject("MARKET_CLOSED", `The market is closed. ${clock.label}`);
  }
  return null;
}

export interface QuantityRequest {
  /** Share count. Mutually exclusive with `notional`. */
  qty?: number;
  /** Dollar amount, converted at the price the Worker fetched. */
  notional?: number;
  price: number;
  symbol: string;
  /** From Alpaca's asset list. Undefined when the universe has not synced. */
  fractionable?: boolean;
}

/**
 * Resolve what the member typed into a share count.
 *
 * Dollar entry is the point of this app — a member thinks "put $500 into NVDA",
 * not "buy 2.7 shares" — so the conversion happens here at the price the Worker
 * just fetched, and the client's arithmetic never enters into it.
 *
 * A whole-share-only symbol rounds DOWN. Rounding up would spend more than the
 * member asked for, which is the one direction that is never acceptable.
 */
export function resolveQuantity(request: QuantityRequest): { qty: number } | Rejection {
  const { price, symbol, fractionable } = request;

  if (!Number.isFinite(price) || price <= 0) {
    return reject("INVALID_ORDER", `No usable price for ${symbol}.`);
  }

  const hasQty = request.qty !== undefined;
  const hasNotional = request.notional !== undefined;

  if (hasQty === hasNotional) {
    return reject("INVALID_ORDER", "Enter either a share count or a dollar amount, not both.");
  }

  let qty: number;

  if (hasQty) {
    qty = Number(request.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return reject("INVALID_ORDER", "Share count must be greater than zero.");
    }
    qty = units(qty);
  } else {
    const notional = Number(request.notional);
    if (!Number.isFinite(notional) || notional <= 0) {
      return reject("INVALID_ORDER", "Dollar amount must be greater than zero.");
    }
    // Floor rather than round, for the same reason as below: a $500 order must
    // never cost $500.01.
    qty = Math.floor((notional / price) * 1e6) / 1e6;
  }

  if (fractionable === false) {
    const whole = Math.floor(qty);
    if (whole < 1) {
      return reject(
        "INVALID_ORDER",
        `${symbol} trades in whole shares only, and that is less than one share at ${dollars(price)}.`,
      );
    }
    qty = whole;
  }

  if (qty <= 0) {
    return reject("INVALID_ORDER", `That is less than the smallest tradable amount of ${symbol}.`);
  }

  return { qty };
}

/** 40 -> "40", 2.5 -> "2.5". Share counts, for use inside a sentence. */
function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(units(qty));
}

/** 1234.5 -> "$1,234.50". Only ever used inside a rejection message. */
function dollars(value: number): string {
  return `$${money(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// =============================================================================
// Resting orders
//
// An order that cannot fill now is stored and swept later. Two questions have
// to be answered before it goes into the table, and both are pure arithmetic,
// so both live here where a test can reach them:
//
//   reserveFor()  — how much buying power or how many shares to hold while it
//                   rests, so a member cannot promise the same dollar twice.
//   isMarketable() — whether the market has come to the order's price yet.
//
// Neither knows anything about weekends, and that is correct: a resting order
// has no opinion about the calendar. The sweep simply is not run while the
// market is shut, because there is no session for an order to trade in — US
// equities trade 09:30-16:00 ET on weekdays, and Friday's close does not move
// until Monday.
// =============================================================================

export const ORDER_TYPES = ["MARKET", "LIMIT"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const TIME_IN_FORCE = ["DAY", "GTC"] as const;
export type TimeInForce = (typeof TIME_IN_FORCE)[number];

/**
 * Head-room on a market order entered as a share count.
 *
 * "BUY 10 NVDA at market" has no cost until it fills, and it fills at whatever
 * Monday opens at. Reserving only the last price would let a member queue an
 * order that gaps up and then cannot be paid for, so a little extra is held.
 * Five per cent covers an ordinary overnight move; a gap larger than that
 * rejects at fill, which is the honest outcome.
 *
 * A dollar order needs none of this — its cost is the number the member typed.
 * Nor does a BUY limit, whose limit price is the cap by definition. This is
 * worth surfacing in the ticket, because "why is $6,300 held for a $6,000
 * order" is otherwise a reasonable thing to be confused by.
 */
export const MARKET_ORDER_BUFFER = 0.05;

export interface RestingOrderSpec {
  side: OrderSide;
  orderType: OrderType;
  /** Required for LIMIT, absent for MARKET. */
  limitPrice?: number | null;
  /** A share count. Required on SELL and COVER — see reserveFor(). */
  qty?: number;
  /** A dollar amount. Opening sides only. */
  notional?: number;
  /** Last known price, used only to size a market order's reservation. */
  referencePrice: number;
}

export interface Reservation {
  /** Buying power held while the order rests. */
  cash: number;
  /** Shares of an existing position held while the order rests. */
  qty: number;
}

/**
 * What to hold back while an order rests.
 *
 * Closing orders reserve shares, not cash: a SELL raises money rather than
 * spending it, but it does consume a position, and two queued SELLs of the same
 * 40 shares must not both be accepted.
 *
 * Closing orders must be entered as a share count. A dollar amount would have
 * to be converted at a price that does not exist yet, and the conversion runs
 * the wrong way — the cheaper the fill, the more shares "$500 of NVDA" turns
 * out to be, so there is no honest number to reserve. Immediate orders keep
 * dollar entry, because there the price is known.
 */
export function reserveFor(spec: RestingOrderSpec): Reservation | Rejection {
  const { side, orderType, referencePrice } = spec;
  const limitPrice = spec.limitPrice ?? null;

  if (orderType === "LIMIT" && !(Number.isFinite(limitPrice) && (limitPrice as number) > 0)) {
    return reject("INVALID_ORDER", "A limit order needs a limit price.");
  }
  if (orderType === "MARKET" && limitPrice !== null) {
    return reject("INVALID_ORDER", "A market order cannot carry a limit price.");
  }
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return reject("INVALID_ORDER", "No usable price to size this order against.");
  }

  const hasQty = spec.qty !== undefined;
  const hasNotional = spec.notional !== undefined;
  if (hasQty === hasNotional) {
    return reject("INVALID_ORDER", "Enter either a share count or a dollar amount, not both.");
  }

  const closing = side === "SELL" || side === "COVER";

  if (closing) {
    if (!hasQty) {
      return reject(
        "INVALID_ORDER",
        `A working ${side} order is entered in shares, not dollars — how many shares a dollar amount closes is not known until it fills.`,
      );
    }
    const qty = units(Number(spec.qty));
    if (!(qty > 0)) {
      return reject("INVALID_ORDER", "Share count must be greater than zero.");
    }
    return { cash: 0, qty };
  }

  // Opening sides. The worst the fill can cost, then halved for a short,
  // because the proceeds land in cash and only the 0.5x excess of the margin
  // is new money.
  let worstCost: number;

  if (hasNotional) {
    const notional = Number(spec.notional);
    if (!Number.isFinite(notional) || notional <= 0) {
      return reject("INVALID_ORDER", "Dollar amount must be greater than zero.");
    }
    // A dollar order spends exactly what it says, whatever the price does.
    worstCost = notional;
  } else {
    const qty = units(Number(spec.qty));
    if (!(qty > 0)) {
      return reject("INVALID_ORDER", "Share count must be greater than zero.");
    }

    if (orderType === "LIMIT" && side === "BUY") {
      // The limit is the cap. No head-room needed.
      worstCost = qty * (limitPrice as number);
    } else if (orderType === "LIMIT") {
      // A SHORT limit fills at its price *or higher*, so the proceeds — and the
      // margin against them — have no ceiling. Buffered like a market order.
      worstCost = qty * (limitPrice as number) * (1 + MARKET_ORDER_BUFFER);
    } else {
      worstCost = qty * referencePrice * (1 + MARKET_ORDER_BUFFER);
    }
  }

  const cash = side === "SHORT" ? worstCost * (REG_T_MARGIN_MULTIPLIER - 1) : worstCost;
  return { cash: money(cash), qty: 0 };
}

/**
 * Has the market reached this order's price?
 *
 * A market order is always marketable — the sweep only runs while the session
 * is open, so "at market" means "now". A limit is directional: BUY and COVER
 * are paying and want the price at or below their limit; SELL and SHORT are
 * receiving and want it at or above.
 */
export function isMarketable(
  order: { side: OrderSide; orderType: OrderType; limitPrice?: number | null },
  price: number,
): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  if (order.orderType === "MARKET") return true;

  const limit = order.limitPrice;
  if (!Number.isFinite(limit) || (limit as number) <= 0) return false;

  return order.side === "BUY" || order.side === "COVER"
    ? price <= (limit as number)
    : price >= (limit as number);
}

/**
 * What a resting order actually fills at.
 *
 * The market price, not the limit price. A buy limit at $105 against a market
 * that opened at $95 fills at $95, because $95 is where the trade happened —
 * the limit was a ceiling, not a target. Filling at $105 would quietly charge
 * the member ten dollars a share for nothing and hide how opening gaps work,
 * which is one of the more useful things to learn from a paper account.
 */
export function fillPriceFor(
  _order: { side: OrderSide; orderType: OrderType; limitPrice?: number | null },
  price: number,
): number {
  return price;
}

/**
 * Whether a rejection from the database is worth retrying on the next sweep.
 *
 * Most are not: a SELL whose position was closed by hand will never come good,
 * and leaving it resting means it sits there looking live forever. Trading
 * being locked is the exception — an officer will unlock it — so those orders
 * stay put.
 */
export function isRetryable(code: RejectCode): boolean {
  return code === "TRADING_LOCKED";
}
