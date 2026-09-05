import test from "node:test";
import assert from "node:assert/strict";
import { researchMatcher } from "./research-relevance.ts";

/**
 * A provider can tag an Amazon story with TSLA because Tesla appears somewhere
 * in its full text. The panel must require evidence in the headline it shows.
 * Ordinary words used as tickers and similarly named coins are the dangerous
 * cases: they make unrelated rows look as if they passed an exact check.
 *
 * Run with: npm test
 */

test("Tesla headlines accept the resolved company, explicit ticker and relevant comparisons", () => {
  const matches = researchMatcher("TSLA", "Tesla Inc.");
  for (const headline of [
    "Tesla deliveries rise after factory expansion",
    "$TSLA climbs after its earnings report",
    "TSLA reports a new quarterly record",
    "Amazon and Tesla sign a logistics agreement",
    "Tesla versus Amazon: comparing their latest results",
  ]) assert.equal(matches(headline), true, headline);
});

test("an unrelated headline stays unrelated when metadata, summary and URL mention the ticker", () => {
  const matches = researchMatcher("TSLA", "Tesla Inc.");
  const upstream = {
    headline: "Amazon raises its quarterly revenue forecast",
    summary: "Tesla and TSLA were also mentioned in a broader market roundup.",
    symbols: ["AMZN", "TSLA"],
    url: "https://publisher.example/markets/tesla-and-amazon",
  };
  assert.equal(matches(upstream.headline), false);
  assert.equal(matches("Markets rise as technology stocks lead the rally"), false);
});

test("company matches ignore legal suffixes including the comma before incorporated", () => {
  for (const name of ["Tesla Inc.", "Tesla, Inc.", "Tesla Incorporated"]) {
    assert.equal(researchMatcher("TSLA", name)("Tesla announces its quarterly deliveries"), true, name);
  }
  assert.equal(researchMatcher("F", "Ford Motor Company")("Ford Motor opens a new assembly line"), true);
});

test("ticker and company matches cannot occur inside a different word", () => {
  const matches = researchMatcher("TSLA", "Tesla Inc.");
  for (const headline of [
    "TSLAX reports its fund holdings",
    "ATSLAB launches a new product",
    "Teslathon announces its first conference",
  ]) assert.equal(matches(headline), false, headline);
});

test("ordinary words used as tickers require explicit stock notation or the company name", () => {
  const cases = [
    { symbol: "A", name: "Agilent Technologies Inc.", unrelated: "A rally lifts Wall Street" },
    { symbol: "ON", name: "ON Semiconductor Corporation", unrelated: "On the market today: Amazon earnings" },
    { symbol: "IT", name: "Gartner Inc.", unrelated: "Amazon increases IT spending" },
    { symbol: "NOW", name: "ServiceNow Inc.", unrelated: "NOW is the time to compare savings accounts" },
    { symbol: "ALL", name: "Allstate Corporation", unrelated: "ALL major indexes finish higher" },
    { symbol: "CAT", name: "Caterpillar Inc.", unrelated: "A CAT rescue group receives a grant" },
    { symbol: "AI", name: "C3.ai Inc.", unrelated: "Amazon unveils an AI assistant" },
  ];
  for (const { symbol, name, unrelated } of cases) {
    const matches = researchMatcher(symbol, name);
    assert.equal(matches(unrelated), false, `${symbol}: ${unrelated}`);
    assert.equal(matches(`$${symbol} reports its latest earnings`), true, `${symbol} cashtag`);
    assert.equal(matches(`NYSE:${symbol} reports its latest earnings`), true, `${symbol} exchange`);
  }
  assert.equal(researchMatcher("IT", "Gartner Inc.")("Gartner raises its revenue forecast"), true);
  assert.equal(researchMatcher("AI", "C3.ai Inc.")("C3.ai reports its quarterly earnings"), true);
});

test("parenthesized common acronyms do not identify an unrelated stock", () => {
  assert.equal(researchMatcher("AI", "C3.ai Inc.")("Amazon launches new artificial intelligence (AI) services"), false);
  assert.equal(researchMatcher("IT", "Gartner Inc.")("Amazon raises information technology (IT) spending"), false);
  assert.equal(researchMatcher("TSLA", "Tesla Inc.")("Tesla (TSLA) announces quarterly deliveries"), true);
});

test("ambiguous company names must name the company rather than an ordinary word", () => {
  assert.equal(researchMatcher("TGT", "Target Corporation")("Amazon sets a new target for its retail stores"), false);
  assert.equal(researchMatcher("TGT", "Target Corporation")("Target opens new retail stores"), true);
  assert.equal(researchMatcher("AAPL", "Apple Inc.")("An apple pie wins a baking contest"), false);
  assert.equal(researchMatcher("AAPL", "Apple Inc.")("Apple raises its earnings forecast"), true);
});

