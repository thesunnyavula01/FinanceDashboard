import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bookIsSettled, intrinsicValue, planSettlements, type ExpiryResult } from "./expiry.ts";

/**
 * Option expiry.
 *
 * This is the one job in the app that deletes a position and moves money
 * without a member pressing anything, which makes every failure here silent by
 * construction. The cases below are the ones that would be: a put settled with
 * a call's arithmetic (right on a coin flip of days), an in-the-money contract
 * settled at zero because a bar was missing, and a snapshot written on top of a
 * book that never finished settling.
 *
 * Run with: npm test
 */

const TODAY = "2026-09-18";

function held(symbol: string, qty = 1, id = symbol) {
  return { positionId: id, portfolioId: "p1", symbol, qty };
}

test("a call settles on the upside and a put on the downside", () => {
  // The sign error that is right half the time. A put settled with the call's
  // formula pays out on exactly the days it should expire worthless.
  assert.equal(intrinsicValue("CALL", 230, 245), 15);
  assert.equal(intrinsicValue("CALL", 230, 215), 0);
  assert.equal(intrinsicValue("PUT", 230, 215), 15);
  assert.equal(intrinsicValue("PUT", 230, 245), 0);
});

test("at the money is worthless, not free money", () => {
  assert.equal(intrinsicValue("CALL", 230, 230), 0);
  assert.equal(intrinsicValue("PUT", 230, 230), 0);
});

test("intrinsic value never goes negative", () => {
  // An out-of-the-money option expires worthless; it does not owe anything. A
  // negative here would debit a member for a contract they already paid for.
  for (const close of [0.01, 100, 229.99, 1000]) {
    assert.ok(intrinsicValue("CALL", 230, close) >= 0);
    assert.ok(intrinsicValue("PUT", 230, close) >= 0);
  }
});

test("settlement rounds to the cent the price column holds", () => {
  assert.equal(intrinsicValue("CALL", 230, 230.02), 0.02);
  // Under half a cent settles at zero rather than at a rounding artefact. The
  // constraint is written for it: `price > 0 or side = 'EXPIRE'`, so a worthless
  // contract needs no cent invented to satisfy the ledger.
  assert.equal(intrinsicValue("CALL", 230, 230.004), 0);
  assert.equal(intrinsicValue("PUT", 25.5, 25.126), 0.37);
});

test("only contracts expiring today are settled", () => {
  const { rows } = planSettlements(
    [
      held("AAPL260918C00230000"),
      held("AAPL261016C00230000"),
      held("AAPL260911C00230000"),
      held("AAPL"),
      held("BTC/USD"),
    ],
    new Map([["AAPL", 245]]),
    TODAY,
  );

  assert.deepEqual(
    rows.map((r) => r.symbol),
    ["AAPL260918C00230000"],
  );
  assert.equal(rows[0]?.intrinsic, 15);
});

test("a contract whose underlying has no close today is left alone, not zeroed", () => {
  // The failure this whole file is arranged around. Settling at zero would
  // delete an in-the-money position overnight and credit nothing, and it would
  // look exactly like an honest expiry in the blotter — same side, same price,
  // no way to tell them apart afterwards.
  const { rows, skipped } = planSettlements(
    [held("AAPL260918C00230000"), held("TSLA260918P00300000")],
    new Map([["AAPL", 245]]),
    TODAY,
  );

  assert.deepEqual(
    rows.map((r) => r.symbol),
    ["AAPL260918C00230000"],
  );
  assert.deepEqual(
    skipped.map((r) => r.symbol),
    ["TSLA260918P00300000"],
  );
});

