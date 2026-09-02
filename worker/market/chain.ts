import { providerFromEnv, type RouterEnv } from "./router.ts";
import { quoteCache } from "./quotes.ts";
import type { ChainQuote } from "./options.ts";

/**
 * The option chain, cached.
 *
 * Two tiers like everything else — isolate memory and the Cache API — and two
 * TTLs, because the panel asks two questions with very different lifetimes.
 *
 * **Expirations change once a day.** A new weekly is listed overnight; nothing
 * during a session moves the list. An hour is generous and still means an
 * underlying a dozen members are watching costs one request an hour, not one
 * per member per keystroke.
 *
 * **Prices change constantly, and are cached for the quote interval.** Twenty
 * seconds is the same number the quote cache uses, which matters more than it
 * looks: the chain and the ticket's own price line are on screen together, and
 * two caches with different TTLs would show a member two different marks for
 * the contract they are about to buy.
 *
 * Keyed by underlying and expiration rather than by member, which is what makes
 * a club affordable here: thirty members looking at the same AAPL expiry is two
 * upstream calls a minute, not sixty.
 *
 * The chain is never fetched whole. One expiration of a liquid underlying is
 * about two hundred contracts and comes back in a single page; the whole
 * surface is tens of thousands and would be a payload nobody reads. See
 * `options.ts` for the rest of that reasoning.
 */

const CHAIN_TTL_MS = 20_000;
const EXPIRY_TTL_MS = 60 * 60_000;

interface Entry<T> {
  value: T;
  cachedAt: number;
}

const memory = new Map<string, Entry<unknown>>();

function edgeKey(key: string): string {
  return `https://chain-cache.invalid/v1/${encodeURIComponent(key)}`;
}

async function readEdge<T>(key: string, ttl: number, now: number): Promise<T | null> {
  const hot = memory.get(key) as Entry<T> | undefined;
  if (hot && now - hot.cachedAt < ttl) return hot.value;

  if (typeof caches === "undefined") return null;
  try {
    const hit = await caches.default.match(edgeKey(key));
    if (!hit) return null;
    const entry = (await hit.json()) as Entry<T>;
    if (now - entry.cachedAt >= ttl) return null;
    memory.set(key, entry as Entry<unknown>);
    return entry.value;
  } catch {
    // A cache that misbehaves is a miss, never an outage.
    return null;
  }
}

async function writeEdge<T>(key: string, value: T, ttl: number, now: number): Promise<void> {
  const entry: Entry<T> = { value, cachedAt: now };
  memory.set(key, entry as Entry<unknown>);
  if (typeof caches === "undefined") return;
  try {
    await caches.default.put(
      edgeKey(key),
      new Response(JSON.stringify(entry), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${Math.ceil(ttl / 1000)}`,
        },
      }),
    );
  } catch {
    // Losing a cache write costs a fetch, not correctness.
  }
}

export interface ChainResult {
  underlying: string;
  /** The underlying's own price, for the panel header and the ITM shading. */
  underlyingPrice: number | null;
  expirations: string[];
  /** Which one is drawn. Null only when the underlying lists no contracts. */
  expiration: string | null;
  contracts: ChainQuote[];
}

/**
 * One underlying's chain: its expirations, and one of them priced.
 *
 * `expiration` picks which; omitted, it is the nearest one that has not
 * expired, which is what a member means by "the chain" and also the one the
 * club actually trades.
 *
 * The underlying's price comes from the shared quote cache rather than a fresh
 * request. It is almost certainly warm — the member holding this symbol is
 * polling it on F1 — and reading it here means the chain header and the
 * positions grid cannot disagree about spot.
 */
export async function loadChain(
  env: RouterEnv,
  underlying: string,
  expiration: string | undefined,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<ChainResult> {
  const symbol = underlying.trim().toUpperCase();
  const now = Date.now();
  const provider = providerFromEnv(env).options;

  // Spot first: it narrows the expirations query's strike band, and the panel
  // needs it anyway.
  const spot = await quoteCache(env).get([symbol], waitUntil);
  const underlyingPrice = spot.quotes.get(symbol)?.price ?? null;

  const expiryKey = `exp/${symbol}`;
  let expirations = await readEdge<string[]>(expiryKey, EXPIRY_TTL_MS, now);
  if (!expirations) {
    expirations = await provider.expirations(symbol, underlyingPrice);
    await writeEdge(expiryKey, expirations, EXPIRY_TTL_MS, now);
  }

  if (expirations.length === 0) {
    return { underlying: symbol, underlyingPrice, expirations: [], expiration: null, contracts: [] };
  }

  // An expiration the member asked for that is not listed falls back to the
  // front month rather than 404ing: the rail is stale for at most an hour, and
  // a member clicking a date that has just expired should see a chain.
  const chosen =
    expiration && expirations.includes(expiration) ? expiration : (expirations[0] as string);

  const chainKey = `chain/${symbol}/${chosen}`;
  let contracts = await readEdge<ChainQuote[]>(chainKey, CHAIN_TTL_MS, now);
  if (!contracts) {
    contracts = await provider.chain(symbol, chosen);
    await writeEdge(chainKey, contracts, CHAIN_TTL_MS, now);
  }

  return { underlying: symbol, underlyingPrice, expirations, expiration: chosen, contracts };
}

/**
 * Contract metadata for one OCC symbol, cached for an hour.
 *
 * The orders route's validation path. `lookupSymbol()` cannot answer it — the
 * option universe is not in KV and could not fit — so this is what stands
 * between a typo and a position in a contract that does not exist. An hour is
 * safe because a contract's strike, expiry and multiplier never change; only
 * its price does, and that comes from somewhere else.
 */
export async function lookupContract(env: RouterEnv, symbol: string) {
  const occ = symbol.trim().toUpperCase();
  const key = `contract/${occ}`;
  const now = Date.now();

  const cached = await readEdge<Awaited<ReturnType<typeof loadContract>>>(key, EXPIRY_TTL_MS, now);
  if (cached !== null) return cached;

  const meta = await loadContract(env, occ);
  await writeEdge(key, meta, EXPIRY_TTL_MS, now);
  return meta;
}

function loadContract(env: RouterEnv, occ: string) {
  return providerFromEnv(env).options.contract(occ);
}

/** Drops the in-memory tier. Tests only. */
export function forgetChains(): void {
  memory.clear();
}
