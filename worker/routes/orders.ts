import { Hono, type Context } from "hono";
import type { PostgrestError } from "@supabase/supabase-js";
import { requireAdmin, requireAuth, type AuthedBindings } from "../middleware/auth.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import { loadPortfolio, PortfolioError } from "../lib/portfolio.ts";
import { marketClock } from "../market/clock.ts";
import { describeMarketError } from "../market/provider.ts";
import { quoteCache } from "../market/quotes.ts";
import { lookupSymbol } from "../market/universe.ts";
import { sweepRestingOrders } from "../orders/sweep.ts";
import {
  applyFill,
  buyingPowerAfter,
  fillPriceFor,
  isMarketable,
  ORDER_SIDES,
  ORDER_TYPES,
  reserveFor,
  resolveQuantity,
  TIME_IN_FORCE,
  tradingWindow,
  type OrderSide,
  type OrderType,
  type Rejection,
  type TimeInForce,
} from "../orders/engine.ts";

export const orders = new Hono<AuthedBindings>();

orders.use("*", requireAuth);

/**
 * Order entry.
 *
 * The shape of this route is dictated by non-negotiable rule 3: never trust a
 * client-supplied price. A browser posts a symbol, a side, a type, and either a
 * share count or a dollar amount. It does not post an execution price, and if
 * it does, that field is read by nothing.
 *
 * One endpoint covers both outcomes, because from the member's side there is
 * only one action. If the market is open and the order can trade right now, it
 * fills and comes back with a trade. Otherwise it is queued and comes back with
 * a working order, and the sweep fills it when the market reaches it. What a
 * member must never get is a refusal for the crime of doing their thinking on a
 * Sunday.
 *
 * A queued order does NOT fill on a weekend. There is no session for it to
 * trade in — see worker/orders/sweep.ts.
 */

/** Ceiling on a single order, mostly to catch a fat finger before Reg T does. */
const MAX_NOTIONAL = 10_000_000;

/** Below this a price cannot survive rounding to 6dp as an average cost. */
const MIN_PRICE = 0.0001;

interface OrderBody {
  symbol?: unknown;
  side?: unknown;
  orderType?: unknown;
  limitPrice?: unknown;
  qty?: unknown;
  notional?: unknown;
  timeInForce?: unknown;
}

function rejectionStatus(code: Rejection["code"]): 400 | 404 | 409 {
  switch (code) {
    case "INVALID_ORDER":
      return 400;
    case "NO_PORTFOLIO":
      return 404;
    default:
      return 409;
  }
}

/**
 * place_order() and queue_order() raise with a SQLSTATE per rejection reason,
 * so a database refusal reads exactly like a pre-flight one.
 */
const SQLSTATE_TO_CODE: Record<string, Rejection["code"]> = {
  FC001: "INSUFFICIENT_BUYING_POWER",
  FC002: "POSITION_TOO_SMALL",
  FC003: "WRONG_SIDE",
  FC004: "TRADING_LOCKED",
  FC005: "NO_PORTFOLIO",
  FC006: "INVALID_ORDER",
};

function describeRpcError(
  error: PostgrestError,
): [{ error: string; code?: string }, 400 | 404 | 409 | 500] {
  const code = SQLSTATE_TO_CODE[error.code ?? ""];
  if (code) return [{ error: error.message, code }, rejectionStatus(code)];

  console.error("order RPC failed:", error);
  return [{ error: "The order did not go through. Nothing was changed." }, 500];
}

/**
 * POST /api/orders
 *
 * { symbol, side, orderType?, limitPrice?, qty | notional, timeInForce? }
 * Any `price` field is ignored.
 */
