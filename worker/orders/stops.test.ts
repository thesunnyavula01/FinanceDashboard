import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkStopPlacement,
  hasLimit,
  hasStop,
  isMarketable,
  reserveFor,
  stopFiresOnRise,
  stopTriggered,
  trailingStopFrom,
  type OrderSide,
} from "./engine.ts";

/**
 * Stop, stop-limit and trailing-stop orders.
 *
 * Every bug this file exists to catch is a *direction* bug, and direction bugs
 * in a stop are invisible: the order is accepted, it rests, and then one day it
 * fires — on the wrong side of the market, at the worst possible moment, for a
 * member who did exactly what they were told. A stop-loss that sells into a
 * rally looks identical in the blotter to one that worked.
 *
 * So the eight side/direction combinations are enumerated rather than sampled.
 *
 * Run with: npm test
 */

/** The whole feature in one line, checked in both directions for all four sides. */
test("a stop is the mirror of a limit", () => {
  // A LIMIT buys cheaper than the market and sells dearer.
  // A STOP  buys dearer  than the market and sells cheaper.
  assert.equal(stopFiresOnRise("BUY"), true, "a buy stop is a breakout, above the market");
  assert.equal(stopFiresOnRise("COVER"), true, "covering a short is buying");
  assert.equal(stopFiresOnRise("SELL"), false, "a sell stop is a stop-loss, below the market");
  assert.equal(stopFiresOnRise("SHORT"), false, "shorting a breakdown is selling");

  // And the mirror itself: on the same price, a limit and a stop of the same
  // side are never both live. That is the property, not a coincidence.
  for (const side of ["BUY", "SELL", "SHORT", "COVER"] as const) {
    const limitLive = isMarketable({ side, orderType: "LIMIT", limitPrice: 100 }, 100.01);
    const stopLive = stopTriggered({ side, orderType: "STOP", stopPrice: 100 }, 100.01);
    assert.notEqual(limitLive, stopLive, `${side} limit and stop agreed, which cannot be right`);
  }
});

test("each side triggers on the correct crossing and not the other", () => {
  const cases: Array<[OrderSide, number, boolean, string]> = [
    ["SELL", 147.9, true, "stop-loss on a long fires as the price falls through"],
    ["SELL", 149.0, false, "and not while it is still above"],
    ["SHORT", 147.9, true, "a breakdown short fires on the way down"],
    ["SHORT", 149.0, false, "and not on the way up"],
    ["BUY", 149.0, true, "a breakout buy fires as the price rises through"],
    ["BUY", 147.9, false, "and not while it is still below"],
    ["COVER", 149.0, true, "covering a short fires as the price rises against it"],
    ["COVER", 147.9, false, "and not while the short is winning"],
  ];

  for (const [side, price, expected, why] of cases) {
    assert.equal(
      stopTriggered({ side, orderType: "STOP", stopPrice: 148.5 }, price),
      expected,
      `${side} at ${price}: ${why}`,
    );
  }
});

test("the trigger is inclusive, because the member typed that number", () => {
  assert.equal(stopTriggered({ side: "SELL", orderType: "STOP", stopPrice: 148.5 }, 148.5), true);
  assert.equal(stopTriggered({ side: "BUY", orderType: "STOP", stopPrice: 148.5 }, 148.5), true);
});

test("a stop on the wrong side of the market is refused, not fired instantly", () => {
  // A sell stop above the market fires on the next tick, which means the member
  // meant a market order. Accepting it and triggering immediately would be a
  // stop-loss that sold at once — technically correct, and useless.
  const badSell = checkStopPlacement("SELL", 152, 150);
  assert.ok(badSell && "ok" in badSell);
  assert.match(badSell.message, /below the market/);

  const badBuy = checkStopPlacement("BUY", 148, 150);
  assert.ok(badBuy && "ok" in badBuy);
  assert.match(badBuy.message, /above the market/);

  // The right way round passes.
  assert.equal(checkStopPlacement("SELL", 148, 150), null);
  assert.equal(checkStopPlacement("BUY", 152, 150), null);
  assert.equal(checkStopPlacement("COVER", 152, 150), null);
  assert.equal(checkStopPlacement("SHORT", 148, 150), null);
});

test("a stop exactly at the market is refused too", () => {
  // It would fire on the next print of the same price, which is not a stop.
  assert.ok(checkStopPlacement("SELL", 150, 150));
  assert.ok(checkStopPlacement("BUY", 150, 150));
});

