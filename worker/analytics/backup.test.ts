import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertCompleteSeason, writeBackup, usableSavedPrice, readSavedPrices, readBackupState,
  fingerprintSeason, BACKUP_PREFIX, SAVED_PRICES_KEY, SAVED_PRICE_RETENTION_SECONDS, MAX_BACKUP_BYTES, type BackupSeason } from "./backup.ts";
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
  const metadata = new Map<string, unknown>();
  const writes: { key: string; options: KVNamespacePutOptions }[] = [];
  const kv = { async put(key: string, value: string, options: KVNamespacePutOptions) {
    values.set(key, value); metadata.set(key, options.metadata ?? null); writes.push({ key, options });
  }, async get(key: string) { const value = values.get(key); return value ? JSON.parse(value) : null; },
  async getWithMetadata(key: string) {
    const value = values.get(key);
    return { value: value ? JSON.parse(value) : null, metadata: metadata.get(key) ?? null };
  } };
  return { kv: kv as unknown as KVNamespace, values, writes };
}
/** One scheduled run, reading what the previous one left, as backupSeason does. */
async function run(kv: KVNamespace, book: BackupSeason, quotes: Map<string, Quote>, at: Date) {
  const { prices, state } = await readBackupState(kv);
  return writeBackup(kv, book, quotes, at, prices, undefined, state);
}
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

test("checkpoints preserve whole books, expire after 24 hours, and isolate public prices", async () => {
  const { kv, values, writes } = kvStub();
  const result = await writeBackup(kv, season(), new Map([["AAPL", quote]]), now);
  assert.ok(result.key.startsWith(BACKUP_PREFIX));
  const backup = JSON.parse(values.get(result.key)!);
  assert.deepEqual(backup.season, season());
  assert.equal(backup.prices.AAPL.quote.price, 150);
  assert.equal(writes.length, 2, "at most two KV writes a run, not a write for each member or symbol");
  assert.equal(writes[0]!.options.expirationTtl, 86400);
  assert.equal(writes[1]!.options.expirationTtl, SAVED_PRICE_RETENTION_SECONDS);
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
  assert.equal(usableSavedPrice({ quote, savedAt: "2026-09-11T15:00:00Z" }, now.getTime()), true,
    "saved display prices bridge weekends and holidays");
  for (const savedAt of ["invalid", "2026-09-07T15:00:00Z", "2026-09-16T15:00:00Z"]) {
    assert.equal(usableSavedPrice({ quote, savedAt }, now.getTime()), false);
  }
  assert.equal(usableSavedPrice({ quote: { ...quote, price: 0 }, savedAt: now.toISOString() }, now.getTime()), false);
});

test("price recovery includes benchmarks and preserves the cache's actual observation time", async () => {
  const { kv } = kvStub();
  const observed = now.getTime() - 15_000;
  await writeBackup(kv, season(), new Map([["AAPL", quote], ["SPY", { ...quote, symbol: "SPY" }]]), now, {},
    new Map([["AAPL", observed], ["SPY", observed]]));
  const previous = await readSavedPrices(kv);
  assert.equal(previous.AAPL.savedAt, new Date(observed).toISOString());
  assert.equal(previous.SPY.savedAt, new Date(observed).toISOString());
  await writeBackup(kv, season(), new Map(), new Date(now.getTime() + 3 * 86400000), previous);
  const recovered = await readSavedPrices(kv);
  assert.equal(recovered.AAPL.savedAt, previous.AAPL.savedAt);
  assert.equal(recovered.SPY.savedAt, previous.SPY.savedAt);
});

test("private backup exports require the admin middleware and never restore money automatically", () => {
  const admin = readFileSync(new URL("../routes/admin.ts", import.meta.url), "utf8");
  assert.ok(admin.indexOf('admin.use("*", requireAuth, requireAdmin)') < admin.indexOf('admin.get("/backups"'));
  const backup = readFileSync(new URL("backup.ts", import.meta.url), "utf8");
  assert.doesNotMatch(backup, /\.(insert|update|upsert|delete|rpc)\(/);
});

test("an unchanged book is not checkpointed again until the heartbeat", async () => {
  const { kv, writes } = kvStub();
  const quotes = new Map([["AAPL", quote]]);
  const first = await run(kv, season(), quotes, now);
  assert.equal(first.checkpoint, "written");
  writes.length = 0;

  const quiet = await run(kv, season(), quotes, minutes(5));
  assert.equal(quiet.checkpoint, "unchanged");
  assert.equal(quiet.key, first.key, "the newest checkpoint is still the recovery point");
  assert.equal(writes.length, 0, "nothing changed, so nothing is written");

  const heartbeat = await run(kv, season(), quotes, minutes(6 * 60));
  assert.equal(heartbeat.checkpoint, "written", "a live checkpoint must outlast the 24-hour retention");
  assert.notEqual(heartbeat.key, first.key);
});

test("any change to the book is checkpointed on the next run", async () => {
  const { kv, writes } = kvStub();
  await run(kv, season(), new Map([["AAPL", quote]]), now);
  writes.length = 0;
  const book = season();
  book.portfolios[0]!.pending_orders = [{ id: "order", trail_anchor: "151" }];
  book.portfolios[0]!.order_count = [{ count: 1 }];
  const result = await run(kv, book, new Map([["AAPL", quote]]), minutes(5));
  assert.equal(result.checkpoint, "written");
  assert.ok(writes.some((write) => write.key.startsWith(BACKUP_PREFIX)));
  assert.ok(writes.some((write) => write.key === SAVED_PRICES_KEY), "the fingerprint is stored beside the prices");
});

test("moving prices are rewritten at most every fifteen minutes, a new symbol at once", async () => {
  const { kv, writes } = kvStub();
  await run(kv, season(), new Map([["AAPL", quote]]), now);
  writes.length = 0;

  const moved = new Map([["AAPL", { ...quote, price: 151 }]]);
  assert.equal((await run(kv, season(), moved, minutes(5))).pricesWritten, false);
  assert.equal((await readSavedPrices(kv)).AAPL.quote.price, 150, "throttled, still the older observation");
  assert.equal((await run(kv, season(), moved, minutes(15))).pricesWritten, true);
  assert.equal((await readSavedPrices(kv)).AAPL.quote.price, 151);
  assert.equal(writes.length, 1, "prices only; the book did not change");

  writes.length = 0;
  const added = new Map([["AAPL", { ...quote, price: 151 }], ["SPY", { ...quote, symbol: "SPY" }]]);
  assert.equal((await run(kv, season(), added, minutes(20))).pricesWritten, true);
  assert.ok((await readSavedPrices(kv)).SPY, "a newly priced symbol gains its fallback immediately");
});

test("a closed market re-observing the same close writes nothing", async () => {
  const { kv, writes } = kvStub();
  await run(kv, season(), new Map([["AAPL", quote]]), now);
  writes.length = 0;
  for (let i = 1; i <= 12; i++) await run(kv, season(), new Map([["AAPL", quote]]), minutes(5 * i));
  assert.equal(writes.length, 0);
});

test("the fingerprint ignores the order rows were embedded in", async () => {
  const a = season(), b = season();
  a.portfolios[0]!.trades = [{ id: "t1", qty: "1" }, { id: "t2", qty: "2" }];
  b.portfolios[0]!.trades = [{ qty: "2", id: "t2" }, { id: "t1", qty: "1" }];
  assert.equal(await fingerprintSeason(a), await fingerprintSeason(b));
  b.portfolios[0]!.trades[0]!.qty = "3";
  assert.notEqual(await fingerprintSeason(a), await fingerprintSeason(b));
});
