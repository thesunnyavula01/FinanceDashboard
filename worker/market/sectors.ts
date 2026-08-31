/**
 * Finnhub industry -> GICS sector.
 *
 * Finnhub's `finnhubIndustry` is a flat list of roughly sixty labels that is
 * neither GICS nor documented as stable. The sector breakdown needs the eleven
 * GICS buckets, so this file is the translation, and it is deliberately
 * defensive: an exact-match table for the labels we know, an ordered keyword
 * pass for labels we do not, and an explicit "Unclassified" bucket rather than
 * a silent guess. A ticker landing in Unclassified is a visible prompt to add
 * a row here, which is much better than it landing in the wrong sector and
 * quietly skewing the club's exposure chart.
 */

export const GICS_SECTORS = [
  "Information Technology",
  "Health Care",
  "Financials",
  "Consumer Discretionary",
  "Communication Services",
  "Industrials",
  "Consumer Staples",
  "Energy",
  "Utilities",
  "Real Estate",
  "Materials",
] as const;

export type GicsSector = (typeof GICS_SECTORS)[number];

/** ETFs have no industry, so they get their own bucket rather than a guess. */
export const ETF_SECTOR = "ETF / Fund";

/** Everything the table and the keyword pass both failed to place. */
export const UNCLASSIFIED = "Unclassified";

export type Sector = GicsSector | typeof ETF_SECTOR | typeof UNCLASSIFIED;

/** Every bucket a position can land in, in the order charts should show them. */
export const ALL_SECTORS: readonly Sector[] = [...GICS_SECTORS, ETF_SECTOR, UNCLASSIFIED];

/**
 * Exact matches, keyed by normalised label. Carries both Finnhub's own
 * spellings and the GICS industry-group names, so the same table works for
 * anything else that ever supplies an industry string.
 */
const EXACT: Record<string, GicsSector> = {
  // Information Technology
  "technology": "Information Technology",
  "software": "Information Technology",
  "semiconductors": "Information Technology",
  "it services": "Information Technology",
  "technology hardware": "Information Technology",
  "electronic equipment": "Information Technology",
  "computers & peripherals": "Information Technology",

  // Communication Services
  "communications": "Communication Services",
  "telecommunication": "Communication Services",
  "telecommunications": "Communication Services",
  "wireless telecommunication services": "Communication Services",
  "diversified telecommunication services": "Communication Services",
  "media": "Communication Services",
  "entertainment": "Communication Services",
  "interactive media & services": "Communication Services",
  "internet": "Communication Services",
  "advertising": "Communication Services",
  "publishing": "Communication Services",
  "broadcasting": "Communication Services",

  // Health Care
  "health care": "Health Care",
  "healthcare": "Health Care",
  "pharmaceuticals": "Health Care",
  "biotechnology": "Health Care",
  "life sciences tools & services": "Health Care",
  "health care providers & services": "Health Care",
  "health care equipment & supplies": "Health Care",
  "medical devices": "Health Care",

  // Financials
  "banking": "Financials",
  "banks": "Financials",
  "financial services": "Financials",
  "insurance": "Financials",
  "capital markets": "Financials",
  "consumer finance": "Financials",
  "diversified financial services": "Financials",
  "investment banking & brokerage": "Financials",

  // Consumer Discretionary
  "retail": "Consumer Discretionary",
  "retailing": "Consumer Discretionary",
  "automobiles": "Consumer Discretionary",
  "auto components": "Consumer Discretionary",
  "auto manufacturers": "Consumer Discretionary",
  "hotels, restaurants & leisure": "Consumer Discretionary",
  "hotels restaurants & leisure": "Consumer Discretionary",
  "restaurants": "Consumer Discretionary",
  "textiles, apparel & luxury goods": "Consumer Discretionary",
  "textiles apparel & luxury goods": "Consumer Discretionary",
  "leisure products": "Consumer Discretionary",
  "diversified consumer services": "Consumer Discretionary",
  "distributors": "Consumer Discretionary",
  "household durables": "Consumer Discretionary",
  "homebuilding": "Consumer Discretionary",
  "education": "Consumer Discretionary",

  // Consumer Staples
  "consumer products": "Consumer Staples",
  "food products": "Consumer Staples",
  "beverages": "Consumer Staples",
  "tobacco": "Consumer Staples",
  "household products": "Consumer Staples",
  "personal products": "Consumer Staples",
  "food & staples retailing": "Consumer Staples",

  // Energy
  "energy": "Energy",
  "oil & gas": "Energy",
  "oil, gas & consumable fuels": "Energy",
  "energy equipment & services": "Energy",
  "coal": "Energy",

  // Utilities
  "utilities": "Utilities",
  "electric utilities": "Utilities",
  "electrical utilities": "Utilities",
  "gas utilities": "Utilities",
  "water utilities": "Utilities",
  "multi-utilities": "Utilities",
  "renewable energy": "Utilities",
  "independent power and renewable electricity producers": "Utilities",

  // Real Estate
  "real estate": "Real Estate",
  "real estate management & development": "Real Estate",
  "equity real estate investment trusts": "Real Estate",
  "reit": "Real Estate",

  // Materials
  "chemicals": "Materials",
  "metals & mining": "Materials",
  "paper & forest": "Materials",
  "paper & forest products": "Materials",
  "packaging": "Materials",
  "containers & packaging": "Materials",
  // Keys are stored already normalised, which is why this one has no
  // trailing period even though Finnhub sends "Constr. Mat.".
  "constr. mat": "Materials",
  "construction materials": "Materials",
  "steel": "Materials",

  // Industrials
  "aerospace & defense": "Industrials",
  "airlines": "Industrials",
  "building": "Industrials",
  "building products": "Industrials",
  "construction": "Industrials",
  "construction & engineering": "Industrials",
  "commercial services & supplies": "Industrials",
  "professional services": "Industrials",
  "electrical equipment": "Industrials",
  "industrial conglomerates": "Industrials",
  "machinery": "Industrials",
  "marine": "Industrials",
  "road & rail": "Industrials",
  "railroads": "Industrials",
  "trucking": "Industrials",
  "logistics & transportation": "Industrials",
  "air freight & logistics": "Industrials",
  "transportation": "Industrials",
  "transportation infrastructure": "Industrials",
  "trading companies & distributors": "Industrials",
  "waste management": "Industrials",
  "environmental services": "Industrials",
};