test("a trailing stop starts one trail away, on the correct side", () => {
  // Selling: the stop sits below and follows the high up.
  assert.equal(trailingStopFrom("SELL", 100, { amount: 5 }), 95);
  assert.equal(trailingStopFrom("SELL", 100, { percent: 5 }), 95);
  // Buying: the stop sits above and follows the low down.
  assert.equal(trailingStopFrom("BUY", 100, { amount: 5 }), 105);
  assert.equal(trailingStopFrom("COVER", 100, { percent: 10 }), 110);
  assert.equal(trailingStopFrom("SHORT", 100, { amount: 2.5 }), 97.5);
});

test("a trail must be one thing or the other, and within its bounds", () => {
  for (const bad of [
    { amount: 5, percent: 5 },
    {},
    { amount: 0 },
    { amount: -1 },
    { percent: 0 },
    { percent: 100 },
    { percent: 150 },
  ]) {
    const out = trailingStopFrom("SELL", 100, bad);
    assert.ok(typeof out !== "number", `${JSON.stringify(bad)} was accepted`);
  }
});

test("a trail wider than the price is refused rather than parked at zero", () => {
  // A $150 trail on a $100 stock puts the stop at -$50, where nothing can ever
  // reach it — a good-til-cancelled no-op wearing a stop-loss's clothes.
  const out = trailingStopFrom("SELL", 100, { amount: 150 });
  assert.ok(typeof out !== "number");
  assert.match((out as { message: string }).message, /never be reachable/);
});

/**
 * The trigger is a one-way event, and this is the test that says so.
 *
 * A stop-limit that fires and then sees the price cross back must not un-fire:
 * it is a limit order from that moment on. Re-deriving the trigger each sweep
 * instead of recording it produces an order that flickers between the two
 * states and fills on whichever tick the sweep happened to land.
 */
test("a fired stop stops being a stop", () => {
  const stop = { side: "SELL" as const, orderType: "STOP" as const, stopPrice: 148.5 };

  // Untriggered and above the stop: not marketable at any price.
  assert.equal(isMarketable(stop, 160), false);
  // The crossing makes it marketable in the same call.
  assert.equal(isMarketable(stop, 148), true);
  // And once recorded, it stays marketable even back above the trigger.
  assert.equal(isMarketable({ ...stop, triggeredAt: "2026-09-02T15:00:00Z" }, 160), true);
});

test("a triggered stop-limit is a limit order, not a market order", () => {
  const order = {
    side: "SELL" as const,
    orderType: "STOP_LIMIT" as const,
    stopPrice: 148.5,
    limitPrice: 147,
    triggeredAt: "2026-09-02T15:00:00Z",
  };

  // Triggered, but the price is below the limit — a SELL wants at-or-above.
  assert.equal(isMarketable(order, 146), false, "it filled below its own limit");
  assert.equal(isMarketable(order, 147.5), true);

  // Untriggered, the limit being satisfied is not enough on its own. 149 is
  // above the 147 limit a SELL wants, and still above the 148.5 stop — so the
  // trigger has not been crossed and the order is not live, however good the
  // price looks against the limit alone.
  assert.equal(isMarketable({ ...order, triggeredAt: null }, 149), false);
  // And at 147.5 both conditions are met at once, which is a real fill: the
  // price fell through the stop and is still above the limit.
  assert.equal(isMarketable({ ...order, triggeredAt: null }, 147.5), true);
});

test("an untriggered stop is never marketable, whatever the limit says", () => {
  for (const orderType of ["STOP", "STOP_LIMIT", "TRAILING_STOP"] as const) {
    assert.equal(
      isMarketable({ side: "BUY", orderType, stopPrice: 200, limitPrice: 200 }, 100),
      false,
      `${orderType} was marketable before it fired`,
    );
  }
});

/**
 * Reservations. A buy stop sits *above* the market, so reserving against the
 * last price understates the cost by the whole distance to the trigger — the
 * member queues an order they cannot pay for, and it fails on the day it
 * finally fires.
 */
test("a buy stop reserves against its trigger, not the last price", () => {
  const held = reserveFor({
    side: "BUY",
    orderType: "STOP",
    stopPrice: 200,
    qty: 10,
    referencePrice: 100,
  });

  assert.ok(!("ok" in held));
  // 10 x 200 x 1.05 — the trigger, plus the usual market head-room past it.
  assert.equal(held.cash, 2100);
});

