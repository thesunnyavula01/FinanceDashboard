import type { Env } from "../types.ts";
import { serviceClient } from "../lib/supabase.ts";
import { quoteCache } from "../market/quotes.ts";
import type { Quote } from "../market/provider.ts";

export const BACKUP_PREFIX = "portfolio-backup:v1:";
export const SAVED_PRICES_KEY = "portfolio-prices:v1";
export const BACKUP_RETENTION_SECONDS = 24 * 60 * 60;
// 288 checkpoints/day fit below the KV free storage allowance at this ceiling.
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

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
  return age >= 0 && age <= BACKUP_RETENTION_SECONDS * 1000 &&
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

export async function writeBackup(
  kv: KVNamespace, season: BackupSeason, quotes: Map<string, Quote>,
  now = new Date(), previous: SavedPrices = {},
) {
  assertCompleteSeason(season);
  const capturedAt = now.toISOString();
  const symbols = [...new Set(season.portfolios.flatMap((p) => p.positions.map((p) => p.symbol)))];
  const prices: SavedPrices = {};
  for (const symbol of symbols) {
    const quote = quotes.get(symbol);
    if (quote) prices[symbol] = { quote, savedAt: capturedAt };
    else if (usableSavedPrice(previous[symbol], now.getTime())) prices[symbol] = previous[symbol]!;
  }
  const body = JSON.stringify({ version: 1, capturedAt, season, prices });
  if (new TextEncoder().encode(body).byteLength > MAX_BACKUP_BYTES) {
    throw new Error("Backup exceeds storage budget. Previous backups retained; increase capacity before retrying.");
  }
  const key = `${BACKUP_PREFIX}${capturedAt}`;
  await kv.put(key, body, {
    expirationTtl: BACKUP_RETENTION_SECONDS,
    metadata: { capturedAt, seasonId: season.id, portfolios: season.portfolios.length },
  });
  // A separate public-price-only copy: a quote request never loads private books.
  // Failure here cannot erase the immutable checkpoint written above.
  await kv.put(SAVED_PRICES_KEY, JSON.stringify(prices), { expirationTtl: BACKUP_RETENTION_SECONDS });
  return { key, capturedAt, portfolios: season.portfolios.length, prices: Object.keys(prices).length };
}

export async function backupSeason(env: Env, waitUntil?: (promise: Promise<unknown>) => void) {
  const { data, error } = await serviceClient(env).from("seasons")
    .select(BACKUP_SELECT).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const capturedAt = new Date();
  const season = data as unknown as BackupSeason;
  assertCompleteSeason(season);
  const symbols = [...new Set(season.portfolios.flatMap((p) => p.positions.map((p) => p.symbol)))];
  const [result, previous] = await Promise.all([
    quoteCache(env).get(symbols, waitUntil), readSavedPrices(env.QUOTES),
  ]);
  return writeBackup(env.QUOTES, season, result.quotes, capturedAt, previous);
}
