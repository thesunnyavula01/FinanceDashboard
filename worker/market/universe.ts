import { alpacaFromEnv } from "./alpaca.ts";
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

/** Shards live for a night; ten minutes of isolate memory is plenty. */
const SHARD_MEMORY_TTL_MS = 10 * 60_000;

const FRACTIONABLE = 1;
const SHORTABLE = 2;
const EASY_TO_BORROW = 4;

/** [symbol, name, flags] — an array, not an object, to keep the shards small. */
type PackedAsset = [string, string, number];

export interface UniverseMeta {
  count: number;
  syncedAt: string;
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
  return [asset.symbol, asset.name, flags];
}

function unpack(packed: PackedAsset): TradableAsset {
  const [symbol, name, flags] = packed;
  return {
    symbol,
    name,
    // Not stored: nothing in the app branches on the venue, and dropping it
    // takes a fifth off every shard.
    exchange: "",
    fractionable: (flags & FRACTIONABLE) !== 0,
    shortable: (flags & SHORTABLE) !== 0,
    easyToBorrow: (flags & EASY_TO_BORROW) !== 0,
  };
}

const shardMemory = new Map<string, { rows: PackedAsset[]; loadedAt: number }>();

async function loadShard(env: UniverseEnv, key: string): Promise<PackedAsset[] | null> {
  const cached = shardMemory.get(key);
  if (cached && Date.now() - cached.loadedAt < SHARD_MEMORY_TTL_MS) return cached.rows;

  const rows = await env.QUOTES.get<PackedAsset[]>(key, "json");
  if (!rows) return null;

  shardMemory.set(key, { rows, loadedAt: Date.now() });
  return rows;
}

export async function universeMeta(env: UniverseEnv): Promise<UniverseMeta | null> {
  return env.QUOTES.get<UniverseMeta>(META_KEY, "json");
}

/** Guards against two lazy triggers syncing the same 11,000 rows at once. */
let syncing: Promise<UniverseMeta> | null = null;

export function syncUniverse(env: UniverseEnv): Promise<UniverseMeta> {
  if (syncing) return syncing;
  syncing = runSync(env).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function runSync(env: UniverseEnv): Promise<UniverseMeta> {
  const assets = await alpacaFromEnv(env).assets();

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

  // Every shard is written, empty ones included, so a symbol that disappears
  // from Alpaca's list does not linger in a stale shard forever.
  await Promise.all(
    ALL_SHARDS.flatMap((shard) => [
      env.QUOTES.put(SYMBOL_PREFIX + shard, JSON.stringify(bySymbol.get(shard) ?? [])),
      env.QUOTES.put(NAME_PREFIX + shard, JSON.stringify(byName.get(shard) ?? [])),
    ]),
  );

  const meta: UniverseMeta = { count: assets.length, syncedAt: new Date().toISOString() };
  await env.QUOTES.put(META_KEY, JSON.stringify(meta));

  shardMemory.clear();
  return meta;
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
