import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  allowsShort,
  classify,
  cryptoBase,
  formatContract,
  isTradableSymbol,
  multiplierFor,
  parseContract,
  tradesAroundTheClock,
  underlyingOf,
} from "./symbols.ts";

/**
 * The whole three-asset-class design rests on one claim: a symbol says what it
 * is, unambiguously, with no column to consult. If that claim is ever false the
 * failure is silent and expensive — an equity valued at 100x, or a contract
 * routed to the stocks endpoint and negative-cached as unpriceable. So the
 * cases below are mostly attempts to break it.
 *
 * Run with: npm test
 */

test("classifies the three shapes apart", () => {
  assert.equal(classify("AAPL"), "EQUITY");
  assert.equal(classify("BTC/USD"), "CRYPTO");
  assert.equal(classify("AAPL260116C00150000"), "OPTION");
});

test("no listed equity ticker can be mistaken for a contract or a pair", () => {
  // Class shares use a dot, never a slash — this is the entire reason a slash
  // is safe to read as "crypto".
  for (const ticker of ["BRK.B", "BF.B", "RDS.A", "AAPL", "T", "F", "GOOGL", "SPY", "ZVZZT"]) {
    assert.equal(classify(ticker), "EQUITY", ticker);
  }

  // The OCC tail is fifteen fixed characters. Nothing tradable is that shape,
  // including tickers that are all digits after a letter.
  assert.equal(classify("A123456"), "EQUITY");
  assert.equal(classify("C00150000"), "EQUITY");
});

test("parses an OCC symbol from the right, because the root is variable length", () => {
  // Alpaca does not pad the root to six characters the way raw OCC does, so a
  // fixed offset would read the wrong bytes on anything but a four-letter root.
  const short = parseContract("T260116C00025000");
  assert.deepEqual(short, {
    symbol: "T260116C00025000",
    underlying: "T",
    expiration: "2026-01-16",
    type: "CALL",
    strike: 25,
  });

  const long = parseContract("GOOGL260116P00150000");
  assert.equal(long?.underlying, "GOOGL");
  assert.equal(long?.type, "PUT");
  assert.equal(long?.strike, 150);
});

test("decodes the strike as thousandths", () => {
  assert.equal(parseContract("SPY250613C00700000")?.strike, 700);
  assert.equal(parseContract("SPY250613C00007500")?.strike, 7.5);
  assert.equal(parseContract("SPY250613C00000500")?.strike, 0.5);
});

test("rejects a date that does not exist rather than rolling it forward", () => {
  // `new Date(2026, 1, 31)` is silently the 3rd of March. An expiry that never
  // comes would settle on a day that never comes.
  assert.equal(parseContract("AAPL260231C00150000"), null);
  assert.equal(parseContract("AAPL261301C00150000"), null);
  assert.equal(parseContract("AAPL260100C00150000"), null);
});

test("rejects a zero strike, a missing root and a malformed tail", () => {
  assert.equal(parseContract("AAPL260116C00000000"), null);
  assert.equal(parseContract("260116C00150000"), null, "no root");
  assert.equal(parseContract("AAPL260116X00150000"), null, "not a call or a put");
  assert.equal(parseContract("AAPL260116C0015000"), null, "seven strike digits");
  assert.equal(parseContract("AAPL.B260116C00150000"), null, "a dot is not an OCC root");
});

test("formats a contract for a human and leaves everything else alone", () => {
  assert.equal(formatContract("AAPL260116C00150000"), "AAPL 16JAN26 150C");
  assert.equal(formatContract("T261218P00025500"), "T 18DEC26 25.5P");
  // Callers run every symbol through this, so a non-contract must survive.
  assert.equal(formatContract("AAPL"), "AAPL");
  assert.equal(formatContract("BTC/USD"), "BTC/USD");
});

test("an option's underlying is what its sector bucket and its settlement need", () => {
  assert.equal(underlyingOf("AAPL260116C00150000"), "AAPL");
  assert.equal(underlyingOf("AAPL"), null);
  assert.equal(underlyingOf("BTC/USD"), null);
});

