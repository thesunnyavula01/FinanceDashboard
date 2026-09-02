import { finnhubFromEnv } from "./finnhub.ts";
import { MarketConfigError } from "./provider.ts";
import { CRYPTO_SECTOR, UNCLASSIFIED } from "./sectors.ts";
import { classify, cryptoBase, formatContract, underlyingOf } from "./symbols.ts";
import { lookupSymbol } from "./universe.ts";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import type { Env } from "../types.ts";

/**
 * Sector enrichment.
 *
 * A ticker's sector is fetched from Finnhub the first time anyone in the club
 * touches it, then written to the `securities` table and never fetched again.
 * That "once per ticker, ever" property is the entire reason a 60 call/minute
 * personal-tier key can serve a hundred members: after the first week of a
 * season the table already holds everything anyone trades, and Finnhub stops
 * being in the request path at all.
 *
 * Enrichment therefore never blocks a response. A symbol nobody has looked up
 * before comes back without a sector, the lookup happens behind the response,
 * and the next poll twenty seconds later has it.
 */

/**
 * Finnhub calls started per request. They all go out together, so this doubles
 * as the concurrency limit — twelve at a time is comfortably under the
 * 60/minute personal-tier ceiling, and a cold portfolio fills itself in over
 * the next few twenty-second polls.
 */
const MAX_ENRICH_PER_REQUEST = 12;

/** Rows never change once written, so this can be generous. */
const MEMORY_TTL_MS = 6 * 60 * 60_000;

export interface SecurityRecord {
  symbol: string;
  name: string | null;
  sector: string;
  industry: string | null;
  assetType: "STOCK" | "ETF" | "CRYPTO" | "OPTION";
  logoUrl: string | null;
}

interface SecurityRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  asset_type: string | null;
  logo_url: string | null;
}

function fromRow(row: SecurityRow): SecurityRecord {
  return {
    symbol: row.symbol,
    name: row.name,
    sector: row.sector ?? UNCLASSIFIED,
    assetType:
      row.asset_type === "ETF" || row.asset_type === "CRYPTO" || row.asset_type === "OPTION"
        ? row.asset_type
        : "STOCK",
    industry: row.industry,
    logoUrl: row.logo_url,
  };
}

const memory = new Map<string, { record: SecurityRecord; loadedAt: number }>();

/** Symbols whose Finnhub lookup is already running in this isolate. */
const enriching = new Map<string, Promise<SecurityRecord | null>>();

export interface SecuritiesResult {
  securities: Map<string, SecurityRecord>;
  /** Symbols still being looked up. They will be present on a later call. */
  pending: string[];
}

/**
 * Profiles for a set of symbols, filling in whatever is missing behind the
 * response. Pass `waitUntil` so the lookup survives the response returning.
 */
