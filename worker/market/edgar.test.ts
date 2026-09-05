/**
 * EDGAR failures look like empty filings, and YTD EPS looks like a quarterly
 * result. Pin identification, shared CIK lookup, and the reported-period gate.
 * Run with: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EdgarProvider, earningsFromFacts, forgetEdgar } from "./edgar.ts";
import { MarketConfigError } from "./provider.ts";

test("every SEC request identifies the configured contact and concurrent readers share ticker lookup", async () => {
  const original = globalThis.fetch;
  forgetEdgar();
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Finance Club research contact@school.edu");
    assert.ok(init?.signal);
    if (url.pathname.endsWith("company_tickers.json")) {
      return Response.json({ "0": { ticker: "TSLA", cik_str: 1318605 }, "1": { ticker: "BRK-B", cik_str: 1067983 } });
    }
    if (url.hostname === "efts.sec.gov") {
      assert.equal(url.searchParams.get("ciks"), "0001318605");
      assert.equal(url.searchParams.get("forms"), "8-K,10-Q,10-K");
      return Response.json({ hits: { hits: [{ _id: "0001628280-26-010101:tsla.htm", _source: {
        adsh: "0001628280-26-010101", form: "10-Q", file_date: "2026-07-22",
      } }, { _source: { adsh: "0001628280-26-010101", form: "10-Q", file_date: "2026-07-22" } }] } });
    }
    assert.equal(url.pathname, "/api/xbrl/companyfacts/CIK0001318605.json");
    return Response.json({ facts: {} });
  };
  try {
    const provider = new EdgarProvider("Finance Club research contact@school.edu");
    const [filings] = await Promise.all([provider.filings("TSLA"), provider.earnings("TSLA")]);
    await provider.earnings("TSLA");
    assert.equal(calls.filter((url) => url.endsWith("company_tickers.json")).length, 1);
    assert.equal(filings.length, 1);
    assert.equal(filings[0]?.url, "https://www.sec.gov/Archives/edgar/data/1318605/000162828026010101/0001628280-26-010101-index.html");
  } finally { globalThis.fetch = original; forgetEdgar(); }
});

test("an unknown SEC ticker is an empty result and the successful ticker map is still cached", async () => {
  const original = globalThis.fetch;
  forgetEdgar();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ "0": { ticker: "TSLA", cik_str: 1318605 } });
  };
  try {
    const provider = new EdgarProvider("contact@school.edu");
    assert.deepEqual(await provider.filings("ZZZZ"), []);
    assert.deepEqual(await provider.filings("ZZZZ"), []);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; forgetEdgar(); }
});

test("a placeholder SEC contact fails locally before an unidentified request is sent", () => {
  assert.throws(() => new EdgarProvider("Finance Club Terminal - set-me@example.com"), MarketConfigError);
  assert.throws(() => new EdgarProvider(""), MarketConfigError);
});

test("SEC earnings discard annual and YTD facts and keep latest reported quarterly actuals without invented estimates", () => {
  const rows = [
    { start: "2025-01-01", end: "2025-12-31", val: 9.6, form: "10-K", filed: "2026-02-01" },
    { start: "2026-01-01", end: "2026-06-30", val: 4.8, form: "10-Q", filed: "2026-07-22" },
    { start: "2026-04-01", end: "2026-06-30", val: 1.2, form: "10-Q", filed: "2026-07-22", fy: 2026, fp: "Q2" },
    { start: "2026-04-01", end: "2026-06-30", val: 1.3, form: "10-Q/A", filed: "2026-08-01", fy: 2026, fp: "Q2" },
    { start: "2026-01-01", end: "2026-03-31", val: 0, form: "10-Q", filed: "2026-04-20" },
  ];
  const out = earningsFromFacts({ facts: { "us-gaap": { EarningsPerShareDiluted: { units: { "USD/shares": rows } } } } });
  assert.deepEqual(out.map((row) => [row.period, row.actual]), [["2026-06-30", 1.3], ["2026-03-31", 0]]);
  assert.ok(out.every((row) => row.source === "edgar" && row.estimate === null && row.surprisePercent === null));
  assert.ok(out.every((row) => row.quarter === null && row.year === null));
});
