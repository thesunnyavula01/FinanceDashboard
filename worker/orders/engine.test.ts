import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyFill,
  buyingPowerAfter,
  marketValues,
  REG_T_MARGIN_MULTIPLIER,
  resolveQuantity,
  round,
  tradingWindow,
  type Fill,
  type Position,
} from "./engine.ts";
import type { MarketClock } from "../market/provider.ts";

/**
 * The behaviours Phase 4 has to get right, pinned.
 *
 * Everything here runs against engine.ts, which is the pre-flight half of the
 * trading rules. The authority is place_order() in the migration, and the last
 * test in this file reads that SQL and fails if the two have drifted apart on
 * anything a unit test cannot otherwise see.
 *
 * Run with: npm test
 */

function fill(outcome: ReturnType<typeof applyFill>): Fill {
  assert.equal(outcome.ok, true, `expected a fill, got: ${JSON.stringify(outcome)}`);
  return outcome as Fill;
}

// -----------------------------------------------------------------------------
// The signed-quantity convention, in both directions.
// -----------------------------------------------------------------------------

test("a short is stored as negative quantity", () => {
  const opened = fill(applyFill(null, "TSLA", "SHORT", 15, 242.8));

  assert.equal(opened.position?.qty, -15);
  assert.equal(opened.position?.avgCost, 242.8);
  // Shorting credits the proceeds. The cost of the position is the margin held
  // against it, not a cash outflow.
  assert.equal(opened.cashDelta, 3642);
  assert.equal(opened.realizedPnl, 0);
});

test("a short that falls in price realises a POSITIVE P/L", () => {
  // The headline case from the plan. Short 15 TSLA at 242.80, cover at 236.15:
  // the price fell 6.65, so the member made 6.65 x 15 = 99.75.
  const position: Position = { symbol: "TSLA", qty: -15, avgCost: 242.8 };
  const covered = fill(applyFill(position, "TSLA", "COVER", 15, 236.15));

  assert.equal(covered.realizedPnl, 99.75);
  assert.ok(covered.realizedPnl > 0, "a short that fell must book a gain");
  assert.equal(covered.position, null, "covering the whole thing closes the position");
  assert.equal(covered.cashDelta, -3542.25);
});

test("a short that rises in price realises a loss", () => {
  const position: Position = { symbol: "TSLA", qty: -15, avgCost: 242.8 };
  const covered = fill(applyFill(position, "TSLA", "COVER", 15, 250.0));

  assert.equal(covered.realizedPnl, -108);
});

test("the unrealised formula needs no long/short branch", () => {
  // (price - avg_cost) * qty, with qty carrying the sign. This is the invariant
  // the whole analytics layer leans on, so it is worth stating as a test rather
  // than only as a comment.
  const pnl = (price: number, avgCost: number, qty: number) => round((price - avgCost) * qty, 2);

  assert.equal(pnl(180, 176.2, 40), 152); // long, up
  assert.equal(pnl(170, 176.2, 40), -248); // long, down
  assert.equal(pnl(236.15, 242.8, -15), 99.75); // short, down -> gain
  assert.equal(pnl(250, 242.8, -15), -108); // short, up -> loss
});

// -----------------------------------------------------------------------------
// Partial closes.
// -----------------------------------------------------------------------------

test("a partial cover leaves the rest of the short at its original average", () => {
  const position: Position = { symbol: "TSLA", qty: -15, avgCost: 242.8 };
  const covered = fill(applyFill(position, "TSLA", "COVER", 5, 236.15));

  assert.equal(covered.realizedPnl, 33.25, "5 shares x 6.65");
  assert.equal(covered.position?.qty, -10, "still short the other ten");
  assert.equal(
    covered.position?.avgCost,
    242.8,
    "covering part of a short does not change what the rest was sold at",
  );
});

test("a partial sell leaves the rest of the long at its original average", () => {
  const position: Position = { symbol: "NVDA", qty: 40, avgCost: 176.2 };
  const sold = fill(applyFill(position, "NVDA", "SELL", 10, 180.1));

  assert.equal(sold.realizedPnl, 39);
  assert.equal(sold.position?.qty, 30);
  assert.equal(sold.position?.avgCost, 176.2);
  assert.equal(sold.cashDelta, 1801);
});