orders.post("/", async (c) => {
  let body: OrderBody;
  try {
    body = await c.req.json<OrderBody>();
  } catch {
    return c.json({ error: "Expected a JSON body.", code: "INVALID_ORDER" }, 400);
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = (typeof body.side === "string" ? body.side.trim().toUpperCase() : "") as OrderSide;
  const orderType = (
    typeof body.orderType === "string" ? body.orderType.trim().toUpperCase() : "MARKET"
  ) as OrderType;
  const timeInForce = (
    typeof body.timeInForce === "string" ? body.timeInForce.trim().toUpperCase() : "DAY"
  ) as TimeInForce;

  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return c.json({ error: "That is not a ticker we recognise.", code: "INVALID_ORDER" }, 400);
  }
  if (!ORDER_SIDES.includes(side)) {
    return c.json(
      { error: `Side must be one of ${ORDER_SIDES.join(", ")}.`, code: "INVALID_ORDER" },
      400,
    );
  }
  if (!ORDER_TYPES.includes(orderType)) {
    return c.json({ error: "Order type must be MARKET or LIMIT.", code: "INVALID_ORDER" }, 400);
  }
  if (!TIME_IN_FORCE.includes(timeInForce)) {
    return c.json({ error: "Time in force must be DAY or GTC.", code: "INVALID_ORDER" }, 400);
  }

  const limitPrice =
    body.limitPrice === undefined || body.limitPrice === null || body.limitPrice === ""
      ? null
      : Number(body.limitPrice);

  if (orderType === "LIMIT" && !(Number.isFinite(limitPrice) && (limitPrice as number) > 0)) {
    return c.json({ error: "A limit order needs a limit price.", code: "INVALID_ORDER" }, 400);
  }
  if (orderType === "MARKET" && limitPrice !== null) {
    return c.json(
      { error: "A market order cannot carry a limit price.", code: "INVALID_ORDER" },
      400,
    );
  }

  const wantsQty = body.qty !== undefined && body.qty !== null && body.qty !== "";
  const wantsNotional =
    body.notional !== undefined && body.notional !== null && body.notional !== "";

  if (wantsQty === wantsNotional) {
    return c.json(
      { error: "Enter either a share count or a dollar amount, not both.", code: "INVALID_ORDER" },
      400,
    );
  }
  if (wantsNotional && Number(body.notional) > MAX_NOTIONAL) {
    return c.json({ error: "That order is implausibly large.", code: "INVALID_ORDER" }, 400);
  }

  // ---------------------------------------------------------------------------
  // 1. Is the ticker tradable? `undefined` means the nightly universe sync has
  //    never run, which is a property of the deployment and not of the ticker.
  // ---------------------------------------------------------------------------
  const asset = await lookupSymbol(c.env, symbol).catch(() => undefined);

  if (asset === null) {
    return c.json(
      { error: `${symbol} is not in the tradable universe.`, code: "INVALID_ORDER" },
      400,
    );
  }
  if (side === "SHORT" && asset?.shortable === false) {
    return c.json({ error: `${symbol} cannot be sold short.`, code: "INVALID_ORDER" }, 400);
  }

  // ---------------------------------------------------------------------------
  // 2. Portfolio, clock, and the price of everything held.
  // ---------------------------------------------------------------------------
  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  let portfolio;
  try {
    portfolio = await loadPortfolio(supabase, c.get("user").id);
  } catch (err) {
    if (err instanceof PortfolioError) {
      return c.json({ error: err.message, code: "NO_PORTFOLIO" }, 404);
    }
    console.error("portfolio load failed:", err);
    return c.json({ error: "Could not load your portfolio." }, 500);
  }

  if (portfolio.season.tradingLocked) {
    return c.json({ error: "Trading is locked for this season.", code: "TRADING_LOCKED" }, 409);
  }

  const clock = await marketClock(c.env);
  const wanted = [...new Set([symbol, ...portfolio.positions.map((p) => p.symbol)])];

  let priced;
  try {
    priced = await quoteCache(c.env).get(wanted, (p) => c.executionCtx.waitUntil(p));
  } catch (err) {
    const { message, status } = describeMarketError(err);
    if (status === 502) console.error("Order pricing failed:", err);
    return c.json({ error: message }, status);
  }

  const quote = priced.quotes.get(symbol);
  if (!quote || !(quote.price >= MIN_PRICE)) {
    return c.json(
      {
        error: `There is no usable price for ${symbol}, so the order was not placed.`,
        code: "INVALID_ORDER",
      },
      409,
    );
  }

  const marks: Record<string, number> = {};
  for (const [held, heldQuote] of priced.quotes) marks[held] = heldQuote.price;

  // ---------------------------------------------------------------------------
  // 3. Fill now, or rest?
  //
  // Only two things make an order immediate: the market is genuinely open, and
  // the order's own price condition is already met. Outside a session the last
  // price is a stale close, not something to trade against — so everything else
  // is queued, which is the whole point of this route.
  // ---------------------------------------------------------------------------
  const spec = { side, orderType, limitPrice };
  const marketShut = tradingWindow(clock);
  const canFillNow = !marketShut && isMarketable(spec, quote.price);

  if (canFillNow) {
    return fillImmediately(c, {
      supabase,
      symbol,
      side,
      price: fillPriceFor(spec, quote.price),
      body,
      wantsQty,
      fractionable: asset?.fractionable,
      portfolio,
      marks,
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Queue it.
  // ---------------------------------------------------------------------------
  const reservation = reserveFor({
    side,
    orderType,
    limitPrice,
    qty: wantsQty ? Number(body.qty) : undefined,
    notional: wantsNotional ? Number(body.notional) : undefined,
    referencePrice: quote.price,
  });

  if ("ok" in reservation) {
    return c.json(
      { error: reservation.message, code: reservation.code },
      rejectionStatus(reservation.code),
    );
  }

  // A DAY order needs a session close to die at, and that comes off the exchange
  // calendar. Without one there is no honest expiry to promise, so rather than
  // invent midnight, say so and offer the alternative.
  let expiresAt: string | null = null;
  if (timeInForce === "DAY") {
    if (!clock.nextClose) {
      return c.json(
        {
          error:
            "The market calendar is unreachable, so a day order has no end to point at. Try again shortly, or queue it as good-til-cancelled.",
          code: "MARKET_CLOSED",
        },
        409,
      );
    }
    expiresAt = clock.nextClose;
  }

  const { data, error } = await supabase.rpc("queue_order", {
    p_user_id: c.get("user").id,
    p_symbol: symbol,
    p_side: side,
    p_order_type: orderType,
    p_limit_price: limitPrice,
    p_qty: wantsQty ? Number(body.qty) : null,
    p_notional: wantsNotional ? Number(body.notional) : null,
    p_time_in_force: timeInForce,
    p_reserve_cash: reservation.cash,
    p_reserve_qty: reservation.qty,
    p_expires_at: expiresAt,
  });

  if (error) return c.json(...describeRpcError(error));

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    console.error("queue_order returned no row");
    return c.json({ error: "The order was not queued. Nothing was changed." }, 500);
  }

  return c.json({
    ok: true,
    status: "QUEUED",
    order: {
      id: row.order_id,
      symbol: row.symbol,
      side: row.side,
      orderType: row.order_type,
      limitPrice: row.limit_price,
      qty: row.qty,
      notional: row.notional,
      timeInForce: row.time_in_force,
      reservedCash: row.reserved_cash,
      reservedQty: row.reserved_qty,
      expiresAt: row.expires_at,
      placedAt: row.placed_at,
    },
    buyingPower: row.buying_power,
    /** Why it did not fill, and when it might. */
    reason: marketShut ? marketShut.message : `${symbol} has not reached your limit yet.`,
    nextOpen: clock.nextOpen,
    referencePrice: quote.price,
  });
});

/** The immediate path, unchanged in substance from Phase 4. */
async function fillImmediately(
  c: Context<AuthedBindings>,
  args: {
    supabase: ReturnType<typeof serviceClient>;
    symbol: string;
    side: OrderSide;
    price: number;
    body: OrderBody;
    wantsQty: boolean;
    fractionable: boolean | undefined;
    portfolio: Awaited<ReturnType<typeof loadPortfolio>>;
    marks: Record<string, number>;
  },
) {
  const { supabase, symbol, side, price, body, wantsQty, fractionable, portfolio, marks } = args;

  const resolved = resolveQuantity({
    qty: wantsQty ? Number(body.qty) : undefined,
    notional: wantsQty ? undefined : Number(body.notional),
    price,
    symbol,
    fractionable,
  });

  if ("ok" in resolved) {
    return c.json({ error: resolved.message, code: resolved.code }, rejectionStatus(resolved.code));
  }

  // Pre-flight. Re-checked under the lock inside place_order(); this exists so a
  // member gets a sentence about their own position instead of a database error.
  const held = portfolio.positions.find((p) => p.symbol === symbol) ?? null;
  const outcome = applyFill(held, symbol, side, resolved.qty, price);

  if (!outcome.ok) {
    return c.json({ error: outcome.message, code: outcome.code }, rejectionStatus(outcome.code));
  }

  const { rejection } = buyingPowerAfter(portfolio.positions, portfolio.cash, outcome, marks);
  if (rejection) {
    return c.json(
      { error: rejection.message, code: rejection.code },
      rejectionStatus(rejection.code),
    );
  }

  const { data, error } = await supabase.rpc("place_order", {
    p_user_id: c.get("user").id,
    p_symbol: symbol,
    p_side: side,
    p_qty: resolved.qty,
    p_price: price,
    p_marks: marks,
    p_pending_order_id: null,
  });

  if (error) return c.json(...describeRpcError(error));

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    console.error("place_order returned no row");
    return c.json({ error: "The order did not complete. Nothing was changed." }, 500);
  }

  return c.json({
    ok: true,
    status: "FILLED",
    trade: {
      id: row.trade_id,
      symbol: row.symbol,
      side: row.side,
      qty: row.qty,
      price: row.price,
      notional: row.notional,
      realizedPnl: row.realized_pnl,
      executedAt: row.executed_at,
    },
    position:
      row.position_qty === null
        ? null
        : { symbol: row.symbol, qty: row.position_qty, avgCost: row.position_avg_cost },
    portfolio: {
      cash: row.cash,
      longMv: row.long_mv,
      shortMv: row.short_mv,
      equity: row.equity,
      marginHeld: row.margin_held,
      buyingPower: row.buying_power,
      reservedCash: row.reserved_cash,
    },
  });
}

/**
 * GET /api/orders/working — orders waiting for the market.
 *
 * Owner-only at the database level too: unlike positions and trades, a resting
 * order is intent, and publishing it would invite the club to trade in front
 * of it.
 */
orders.get("/working", async (c) => {
  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  let portfolio;
  try {
    portfolio = await loadPortfolio(supabase, c.get("user").id);
  } catch (err) {
    if (err instanceof PortfolioError) return c.json({ orders: [], note: err.message });
    console.error("portfolio load failed:", err);
    return c.json({ error: "Could not load your portfolio." }, 500);
  }

  const { data, error } = await supabase
    .from("pending_orders")
    .select(
      "id, symbol, side, order_type, limit_price, qty, notional, time_in_force, status, reserved_cash, reserved_qty, expires_at, placed_at, resolved_at, reject_reason",
    )
    .eq("portfolio_id", portfolio.id)
    .order("placed_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("working order query failed:", error);
    return c.json({ error: "Could not load your working orders." }, 500);
  }

  return c.json({
    orders: (data ?? []).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      orderType: row.order_type,
      limitPrice: row.limit_price,
      qty: row.qty,
      notional: row.notional,
      timeInForce: row.time_in_force,
      status: row.status,
      reservedCash: row.reserved_cash,
      reservedQty: row.reserved_qty,
      expiresAt: row.expires_at,
      placedAt: row.placed_at,
      resolvedAt: row.resolved_at,
      rejectReason: row.reject_reason,
    })),
  });
});

