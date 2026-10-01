import { providerFromEnv } from "./router.ts";
import { classify, type AssetClass } from "./symbols.ts";
import type { TradableAsset } from "./provider.ts";

/**
 * The tradable universe, cached in KV for instant ticker autocomplete.
 *
 * Alpaca's asset list is about 11,000 rows and several megabytes. Fetching it
 * per keystroke is absurd, so it is synced once a night by the cron trigger
 * and served from KV — which is exactly the workload KV is good at: written
 * fifty-odd times a day, read constantly, and never needing sub-minute
 * freshness. (Quotes are the opposite shape and live in quotes.ts, on the
 * Cache API, for reasons documented there.)
 *
 * The list is sharded by first letter rather than stored as one blob, so an
 * autocomplete request reads ~20KB instead of ~600KB. There are two shard
 * families because members search both ways: by ticker ("NVD") and by company
 * ("nvidia"), and those two often start with different letters — nobody typing
 * "alphabet" would find GOOGL from a symbol-keyed index alone.
 */

const META_KEY = "universe:meta";
const SYMBOL_PREFIX = "universe:sym:";
const NAME_PREFIX = "universe:name:";

/**
 * Shards live for a night, and a sync in this isolate clears them at once, so
 * an hour of isolate memory costs nothing but saves a KV read per keystroke.
 */
const SHARD_MEMORY_TTL_MS = 60 * 60_000;
/** A missing shard is rechecked after a minute rather than on every keystroke. */
const MISSING_SHARD_TTL_MS = 60_000;
const META_MEMORY_TTL_MS = 10 * 60_000;

const FRACTIONABLE = 1;
const SHORTABLE = 2;
const EASY_TO_BORROW = 4;

/**
 * [symbol, name, flags] — an array, not an object, to keep the shards small.
 *
 * A fourth element carries a crypto pair's minimum order size, which equities
 * do not have. Optional rather than always present, so the thirteen thousand
 * equity rows are unchanged in size and every shard written before this stays
 * readable.
 */
type PackedAsset = [string, string, number] | [string, string, number, number];

export interface UniverseMeta {
  count: number;
  syncedAt: string;
}

/**
 * What is stored. The shard hashes let a sync write only the shards that
 * changed — most nights a handful of 54 — and never leave the Worker.
 */
interface StoredMeta extends UniverseMeta {
  hashes?: Record<string, string>;
}

export interface UniverseSearchResult {
  results: TradableAsset[];
  /** True when the universe has never been synced, so results are empty. */
  warming: boolean;
}

interface UniverseEnv {
  QUOTES: KVNamespace;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
}

/** A-Z, with everything else pooled under "#". */
function shardOf(text: string): string {
  const first = text.trim().charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : "#";
}

const ALL_SHARDS = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  "#",
];

function pack(asset: TradableAsset): PackedAsset {
  const flags =
    (asset.fractionable ? FRACTIONABLE : 0) |
    (asset.shortable ? SHORTABLE : 0) |
    (asset.easyToBorrow ? EASY_TO_BORROW : 0);
  return asset.minOrderSize !== undefined
    ? [asset.symbol, asset.name, flags, asset.minOrderSize]
    : [asset.symbol, asset.name, flags];
}

function unpack(packed: PackedAsset): TradableAsset {
  const [symbol, name, flags, minOrderSize] = packed;
  return {
    symbol,
    name,
    // Not stored: nothing in the app branches on the venue, and dropping it
    // takes a fifth off every shard.
    exchange: "",
    fractionable: (flags & FRACTIONABLE) !== 0,
    shortable: (flags & SHORTABLE) !== 0,
    easyToBorrow: (flags & EASY_TO_BORROW) !== 0,
    ...(minOrderSize === undefined ? {} : { minOrderSize }),
  };
}

const shardMemory = new Map<string, { rows: PackedAsset[] | null; loadedAt: number }>();

async function loadShard(env: UniverseEnv, key: string): Promise<PackedAsset[] | null> {
  const cached = shardMemory.get(key);
  const ttl = cached?.rows ? SHARD_MEMORY_TTL_MS : MISSING_SHARD_TTL_MS;
  if (cached && Date.now() - cached.loadedAt < ttl) return cached.rows;

  const rows = await env.QUOTES.get<PackedAsset[]>(key, "json");
  shardMemory.set(key, { rows: rows ?? null, loadedAt: Date.now() });
  return rows ?? null;
}

let metaMemory: { meta: StoredMeta | null; loadedAt: number } | null = null;

async function storedMeta(env: UniverseEnv): Promise<StoredMeta | null> {
  if (metaMemory && Date.now() - metaMemory.loadedAt < META_MEMORY_TTL_MS) return metaMemory.meta;
  const meta = await env.QUOTES.get<StoredMeta>(META_KEY, "json");
  metaMemory = { meta, loadedAt: Date.now() };
  return meta;
}