test("punctuation in a ticker or company name is literal rather than a regex wildcard", () => {
  const shares = researchMatcher("BRK.B", null);
  assert.equal(shares("BRK.B reports quarterly results"), true);
  assert.equal(shares("BRKxB reports quarterly results"), false);
  const company = researchMatcher("AI", "C3.ai Inc.");
  assert.equal(company("C3.ai launches an enterprise service"), true);
  assert.equal(company("C3xai launches an enterprise service"), false);
});

test("a missing company profile permits an unambiguous ticker without inventing name aliases", () => {
  const matches = researchMatcher("TSLA", null);
  assert.equal(matches("TSLA reports quarterly results"), true);
  assert.equal(matches("$TSLA reports quarterly results"), true);
  assert.equal(matches("Amazon reports quarterly results"), false);
  assert.equal(researchMatcher("A", null)("A rally lifts the market"), false);
});

test("a CEO or product alone is not silently treated as the company", () => {
  const matches = researchMatcher("TSLA", "Tesla Inc.");
  assert.equal(matches("Elon Musk discusses a new project"), false);
  assert.equal(matches("Cybertruck owners gather for a weekend event"), false);
  assert.equal(matches("Tesla Cybertruck owners gather for a weekend event"), true);
});

test("only visible plain text can establish relevance through encoded or literal markup", () => {
  const matches = researchMatcher("TSLA", "Tesla Inc.");
  assert.equal(matches("<b>Tesla</b> reports stronger deliveries"), true);
  assert.equal(matches("&lt;b&gt;Tesla&lt;/b&gt; reports stronger deliveries"), true);
  assert.equal(matches("Amazon &amp; Tesla sign an agreement"), true);
  assert.equal(matches("<script>Tesla TSLA</script>Amazon reports earnings"), false);
  assert.equal(matches('<img alt="Tesla" src="https://tesla.example/image">Amazon reports earnings'), false);
  assert.equal(matches('<a href="https://tesla.example">Amazon reports earnings</a>'), false);
});

test("Bitcoin Cash alone does not count as Bitcoin while an actual comparison still does", () => {
  const matches = researchMatcher("BTC/USD", "Bitcoin");
  assert.equal(matches("Bitcoin adoption expands among merchants"), true);
  assert.equal(matches("BTC rallies after the latest trading session"), true);
  assert.equal(matches("Bitcoin Cash launches a network upgrade"), false);
  assert.equal(matches("Bitcoin Cash outperforms Bitcoin this week"), true);
  assert.equal(matches("Ethereum developers announce a network upgrade"), false);
});

test("Ethereum Classic alone does not count as Ethereum while an actual comparison still does", () => {
  const matches = researchMatcher("ETH/USD", "Ethereum");
  assert.equal(matches("Ethereum developers announce an upgrade"), true);
  assert.equal(matches("ETH trading volume rises"), true);
  assert.equal(matches("Ethereum Classic launches a network upgrade"), false);
  assert.equal(matches("Ethereum Classic gains as Ethereum trading slows"), true);
});

test("a crypto ticker that is an ordinary word cannot match unrelated prose", () => {
  const link = researchMatcher("LINK/USD", "Chainlink");
  assert.equal(link("A new link connects two railway stations"), false);
  assert.equal(link("Chainlink announces a blockchain network integration"), true);
  assert.equal(link("$LINK rallies after a network announcement"), true);
  const dot = researchMatcher("DOT/USD", "Polkadot");
  assert.equal(dot("A tiny dot appears on the new display"), false);
  assert.equal(dot("Polkadot announces a protocol update"), true);
});

test("Avalanche needs crypto context so a weather story cannot become AVAX research", () => {
  const matches = researchMatcher("AVAX/USD", "Avalanche");
  assert.equal(matches("Avalanche warnings issued after heavy snowfall"), false);
  assert.equal(matches("Rescuers search for survivors after an avalanche"), false);
  assert.equal(matches("Avalanche blockchain launches a network upgrade"), true);
  assert.equal(matches("Avalanche token gains as crypto trading increases"), true);
  assert.equal(matches("AVAX rallies after a protocol update"), true);
});

test("a discussion needs subject evidence in its title even if its full text matches", () => {
  const matches = researchMatcher("TSLA", "Tesla Inc.");
  const discussion = {
    title: "Amazon introduces a new warehouse robot",
    story_text: "The comments compare this announcement with Tesla and TSLA.",
  };
  assert.equal(matches(discussion.title), false);
  assert.equal(matches("Tesla publishes new details about factory automation"), true);
});
