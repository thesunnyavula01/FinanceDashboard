import { alpacaFromEnv } from "./alpaca.ts";
import { edgarFromEnv } from "./edgar.ts";
import { finnhubFromEnv } from "./finnhub.ts";
import { GdeltProvider } from "./gdelt.ts";
import { HackerNewsProvider } from "./hackernews.ts";
import {
  MarketDataError,
  type DiscussionPost,
  type EarningsQuarter,
  type Filing,
  type NewsItem,
  type ResearchSource,
} from "./provider.ts";
import { cryptoResearchName, normalizeNews, stripMarkup } from "./research-utils.ts";
import { researchMatcher } from "./research-relevance.ts";
import { getSecurities } from "./securities.ts";
import { classify, normalise, underlyingOf } from "./symbols.ts";
import { lookupSymbol } from "./universe.ts";
import type { Env } from "../types.ts";

/**
 * One member's research request is one shared round of upstream calls.
 *
 * The five kinds have different lifetimes, so an expiring headline never
 * re-fetches quarterly earnings. Each fragment also caches its source status:
 * a working news call does not conceal a failed earnings call to the same
 * provider. A failed fragment stays a failure during its brief retry window,
 * rather than becoming a successful empty feed for half an hour.
 *
 * The in-flight guard starts before profile resolution and edge-cache reads.
 * A hundred cold readers therefore share the company-name lookup as well as
 * the news, including when the asset card already started that enrichment.
 */
const NEWS_TTL_MS = 5 * 60_000;
const WEB_TTL_MS = 15 * 60_000;
const EARNINGS_TTL_MS = 12 * 60 * 60_000;
const FILINGS_TTL_MS = 6 * 60 * 60_000;
const SOCIAL_TTL_MS = 10 * 60_000;
const EMPTY_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 60_000;

const SOURCE_ORDER: ResearchSource[] = ["alpaca", "finnhub", "gdelt", "edgar", "hackernews"];

interface Fragment<T> {
  items: T[];
  sources: ResearchSource[];
  missing: ResearchSource[];
  asOf: string;
}

type Cached<T> = { ok: true; value: Fragment<T> } | { ok: false; missing: ResearchSource[] };
interface Entry<T> {
  value: Cached<T>;
  expiresAt: number;
}

class FragmentFailure extends Error {
  missing: ResearchSource[];
  cacheable: boolean;

  constructor(missing: ResearchSource[], cacheable = true) {
    super(`Research unavailable from ${missing.join(", ")}.`);
    this.missing = missing;
    this.cacheable = cacheable;
  }
}

const memory = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<ResearchResult>>();

function edgeKey(key: string): string {
  return `https://research-cache.invalid/v1/${encodeURIComponent(key)}`;
}

async function readEdge<T>(key: string): Promise<Cached<T> | null> {
  const now = Date.now();
  const hot = memory.get(key) as Entry<T> | undefined;
  if (hot && now < hot.expiresAt) return hot.value;
  if (typeof caches === "undefined") return null;
  try {
    const response = await caches.default.match(edgeKey(key));
    if (!response) return null;
    const entry = await response.json() as Entry<T>;
    if (!entry.value || !Number.isFinite(entry.expiresAt) || now >= entry.expiresAt) return null;
    const value = entry.value;
    if (value.ok === false) {
      if (!Array.isArray(value.missing)) return null;
    } else if (value.ok !== true || !value.value || !Array.isArray(value.value.items) ||
      !Array.isArray(value.value.sources) || !Array.isArray(value.value.missing) ||
      !Number.isFinite(Date.parse(value.value.asOf))) return null;
    memory.set(key, entry as Entry<unknown>);
    return entry.value;
  } catch {
    // The Cache API is an optimisation, not another upstream that can fail F4.
    return null;
  }
}

