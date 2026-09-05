import { MarketConfigError, MarketDataError, type ProfileProvider, type SecurityProfile,
  type NewsItem, type NewsProvider, type NewsQuery, type EarningsQuarter } from "./provider.ts";
import { ETF_SECTOR, toSector, UNCLASSIFIED } from "./sectors.ts";
import { cryptoResearchName, finiteNumber, isoDate, normalizeNews, researchJson, researchWindow } from "./research-utils.ts";

/**
 * Finnhub — sector classification, news, and quarterly earnings.
 *
 * Alpaca has no fundamentals, so this is the only source for the sector
 * breakdown. It is used for exactly one call per ticker in the club's entire
 * history: the answer is written to the `securities` table and never fetched
 * again. Research shares that 60 call/minute budget and is cached in research.ts;
 * these are news and fundamentals calls, never additional price polling.
 *
 * Do not add price calls here. `/stock/candle` is premium and answers 403 on
 * free keys, and `/quote` has no batch form — 200 symbols would be 200 HTTP
 * calls where Alpaca does two.
 */

const HOST = "https://finnhub.io/api/v1";

interface Profile2Response {
  ticker?: string;
  name?: string;
  finnhubIndustry?: string;
  logo?: string;
  exchange?: string;
}

export class FinnhubProvider implements ProfileProvider, NewsProvider {
  readonly name = "finnhub";
  #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  /**
   * Company profile for one symbol.
   *
   * An empty object is Finnhub's answer for an ETF: a fund has no industry,
   * no CEO and no headquarters, so there is nothing to return. It is also what
   * comes back for a symbol Finnhub simply does not cover. This app trades US
   * stocks and ETFs only and Finnhub's US common-stock coverage is complete,
   * so an empty profile is read as "fund", which is right far more often than
   * it is wrong — and a fund misfiled as a stock would show up as an obviously
   * missing sector rather than a wrong one.
   */
  async profile(symbol: string): Promise<SecurityProfile | null> {
    const params = new URLSearchParams({ symbol, token: this.#apiKey });

    let response: Response;
    try {
      response = await fetch(`${HOST}/stock/profile2?${params}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new MarketDataError("finnhub", "Could not reach Finnhub.", 502);
    }

    if (response.status === 429) {
      throw new MarketDataError("finnhub", "Finnhub rate limit reached.", 429);
    }
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new MarketDataError("finnhub", `Finnhub returned ${response.status}`, 502);
    }

    const body = (await response.json()) as Profile2Response;
    const industry = typeof body.finnhubIndustry === "string" ? body.finnhubIndustry.trim() : "";

    if (!industry) {
      return {
        symbol,
        name: body.name?.trim() || null,
        sector: ETF_SECTOR,
        industry: null,
        assetType: "ETF",
        logoUrl: body.logo?.trim() || null,
      };
    }

    const sector = toSector(industry);
    if (sector === UNCLASSIFIED) {
      // Loud on purpose. Every one of these is a one-line addition to the
      // table in sectors.ts, and a member's position is sitting in the
      // Unclassified bucket until someone makes it.
      console.warn(`Unmapped Finnhub industry for ${symbol}: ${JSON.stringify(industry)}`);
    }

    return {
      symbol,
      name: body.name?.trim() || null,
      sector,
      industry,
      assetType: "STOCK",
      logoUrl: body.logo?.trim() || null,
    };
  }

  async news(symbol: string, opts: NewsQuery = {}): Promise<NewsItem[]> {
    const window = researchWindow(opts);
    const crypto = symbol.includes("/");
    const params = crypto ? new URLSearchParams({ category: "crypto" }) : new URLSearchParams({
      symbol, from: window.start.slice(0, 10), to: window.end.slice(0, 10),
    });
    const body = await researchJson<Record<string, unknown>[]>(this.name,
      `${HOST}/${crypto ? "news" : "company-news"}?${params}`, { "X-Finnhub-Token": this.#apiKey });
    if (!Array.isArray(body)) throw new MarketDataError(this.name, "Finnhub news returned an invalid response.");
    const base = symbol.split("/")[0]!;
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const coinName = cryptoResearchName(symbol).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const words = new RegExp(`\\b(?:${escapedBase}|${coinName})\\b`, "i");
    return body.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const item = normalizeNews({ ...row, publishedAt: row.datetime, provider: "finnhub", tier: crypto ? "WEB" : "WIRE" });
      if (!item || item.publishedAt < window.start || item.publishedAt > window.end) return [];
      // Finnhub's crypto endpoint is category-wide. Name matches never claim ticker precision.
      if (crypto && !words.test(`${item.headline} ${item.summary ?? ""}`)) return [];
      return [item];
    }).slice(0, window.limit);
  }

  /** Live-key probe 2026-09-05 returned 200 and four quarters on the free key. */
  async earnings(symbol: string): Promise<EarningsQuarter[]> {
    if (symbol.includes("/")) return [];
    const body = await researchJson<Record<string, unknown>[]>(this.name,
      `${HOST}/stock/earnings?${new URLSearchParams({ symbol, limit: "8" })}`, { "X-Finnhub-Token": this.#apiKey });
    if (!Array.isArray(body)) throw new MarketDataError(this.name, "Finnhub earnings returned an invalid response.");
    return body.flatMap((row): EarningsQuarter[] => {
      if (!row || typeof row !== "object") return [];
      const period = isoDate(row.period)?.slice(0, 10);
      if (!period) return [];
      return [{ period, quarter: finiteNumber(row.quarter), year: finiteNumber(row.year),
        estimate: finiteNumber(row.estimate), actual: finiteNumber(row.actual),
        surprisePercent: finiteNumber(row.surprisePercent), source: "finnhub" }];
    }).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 8);
  }
}

export function finnhubFromEnv(env: { FINNHUB_API_KEY?: string }): FinnhubProvider {
  if (!env.FINNHUB_API_KEY) {
    throw new MarketConfigError(
      "Sector lookup is not configured. Set FINNHUB_API_KEY.",
    );
  }
  return new FinnhubProvider(env.FINNHUB_API_KEY);
}
