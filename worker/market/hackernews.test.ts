/**
 * A relevance-sorted feed can silently return decade-old discussion. Pin the
 * upstream date filter and ensure unsafe article URLs cannot reach the client.
 * Run with: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HackerNewsProvider } from "./hackernews.ts";

test("hacker news searches by date with a recency filter and the resolved company name", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/search_by_date");
    assert.equal(url.searchParams.get("query"), "Tesla");
    assert.equal(url.searchParams.get("tags"), "story");
    assert.equal(url.searchParams.get("numericFilters"), "created_at_i>=1788307200,created_at_i<=1788652800");
    assert.ok(init?.signal);
    return Response.json({ hits: [
      { objectID: "12345", title: "<b>Tesla</b> discussion", url: "javascript:alert(1)", created_at: "2026-09-05T12:00:00Z", points: 0, num_comments: 4 },
      { objectID: "10", title: "Old Tesla", created_at: "2018-09-05T12:00:00Z" },
    ] });
  };
  try {
    const rows = await new HackerNewsProvider().discussion("Tesla Inc.", { start: "2026-09-02T00:00:00Z", end: "2026-09-06T00:00:00Z" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, "Tesla discussion");
    assert.equal(rows[0]?.url, rows[0]?.commentsUrl);
    assert.equal(rows[0]?.score, 0);
  } finally { globalThis.fetch = original; }
});
