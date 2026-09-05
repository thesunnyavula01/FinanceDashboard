import { MarketDataError, type NewsItem, type NewsQuery } from "./provider.ts";

const PAYWALLS = ["wsj.com", "bloomberg.com", "barrons.com", "ft.com", "seekingalpha.com",
  "theinformation.com", "economist.com"];
// Finnhub returns an opaque redirect URL, with the publisher only in `source`.
const PAYWALLED_PUBLISHERS = new Set(["wsj", "wallstreetjournal", "thewallstreetjournal", "bloomberg",
  "barrons", "financialtimes", "seekingalpha", "theinformation", "economist", "theeconomist"]);
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

/** Only plain text crosses the Worker boundary. Decode first so encoded tags cannot survive. */
export function stripMarkup(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const number = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  }).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isoDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function researchWindow(opts: NewsQuery = {}): { start: string; end: string; limit: number } {
  return {
    start: isoDate(opts.start) ?? new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
    end: isoDate(opts.end) ?? new Date().toISOString(),
    limit: Math.min(50, Math.max(1, Math.floor(opts.limit ?? 40))),
  };
}

/** Legal suffixes make "Tesla Inc." far narrower than the name used by the press. */
export function companyKeyword(name: string): string {
  return stripMarkup(name).replace(/\s+(?:incorporated|inc\.?|corporation|corp\.?|company|co\.?|ltd\.?|limited|plc)\s*$/i, "")
    .replace(/["():{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

const COIN_NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", DOGE: "Dogecoin",
  LTC: "Litecoin", BCH: "Bitcoin Cash", AVAX: "Avalanche", LINK: "Chainlink", XRP: "XRP", DOT: "Polkadot",
  SHIB: "Shiba Inu", UNI: "Uniswap", AAVE: "Aave", USDC: "USD Coin", USDT: "Tether" };

export function cryptoResearchName(symbol: string, name?: string | null): string {
  const base = symbol.split("/")[0]!;
  return COIN_NAMES[base] ?? (name && name !== symbol && name !== base ? name : base);
}

export function normalizeNews(row: {
  id?: unknown; headline?: unknown; summary?: unknown; url?: unknown; source?: unknown;
  publishedAt?: unknown; provider: NewsItem["provider"]; tier: NewsItem["tier"];
}): NewsItem | null {
  const url = safeExternalUrl(row.url);
  const headline = stripMarkup(row.headline);
  const publishedAt = isoDate(row.publishedAt);
  if (!url || !headline || !publishedAt) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const source = stripMarkup(row.source) || host;
  const knownRedirectPublisher = row.provider === "finnhub" && host === "finnhub.io"
    && PAYWALLED_PUBLISHERS.has(source.toLowerCase().replace(/[^a-z]/g, ""));
  return {
    ...(typeof row.id === "string" || typeof row.id === "number" ? { id: String(row.id) } : {}),
    headline, summary: stripMarkup(row.summary).slice(0, 1500) || null, url,
    source, provider: row.provider, tier: row.tier, publishedAt,
    paywalled: knownRedirectPublisher || PAYWALLS.some((domain) => host === domain || host.endsWith(`.${domain}`)),
  };
}

/** Bounded fetches and deliberately generic failures keep API tokens out of error payloads. */
export async function researchJson<T>(provider: string, url: string, headers: HeadersInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(8000) });
  } catch { throw new MarketDataError(provider, `${provider} research could not be reached.`, 502); }
  if (!response.ok) {
    throw new MarketDataError(provider, `${provider} research returned ${response.status}.`, response.status);
  }
  try { return await response.json() as T; }
  catch { throw new MarketDataError(provider, `${provider} research returned an invalid response.`, 502); }
}