async function writeEdge<T>(key: string, value: Cached<T>, ttl: number): Promise<void> {
  const entry: Entry<T> = { value, expiresAt: Date.now() + ttl };
  memory.set(key, entry as Entry<unknown>);
  if (typeof caches === "undefined") return;
  try {
    await caches.default.put(edgeKey(key), new Response(JSON.stringify(entry), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${Math.ceil(ttl / 1000)}` },
    }));
  } catch {
    // Losing a write costs a fetch, never the research response.
  }
}

async function cached<T>(
  key: string,
  ttl: number,
  providers: ResearchSource[],
  load: () => Promise<Fragment<T>>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Fragment<T>> {
  const hit = await readEdge<T>(key);
  if (hit) {
    if (!hit.ok) throw new FragmentFailure(hit.missing);
    return hit.value;
  }
  const write = async (value: Cached<T>, lifetime: number) => {
    const work = writeEdge(key, value, lifetime);
    if (waitUntil) waitUntil(work);
    else await work;
  };
  try {
    const value = await load();
    await write({ ok: true, value }, value.items.length || value.missing.length ? ttl : Math.max(ttl, EMPTY_TTL_MS));
    return value;
  } catch (error) {
    const failure = error instanceof FragmentFailure ? error : new FragmentFailure(providers);
    if (!(error instanceof FragmentFailure)) console.error(`Research ${key} failed:`, error);
    if (failure.cacheable) await write({ ok: false, missing: failure.missing }, FAILURE_TTL_MS);
    throw failure;
  }
}

function ordered(sources: Iterable<ResearchSource>): ResearchSource[] {
  const set = new Set(sources);
  return SOURCE_ORDER.filter((source) => set.has(source));
}

/** A successful empty array means coverage was checked, not that it failed. */
async function collect<T>(sources: Array<{ source: ResearchSource; load: () => Promise<T[]> }>): Promise<Fragment<T>> {
  const results = await Promise.allSettled(sources.map((source) => Promise.resolve().then(source.load)));
  const fragment: Fragment<T> = { items: [], sources: [], missing: [], asOf: new Date(Date.now()).toISOString() };
  results.forEach((result, index) => {
    const source = sources[index]!.source;
    if (result.status === "fulfilled") {
      fragment.items.push(...result.value);
      fragment.sources.push(source);
    } else {
      console.error(`Research ${source} failed:`, result.reason);
      fragment.missing.push(source);
    }
  });
  if (!fragment.sources.length) throw new FragmentFailure(fragment.missing);
  return fragment;
}

/** Keyword feeds must search the company, not cache a cold profile's ticker. */
async function resolveName(env: Env, symbol: string): Promise<string | null> {
  const asset = await lookupSymbol(env, symbol).catch(() => undefined);
  if (classify(symbol) === "CRYPTO") return cryptoResearchName(symbol, asset?.name);
  try {
    const result = await getSecurities(env, [symbol]);
    const name = result.securities.get(symbol)?.name ?? asset?.name;
    return name ? stripMarkup(name) || null : null;
  } catch (error) {
    console.error(`Research profile ${symbol} failed:`, error);
    return asset?.name ? stripMarkup(asset.name) || null : null;
  }
}

/**
 * Tracking parameters do not turn a syndicated story into a second row.
 * Finnhub's live feed is the exception: every link has path `/api/news` and
 * the article lives in `id`. Dropping that would merge its entire feed into
 * one headline, so keep that identity parameter while ignoring its trackers.
 */
export function mergeHeadlines(items: NewsItem[]): NewsItem[] {
  const merged = new Map<string, NewsItem>();
  for (const item of items) {
    const clean = normalizeNews(item);
    if (!clean) continue;
    const publishedAt = Date.parse(clean.publishedAt);
    const parsed = new URL(clean.url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const articleId = host === "finnhub.io" && path === "/api/news" ? parsed.searchParams.get("id") : null;
    const key = host + path + (articleId ? `?id=${encodeURIComponent(articleId)}` : "");
    const existing = merged.get(key);
    if (!existing || publishedAt < Date.parse(existing.publishedAt) ||
      (publishedAt === Date.parse(existing.publishedAt) && existing.tier === "WEB" && clean.tier === "WIRE")) {
      merged.set(key, clean);
    }
  }
  return [...merged.values()].sort((a, b) =>
    Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
    Number(a.paywalled) - Number(b.paywalled) || a.headline.localeCompare(b.headline),
  );
}

export interface ResearchResult {
  symbol: string;
  assetClass: "EQUITY" | "CRYPTO";
  name: string | null;
  headlines: NewsItem[];
  earnings: EarningsQuarter[];
  filings: Filing[];
  discussion: DiscussionPost[];
  sources: ResearchSource[];
  missing: ResearchSource[];
  sectionMissing: Record<"headlines" | "earnings" | "filings" | "discussion", ResearchSource[]>;
  asOf: string;
}

export function loadResearch(env: Env, rawSymbol: string, waitUntil?: (promise: Promise<unknown>) => void): Promise<ResearchResult> {
  const symbol = underlyingOf(rawSymbol) ?? normalise(rawSymbol);
  const running = inFlight.get(symbol);
  if (running) return running;
  const work = buildResearch(env, symbol, waitUntil).finally(() => inFlight.delete(symbol));
  inFlight.set(symbol, work);
  return work;
}

async function buildResearch(env: Env, symbol: string, waitUntil?: (promise: Promise<unknown>) => void): Promise<ResearchResult> {
  const assetClass = classify(symbol) === "CRYPTO" ? "CRYPTO" : "EQUITY";
  const identity = resolveName(env, symbol);
  const keyword = async (source: ResearchSource) => {
    const name = await identity;
    if (!name) throw new FragmentFailure([source], false);
    return name;
  };
  const wire = cached(`wire/${symbol}`, NEWS_TTL_MS, ["alpaca", "finnhub"], () => collect<NewsItem>([
    { source: "alpaca", load: () => alpacaFromEnv(env).news([symbol]) },
    { source: "finnhub", load: () => finnhubFromEnv(env).news(symbol) },
  ]), waitUntil);
  const web = cached(`web/${symbol}`, WEB_TTL_MS, ["gdelt"], async () => {
    const name = await keyword("gdelt");
    return collect<NewsItem>([{ source: "gdelt", load: () => new GdeltProvider().news(name) }]);
  }, waitUntil);
  const social = cached(`social/${symbol}`, SOCIAL_TTL_MS, ["hackernews"], async () => {
    const name = await keyword("hackernews");
    return collect<DiscussionPost>([{ source: "hackernews", load: () => new HackerNewsProvider().discussion(name) }]);
  }, waitUntil);
  const empty = <T>(): Promise<Fragment<T>> => Promise.resolve({ items: [], sources: [], missing: [], asOf: new Date(Date.now()).toISOString() });
  const earnings = assetClass === "CRYPTO" ? empty<EarningsQuarter>() : cached(`earnings/${symbol}`, EARNINGS_TTL_MS, ["finnhub", "edgar"], async () => {
    try {
      return await collect<EarningsQuarter>([{ source: "finnhub", load: () => finnhubFromEnv(env).earnings(symbol) }]);
    } catch {
      try {
        const fallback = await collect<EarningsQuarter>([{ source: "edgar", load: () => edgarFromEnv(env).earnings(symbol) }]);
        fallback.missing.push("finnhub");
        return fallback;
      } catch {
        throw new FragmentFailure(["finnhub", "edgar"]);
      }
    }
  }, waitUntil);
  const filings = assetClass === "CRYPTO" ? empty<Filing>() : cached(`filings/${symbol}`, FILINGS_TTL_MS, ["edgar"], () =>
    collect<Filing>([{ source: "edgar", load: () => edgarFromEnv(env).filings(symbol) }]), waitUntil);

  const [wireResult, webResult, earningsResult, filingsResult, socialResult] = await Promise.allSettled([wire, web, earnings, filings, social]);
  const unwrap = <T>(result: PromiseSettledResult<Fragment<T>>): Fragment<T> => result.status === "fulfilled" ? result.value : {
    items: [], sources: [], missing: result.reason instanceof FragmentFailure ? result.reason.missing : [], asOf: "",
  };
  const w = unwrap(wireResult), g = unwrap(webResult), e = unwrap(earningsResult), f = unwrap(filingsResult), h = unwrap(socialResult);
  const parts = [w, g, e, f, h];
  const sources = ordered(parts.flatMap((part) => part.sources));
  if (!sources.length) throw new MarketDataError("research", "Research sources are temporarily unavailable. Try again shortly.");
  const name = await identity;
  const relevant = researchMatcher(symbol, name);
  return {
    symbol, assetClass, name,
    // Filter even warm entries: older provider/cache rows can be mis-tagged.
    // Summaries and ticker metadata never qualify an unrelated headline.
    headlines: mergeHeadlines([...w.items, ...g.items].filter((item) => relevant(item.headline))),
    earnings: e.items,
    filings: f.items,
    discussion: h.items.filter((item) => relevant(item.title)),
    sources,
    missing: ordered(parts.flatMap((part) => part.missing)),
    sectionMissing: { headlines: ordered([...w.missing, ...g.missing]), earnings: ordered(e.missing), filings: ordered(f.missing), discussion: ordered(h.missing) },
    // Oldest contributing source, so a warm cache never claims to be fresh.
    asOf: parts.filter((part) => part.sources.length).map((part) => part.asOf).sort()[0]!,
  };
}

/** Drops the isolate tier and request guards. Tests only. */
export function forgetResearch(): void {
  memory.clear();
  inFlight.clear();
}
