import test from "node:test";
import assert from "node:assert/strict";
import { ETF_SECTOR, GICS_SECTORS, isGicsSector, toSector, UNCLASSIFIED } from "./sectors.ts";

/**
 * The sector map decides what the club's exposure chart says, and a wrong
 * bucket is worse than an empty one: nobody audits a number that looks
 * plausible. So the cases below pin the mappings that are easy to get
 * backwards, and pin that an unrecognised label lands in Unclassified rather
 * than being quietly absorbed by a neighbouring keyword.
 *
 * Run with: npm test
 */

test("maps Finnhub's own industry labels to GICS sectors", () => {
  assert.equal(toSector("Semiconductors"), "Information Technology");
  assert.equal(toSector("Technology"), "Information Technology");
  assert.equal(toSector("Banking"), "Financials");
  assert.equal(toSector("Retail"), "Consumer Discretionary");
  assert.equal(toSector("Pharmaceuticals"), "Health Care");
  assert.equal(toSector("Media"), "Communication Services");
  assert.equal(toSector("Aerospace & Defense"), "Industrials");
  assert.equal(toSector("Beverages"), "Consumer Staples");
  assert.equal(toSector("Energy"), "Energy");
  assert.equal(toSector("Metals & Mining"), "Materials");
  assert.equal(toSector("Real Estate"), "Real Estate");
  assert.equal(toSector("Utilities"), "Utilities");
});

test("ignores case, padding and the trailing period in abbreviations", () => {
  assert.equal(toSector("  SOFTWARE  "), "Information Technology");
  assert.equal(toSector("Constr. Mat."), "Materials");
  assert.equal(toSector("constr. mat"), "Materials");
  assert.equal(toSector("Health  Care"), "Health Care");
});

test("falls back to keywords for labels the table has never seen", () => {
  assert.equal(toSector("Semiconductor Equipment & Materials"), "Information Technology");
  assert.equal(toSector("Regional Banks"), "Financials");
  assert.equal(toSector("Oil & Gas Midstream"), "Energy");
  assert.equal(toSector("Specialty Retail Stores"), "Consumer Discretionary");
  assert.equal(toSector("Biotechnology Research"), "Health Care");
});

test("keeps energy and utilities apart, which the keyword order exists for", () => {
  // Both labels contain a word the other bucket also claims. If the ordering
  // in KEYWORDS is ever shuffled, this is what breaks.
  assert.equal(toSector("Oil & Gas Exploration"), "Energy");
  assert.equal(toSector("Gas Utilities"), "Utilities");
  assert.equal(toSector("Electric Utilities"), "Utilities");
});

test("puts real estate in Real Estate, not Financials", () => {
  assert.equal(toSector("Real Estate Investment Trusts"), "Real Estate");
  assert.equal(toSector("REIT - Residential"), "Real Estate");
  assert.equal(toSector("Real Estate Financing"), "Real Estate");
});

test("an empty or missing industry is not classified", () => {
  // This is what Finnhub returns for an ETF. The caller decides that means
  // "fund"; this function only reports that it could not place it.
  assert.equal(toSector(""), UNCLASSIFIED);
  assert.equal(toSector("   "), UNCLASSIFIED);
  assert.equal(toSector(null), UNCLASSIFIED);
  assert.equal(toSector(undefined), UNCLASSIFIED);
});

test("an unrecognisable label is Unclassified, never a guess", () => {
  assert.equal(toSector("Blank Check Companies"), UNCLASSIFIED);
  assert.equal(toSector("zzzz"), UNCLASSIFIED);
});

test("every mapped result is one of the eleven GICS sectors", () => {
  const samples = [
    "Software", "Banking", "Retail", "Pharmaceuticals", "Media",
    "Airlines", "Tobacco", "Coal", "Water Utilities", "REIT", "Chemicals",
  ];
  for (const sample of samples) {
    assert.ok(isGicsSector(toSector(sample)), `${sample} produced a non-GICS sector`);
  }
  assert.equal(GICS_SECTORS.length, 11);
});

test("the ETF bucket is not one of the GICS eleven", () => {
  assert.equal(isGicsSector(ETF_SECTOR), false);
  assert.equal(isGicsSector(UNCLASSIFIED), false);
});
