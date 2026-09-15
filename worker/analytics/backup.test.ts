import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertCompleteSeason, writeBackup, usableSavedPrice, readSavedPrices,
  BACKUP_PREFIX, SAVED_PRICES_KEY, MAX_BACKUP_BYTES, type BackupSeason } from "./backup.ts";
import type { Quote } from "../market/provider.ts";

const now = new Date("2026-09-15T15:00:00Z");
const quote: Quote = { symbol: "AAPL", price: 150, source: "trade", prevClose: 100,
  dayChange: 50, dayChangePercent: 50, dayOpen: 100, dayHigh: 150, dayLow: 100,
  dayVolume: 10, asOf: now.toISOString() };
function season(): BackupSeason {
  return { id: "season", portfolio_count: [{ count: 1 }], portfolios: [{ id: "book", cash: "123.456789",
    positions: [{ symbol: "AAPL", qty: "2", avg_cost: "100" }], position_count: [{ count: 1 }],
    trades: [{ id: "trade" }], trade_count: [{ count: 1 }], pending_orders: [], order_count: [{ count: 0 }] }] };
}
function kvStub() {
  const values = new Map<string, string>();
  const writes: { key: string; options: KVNamespacePutOptions }[] = [];
  const kv = { async put(key: string, value: string, options: KVNamespacePutOptions) {
    values.set(key, value); writes.push({ key, options });
  }, async get(key: string) { const value = values.get(key); return value ? JSON.parse(value) : null; } };
  return { kv: kv as unknown as KVNamespace, values, writes };
}

test("checkpoints preserve whole books, expire after 24 hours, and isolate public prices", async () => {
  const { kv, values, writes } = kvStub();
  const result = await writeBackup(kv, season(), new Map([["AAPL", quote]]), now);
  assert.ok(result.key.startsWith(BACKUP_PREFIX));
  const backup = JSON.parse(values.get(result.key)!);
  assert.deepEqual(backup.season, season());
  assert.equal(backup.prices.AAPL.quote.price, 150);
  assert.equal(writes.length, 2, "576 KV writes/day, not a write for each member or symbol");
  assert.ok(writes.every((w) => w.options.expirationTtl === 86400));
  assert.ok(!values.get(SAVED_PRICES_KEY)!.includes("cash"));
  await writeBackup(kv, season(), new Map(), new Date(now.getTime() + 300000), await readSavedPrices(kv));
  assert.equal([...values.keys()].filter((key) => key.startsWith(BACKUP_PREFIX)).length, 2);
  const saved = await readSavedPrices(kv);
  assert.equal(saved.AAPL.savedAt, now.toISOString(), "outages do not re-date old prices");
});

test("truncated collections never replace a complete backup", async () => {
  for (const field of ["position_count", "trade_count", "order_count"] as const) {
    const book = season();
    book.portfolios[0]![field] = [{ count: 1001 }];
    const { kv, writes } = kvStub();
    await assert.rejects(writeBackup(kv, book, new Map(), now), /truncated/);
    assert.equal(writes.length, 0);
  }
  const book = season(); book.portfolio_count = [{ count: 1001 }];
  assert.throws(() => assertCompleteSeason(book), /truncated/);
});

test("oversized checkpoints fail without touching previous checkpoints", async () => {
  const book = season(); book.padding = "x".repeat(MAX_BACKUP_BYTES);
  const { kv, writes } = kvStub();
  await assert.rejects(writeBackup(kv, book, new Map(), now), /storage budget/);
  assert.equal(writes.length, 0);
});

test("expired, future-dated and invalid saved prices are never restored", () => {
  assert.equal(usableSavedPrice({ quote, savedAt: now.toISOString() }, now.getTime()), true);
  for (const savedAt of ["invalid", "2026-09-13T15:00:00Z", "2026-09-16T15:00:00Z"]) {
    assert.equal(usableSavedPrice({ quote, savedAt }, now.getTime()), false);
  }
  assert.equal(usableSavedPrice({ quote: { ...quote, price: 0 }, savedAt: now.toISOString() }, now.getTime()), false);
});

test("private backup exports require the admin middleware and never restore money automatically", () => {
  const admin = readFileSync(new URL("../routes/admin.ts", import.meta.url), "utf8");
  assert.ok(admin.indexOf('admin.use("*", requireAuth, requireAdmin)') < admin.indexOf('admin.get("/backups"'));
  const backup = readFileSync(new URL("backup.ts", import.meta.url), "utf8");
  assert.doesNotMatch(backup, /\.(insert|update|upsert|delete|rpc)\(/);
});