test("a crypto base is the half before the slash", () => {
  assert.equal(cryptoBase("BTC/USD"), "BTC");
  assert.equal(cryptoBase("SHIB/USD"), "SHIB");
  assert.equal(cryptoBase("AAPL"), null);
});

test("only options carry a multiplier, which is why the column defaults to 1", () => {
  assert.equal(multiplierFor("AAPL260116C00150000"), 100);
  assert.equal(multiplierFor("AAPL"), 1);
  assert.equal(multiplierFor("BTC/USD"), 1);
});

test("shape validation accepts each class and refuses junk", () => {
  assert.equal(isTradableSymbol("AAPL"), true);
  assert.equal(isTradableSymbol("BRK.B"), true);
  assert.equal(isTradableSymbol("BTC/USD"), true);
  assert.equal(isTradableSymbol("AAPL260116C00150000"), true);

  assert.equal(isTradableSymbol(""), false);
  assert.equal(isTradableSymbol("1AAPL"), false, "a ticker starts with a letter");
  assert.equal(isTradableSymbol("BTC/"), false);
  assert.equal(isTradableSymbol("TOOLONGTICKER"), false);
});

test("only equities may be shorted, and only crypto ignores the clock", () => {
  assert.equal(allowsShort("AAPL"), true);
  assert.equal(allowsShort("BTC/USD"), false);
  assert.equal(allowsShort("AAPL260116C00150000"), false);

  assert.equal(tradesAroundTheClock("BTC/USD"), true);
  assert.equal(tradesAroundTheClock("AAPL"), false);
  assert.equal(tradesAroundTheClock("AAPL260116C00150000"), false);
});

/**
 * The browser keeps its own copy of this classifier, because tsconfig.app
 * includes only `src` and cannot import from `worker`. Same arrangement as
 * src/lib/portfolio.ts mirroring the order engine, and the same hazard: if the
 * two disagree, the ticket offers a control the Worker then refuses, or worse,
 * sizes an order against a multiplier the server does not apply.
 *
 * `npm test` cannot import the mirror either — it is a browser module — so this
 * reads it as text and checks the parts that must be identical.
 */
test("the browser's copy of the classifier has not drifted from this one", () => {
  const mirror = readFileSync(
    fileURLToPath(new URL("../../src/lib/symbols.ts", import.meta.url)),
    "utf8",
  );
  const source = readFileSync(fileURLToPath(new URL("./symbols.ts", import.meta.url)), "utf8");

  // The three shape tests, verbatim. A widened regex on one side only is how a
  // symbol becomes tradable in the ticket and rejected by the route.
  for (const name of ["EQUITY_SYMBOL", "CRYPTO_SYMBOL", "OPTION_SYMBOL"]) {
    const pattern = new RegExp(`${name} = (/[^\\n]+/);`);
    const here = source.match(pattern);
    const there = mirror.match(pattern);
    assert.ok(here, `${name} is no longer a literal in the Worker's copy`);
    assert.ok(there, `${name} is missing from the browser's copy`);
    assert.equal(there[1], here[1], `${name} differs between the two copies`);
  }

  // The fixed OCC tail and the contract size, which are the two numbers that
  // silently misprice an order rather than failing it.
  assert.match(mirror, /const CONTRACT_TAIL = 15;/);
  assert.match(mirror, /OPTION_MULTIPLIER = 100/);

  // And the long-only rule, which decides which keys the ticket even offers.
  assert.match(mirror, /classify\(symbol\) === "EQUITY"/);
});

test("input is normalised, so a member typing lowercase gets the same answer", () => {
  assert.equal(classify(" btc/usd "), "CRYPTO");
  assert.equal(classify("aapl260116c00150000"), "OPTION");
  assert.equal(parseContract("aapl260116c00150000")?.symbol, "AAPL260116C00150000");
  assert.equal(multiplierFor(" aapl260116c00150000 "), 100);
});
