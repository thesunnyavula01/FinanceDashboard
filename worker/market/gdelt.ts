import { MarketDataError, type NewsItem, type NewsProvider, type NewsQuery } from "./provider.ts";
import { companyKeyword, normalizeNews, researchJson, researchWindow } from "./research-utils.ts";

/** Global press is name-matched; a GDELT hit is never presented as ticker-exact. */
export class GdeltProvider implements NewsProvider {
  readonly name = "gdelt";

  async news(name: string, opts: NewsQuery = {}): Promise<NewsItem[]> {
    const keyword = companyKeyword(name);
    if (!keyword) return [];
    const window = researchWindow(opts);
    const compact = (value: string) => value.replace(/[-:TZ.]/g, "").slice(0, 14);
    const params = new URLSearchParams({ query: `"${keyword}"`, mode: "artlist", format: "json",
      maxrecords: String(window.limit), sort: "datedesc", startdatetime: compact(window.start), enddatetime: compact(window.end) });
    const body = await researchJson<{ articles?: Record<string, unknown>[] }>(this.name,
      `https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { "User-Agent": "Finance Club Terminal research" });
    if (!Array.isArray(body?.articles)) throw new MarketDataError(this.name, "GDELT returned an invalid article list.");
    return body.articles.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const seen = typeof row.seendate === "string"
        ? row.seendate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z") : null;
      const item = normalizeNews({ headline: row.title, url: row.url, source: row.domain,
        publishedAt: seen, provider: "gdelt", tier: "WEB" });
      return item ? [item] : [];
    });
  }
}