test("closing a position exactly removes it", () => {
  const position: Position = { symbol: "NVDA", qty: 40, avgCost: 176.2 };
  assert.equal(fill(applyFill(position, "NVDA", "SELL", 40, 180.1)).position, null);
});

// -----------------------------------------------------------------------------
// Weighted average cost.
// -----------------------------------------------------------------------------

test("adding to a long re-weights the average cost", () => {
  const position: Position = { symbol: "AAPL", qty: 100, avgCost: 200 };
  const added = fill(applyFill(position, "AAPL", "BUY", 100, 240));

  assert.equal(added.position?.qty, 200);
  assert.equal(added.position?.avgCost, 220, "the midpoint of equal-sized lots");
});

test("adding to a short re-weights the average cost too", () => {
  const position: Position = { symbol: "TSLA", qty: -10, avgCost: 240 };
  const added = fill(applyFill(position, "TSLA", "SHORT", 30, 260));

  assert.equal(added.position?.qty, -40);
  // (10 x 240 + 30 x 260) / 40 = 255
  assert.equal(added.position?.avgCost, 255);
});

test("a first buy sets the average cost to the fill price", () => {
  assert.equal(fill(applyFill(null, "MSFT", "BUY", 30, 410.1)).position?.avgCost, 410.1);
});

// -----------------------------------------------------------------------------
// Rejections.
// -----------------------------------------------------------------------------

test("selling more than you hold is rejected", () => {
  const position: Position = { symbol: "NVDA", qty: 40, avgCost: 176.2 };
  const outcome = applyFill(position, "NVDA", "SELL", 41, 180.1);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, "POSITION_TOO_SMALL");
  assert.match(outcome.ok === false ? outcome.message : "", /you cannot sell 41/i);
});

test("selling something you do not hold is rejected", () => {
  const outcome = applyFill(null, "NVDA", "SELL", 1, 180.1);
  assert.equal(outcome.ok === false && outcome.code, "POSITION_TOO_SMALL");
});

test("covering more than you are short is rejected", () => {
  const position: Position = { symbol: "TSLA", qty: -15, avgCost: 242.8 };
  const outcome = applyFill(position, "TSLA", "COVER", 16, 236.15);

  assert.equal(outcome.ok === false && outcome.code, "POSITION_TOO_SMALL");
});

test("no side is allowed to flip a position through zero", () => {
  const long: Position = { symbol: "NVDA", qty: 40, avgCost: 176.2 };
  const short: Position = { symbol: "TSLA", qty: -15, avgCost: 242.8 };

  // Each rejection names the side that would have done what the member meant.
  const buyOnShort = applyFill(short, "TSLA", "BUY", 15, 236.15);
  assert.equal(buyOnShort.ok === false && buyOnShort.code, "WRONG_SIDE");
  assert.match(buyOnShort.ok === false ? buyOnShort.message : "", /COVER/);

  const shortOnLong = applyFill(long, "NVDA", "SHORT", 40, 180.1);
  assert.equal(shortOnLong.ok === false && shortOnLong.code, "WRONG_SIDE");
  assert.match(shortOnLong.ok === false ? shortOnLong.message : "", /SELL/);

  const sellOnShort = applyFill(short, "TSLA", "SELL", 5, 236.15);
  assert.equal(sellOnShort.ok === false && sellOnShort.code, "WRONG_SIDE");

  const coverOnLong = applyFill(long, "NVDA", "COVER", 5, 180.1);
  assert.equal(coverOnLong.ok === false && coverOnLong.code, "WRONG_SIDE");
});

test("zero and negative quantities are rejected before anything else", () => {
  assert.equal(applyFill(null, "NVDA", "BUY", 0, 180).ok, false);
  assert.equal(applyFill(null, "NVDA", "BUY", -5, 180).ok, false);
  assert.equal(applyFill(null, "NVDA", "BUY", 5, 0).ok, false);
  assert.equal(applyFill(null, "NVDA", "BUY", 5, Number.NaN).ok, false);
});

