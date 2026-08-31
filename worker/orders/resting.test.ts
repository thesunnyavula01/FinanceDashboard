import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fillPriceFor,
  isMarketable,
  isRetryable,
  MARKET_ORDER_BUFFER,
  reserveFor,
  REG_T_MARGIN_MULTIPLIER,
} from "./engine.ts";

/**
 * Resting orders.
 *
 * The premise underneath every test here: nothing fills on a weekend. US
 * equities trade 09:30-16:00 ET on weekdays, so a queued order is a stored
 * instruction and Friday's close does not move until Monday. These pin what
 * happens when the market finally opens — not any notion of matching a price
 * while it is shut.
 *
 * Run with: npm test
 */

function res(outcome: ReturnType<typeof reserveFor>) {
  assert.ok(!("ok" in outcome), `expected a reservation, got: ${JSON.stringify(outcome)}`);
  return outcome as { cash: number; qty: number };
}

function rejection(outcome: ReturnType<typeof reserveFor>) {
  assert.ok("ok" in outcome, "expected a rejection");
  return outcome as { ok: false; code: string; message: string };
}

// -----------------------------------------------------------------------------
// Reservations — what is held while an order rests.
// -----------------------------------------------------------------------------

test("a dollar buy reserves exactly the dollars typed", () => {
  // "$500 of NVDA" costs $500 whatever the price does, so there is nothing to
  // buffer. It is the cleanest way to queue a weekend order.
  const r = res(
    reserveFor({ side: "BUY", orderType: "MARKET", notional: 500, referencePrice: 180 }),
  );
  assert.equal(r.cash, 500);
  assert.equal(r.qty, 0);
});

test("a share market buy reserves head-room, because the open can gap up", () => {
  // 10 x 180 = 1,800, plus 5% because Monday need not open at Friday's close.
  const r = res(reserveFor({ side: "BUY", orderType: "MARKET", qty: 10, referencePrice: 180 }));
  assert.equal(r.cash, 1890);
  assert.equal(r.cash, 1800 * (1 + MARKET_ORDER_BUFFER));
});

test("a share limit buy reserves exactly its limit — the limit IS the cap", () => {
  const r = res(
    reserveFor({ side: "BUY", orderType: "LIMIT", limitPrice: 170, qty: 10, referencePrice: 180 }),
  );
  assert.equal(r.cash, 1700, "no head-room: the order cannot fill above 170");
});

test("a short reserves half, because the proceeds land in cash", () => {
  const dollars = res(
    reserveFor({ side: "SHORT", orderType: "MARKET", notional: 10_000, referencePrice: 200 }),
  );
  assert.equal(dollars.cash, 5000, "Reg T holds 1.5x against a 1x credit");
  assert.equal(dollars.cash, 10_000 * (REG_T_MARGIN_MULTIPLIER - 1));

  const shares = res(
    reserveFor({ side: "SHORT", orderType: "MARKET", qty: 50, referencePrice: 200 }),
  );
  assert.equal(shares.cash, 5250, "10,000 notional plus 5% head-room, halved");
});

test("a SHORT limit is buffered even though a BUY limit is not", () => {
  // A short limit fills at its price *or higher*, so the proceeds — and the
  // margin held against them — have no ceiling. A buy limit has one by
  // definition, which is why only one of these carries head-room.
  const shortLimit = res(
    reserveFor({ side: "SHORT", orderType: "LIMIT", limitPrice: 200, qty: 50, referencePrice: 190 }),
  );
  const buyLimit = res(
    reserveFor({ side: "BUY", orderType: "LIMIT", limitPrice: 200, qty: 50, referencePrice: 190 }),
  );

  assert.equal(shortLimit.cash, 5250);
  assert.equal(buyLimit.cash, 10_000);
  assert.ok(
    shortLimit.cash > (50 * 200) / 2,
    "the short's reservation must exceed the unbuffered half-notional",
  );
});

test("closing orders reserve shares, not cash", () => {
  // A SELL raises money rather than spending it, but it does consume a
  // position — and two queued SELLs of the same 40 shares must not both stand.
  const sell = res(reserveFor({ side: "SELL", orderType: "MARKET", qty: 40, referencePrice: 180 }));
  assert.deepEqual(sell, { cash: 0, qty: 40 });

  const cover = res(
    reserveFor({ side: "COVER", orderType: "LIMIT", limitPrice: 230, qty: 15, referencePrice: 240 }),
  );
  assert.deepEqual(cover, { cash: 0, qty: 15 });
});