export async function universeMeta(env: UniverseEnv): Promise<UniverseMeta | null> {
  const meta = await storedMeta(env);
  return meta && { count: meta.count, syncedAt: meta.syncedAt };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Guards against two lazy triggers syncing the same 11,000 rows at once. */
let syncing: Promise<UniverseMeta> | null = null;

export function syncUniverse(env: UniverseEnv, { force = false } = {}): Promise<UniverseMeta> {
  if (syncing) return syncing;
  syncing = runSync(env, force).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function runSync(env: UniverseEnv, force: boolean): Promise<UniverseMeta> {
  const assets = await providerFromEnv(env).assets();

  const bySymbol = new Map<string, PackedAsset[]>();
  const byName = new Map<string, PackedAsset[]>();

  const add = (into: Map<string, PackedAsset[]>, shard: string, packed: PackedAsset) => {
    const bucket = into.get(shard);
    if (bucket) bucket.push(packed);
    else into.set(shard, [packed]);
  };

  for (const asset of assets) {
    const packed = pack(asset);
    const symbolShard = shardOf(asset.symbol);
    const nameShard = shardOf(asset.name);

    add(bySymbol, symbolShard, packed);
    // Only a second copy when the two indexes would disagree, which is the
    // only case where the name shard adds anything.
    if (nameShard !== symbolShard) add(byName, nameShard, packed);
  }

  // Every shard is accounted for, empty ones included, so a symbol that
  // disappears from Alpaca's list does not linger in a stale shard forever. A
  // shard is rewritten only when its content differs from what the last sync
  // stored: KV writes are capped per day and most of the list never changes.
  // Without hashes (the first sync, or an older meta) everything is written,
  // and so it is when forced: a cold read found a shard missing that the
  // hashes would otherwise claim is already stored.
  const previous = await env.QUOTES.get<StoredMeta>(META_KEY, "json").catch(() => null);
  const hashes: Record<string, string> = {};
  const writes: Promise<void>[] = [];
  for (const [prefix, index] of [[SYMBOL_PREFIX, bySymbol], [NAME_PREFIX, byName]] as const) {
    for (const shard of ALL_SHARDS) {
      const key = prefix + shard;
      const body = JSON.stringify(index.get(shard) ?? []);
      hashes[key] = await sha256(body);
      if (force || previous?.hashes?.[key] !== hashes[key]) writes.push(env.QUOTES.put(key, body));
    }
  }
  await Promise.all(writes);

  // Written every sync, so `syncedAt` keeps meaning "checked against Alpaca".
  const meta: StoredMeta = { count: assets.length, syncedAt: new Date().toISOString(), hashes };
  await env.QUOTES.put(META_KEY, JSON.stringify(meta));

  shardMemory.clear();
  metaMemory = { meta, loadedAt: Date.now() };
  return { count: meta.count, syncedAt: meta.syncedAt };
}

/**
 * Autocomplete.
 *
 * Ranks exact ticker, then ticker prefix, then company-name prefix, then
 * company-name substring — which is the order a member means them in. Typing
 * "MS" should offer MSFT before "Morgan Stanley Direct Lending Fund".
 */
export async function searchSymbols(
  env: UniverseEnv,
  query: string,
  limit = 20,
  assetClass?: AssetClass,
): Promise<UniverseSearchResult> {
  const needle = query.trim().toUpperCase();
  if (!needle) return { results: [], warming: false };

  const shard = shardOf(needle);
  const [symbolRows, nameRows] = await Promise.all([
    loadShard(env, SYMBOL_PREFIX + shard),
    loadShard(env, NAME_PREFIX + shard),
  ]);

  if (symbolRows === null && nameRows === null) {
    return { results: [], warming: true };
  }

  const lowered = needle.toLowerCase();
  const scored: Array<{ row: PackedAsset; rank: number }> = [];
  const seen = new Set<string>();

  for (const row of [...(symbolRows ?? []), ...(nameRows ?? [])]) {
    const [symbol, name] = row;
    if (seen.has(symbol)) continue;
    // One universe, three classes, one shard per letter — so a search from the
    // crypto ticket would otherwise walk straight past BTC/USD and return five
    // hundred stocks beginning with B. Filtered here rather than in the
    // browser, because trimming after the slice would return a page of
    // equities and then show none of it.
    if (assetClass !== undefined && classify(symbol) !== assetClass) continue;

    const lowerName = name.toLowerCase();
    let rank: number;
    if (symbol === needle) rank = 0;
    else if (symbol.startsWith(needle)) rank = 1;
    else if (lowerName.startsWith(lowered)) rank = 2;
    else if (lowerName.includes(lowered)) rank = 3;
    else continue;

    seen.add(symbol);
    scored.push({ row, rank });
  }

  scored.sort((a, b) => a.rank - b.rank || (a.row[0] < b.row[0] ? -1 : 1));

  return { results: scored.slice(0, limit).map((s) => unpack(s.row)), warming: false };
}

/**
 * Exact lookup, for validating an order before it reaches the database.
 * Returns null for a symbol that is not tradable, undefined if the universe
 * has never been synced — the caller must not treat "unknown" as "invalid".
 */
export async function lookupSymbol(
  env: UniverseEnv,
  symbol: string,
): Promise<TradableAsset | null | undefined> {
  const wanted = symbol.trim().toUpperCase();
  const rows = await loadShard(env, SYMBOL_PREFIX + shardOf(wanted));
  if (rows === null) return undefined;

  const found = rows.find((row) => row[0] === wanted);
  return found ? unpack(found) : null;
}

/** Drops the in-memory shard cache. Tests only. */
export function forgetShards(): void {
  shardMemory.clear();
  metaMemory = null;
}