// -----------------------------------------------------------------------------
// Reg T and buying power.
// -----------------------------------------------------------------------------

test("buying power is cash less 1.5x the short market value", () => {
  const positions: Position[] = [
    { symbol: "NVDA", qty: 40, avgCost: 176.2 },
    { symbol: "TSLA", qty: -15, avgCost: 242.8 },
  ];
  const marks = { NVDA: 180, TSLA: 240 };

  const v = marketValues(positions, marks, 50_000);

  assert.equal(v.longMv, 7200);
  assert.equal(v.shortMv, 3600);
  assert.equal(v.marginHeld, 5400, "1.5 x 3600");
  assert.equal(v.equity, 53_600, "cash + long - short");
  assert.equal(v.buyingPower, 44_600);
});

test("a position with no mark falls back to its average cost", () => {
  const v = marketValues([{ symbol: "NVDA", qty: 10, avgCost: 100 }], {}, 1000);
  assert.equal(v.longMv, 1000);
});

test("a buy beyond buying power is rejected", () => {
  const positions: Position[] = [];
  const cash = 1000;
  const outcome = fill(applyFill(null, "NVDA", "BUY", 10, 180));
  const { rejection } = buyingPowerAfter(positions, cash, outcome, {});

  assert.ok(rejection, "1,800 of stock on 1,000 of cash must not fill");
  assert.equal(rejection?.code, "INSUFFICIENT_BUYING_POWER");
  assert.match(rejection?.message ?? "", /needs \$1,800\.00/);
  assert.match(rejection?.message ?? "", /you have \$1,000\.00/);
});

test("a buy that exactly spends buying power is allowed", () => {
  const outcome = fill(applyFill(null, "NVDA", "BUY", 10, 100));
  const { rejection, valuation } = buyingPowerAfter([], 1000, outcome, {});

  assert.equal(rejection, null);
  assert.equal(valuation.buyingPower, 0);
  assert.equal(valuation.equity, 1000, "spending cash on stock does not change equity");
});

test("shorting consumes half the notional in buying power", () => {
  // The claim in CLAUDE.md: shorting $X credits $X and locks 1.5X, so it costs
  // 0.5X of buying power. $10,000 of cash therefore supports a $20,000 short.
  const twenty = fill(applyFill(null, "TSLA", "SHORT", 100, 200));
  assert.equal(buyingPowerAfter([], 10_000, twenty, {}).rejection, null);
  assert.equal(buyingPowerAfter([], 10_000, twenty, {}).valuation.buyingPower, 0);

  const overTwenty = fill(applyFill(null, "TSLA", "SHORT", 101, 200));
  assert.ok(
    buyingPowerAfter([], 10_000, overTwenty, {}).rejection,
    "one share more than the limit must be refused",
  );
});

test("a short rejection quotes half the notional, not the whole thing", () => {
  const outcome = fill(applyFill(null, "TSLA", "SHORT", 200, 200));
  const { rejection } = buyingPowerAfter([], 10_000, outcome, {});

  // $40,000 notional, so $20,000 of buying power. Quoting $40,000 would tell a
  // member they need twice what they actually do.
  assert.match(rejection?.message ?? "", /needs \$20,000\.00/);
});

test("a short is marked at the live price, not at what it was sold for", () => {
  // Short 100 at 200 on 20,000 of cash: 40,000 credited, 30,000 held, 30,000
  // free. The price then doubles, so the margin requirement doubles too and the
  // member is deep underwater — a new buy must not squeeze through on a stale
  // mark of 200.
  const positions: Position[] = [{ symbol: "TSLA", qty: -100, avgCost: 200 }];
  const cash = 60_000;

  const atCost = marketValues(positions, { TSLA: 200 }, cash);
  assert.equal(atCost.buyingPower, 30_000);

  const atMarket = marketValues(positions, { TSLA: 400 }, cash);
  assert.equal(atMarket.marginHeld, 60_000);
  assert.equal(atMarket.buyingPower, 0);
  assert.equal(atMarket.netBuyingPower, 0);

  const buy = fill(applyFill(null, "NVDA", "BUY", 10, 180));
  assert.ok(
    buyingPowerAfter(positions, cash, buy, { TSLA: 400 }).rejection,
    "the buy must be refused against the re-marked short",
  );
});