export async function getSecurities(
  env: Env,
  symbols: string[],
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<SecuritiesResult> {
  const securities = new Map<string, SecurityRecord>();
  const now = Date.now();

  const missing: string[] = [];
  for (const symbol of symbols) {
    const cached = memory.get(symbol);
    if (cached && now - cached.loadedAt < MEMORY_TTL_MS) securities.set(symbol, cached.record);
    else missing.push(symbol);
  }

  if (missing.length === 0) return { securities, pending: [] };

  const stored = await readStored(env, missing);
  await fillMissingNames(env, [...stored.values()], waitUntil);

  const unknown: string[] = [];
  for (const symbol of missing) {
    const record = stored.get(symbol);
    if (record) {
      memory.set(symbol, { record, loadedAt: now });
      securities.set(symbol, record);
    } else {
      unknown.push(symbol);
    }
  }

  if (unknown.length === 0) return { securities, pending: [] };

  const toEnrich = unknown.slice(0, MAX_ENRICH_PER_REQUEST);
  const work = enrich(env, toEnrich);
  if (waitUntil) waitUntil(work);
  else await work.catch(() => undefined);

  return { securities, pending: unknown };
}

/**
 * Repairs rows that were written without a name.
 *
 * Finnhub returns no name for a fund, so an ETF's name has to come from
 * Alpaca's asset list — which lives in KV and may not have been synced yet the
 * first time anyone looks the ticker up. Without this, whichever member
 * happened to search SPY before the first nightly sync would leave the whole
 * club with a permanently nameless row. Repairing on read costs one
 * memory-cached shard lookup and fixes itself the moment the universe lands.
 */
async function fillMissingNames(
  env: Env,
  records: SecurityRecord[],
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const needy = records.filter((record) => !record.name);
  if (needy.length === 0) return;

  await Promise.all(
    needy.map(async (record) => {
      const asset = await lookupSymbol(env, record.symbol).catch(() => undefined);
      if (!asset?.name) return;

      record.name = asset.name;
      const write = store(env, record);
      if (waitUntil) waitUntil(write);
      else await write;
    }),
  );
}

async function readStored(env: Env, symbols: string[]): Promise<Map<string, SecurityRecord>> {
  const out = new Map<string, SecurityRecord>();

  let supabase;
  try {
    supabase = serviceClient(env);
  } catch (err) {
    if (err instanceof ConfigError) return out;
    throw err;
  }

  const { data, error } = await supabase
    .from("securities")
    .select("symbol, name, sector, industry, asset_type, logo_url")
    .in("symbol", symbols);

  if (error) {
    console.error("securities lookup failed:", error);
    return out;
  }

  for (const row of (data ?? []) as SecurityRow[]) out.set(row.symbol, fromRow(row));
  return out;
}

/**
 * Look up and persist a batch of unknown symbols.
 *
 * Deduped per symbol within the isolate, so a hundred members loading the same
 * cold portfolio at once do not each spend a Finnhub call on NVDA. Across
 * isolates a symbol can still be fetched more than once on the very first
 * sighting; that costs a handful of duplicate calls exactly once in a
 * ticker's life, which is not worth a distributed lock.
 */
async function enrich(env: Env, symbols: string[]): Promise<void> {
  const queue = symbols.filter((symbol) => !enriching.has(symbol));
  const joined = symbols
    .map((symbol) => enriching.get(symbol))
    .filter((p): p is Promise<SecurityRecord | null> => Boolean(p));

  const started = queue.map((symbol) => {
    const promise = fetchAndStore(env, symbol).finally(() => enriching.delete(symbol));
    enriching.set(symbol, promise);
    return promise;
  });

  await Promise.allSettled([...started, ...joined]);
}

/**
 * The record for a symbol Finnhub has never heard of and never will.
 *
 * Finnhub prices company fundamentals. A coin has no company, and an option is
 * a claim on one rather than the thing itself — so neither is worth an HTTP
 * call, and both would come back empty and land in Unclassified, which on this
 * dashboard reads as "somebody should add a mapping" rather than "there is
 * nothing to map".
 *
 * An option takes its sector from its underlying, which is the honest answer:
 * an AAPL call is a bet on Information Technology. That row is already in the
 * table if anyone has ever held the stock, and gets fetched on its own terms if
 * not, so this returns null for an option and lets the caller resolve the
 * underlying instead.
 */
function withoutFundamentals(symbol: string): SecurityRecord | null {
  if (classify(symbol) !== "CRYPTO") return null;

  return {
    symbol,
    // "BTC/USD" reads as a pair; "BTC" is what a member calls it.
    name: cryptoBase(symbol) ?? symbol,
    sector: CRYPTO_SECTOR,
    industry: null,
    assetType: "CRYPTO",
    logoUrl: null,
  };
}

async function fetchAndStore(env: Env, symbol: string): Promise<SecurityRecord | null> {
  let record: SecurityRecord;

  const local = withoutFundamentals(symbol);
  if (local) {
    await persist(env, local);
    return local;
  }

  // An option's profile is its underlying's. Written under the contract symbol
  // so a single lookup answers, rather than making every caller know to ask a
  // second question about a symbol it already has.
  const underlying = underlyingOf(symbol);
  if (underlying) {
    const parent = await fetchAndStore(env, underlying);
    const derived: SecurityRecord = {
      symbol,
      name: formatContract(symbol),
      sector: parent?.sector ?? UNCLASSIFIED,
      industry: parent?.industry ?? null,
      assetType: "OPTION",
      logoUrl: parent?.logoUrl ?? null,
    };
    await persist(env, derived);
    return derived;
  }

  try {
    const profile = await finnhubFromEnv(env).profile(symbol);

    if (profile) {
      record = {
        symbol,
        name: profile.name,
        sector: profile.sector,
        industry: profile.industry,
        assetType: profile.assetType,
        logoUrl: profile.logoUrl,
      };
    } else {
      record = {
        symbol,
        name: null,
        sector: UNCLASSIFIED,
        industry: null,
        assetType: "STOCK",
        logoUrl: null,
      };
    }
  } catch (err) {
    if (err instanceof MarketConfigError) return null;
    console.error(`Sector lookup failed for ${symbol}:`, err);
    return null;
  }

  // Finnhub returns no name for a fund. Alpaca's asset list does, and it is
  // already in KV, so an ETF row still ends up with something readable in it.
  if (!record.name) {
    const asset = await lookupSymbol(env, symbol).catch(() => undefined);
    if (asset) record.name = asset.name;
  }

  await store(env, record);
  memory.set(symbol, { record, loadedAt: Date.now() });
  return record;
}

/** Write a record through to the table and the isolate cache, in that order. */
async function persist(env: Env, record: SecurityRecord): Promise<SecurityRecord> {
  await store(env, record);
  memory.set(record.symbol, { record, loadedAt: Date.now() });
  return record;
}

async function store(env: Env, record: SecurityRecord): Promise<void> {
  let supabase;
  try {
    supabase = serviceClient(env);
  } catch (err) {
    if (err instanceof ConfigError) return;
    throw err;
  }

  const { error } = await supabase.from("securities").upsert(
    {
      symbol: record.symbol,
      name: record.name,
      sector: record.sector,
      industry: record.industry,
      asset_type: record.assetType,
      logo_url: record.logoUrl,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "symbol" },
  );

  if (error) console.error(`Could not persist ${record.symbol}:`, error);
}