/** DELETE /api/orders/working/:id — cancel, and give the reservation back. */
orders.delete("/working/:id", async (c) => {
  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { data, error } = await supabase.rpc("cancel_pending_order", {
    p_user_id: c.get("user").id,
    p_order_id: c.req.param("id"),
  });

  if (error) return c.json(...describeRpcError(error));

  const row = Array.isArray(data) ? data[0] : data;
  return c.json({
    ok: true,
    orderId: row?.order_id ?? null,
    symbol: row?.symbol ?? null,
    side: row?.side ?? null,
    buyingPower: row?.buying_power ?? null,
  });
});

/**
 * POST /api/orders/sweep — officers only.
 *
 * The cron trigger runs this every minute the market is open. This exists for
 * the morning someone wants to see a queue clear without waiting for the tick,
 * and for diagnosing why an order has not filled.
 */
orders.post("/sweep", requireAdmin, async (c) => {
  const result = await sweepRestingOrders(c.env, (p) => c.executionCtx.waitUntil(p));
  return c.json(result);
});

/**
 * GET /api/orders?limit=100 — the trade blotter.
 *
 * Every fill in the active season, newest first, with the realised P/L booked
 * at the time. A log, not a projection: these numbers do not move when prices
 * do.
 */
orders.get("/", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);

  let supabase;
  try {
    supabase = serviceClient(c.env);
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    throw err;
  }

  let portfolio;
  try {
    portfolio = await loadPortfolio(supabase, c.get("user").id);
  } catch (err) {
    if (err instanceof PortfolioError) return c.json({ trades: [], note: err.message });
    console.error("portfolio load failed:", err);
    return c.json({ error: "Could not load your portfolio." }, 500);
  }

  const { data, error } = await supabase
    .from("trades")
    .select("id, symbol, side, qty, price, notional, realized_pnl, executed_at")
    .eq("portfolio_id", portfolio.id)
    .order("executed_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("blotter query failed:", error);
    return c.json({ error: "Could not load your trades." }, 500);
  }

  return c.json({
    trades: (data ?? []).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      qty: row.qty,
      price: row.price,
      notional: row.notional,
      realizedPnl: row.realized_pnl,
      executedAt: row.executed_at,
    })),
  });
});
