import { MarketConfigError, MarketDataError, type EarningsQuarter, type Filing } from "./provider.ts";
import { finiteNumber, isoDate, researchJson, stripMarkup } from "./research-utils.ts";

/** The SEC has no API key. Every request identifies a reachable contact. */
const CIK_TTL_MS = 7 * 24 * 60 * 60_000;
const CIK_KEY = "https://research-cache.invalid/v1/cik/company-tickers";
interface CikEntry { cachedAt: number; value: Record<string, string> }
let cikMemory: CikEntry | null = null;
let cikPending: Promise<Record<string, string>> | null = null;
let nextSecRequest = 0;

function contactHeader(contact: string): string {
  const value = contact.trim();
  if (!/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value) || /(?:set-me|example\.(?:com|org|net)|[\r\n])/i.test(value)) {
    throw new MarketConfigError("SEC filings are not configured. Set SEC_CONTACT to a reachable contact address.");
  }
  return value;
}

async function secJson<T>(url: string, contact: string): Promise<T> {
  const header = contactHeader(contact);
  // Shared across filings, companyfacts and ticker resolution in this isolate.
  const delay = Math.max(0, nextSecRequest - Date.now());
  nextSecRequest = Date.now() + delay + 120;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  return researchJson<T>("edgar", url, { "User-Agent": header });
}

async function cikMap(contact: string): Promise<Record<string, string>> {
  contactHeader(contact);
  if (cikMemory && Date.now() - cikMemory.cachedAt < CIK_TTL_MS) return cikMemory.value;
  if (cikPending) return cikPending;
  const pending = (async () => {
    if (typeof caches !== "undefined") {
      try {
        const hit = await caches.default.match(CIK_KEY);
        if (hit) {
          const entry = await hit.json() as CikEntry;
          if (entry?.value && typeof entry.value === "object" && Number.isFinite(entry.cachedAt)
            && Date.now() - entry.cachedAt < CIK_TTL_MS) {
            cikMemory = entry;
            return entry.value;
          }
        }
      } catch { /* Cache failure is a miss. */ }
    }
    const body = await secJson<Record<string, { ticker?: unknown; cik_str?: unknown }>>(
      "https://www.sec.gov/files/company_tickers.json", contact);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new MarketDataError("edgar", "SEC ticker lookup returned an invalid response.");
    }
    const value: Record<string, string> = {};
    for (const row of Object.values(body)) {
      if (row && typeof row.ticker === "string" && /^\d{1,10}$/.test(String(row.cik_str))) {
        value[row.ticker.toUpperCase().replace(/-/g, ".")] = String(row.cik_str).padStart(10, "0");
      }
    }
    if (Object.keys(value).length === 0) throw new MarketDataError("edgar", "SEC ticker lookup returned no companies.");
    cikMemory = { value, cachedAt: Date.now() };
    if (typeof caches !== "undefined") {
      try {
        await caches.default.put(CIK_KEY, new Response(JSON.stringify(cikMemory), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${CIK_TTL_MS / 1000}` },
        }));
      } catch { /* Losing this write costs a fetch, not the filings panel. */ }
    }
    return value;
  })();
  cikPending = pending;
  try { return await pending; }
  finally { if (cikPending === pending) cikPending = null; }
}

export class EdgarProvider {
  readonly name = "edgar";
  #contact: string;

  constructor(contact: string) { this.#contact = contactHeader(contact); }

  async filings(symbol: string): Promise<Filing[]> {
    const cik = (await cikMap(this.#contact))[symbol.replace(/-/g, ".")];
    if (!cik) return [];
    const params = new URLSearchParams({ ciks: cik, forms: "8-K,10-Q,10-K", dateRange: "custom",
      startdt: new Date(Date.now() - 366 * 24 * 60 * 60_000).toISOString().slice(0, 10),
      enddt: new Date().toISOString().slice(0, 10), from: "0", size: "40", sort: "desc" });
    const body = await secJson<{ hits?: { hits?: { _id?: string; _source?: Record<string, unknown> }[] } }>(
      `https://efts.sec.gov/LATEST/search-index?${params}`, this.#contact);
    if (!Array.isArray(body?.hits?.hits)) throw new MarketDataError(this.name, "SEC filings returned an invalid response.");
    const rows = new Map<string, Filing>();
    for (const hit of body.hits.hits) {
      const row = hit?._source;
      if (!row) continue;
      const accession = typeof row.adsh === "string" ? row.adsh : hit._id?.split(":")[0];
      const form = stripMarkup(row.form ?? row.file_type);
      const filedAt = isoDate(row.file_date)?.slice(0, 10);
      if (!accession || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !["8-K", "10-Q", "10-K"].includes(form) || !filedAt) continue;
      const titles: Record<string, string> = { "8-K": "Current report", "10-Q": "Quarterly report", "10-K": "Annual report" };
      rows.set(accession, { id: accession, form, title: titles[form]!, filedAt,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.html` });
    }
    return [...rows.values()].sort((a, b) => b.filedAt.localeCompare(a.filedAt)).slice(0, 30);
  }

  async earnings(symbol: string): Promise<EarningsQuarter[]> {
    const cik = (await cikMap(this.#contact))[symbol.replace(/-/g, ".")];
    if (!cik) return [];
    const body = await secJson<unknown>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, this.#contact);
    return earningsFromFacts(body);
  }
}

/** Reported diluted USD EPS only. A nine-month/YTD fact must never masquerade as a quarter. */
export function earningsFromFacts(body: unknown): EarningsQuarter[] {
  const facts = body as { facts?: { "us-gaap"?: { EarningsPerShareDiluted?: { units?: { "USD/shares"?: Record<string, unknown>[] } } } } };
  if (!facts?.facts || typeof facts.facts !== "object") throw new MarketDataError("edgar", "SEC company facts returned an invalid response.");
  const rows = facts.facts["us-gaap"]?.EarningsPerShareDiluted?.units?.["USD/shares"];
  if (!Array.isArray(rows)) return [];
  const quarters = new Map<string, { quarter: EarningsQuarter; filed: string }>();
  for (const row of rows) {
    if (!row || !["10-Q", "10-Q/A", "10-K", "10-K/A"].includes(String(row.form))) continue;
    const start = isoDate(row.start);
    const end = isoDate(row.end);
    const actual = finiteNumber(row.val);
    if (!start || !end || actual === null) continue;
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (days < 60 || days > 120) continue;
    const period = end.slice(0, 10);
    const filed = isoDate(row.filed) ?? "";
    if (quarters.has(period) && quarters.get(period)!.filed > filed) continue;
    // SEC fp/fy name the filing, not necessarily this comparative fact's fiscal quarter.
    // The period date is authoritative; no fiscal label or consensus estimate is invented.
    quarters.set(period, { filed, quarter: { period, quarter: null, year: null, actual,
      estimate: null, surprisePercent: null, source: "edgar" } });
  }
  return [...quarters.values()].map((row) => row.quarter).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 8);
}

export function edgarFromEnv(env: { SEC_CONTACT?: string }): EdgarProvider {
  return new EdgarProvider(env.SEC_CONTACT ?? "");
}

/** Reset both cache and cold-reader guard for deterministic provider tests. */
export function forgetEdgar(): void {
  cikMemory = null;
  cikPending = null;
  nextSecRequest = 0;
}
