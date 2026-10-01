import type { Env } from "../types.ts";
import { serviceClient } from "../lib/supabase.ts";
import { quoteCache } from "../market/quotes.ts";
import type { Quote } from "../market/provider.ts";

export const BACKUP_PREFIX = "portfolio-backup:v1:";
export const SAVED_PRICES_KEY = "portfolio-prices:v1";
export const BACKUP_RETENTION_SECONDS = 24 * 60 * 60;
// Price-only display recovery must bridge weekends and holiday outages. This
// does not extend retention of the private portfolio/trade checkpoints.
export const SAVED_PRICE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
// 288 checkpoints/day fit below the KV free storage allowance at this ceiling.
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
// KV writes are the scarce budget (1,000/day on the free plan), so a run writes
// only what changed. An unchanged book is already in the newest checkpoint, and
// the heartbeat keeps several checkpoints alive inside the 24-hour retention
// however quiet the club is.
export const CHECKPOINT_HEARTBEAT_SECONDS = 6 * 60 * 60;
// Moving prices are rewritten at most this often. The copy is display fallback
// only and every saved price keeps its own observation time, so a slower write
// makes a fallback older, never mislabelled. A new symbol is written at once.
export const PRICE_WRITE_INTERVAL_SECONDS = 15 * 60;

type Count = { count: number }[];
interface Book {
  id: string;
  positions: { symbol: string; [key: string]: unknown }[];
  position_count: Count;
  trades: Record<string, unknown>[];
  trade_count: Count;
  pending_orders: Record<string, unknown>[];
  order_count: Count;
  [key: string]: unknown;
}
export interface BackupSeason {
  id: string;
  portfolios: Book[];
  portfolio_count: Count;
  [key: string]: unknown;
}
export interface SavedPrice { quote: Quote; savedAt: string }
export type SavedPrices = Record<string, SavedPrice>;
/** Stored as KV metadata on the price key, so it costs no read or write of its own. */
export interface BackupState {
  bookHash: string;
  checkpointKey: string;
  checkpointAt: string;
  priceWrittenAt: string;
}

// One embedded PostgREST statement: cash, holdings and fills share a database
// snapshot, even if a trade commits while the request is running. Counts detect
// PostgREST's row cap on every embedded collection; never publish a partial book.
export const BACKUP_SELECT = `*, portfolio_count:portfolios(count), portfolios(
  *, positions(*), position_count:positions(count),
  trades(*), trade_count:trades(count),
  pending_orders(*), order_count:pending_orders(count)
)`;

export function assertCompleteSeason(season: BackupSeason): void {
  const check = (rows: unknown[], count: Count, label: string) => {
    if (!Array.isArray(rows) || rows.length !== count?.[0]?.count) {
      throw new Error(`Backup incomplete: ${label} was truncated. Previous backups retained.`);
    }
  };
  check(season.portfolios, season.portfolio_count, "portfolios");
  for (const book of season.portfolios) {
    check(book.positions, book.position_count, "positions");
    check(book.trades, book.trade_count, "trades");
    check(book.pending_orders, book.order_count, "pending orders");
  }
}

export function usableSavedPrice(saved: SavedPrice | undefined, now = Date.now()): boolean {
  const age = now - Date.parse(saved?.savedAt ?? "");
  return age >= 0 && age <= SAVED_PRICE_RETENTION_SECONDS * 1000 &&
    Number.isFinite(saved?.quote?.price) && (saved?.quote?.price ?? 0) > 0;
}

export async function readSavedPrices(kv: KVNamespace): Promise<SavedPrices> {
  try {
    return await kv.get<SavedPrices>(SAVED_PRICES_KEY, "json") ?? {};
  } catch (error) {
    console.error("Saved prices unavailable:", error);
    return {};
  }
}

/** The prices and the bookkeeping the previous run left, in one KV read. */
export async function readBackupState(kv: KVNamespace): Promise<{ prices: SavedPrices; state: BackupState | null }> {
  try {
    const { value, metadata } = await kv.getWithMetadata<SavedPrices, BackupState>(SAVED_PRICES_KEY, "json");
    return { prices: value ?? {}, state: metadata?.bookHash ? metadata : null };
  } catch (error) {
    console.error("Saved prices unavailable:", error);
    return { prices: {}, state: null };
  }
}

/**
 * The book's identity, independent of the order PostgREST happened to embed
 * rows in. An unstable order would only cost a redundant write, but there is no
 * reason to pay it.
 */