test("closing sides are never blocked, even from underwater", () => {
  // A short that has run away: 100 at 200, now trading at 500. Margin held is
  // 75,000 against 55,000 of cash, so buying power is long gone. There is no
  // forced liquidation in v1, so covering has to stay possible — refusing it
  // would leave the member with no way out at all.
  const positions: Position[] = [{ symbol: "TSLA", qty: -100, avgCost: 200 }];
  const cash = 55_000;
  const marks = { TSLA: 500 };

  assert.ok(marketValues(positions, marks, cash).netBuyingPower < 0, "already underwater");

  const cover = fill(applyFill(positions[0]!, "TSLA", "COVER", 100, 500));
  const { rejection, valuation } = buyingPowerAfter(positions, cash, cover, marks);

  assert.equal(rejection, null, "a cover must never be refused");
  assert.equal(valuation.equity, 5000, "55,000 cash less the 50,000 it cost to buy back");

  // And a sell, for the same reason.
  const long: Position[] = [{ symbol: "NVDA", qty: 10, avgCost: 100 }];
  const sell = fill(applyFill(long[0]!, "NVDA", "SELL", 10, 90));
  assert.equal(buyingPowerAfter(long, 0, sell, { NVDA: 90 }).rejection, null);
});

test("covering may drive cash negative rather than trapping the member", () => {
  const positions: Position[] = [{ symbol: "TSLA", qty: -100, avgCost: 200 }];
  const cover = fill(applyFill(positions[0]!, "TSLA", "COVER", 100, 500));
  const { rejection, valuation } = buyingPowerAfter(positions, 1000, cover, { TSLA: 500 });

  assert.equal(rejection, null);
  assert.equal(valuation.equity, -49_000, "a real loss, shown rather than prevented");
});

// -----------------------------------------------------------------------------
// The market window.
// -----------------------------------------------------------------------------

function clock(overrides: Partial<MarketClock> = {}): MarketClock {
  return {
    state: "OPEN",
    isOpen: true,
    label: "Open until 16:00 ET",
    nextOpen: null,
    nextClose: null,
    authoritative: true,
    ...overrides,
  };
}

test("orders fill only while the market is open", () => {
  assert.equal(tradingWindow(clock()), null);

  const closed = tradingWindow(clock({ isOpen: false, state: "CLOSED", label: "Opens 09:30 ET" }));
  assert.equal(closed?.code, "MARKET_CLOSED");
  assert.match(closed?.message ?? "", /Opens 09:30 ET/);
});

test("an estimated clock is refused as firmly as a closed one", () => {
  // The fallback in session.ts guesses from New York wall-clock hours and knows
  // nothing about Thanksgiving. Filling on a guess would mean trades on a day
  // the exchange never opened.
  const guessing = tradingWindow(clock({ authoritative: false }));

  assert.equal(guessing?.code, "MARKET_CLOSED");
  assert.match(guessing?.message ?? "", /cannot confirm/i);
});

test("pre-market and after-hours are not open", () => {
  assert.ok(tradingWindow(clock({ isOpen: false, state: "PRE" })));
  assert.ok(tradingWindow(clock({ isOpen: false, state: "POST" })));
});

// -----------------------------------------------------------------------------
// Dollar-denominated entry.
// -----------------------------------------------------------------------------

test("a dollar amount converts at the price the Worker fetched", () => {
  const resolved = resolveQuantity({ notional: 500, price: 180, symbol: "NVDA" });
  assert.equal("qty" in resolved && resolved.qty, 2.777777, "floored to 6dp, never rounded up");
  assert.ok(2.777777 * 180 <= 500, "a $500 order must never cost $500.01");
});

test("a whole-share-only symbol rounds down", () => {
  const resolved = resolveQuantity({
    notional: 500,
    price: 180,
    symbol: "BRK.A",
    fractionable: false,
  });
  assert.equal("qty" in resolved && resolved.qty, 2);
});