test("a working close must be entered in shares, not dollars", () => {
  // The conversion runs the wrong way: the cheaper the fill, the more shares
  // "$500 of NVDA" turns out to be, so there is no honest number to reserve.
  const outcome = rejection(
    reserveFor({ side: "SELL", orderType: "MARKET", notional: 500, referencePrice: 180 }),
  );

  assert.equal(outcome.code, "INVALID_ORDER");
  assert.match(outcome.message, /in shares, not dollars/i);
});

test("a limit needs a limit price and a market order must not carry one", () => {
  assert.equal(
    rejection(reserveFor({ side: "BUY", orderType: "LIMIT", qty: 1, referencePrice: 100 })).code,
    "INVALID_ORDER",
  );
  assert.equal(
    rejection(
      reserveFor({ side: "BUY", orderType: "MARKET", limitPrice: 90, qty: 1, referencePrice: 100 }),
    ).code,
    "INVALID_ORDER",
  );
});

test("shares and dollars stay mutually exclusive on a resting order too", () => {
  assert.equal(
    rejection(
      reserveFor({ side: "BUY", orderType: "MARKET", qty: 5, notional: 500, referencePrice: 100 }),
    ).code,
    "INVALID_ORDER",
  );
  assert.equal(
    rejection(reserveFor({ side: "BUY", orderType: "MARKET", referencePrice: 100 })).code,
    "INVALID_ORDER",
  );
});

// -----------------------------------------------------------------------------
// Marketability — which way a limit points.
// -----------------------------------------------------------------------------

test("a buy limit triggers at or below its price; a sell limit at or above", () => {
  const buy = { side: "BUY" as const, orderType: "LIMIT" as const, limitPrice: 100 };
  assert.equal(isMarketable(buy, 99), true);
  assert.equal(isMarketable(buy, 100), true, "at the limit counts");
  assert.equal(isMarketable(buy, 101), false);

  const sell = { side: "SELL" as const, orderType: "LIMIT" as const, limitPrice: 100 };
  assert.equal(isMarketable(sell, 101), true);
  assert.equal(isMarketable(sell, 100), true);
  assert.equal(isMarketable(sell, 99), false);
});

test("COVER follows BUY and SHORT follows SELL, by who is paying", () => {
  assert.equal(isMarketable({ side: "COVER", orderType: "LIMIT", limitPrice: 100 }, 95), true);
  assert.equal(isMarketable({ side: "COVER", orderType: "LIMIT", limitPrice: 100 }, 105), false);
  assert.equal(isMarketable({ side: "SHORT", orderType: "LIMIT", limitPrice: 100 }, 105), true);
  assert.equal(isMarketable({ side: "SHORT", orderType: "LIMIT", limitPrice: 100 }, 95), false);
});

test("a market order is always marketable — the sweep only runs when open", () => {
  assert.equal(isMarketable({ side: "BUY", orderType: "MARKET" }, 180), true);
  assert.equal(isMarketable({ side: "SELL", orderType: "MARKET" }, 0.01), true);
  // No usable price is still no fill, whatever the type.
  assert.equal(isMarketable({ side: "BUY", orderType: "MARKET" }, 0), false);
});

test("the weekend gap case: a limit fills at the market, not at the limit", () => {
  // The scenario a member will actually hit, and the reason the fill price is
  // the market's rather than the order's. NVDA closes Friday at 100; over the
  // weekend they set a buy limit at 105, which looks certain to fill.
  const order = { side: "BUY" as const, orderType: "LIMIT" as const, limitPrice: 105 };

  // Monday opens at 95. It fills, and at 95 — the better price, because 95 is
  // where the trade happened. Filling at 105 would overcharge 10 a share for
  // nothing and hide how opening gaps work.
  assert.equal(isMarketable(order, 95), true);
  assert.equal(fillPriceFor(order, 95), 95);

  // Monday gaps to 110. No fill at all, despite the limit looking generous on
  // Sunday — the market never traded at 105.
  assert.equal(isMarketable(order, 110), false);

  // And just inside the limit, it fills there.
  assert.equal(isMarketable(order, 104), true);
  assert.equal(fillPriceFor(order, 104), 104);
});