export async function fingerprintSeason(season: BackupSeason): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(canonical);
      const id = (item: unknown) => (item as { id?: unknown } | null)?.id;
      return items.every((item) => typeof id(item) === "string")
        ? items.sort((a, b) => (id(a) as string < (id(b) as string) ? -1 : 1))
        : items;
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(season))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True when `iso` is missing, unparseable, or at least `seconds` before `now`. */
const olderThan = (iso: string | undefined, seconds: number, now: Date) =>
  !(now.getTime() - Date.parse(iso ?? "") < seconds * 1000);

export async function writeBackup(
  kv: KVNamespace, season: BackupSeason, quotes: Map<string, Quote>,
  now = new Date(), previous: SavedPrices = {},
  observedAt?: Map<string, number>, state: BackupState | null = null,
) {
  assertCompleteSeason(season);
  const capturedAt = now.toISOString();
  const symbols = [...new Set([...season.portfolios.flatMap((p) => p.positions.map((p) => p.symbol)), "SPY", "QQQ"])];
  const prices: SavedPrices = {};
  for (const symbol of symbols) {
    const quote = quotes.get(symbol);
    if (quote) prices[symbol] = { quote, savedAt: new Date(observedAt?.get(symbol) ?? now.getTime()).toISOString() };
    else if (usableSavedPrice(previous[symbol], now.getTime())) prices[symbol] = previous[symbol]!;
  }
  const body = JSON.stringify({ version: 1, capturedAt, season, prices });
  if (new TextEncoder().encode(body).byteLength > MAX_BACKUP_BYTES) {
    throw new Error("Backup exceeds storage budget. Previous backups retained; increase capacity before retrying.");
  }
  // An unchanged book is skipped rather than copied: the newest checkpoint
  // already holds it, so the recovery point is still this run.
  const bookHash = await fingerprintSeason(season);
  const checkpoint = !state || state.bookHash !== bookHash ||
    olderThan(state.checkpointAt, CHECKPOINT_HEARTBEAT_SECONDS, now);
  const key = checkpoint ? `${BACKUP_PREFIX}${capturedAt}` : state!.checkpointKey;
  if (checkpoint) {
    await kv.put(key, body, {
      expirationTtl: BACKUP_RETENTION_SECONDS,
      metadata: { capturedAt, seasonId: season.id, portfolios: season.portfolios.length },
    });
  }

  const symbolsChanged = Object.keys(prices).sort().join() !== Object.keys(previous).sort().join();
  // Price, not observation time: a closed market re-observes the same official
  // close every run, and re-dating an unchanged price is not worth a write.
  const pricesMoved = Object.entries(prices).some(([symbol, saved]) =>
    previous[symbol]?.quote.price !== saved.quote.price ||
    previous[symbol]?.quote.prevClose !== saved.quote.prevClose);
  const writePrices = checkpoint || symbolsChanged ||
    (pricesMoved && olderThan(state?.priceWrittenAt, PRICE_WRITE_INTERVAL_SECONDS, now)) ||
    olderThan(state?.priceWrittenAt, CHECKPOINT_HEARTBEAT_SECONDS, now);
  if (writePrices) {
    // A separate public-price-only copy: a quote request never loads private books.
    // Failure here cannot erase the immutable checkpoint written above; the next
    // run still sees the old fingerprint and checkpoints again.
    const next: BackupState = { bookHash, checkpointKey: key,
      checkpointAt: checkpoint ? capturedAt : state!.checkpointAt, priceWrittenAt: capturedAt };
    await kv.put(SAVED_PRICES_KEY, JSON.stringify(prices),
      { expirationTtl: SAVED_PRICE_RETENTION_SECONDS, metadata: next });
  }
  return { key, capturedAt, checkpoint: checkpoint ? "written" as const : "unchanged" as const,
    pricesWritten: writePrices, portfolios: season.portfolios.length, prices: Object.keys(prices).length };
}

export async function backupSeason(env: Env, waitUntil?: (promise: Promise<unknown>) => void) {
  const { data, error } = await serviceClient(env).from("seasons")
    .select(BACKUP_SELECT).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const capturedAt = new Date();
  const season = data as unknown as BackupSeason;
  assertCompleteSeason(season);
  const symbols = [...new Set([...season.portfolios.flatMap((p) => p.positions.map((p) => p.symbol)), "SPY", "QQQ"])];
  const [result, previous] = await Promise.all([
    quoteCache(env).get(symbols, waitUntil), readBackupState(env.QUOTES),
  ]);
  return writeBackup(env.QUOTES, season, result.quotes, capturedAt, previous.prices, result.observedAt,
    previous.state);
}