test("a stop-limit buy is capped by its limit, like any other limit", () => {
  const held = reserveFor({
    side: "BUY",
    orderType: "STOP_LIMIT",
    stopPrice: 200,
    limitPrice: 205,
    qty: 10,
    referencePrice: 100,
  });

  assert.ok(!("ok" in held));
  // The stop decides *when*; the limit still caps *what*. No head-room.
  assert.equal(held.cash, 2050);
});

test("a stop is entered in shares, never in dollars", () => {
  // There is no price to convert at until the trigger fires, and the conversion
  // runs the wrong way — the cheaper the fill, the more shares it buys.
  const out = reserveFor({
    side: "BUY",
    orderType: "STOP",
    stopPrice: 200,
    notional: 1000,
    referencePrice: 100,
  });

  assert.ok("ok" in out);
  assert.match(out.message, /entered in shares/);
});

test("a stop order must carry a stop price and nothing else must", () => {
  const missing = reserveFor({ side: "BUY", orderType: "STOP", qty: 1, referencePrice: 100 });
  assert.ok("ok" in missing);
  assert.match(missing.message, /needs a stop price/);

  const spurious = reserveFor({
    side: "BUY",
    orderType: "MARKET",
    stopPrice: 200,
    qty: 1,
    referencePrice: 100,
  });
  assert.ok("ok" in spurious);
  assert.match(spurious.message, /Only a stop order/);
});

test("a sell stop reserves shares, because it is still a closing order", () => {
  const held = reserveFor({
    side: "SELL",
    orderType: "STOP",
    stopPrice: 90,
    qty: 40,
    referencePrice: 100,
  });

  assert.ok(!("ok" in held));
  assert.deepEqual(held, { cash: 0, qty: 40 });
});

test("the two type predicates agree with the five order types", () => {
  assert.deepEqual(
    ["MARKET", "LIMIT", "STOP", "STOP_LIMIT", "TRAILING_STOP"].filter(
      (t) => hasStop(t as never),
    ),
    ["STOP", "STOP_LIMIT", "TRAILING_STOP"],
  );
  assert.deepEqual(
    ["MARKET", "LIMIT", "STOP", "STOP_LIMIT", "TRAILING_STOP"].filter(
      (t) => hasLimit(t as never),
    ),
    ["LIMIT", "STOP_LIMIT"],
  );
});

/**
 * The SQL side, read out of the migration — `npm test` has no database, and the
 * ratchet is the part that would be silently wrong.
 */
test("the ratchet only ever moves the anchor in the member's favour", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/0007_stop_orders.sql", import.meta.url)),
    "utf8",
  );

  const start = sql.indexOf("create or replace function trail_pending_order");
  assert.ok(start > 0, "trail_pending_order is no longer in 0007");
  const body = sql.slice(start, sql.indexOf("$fn$;", start));

  // greatest for a rising trail, least for a falling one. Anything else lets a
  // concurrent sweep walk the stop backwards and fire it early.
  assert.match(body, /greatest\(/, "the rising anchor no longer ratchets up");
  assert.match(body, /least\(/, "the falling anchor no longer ratchets down");
  assert.match(body, /for update/i, "the row is no longer locked while it moves");
  assert.match(
    body,
    /v_rising\s*:=\s*v_order\.side in \('SELL', 'SHORT'\)/,
    "the trail direction no longer matches stopFiresOnRise() in the engine",
  );
});

test("the migration keeps a stop's columns to the types that own them", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/0007_stop_orders.sql", import.meta.url)),
    "utf8",
  );

  // A stop price on a market order, or a limit price on a plain stop, is an
  // order that says two things at once. The table refuses both.
  assert.match(sql, /pending_orders_stop_price_required/);
  assert.match(sql, /\(order_type in \('LIMIT', 'STOP_LIMIT'\)\) = \(limit_price is not null\)/);
  assert.match(
    sql,
    /\(order_type in \('STOP', 'STOP_LIMIT', 'TRAILING_STOP'\)\) = \(stop_price is not null\)/,
  );
  // And a stop is entered in shares.
  assert.match(sql, /pending_orders_stop_needs_qty/);
});