test("only a locked season is worth retrying on the next sweep", () => {
  // Everything else fails identically in sixty seconds, and an order that can
  // never fill should not sit there looking live.
  assert.equal(isRetryable("TRADING_LOCKED"), true);
  assert.equal(isRetryable("POSITION_TOO_SMALL"), false);
  assert.equal(isRetryable("WRONG_SIDE"), false);
  assert.equal(isRetryable("INSUFFICIENT_BUYING_POWER"), false);
  assert.equal(isRetryable("INVALID_ORDER"), false);
  assert.equal(isRetryable("NO_PORTFOLIO"), false);
});

// -----------------------------------------------------------------------------
// Drift alarm for 0003, same idea as the one in engine.test.ts: the SQL cannot
// be executed here, so assert the properties that must not silently disappear.
// -----------------------------------------------------------------------------

const RESTING = readFileSync(
  fileURLToPath(new URL("../../supabase/migrations/0003_resting_orders.sql", import.meta.url)),
  "utf8",
);

test("every exit from PENDING releases the reservation", () => {
  // A leaked reservation is money the member can never spend again, and it is
  // invisible to them. The table constraint is the backstop.
  assert.match(
    RESTING,
    /constraint pending_orders_released[\s\S]*?status = 'PENDING' or \(reserved_cash = 0 and reserved_qty = 0\)/,
    "the released-on-exit constraint is what stops a reservation leaking",
  );

  for (const fn of ["cancel_pending_order", "expire_pending_orders", "reject_pending_order"]) {
    const start = RESTING.indexOf(`function ${fn}`);
    assert.ok(start > 0, `${fn} should exist`);
    assert.match(
      RESTING.slice(start, start + 1600),
      /reserved_cash = 0,\s*reserved_qty = 0/,
      `${fn} must release the reservation`,
    );
  }
});

test("a fill releases its reservation in the same transaction as the trade", () => {
  // Split across two statements, a crash between them would leave either a
  // trade with no order or a reservation with no order to release it.
  const start = RESTING.indexOf("if p_pending_order_id is not null then");
  assert.ok(RESTING.indexOf("set status = 'FILLED'", start) > 0);
  assert.match(
    RESTING.slice(RESTING.indexOf("set status = 'FILLED'")),
    /reserved_cash = 0,\s*reserved_qty = 0,\s*trade_id = v_trade_id/,
  );
});

test("resting orders are the one table not readable across the club", () => {
  // Every other table is deliberately open — seeing each other's picks is the
  // point. A resting order is intent, and publishing it invites the rest of the
  // club to trade in front of it.
  assert.match(
    RESTING,
    /create policy pending_orders_read[\s\S]*?user_id = auth\.uid\(\)/,
    "pending_orders must be owner-scoped, unlike positions and trades",
  );
});

test("place_order was replaced rather than overloaded", () => {
  // Two candidates differing only by a defaulted argument make every call
  // ambiguous, so the old signature has to go first.
  assert.match(
    RESTING,
    /drop function if exists place_order\(uuid, text, text, numeric, numeric, jsonb\);/,
    "the 6-arg place_order must be dropped before the 7-arg one is created",
  );
});

test("both order paths subtract what other resting orders have reserved", () => {
  // Without this an immediate buy could spend money a queued buy is holding,
  // and the sweep would find it gone on Monday.
  assert.match(
    RESTING,
    /v_reserved\s*:=\s*reserved_cash_for\(v_portfolio\.id, p_pending_order_id\)/,
    "place_order must net off other orders' reservations",
  );
  assert.match(RESTING, /v_buying_power\s*:=\s*v_cash - v_margin_held - v_reserved/);
  assert.match(
    RESTING,
    /v_free_qty\s*:=\s*abs\(v_prev_qty\) - reserved_qty_for\(/,
    "an immediate sell must not spend shares a queued sell is holding",
  );
});

test("the reservation excludes the order being filled, or it rejects itself", () => {
  // reserved_cash_for(portfolio, exclude) — the order being settled is spending
  // its own reservation, not competing with it.
  assert.match(
    RESTING,
    /function reserved_cash_for\(p_portfolio_id uuid, p_exclude uuid default null\)/,
  );
  assert.match(RESTING, /and \(p_exclude is null or o\.id <> p_exclude\)/);
});
