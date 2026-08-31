import { MarketConfigError, MarketDataError, type ProfileProvider, type SecurityProfile } from "./provider.ts";
import { ETF_SECTOR, toSector, UNCLASSIFIED } from "./sectors.ts";

/**
 * Finnhub — sector classification, and nothing else.
 *
 * Alpaca has no fundamentals, so this is the only source for the sector
 * breakdown. It is used for exactly one call per ticker in the club's entire
 * history: the answer is written to the `securities` table and never fetched
 * again. That is the only reason a 60 call/minute personal-tier key is enough.
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

export class FinnhubProvider implements ProfileProvider {
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
      });
    } catch (cause) {
      throw new MarketDataError("finnhub", `Could not reach Finnhub: ${String(cause)}`, 502);
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
}

export function finnhubFromEnv(env: { FINNHUB_API_KEY?: string }): FinnhubProvider {
  if (!env.FINNHUB_API_KEY) {
    throw new MarketConfigError(
      "Sector lookup is not configured. Set FINNHUB_API_KEY.",
    );
  }
  return new FinnhubProvider(env.FINNHUB_API_KEY);
}