test("an unsettled contract stops the night's snapshot", () => {
  // `mergeSnapshots()` prefers a stored snapshot to a replay forever, so one
  // taken over a half-settled book is a wrong number that never washes out.
  const base: ExpiryResult = {
    ran: true,
    reason: null,
    asOf: TODAY,
    settled: 3,
    worthless: 1,
    credited: 1500,
    skipped: 0,
    failed: 0,
  };

  assert.equal(bookIsSettled(base), true);
  assert.equal(bookIsSettled({ ...base, skipped: 1 }), false);
  assert.equal(bookIsSettled({ ...base, failed: 1 }), false);
  // Nothing expired at all is a settled book, which is most nights.
  assert.equal(bookIsSettled({ ...base, settled: 0 }), true);
});

test("a short contract is never settled, because it should not exist", () => {
  // Options are long-only at both ends of the order path, so a negative qty
  // means an invariant has already broken. Settling it would move cash in a
  // direction nothing else in the app can produce.
  const { rows, skipped } = planSettlements(
    [held("AAPL260918C00230000", -1)],
    new Map([["AAPL", 245]]),
    TODAY,
  );

  assert.equal(rows.length, 0);
  assert.equal(skipped.length, 0);
});

test("every expiring contract carries what settled it, for the ledger", () => {
  // The blotter row is the only record a member ever sees of this, so the
  // underlying's close has to be recoverable from the plan rather than
  // recomputed later against a bar that has since been revised.
  const { rows } = planSettlements(
    [held("T260918P00025500", 4)],
    new Map([["T", 25.13]]),
    TODAY,
  );

  assert.deepEqual(rows[0], {
    positionId: "T260918P00025500",
    portfolioId: "p1",
    symbol: "T260918P00025500",
    underlying: "T",
    qty: 4,
    strike: 25.5,
    type: "PUT",
    underlyingClose: 25.13,
    intrinsic: 0.37,
  });
});

/**
 * The nightly ordering, read out of `index.ts` rather than asserted about it.
 *
 * Expiry and the snapshot are chained, not parallel, and that is the one
 * ordering in the scheduler that is load-bearing. Two independent `waitUntil`
 * promises would race, and the snapshot would win about half the time — writing
 * a portfolio that still held a contract that had already settled.
 */
test("the scheduler settles before it snapshots, and skips on a failure", () => {
  const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

  const settleAt = source.indexOf("settleExpiries(env");
  const snapshotAt = source.indexOf("snapshotSeason(env");
  assert.ok(settleAt > 0, "the nightly branch no longer settles expiries");
  assert.ok(snapshotAt > settleAt, "the snapshot no longer runs after settlement");

  // Chained inside one waitUntil, not two. A second `ctx.waitUntil(` between
  // them would mean they race.
  const between = source.slice(settleAt, snapshotAt);
  assert.doesNotMatch(
    between,
    /ctx\.waitUntil\(\s*snapshotSeason/,
    "the snapshot is dispatched independently again, so it can beat settlement",
  );
  assert.match(between, /bookIsSettled\(/, "the snapshot no longer checks the book is settled");
});

/**
 * The expiry side is settled by SQL that this test cannot run, so it reads the
 * migration instead — the same arrangement `migrations.test.ts` uses, and for
 * the same reason: the alarm has to be watching the code that is live.
 */
test("the settlement function writes an EXPIRE trade and releases the position", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/0006_derivatives.sql", import.meta.url)),
    "utf8",
  );

  const start = sql.indexOf("create or replace function settle_option_expiry");
  assert.ok(start > 0, "settle_option_expiry is no longer in 0006");
  const body = sql.slice(start, sql.indexOf("$fn$;", start));

  // The same lock place_order() takes, in the same order. A member's order must
  // not land halfway through their own contract settling.
  assert.match(body, /for update/i, "the portfolio row is no longer locked");
  assert.match(body, /'EXPIRE'/, "the trade is no longer written as an EXPIRE");
  assert.match(body, /delete from positions/i, "the settled contract is no longer removed");
  // A resting order on a contract that no longer exists would hold its
  // reservation forever — invisible money the member can never spend again.
  assert.match(body, /pending_orders/, "resting orders on the symbol are no longer resolved");
});
