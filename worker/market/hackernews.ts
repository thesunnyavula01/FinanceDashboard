import { MarketDataError, type DiscussionPost, type NewsQuery } from "./provider.ts";
import { companyKeyword, finiteNumber, isoDate, researchJson, researchWindow, safeExternalUrl, stripMarkup } from "./research-utils.ts";

/** Discussion is sorted by time and bounded by recency, never Algolia's default relevance. */
export class HackerNewsProvider {
  readonly name = "hackernews";

  async discussion(name: string, opts: NewsQuery = {}): Promise<DiscussionPost[]> {
    const keyword = companyKeyword(name);
    if (!keyword) return [];
    const window = researchWindow(opts);
    const start = Math.floor(Date.parse(window.start) / 1000);
    const end = Math.floor(Date.parse(window.end) / 1000);
    const params = new URLSearchParams({ query: keyword, tags: "story", hitsPerPage: String(window.limit),
      numericFilters: `created_at_i>=${start},created_at_i<=${end}` });
    const body = await researchJson<{ hits?: Record<string, unknown>[] }>(this.name,
      `https://hn.algolia.com/api/v1/search_by_date?${params}`);
    if (!Array.isArray(body?.hits)) throw new MarketDataError(this.name, "Hacker News returned an invalid response.");
    return body.hits.flatMap((row): DiscussionPost[] => {
      if (!row || typeof row !== "object" || !/^\d+$/.test(String(row.objectID ?? ""))) return [];
      const publishedAt = isoDate(row.created_at) ?? isoDate(row.created_at_i);
      const title = stripMarkup(row.title);
      if (!publishedAt || !title || publishedAt < window.start || publishedAt > window.end) return [];
      const id = String(row.objectID);
      const commentsUrl = `https://news.ycombinator.com/item?id=${id}`;
      return [{ id, title, url: safeExternalUrl(row.url) ?? commentsUrl, commentsUrl,
        score: finiteNumber(row.points), comments: finiteNumber(row.num_comments), publishedAt }];
    });
  }
}
