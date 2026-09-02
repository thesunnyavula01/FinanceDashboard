import test from "node:test";
import assert from "node:assert/strict";
import { forgetShards, searchSymbols } from "./universe.ts";

/**
 * Ticker autocomplete, and the one thing about it that is easy to get wrong now
 * that three asset classes share one KV index.
 *
 * The shards are keyed by first letter, not by class, so the crypto ticket's
 * search for "B" reads the same shard as the equity ticket's — five hundred
 * stocks and a handful of pairs in one list. Without a filter the crypto field
 * offers BAC, and a member picks it, and the order is refused three steps later
 * by a rule the ticket already knew.
 *
 * Run with: npm test
 */

/** The shard shape: [symbol, name, flags], plus min order size for a pair. */
const SHARD_B = [
  ["BAC", "Bank of America Corp", 7],
  ["BA", "Boeing Co", 7],
  ["BTC/USD", "Bitcoin / US Dollar", 1, 0.000001],
  ["BCH/USD", "Bitcoin Cash / US Dollar", 1, 0.001],
  ["BBY", "Best Buy Co Inc", 7],
];

const SHARD_A = [
  ["AAPL", "Apple Inc", 7],
  ["AAVE/USD", "Aave / US Dollar", 1, 0.001],
];

function env(shards: Record<string, unknown[]>) {
  return {
    QUOTES: {
      get: async (key: string) => {
        if (key.startsWith("universe:sym:")) return shards[key.slice(-1)] ?? [];
        // No separate name index in these fixtures; the symbol shard carries
        // both, which is what the real one does whenever the two agree.
        return [];
      },
    },
  } as never;
}

test("the crypto ticket is offered pairs and nothing else", async () => {
  forgetShards();
  const found = await searchSymbols(env({ B: SHARD_B }), "B", 20, "CRYPTO");

  assert.deepEqual(
    found.results.map((r) => r.symbol),
    ["BCH/USD", "BTC/USD"],
    "a stock reached the crypto field",
  );
});

test("the equity ticket is never offered a pair", async () => {
  forgetShards();
  const found = await searchSymbols(env({ B: SHARD_B }), "B", 20, "EQUITY");

  assert.deepEqual(found.results.map((r) => r.symbol), ["BA", "BAC", "BBY"]);
  assert.ok(
    found.results.every((r) => !r.symbol.includes("/")),
    "a pair reached the equity field",
  );
});

test("an option's underlying search is an equity search", async () => {
  // A contract is picked off the chain, never typed — the field holds the
  // underlying, and an underlying is a stock. The ticket asks for EQUITY here
  // rather than OPTION, which would match nothing at all.
  forgetShards();
  const found = await searchSymbols(env({ A: SHARD_A }), "A", 20, "EQUITY");
  assert.deepEqual(found.results.map((r) => r.symbol), ["AAPL"]);
});

test("filtering happens before the limit, not after", async () => {
  // Trimming a page of results after slicing is the version of this that looks
  // right and returns an empty dropdown: the three stocks would fill a limit of
  // three and the pairs would never be reached.
  forgetShards();
  const found = await searchSymbols(env({ B: SHARD_B }), "B", 2, "CRYPTO");

  assert.equal(found.results.length, 2);
  assert.ok(found.results.every((r) => r.symbol.includes("/")));
});

test("no class asked for means every class, which is what the command bar wants", async () => {
  forgetShards();
  const found = await searchSymbols(env({ B: SHARD_B }), "B", 20);
  assert.equal(found.results.length, 5);
});

test("a warming universe still reports warming rather than an empty class", async () => {
  forgetShards();
  const cold = {
    QUOTES: { get: async () => null },
  } as never;

  const found = await searchSymbols(cold, "BTC", 20, "CRYPTO");
  assert.equal(found.warming, true);
  assert.deepEqual(found.results, []);
});

test("a pair is found by name as well as by ticker", async () => {
  forgetShards();
  const found = await searchSymbols(env({ B: SHARD_B }), "bitcoin", 20, "CRYPTO");
  assert.deepEqual(found.results.map((r) => r.symbol), ["BCH/USD", "BTC/USD"]);
});

test("a pair keeps its minimum order size through the search", async () => {
  // The fourth packed element. The ticket sizes against it, so losing it here
  // would let a member place an order the venue will not take.
  forgetShards();
  const found = await searchSymbols(env({ B: SHARD_B }), "BTC", 20, "CRYPTO");
  assert.equal(found.results[0]?.symbol, "BTC/USD");
  assert.equal(found.results[0]?.minOrderSize, 0.000001);
});
