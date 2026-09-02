import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import { marketClock } from "../market/clock.ts";
import { quoteCache } from "../market/quotes.ts";
import { lookupSymbol } from "../market/universe.ts";
import {
  fillPriceFor,
  isMarketable,
  stopTriggered,
  isRetryable,
  resolveQuantity,
  tradingWindow,
  type OrderSide,
  type OrderType,
  type RejectCode,
} from "./engine.ts";

/**
 * The sweep: what turns a stored instruction into a fill.
 *
 * This is the half of resting orders that answers the question members ask
 * first — "if I queue it on Sunday, when does it actually happen?" For a stock
 * or an option, nothing happens on Sunday. They trade 09:30-16:00 ET on
 * weekdays; there is no weekend session, no volume and no counterparty, so a
 * queued order simply sits. Monday at 09:30 is when a weekend queue comes to
 * life, all at once.
 *
 * Crypto is the exception, and it is why this function now runs every minute of
 * every day rather than only during the equity session. A coin has no bell, so
 * a queued BTC limit is fillable at 3am on a Sunday and it would be strange to
 * make it wait for the NYSE. The gate is therefore per order rather than per
 * sweep: whichever market an order belongs to decides whether it is eligible
 * this minute, and one of those markets is always open.
 *
 * There is deliberately only ONE sweep. A second, crypto-only cron would have
 * overlapped this one during the session, and two sweeps reading the same
 * PENDING row is a genuine hazard — the loser gets FC002 "already filled",
 * which is not retryable, and would write REJECTED over an order that had just
 * succeeded.
 *
 * Order of business:
 *
 *   1. Expire DAY orders whose session has ended. This runs even when the
 *      market is shut, because 16:00 is exactly when it needs to happen.
 *   2. If the market is closed — or the calendar is unreachable, which is
 *      treated identically — stop. Filling on a guess is how trades appear on
 *      Thanksgiving.
 *   3. Price every symbol involved in one batched request and fill whatever
 *      has become marketable.
 *
 * Fills go through place_order() exactly like an immediate order, passing the
 * resting order's id so its reservation is released and it is marked FILLED
 * inside the same locked transaction as the trade.
 */

/** Orders examined per sweep. Far above any plausible club-wide queue. */
const MAX_ORDERS_PER_SWEEP = 500;

export interface SweepResult {
  /** False when the market was shut, which is the ordinary weekend case. */
  ran: boolean;
  reason: string | null;
  expired: number;
  considered: number;
  filled: number;
  rejected: number;
  /** Still resting: not marketable yet, or unpriceable this minute. */
  resting: number;
  /** Trailing stops whose anchor moved in the member's favour this tick. */
  trailed: number;
  /** Stops that fired this tick. A triggered STOP_LIMIT may still rest. */
  triggered: number;
}

interface PendingRow {
  id: string;
  portfolio_id: string;
  symbol: string;
  side: OrderSide;
  order_type: OrderType;
  limit_price: string | null;
  stop_price: string | null;
  trail_amount: string | null;
  trail_percent: string | null;
  trail_anchor: string | null;
  triggered_at: string | null;
  qty: string | null;
  notional: string | null;
  multiplier: string | null;
  portfolios: { user_id: string } | { user_id: string }[] | null;
}

const SQLSTATE_TO_CODE: Record<string, RejectCode> = {
  FC001: "INSUFFICIENT_BUYING_POWER",
  FC002: "POSITION_TOO_SMALL",
  FC003: "WRONG_SIDE",
  FC004: "TRADING_LOCKED",
  FC005: "NO_PORTFOLIO",
  FC006: "INVALID_ORDER",
};