test("a dollar amount below one whole share is rejected, not rounded to zero", () => {
  const resolved = resolveQuantity({
    notional: 100,
    price: 180,
    symbol: "BRK.A",
    fractionable: false,
  });
  assert.equal("ok" in resolved && resolved.ok, false);
  assert.match("message" in resolved ? resolved.message : "", /whole shares only/i);
});

test("shares and dollars are mutually exclusive", () => {
  assert.equal(
    "ok" in resolveQuantity({ qty: 5, notional: 500, price: 180, symbol: "NVDA" }),
    true,
    "asking for both is a rejection",
  );
  assert.equal("ok" in resolveQuantity({ price: 180, symbol: "NVDA" }), true, "asking for neither too");
});

test("a fractional share count on a whole-share symbol is floored", () => {
  const resolved = resolveQuantity({ qty: 2.9, price: 180, symbol: "BRK.A", fractionable: false });
  assert.equal("qty" in resolved && resolved.qty, 2);
});

test("an unsynced universe does not block an order", () => {
  // lookupSymbol returns undefined when KV has never been populated. That is
  // "we don't know", not "not fractionable", and a cold cache must not stop the
  // club trading on the first day of a deployment.
  const resolved = resolveQuantity({ qty: 2.5, price: 180, symbol: "NVDA" });
  assert.equal("qty" in resolved && resolved.qty, 2.5);
});

// -----------------------------------------------------------------------------
// Rounding.
// -----------------------------------------------------------------------------

test("rounding matches Postgres rather than binary floating point", () => {
  // Math.round(1.005 * 100) / 100 is 1, because 1.005 is really 1.00499…
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(2.675, 2), 2.68);
  assert.equal(round(-1.005, 2), -1);
  assert.equal(round(0.1 + 0.2, 2), 0.3);
});

test("a fill's notional is rounded to cents, not carried at full float width", () => {
  const outcome = fill(applyFill(null, "NVDA", "BUY", 3, 33.333333));
  assert.equal(outcome.notional, 100);
  assert.equal(outcome.cashDelta, -100);
});

// -----------------------------------------------------------------------------
// Drift alarm.
//
// The two halves of the trading rules live in different languages and cannot be
// executed together here — node --test has no Postgres. What this can do is read
// the SQL and fail loudly if the pieces that must agree have stopped agreeing.
// -----------------------------------------------------------------------------

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../supabase/migrations/0002_trading.sql", import.meta.url)),
  "utf8",
);

test("the SQL and this engine agree on the Reg T multiplier", () => {
  const match = MIGRATION.match(/reg_t_margin_multiplier\(\)[\s\S]*?select\s+([\d.]+)::numeric/);
  assert.ok(match, "reg_t_margin_multiplier() should still be a one-line SQL function");
  assert.equal(
    Number(match![1]),
    REG_T_MARGIN_MULTIPLIER,
    "the margin multiplier changed in the migration but not in engine.ts",
  );
});

test("the SQL takes a row lock before it reads the balance", () => {
  // This is the guarantee no unit test can reproduce: two orders arriving at
  // once must not both read the same cash balance. It comes entirely from this
  // clause, so its disappearance should break the build.
  assert.match(
    MIGRATION,
    /from portfolios p[\s\S]*?for update of p/,
    "place_order() must select the portfolio FOR UPDATE before touching cash",
  );
  assert.doesNotMatch(
    MIGRATION,
    /for update of p[\s\S]*?for update of p/,
    "there should be exactly one portfolio lock, taken once at the top",
  );
});

test("the SQL rejects the same four sides this engine does", () => {
  for (const code of ["FC001", "FC002", "FC003", "FC004", "FC005", "FC006"]) {
    assert.match(MIGRATION, new RegExp(`errcode = '${code}'`), `${code} is no longer raised`);
  }
});

test("the SQL checks buying power only on the opening sides", () => {
  assert.match(
    MIGRATION,
    /v_side in \('BUY', 'SHORT'\) and v_buying_power < 0/,
    "the closing sides must stay unblocked, or an underwater member is trapped",
  );
});
