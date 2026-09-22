import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { activeSeason, forgetSeason, loadPortfolio } from "./portfolio.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const season = (id: string) => ({
  id, name: id, starting_cash: "100000", trading_locked: false, starts_at: "2026-09-01T00:00:00Z",
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

function client(fetcher: (read: number) => Promise<Response>) {
  let reads = 0;
  const supabase = createClient("https://season.example", "test-service-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: async () => fetcher(++reads) },
  });
  return { supabase, reads: () => reads };
}

test("concurrent season readers share one database lookup and cache its result", async () => {
  forgetSeason();
  const gate = deferred();
  const state = client(async () => { await gate.promise; return json([season("current")]); });
  try {
    const readers = Array.from({ length: 50 }, () => activeSeason(state.supabase));
    gate.resolve();
    assert.ok((await Promise.all(readers)).every((row) => row?.id === "current"));
    assert.equal((await activeSeason(state.supabase))?.id, "current");
    assert.equal(state.reads(), 1);
  } finally { gate.resolve(); forgetSeason(); }
});

test("an invalidated lookup finishing late cannot return or recache a retired season", async () => {
  for (const previous of [[season("retired")], []]) {
    forgetSeason();
    const started = deferred(), release = deferred();
    const state = client(async (read) => {
      if (read === 1) { started.resolve(); await release.promise; return json(previous); }
      return json([season("current")]);
    });
    try {
      const older = activeSeason(state.supabase);
      await started.promise;
      forgetSeason();
      assert.equal((await activeSeason(state.supabase))?.id, "current");
      release.resolve();
      assert.equal((await older)?.id, "current", "existing readers must not act on the invalidated response");
      assert.equal((await activeSeason(state.supabase))?.id, "current");
      assert.equal(state.reads(), 2);
    } finally { release.resolve(); forgetSeason(); }
  }
});

test("an invalidated reader finishing early joins the replacement without detaching it", async () => {
  forgetSeason();
  const firstStarted = deferred(), secondStarted = deferred();
  const releaseFirst = deferred(), releaseSecond = deferred();
  const state = client(async (read) => {
    if (read === 1) { firstStarted.resolve(); await releaseFirst.promise; return json([season("retired")]); }
    secondStarted.resolve(); await releaseSecond.promise; return json([season("current")]);
  });
  try {
    const older = activeSeason(state.supabase);
    await firstStarted.promise;
    forgetSeason();
    const newer = activeSeason(state.supabase);
    await secondStarted.promise;
    releaseFirst.resolve();
    const joined = activeSeason(state.supabase);
    releaseSecond.resolve();
    assert.ok((await Promise.all([older, newer, joined])).every((row) => row?.id === "current"));
    assert.equal(state.reads(), 2);
  } finally { releaseFirst.resolve(); releaseSecond.resolve(); forgetSeason(); }
});

test("a failed shared season lookup releases readers and can recover on the next read", async () => {
  forgetSeason();
  const state = client(async (read) => read === 1
    ? json({ code: "TEST_DB_ERROR", message: "Season unavailable" }, 400)
    : json([season("current")]));
  try {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => activeSeason(state.supabase)));
    assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof Error));
    assert.equal(state.reads(), 1);
    assert.equal((await activeSeason(state.supabase))?.id, "current");
    assert.equal(state.reads(), 2);
  } finally { forgetSeason(); }
});

test("failure from a detached season read cannot defeat a successful replacement", async () => {
  forgetSeason();
  const started = deferred(), release = deferred();
  const state = client(async (read) => {
    if (read === 1) {
      started.resolve(); await release.promise;
      return json({ code: "TEST_DB_ERROR", message: "Retired lookup failed" }, 400);
    }
    return json([season("current")]);
  });
  try {
    const older = activeSeason(state.supabase);
    await started.promise;
    forgetSeason();
    assert.equal((await activeSeason(state.supabase))?.id, "current");
    release.resolve();
    assert.equal((await older)?.id, "current");
    assert.equal(state.reads(), 2);
  } finally { release.resolve(); forgetSeason(); }
});

test("a personal portfolio refuses incomplete holdings instead of concealing risk from order checks", async () => {
  for (const count of [undefined, 2, 1]) {
    forgetSeason();
    const supabase = createClient("https://portfolio.example", "test-service-key", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/seasons")) return json([season("current")]);
        if (url.pathname.endsWith("/portfolios")) return json([{ id: "book", cash: "100000", starting_cash: "100000" }]);
        if (url.pathname.endsWith("/positions")) return new Response(JSON.stringify([
          { symbol: "AAPL", qty: "1", avg_cost: "100", multiplier: "1" },
        ]), { headers: { "content-type": "application/json",
          ...(count === undefined ? {} : { "content-range": `0-0/${count}` }) } });
        throw new Error(`Unexpected portfolio request: ${url.pathname}`);
      } },
    });
    try {
      if (count === 1) assert.equal((await loadPortfolio(supabase, "member")).positions.length, 1);
      else await assert.rejects(loadPortfolio(supabase, "member"), /complete portfolio positions/);
    } finally { forgetSeason(); }
  }
});