export async function sweepRestingOrders(
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<SweepResult> {
  const empty: SweepResult = {
    ran: false,
    reason: null,
    expired: 0,
    considered: 0,
    filled: 0,
    rejected: 0,
    resting: 0,
    trailed: 0,
    triggered: 0,
  };

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(env);
  } catch (err) {
    if (err instanceof ConfigError) return { ...empty, reason: err.message };
    throw err;
  }

  // 1. Expiry first, and unconditionally. A DAY order's whole point is that it
  //    dies at the close, which is a moment when the market is not open.
  const { data: expired, error: expiryError } = await supabase.rpc("expire_pending_orders");
  if (expiryError) console.error("expire_pending_orders failed:", expiryError);
  empty.expired = typeof expired === "number" ? expired : 0;

  // 2. Everything still resting, oldest first. First come, first served is the
  //    only ordering a member can predict, and it matters: two orders can be
  //    competing for the same buying power.
  //
  //    This runs BEFORE the clock is fetched, which is the reverse of the old
  //    order and deliberate. The sweep now fires every minute of every day so
  //    that crypto can fill on a Sunday, and on the overwhelming majority of
  //    those minutes there is nothing queued at all. One indexed query is a
  //    cheaper way to discover that than a clock lookup plus a query.
  const { data, error } = await supabase
    .from("pending_orders")
    .select(
      "id, portfolio_id, symbol, side, order_type, limit_price, stop_price, trail_amount, trail_percent, trail_anchor, triggered_at, qty, notional, multiplier, portfolios!inner(user_id)",
    )
    .eq("status", "PENDING")
    .order("placed_at", { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error("pending order query failed:", error);
    return { ...empty, ran: true, reason: "Could not read working orders." };
  }

  const orders = (data ?? []) as unknown as PendingRow[];
  if (orders.length === 0) return { ...empty, ran: true };

  // 3. The market gate, now per asset class rather than for the whole sweep.
  //    An unreachable calendar is still refused as firmly as a closed one for
  //    equities and options — see tradingWindow() — but it must not take crypto
  //    down with it, because crypto is definitely open and the calendar has
  //    nothing to say about it.
  const clock = await marketClock(env);
  const exchangeShut = tradingWindow(clock);

  const tradable = orders.filter((order) => tradingWindow(clock, order.symbol) === null);
  if (tradable.length === 0) {
    return { ...empty, reason: exchangeShut?.message ?? "Nothing is fillable yet." };
  }

  // Positions of every affected portfolio, so place_order() can be handed marks
  // for the Reg T check rather than falling back to average cost.
  const portfolioIds = [...new Set(tradable.map((o) => o.portfolio_id))];
  const { data: positionRows } = await supabase
    .from("positions")
    .select("portfolio_id, symbol, qty")
    .in("portfolio_id", portfolioIds);

  const positionsByPortfolio = new Map<string, string[]>();
  for (const row of positionRows ?? []) {
    const list = positionsByPortfolio.get(row.portfolio_id as string) ?? [];
    list.push(row.symbol as string);
    positionsByPortfolio.set(row.portfolio_id as string, list);
  }

  // One batched request covers every order and every mark in the club.
  const symbols = [
    ...new Set([...tradable.map((o) => o.symbol), ...(positionRows ?? []).map((r) => r.symbol as string)]),
  ];
  const priced = await quoteCache(env).get(symbols, waitUntil);

  const result: SweepResult = { ...empty, ran: true };
  // Orders whose own market is shut are still resting, not overlooked.
  result.resting += orders.length - tradable.length;

  for (const order of tradable) {
    result.considered += 1;

    const quote = priced.quotes.get(order.symbol);
    if (!quote) {
      // Nothing to fill against this minute. Left resting deliberately — an
      // unpriceable symbol is a data problem, not a bad order.
      result.resting += 1;
      continue;
    }

    const limitPrice = order.limit_price === null ? null : Number(order.limit_price);
    let stopPrice = order.stop_price === null ? null : Number(order.stop_price);
    let triggeredAt = order.triggered_at;

    // ---------------------------------------------------------------------
    // The ratchet, before anything is decided.
    //
    // A trailing stop's trigger is not a number the member typed — it is
    // derived from the best price the market has offered since they placed it,
    // so it has to be brought up to date against *this* tick before that tick
    // is used to test it. Doing it the other way round would evaluate today's
    // price against yesterday's stop, which is a trailing stop that trails one
    // sweep behind and fires late every time.
    //
    // The move itself is `trail_pending_order()`, not an UPDATE here: the
    // anchor may only travel in the member's favour, and saying that with
    // greatest/least inside one statement is what stops a concurrent sweep
    // walking it backwards.
    // ---------------------------------------------------------------------
    if (order.order_type === "TRAILING_STOP" && triggeredAt === null) {
      const { data: trailed, error: trailError } = await supabase.rpc("trail_pending_order", {
        p_order_id: order.id,
        p_price: quote.price,
      });

      if (trailError) {
        // A trail that cannot be updated is left alone rather than tested
        // against a stale stop, which would fire it at the wrong price.
        console.error(`Trailing stop ${order.id} could not be updated:`, trailError.message);
        result.resting += 1;
        continue;
      }

      const row = Array.isArray(trailed) ? trailed[0] : trailed;
      if (row?.stop_price != null) stopPrice = Number(row.stop_price);
      if (row?.moved) result.trailed += 1;
    }

    const spec = {
      side: order.side,
      orderType: order.order_type,
      limitPrice,
      stopPrice,
      triggeredAt,
    };

    // ---------------------------------------------------------------------
    // Firing is recorded, not re-derived.
    //
    // A stop that has fired has stopped being a stop — a STOP becomes a market
    // order and a STOP_LIMIT becomes a limit order that may still have to
    // wait. Stamping `triggered_at` is what keeps a stop-limit from un-firing
    // when the price crosses back over its trigger, which would turn a
    // one-way event into something that flickers.
    // ---------------------------------------------------------------------
    if (triggeredAt === null && stopTriggered(spec, quote.price)) {
      const { error: triggerError } = await supabase.rpc("trigger_pending_order", {
        p_order_id: order.id,
      });

      if (triggerError) {
        console.error(`Stop ${order.id} could not be triggered:`, triggerError.message);
        result.resting += 1;
        continue;
      }

      triggeredAt = new Date().toISOString();
      spec.triggeredAt = triggeredAt;
      result.triggered += 1;
    }

    if (!isMarketable(spec, quote.price)) {
      result.resting += 1;
      continue;
    }

    const price = fillPriceFor(spec, quote.price);
    const asset = await lookupSymbol(env, order.symbol).catch(() => undefined);

    const resolved = resolveQuantity({
      qty: order.qty === null ? undefined : Number(order.qty),
      notional: order.notional === null ? undefined : Number(order.notional),
      price,
      symbol: order.symbol,
      fractionable: asset?.fractionable,
      minSize: asset?.minOrderSize,
    });

    if ("ok" in resolved) {
      await rejectOrder(supabase, order.id, resolved.message);
      result.rejected += 1;
      continue;
    }

    const owner = Array.isArray(order.portfolios) ? order.portfolios[0] : order.portfolios;
    if (!owner?.user_id) {
      await rejectOrder(supabase, order.id, "This order has no owner.");
      result.rejected += 1;
      continue;
    }

    const marks: Record<string, number> = { [order.symbol]: price };
    for (const symbol of positionsByPortfolio.get(order.portfolio_id) ?? []) {
      const mark = priced.quotes.get(symbol);
      if (mark) marks[symbol] = mark.price;
    }

    const { error: fillError } = await supabase.rpc("place_order", {
      p_user_id: owner.user_id,
      p_symbol: order.symbol,
      p_side: order.side,
      p_qty: resolved.qty,
      p_price: price,
      p_marks: marks,
      p_pending_order_id: order.id,
      p_multiplier: order.multiplier === null ? 1 : Number(order.multiplier),
    });

    if (!fillError) {
      result.filled += 1;
      continue;
    }

    const outcome = classify(fillError);
    if (outcome.retry) {
      result.resting += 1;
      continue;
    }

    await rejectOrder(supabase, order.id, outcome.message);
    result.rejected += 1;
  }

  return result;
}

/**
 * Whether a database refusal is worth another minute.
 *
 * An order that can never fill must not sit in the list looking live, so
 * everything except a locked season is written off with its reason kept. An
 * unmapped error is a real fault: it is logged in full and retried, because
 * assuming a bug means "this order is invalid" would silently bin someone's
 * order over an outage.
 */
function classify(error: PostgrestError): { retry: boolean; message: string } {
  const code = SQLSTATE_TO_CODE[error.code ?? ""];

  if (!code) {
    console.error("place_order failed during sweep:", error);
    return { retry: true, message: error.message };
  }

  return { retry: isRetryable(code), message: error.message };
}

async function rejectOrder(supabase: SupabaseClient, id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("reject_pending_order", {
    p_order_id: id,
    p_reason: reason,
  });
  // A failed rejection leaves the order resting with its reservation intact,
  // which is the safe direction: the next sweep tries again.
  if (error) console.error(`Could not reject order ${id}:`, error);
}