/**
 * Ordered fallback for labels the table does not carry. Order matters, because
 * the first match wins: "real estate" has to be tested before the generic
 * finance words, and "oil" before "utilit", so that a natural-gas producer and
 * a gas utility do not collapse into the same bucket.
 */
const KEYWORDS: ReadonlyArray<readonly [string, GicsSector]> = [
  ["real estate", "Real Estate"],
  ["reit", "Real Estate"],
  // Ahead of "technolog", which "Biotechnology Research" also contains and
  // would otherwise file a drug developer under Information Technology.
  ["biotech", "Health Care"],
  ["semiconduct", "Information Technology"],
  ["software", "Information Technology"],
  ["technolog", "Information Technology"],
  ["computer", "Information Technology"],
  ["internet", "Communication Services"],
  ["telecom", "Communication Services"],
  ["media", "Communication Services"],
  ["entertain", "Communication Services"],
  ["pharma", "Health Care"],
  ["health", "Health Care"],
  ["medical", "Health Care"],
  ["bank", "Financials"],
  ["insur", "Financials"],
  ["financ", "Financials"],
  ["capital markets", "Financials"],
  ["mortgage", "Financials"],
  ["oil", "Energy"],
  ["petroleum", "Energy"],
  ["drilling", "Energy"],
  ["coal", "Energy"],
  ["pipeline", "Energy"],
  ["utilit", "Utilities"],
  ["electric power", "Utilities"],
  ["chemical", "Materials"],
  ["mining", "Materials"],
  ["metals", "Materials"],
  ["steel", "Materials"],
  ["packag", "Materials"],
  ["forest", "Materials"],
  ["aerospace", "Industrials"],
  ["defense", "Industrials"],
  ["airline", "Industrials"],
  ["machinery", "Industrials"],
  ["industrial", "Industrials"],
  ["transport", "Industrials"],
  ["logistic", "Industrials"],
  ["freight", "Industrials"],
  ["rail", "Industrials"],
  ["construct", "Industrials"],
  ["engineering", "Industrials"],
  ["waste", "Industrials"],
  ["beverage", "Consumer Staples"],
  ["tobacco", "Consumer Staples"],
  ["food", "Consumer Staples"],
  ["household", "Consumer Staples"],
  ["grocery", "Consumer Staples"],
  ["staples", "Consumer Staples"],
  ["auto", "Consumer Discretionary"],
  ["retail", "Consumer Discretionary"],
  ["apparel", "Consumer Discretionary"],
  ["luxury", "Consumer Discretionary"],
  ["restaurant", "Consumer Discretionary"],
  ["hotel", "Consumer Discretionary"],
  ["leisure", "Consumer Discretionary"],
  ["gaming", "Consumer Discretionary"],
  ["casino", "Consumer Discretionary"],
  ["homebuild", "Consumer Discretionary"],
  ["consumer", "Consumer Discretionary"],
];

/**
 * Lower-cases, collapses whitespace and drops a trailing period, so that
 * "Constr. Mat." and "constr.  mat" reach the same table row.
 */
function normalise(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");
}

/**
 * Classify one provider industry label.
 *
 * Pass null or an empty string for a symbol whose profile came back empty — on
 * Finnhub that is what an ETF looks like, since a fund has no company
 * fundamentals to report. The caller decides whether empty means ETF or
 * genuinely unknown; this function only reports that it could not place it.
 */
export function toSector(industry: string | null | undefined): Sector {
  if (industry === null || industry === undefined) return UNCLASSIFIED;

  const label = normalise(industry);
  if (!label) return UNCLASSIFIED;

  const exact = EXACT[label];
  if (exact) return exact;

  for (const [needle, sector] of KEYWORDS) {
    if (label.includes(needle)) return sector;
  }

  return UNCLASSIFIED;
}

/** True for any bucket that is one of the eleven real GICS sectors. */
export function isGicsSector(value: string): value is GicsSector {
  return (GICS_SECTORS as readonly string[]).includes(value);
}
