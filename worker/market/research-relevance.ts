import { companyKeyword, cryptoResearchName, stripMarkup } from "./research-utils.ts";
import { classify, normalise, underlyingOf } from "./symbols.ts";

// A provider tagging an article with ALL, ON or LINK does not make those
// ordinary words in its headline a ticker. Explicit financial notation still
// works for every symbol, including one-letter and class-share tickers.
const WORD_TICKERS = new Set([
  "AI", "ALL", "ARE", "ARM", "BILL", "CAN", "CAR", "CAT", "COLD", "COST",
  "DAY", "DNA", "EAT", "FAST", "FIX", "FOR", "FUN", "GAP", "HAS", "HEAR",
  "HOME", "HOPE", "JOB", "JOBS", "LIFE", "LIVE", "LOVE", "LOW", "MAIN", "MAN",
  "META", "MORE", "NAME", "NEW", "NEXT", "NOW", "ONE", "OPEN", "OUT", "PATH",
  "PLAY", "POST", "RUN", "SAFE", "SAVE", "SEE", "SHOP", "SO", "SPOT", "STEP",
  "TALK", "TEAM", "TELL", "TRUE", "TWO", "YOU", "LINK", "DOT", "NEAR", "UNI",
]);
const COIN_CONTEXT = /\b(?:crypto(?:currency)?|blockchain|tokens?|coins?|defi|staking|mainnet|wallets?)\b/i;
const AMBIGUOUS_COIN_NAMES = new Set(["avalanche", "chainlink", "near", "internet computer", "maker"]);
const COMPANY_CONTEXT = /\b(?:stocks?|shares?|earnings|revenue|profits?|investors?|dividends?|nasdaq|nyse|ceo|inc|corp|company)\b/i;
const AMBIGUOUS_COMPANY_NAMES = new Set(["apple", "gap", "meta", "target", "block", "unity"]);
const COMPANY_PRODUCTS = /\b(?:iphone|ipad|macbook|imac|ios|app store|facebook|instagram|whatsapp|retailer|retail|stores?|shopping|payments?)\b/i;

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Require the whole company phrase; never turn "Bank of America" into "Bank". */
function companyName(name: string | null): string {
  return companyKeyword(stripMarkup(name)
    .replace(/\s+(?:class\s+[a-z](?:\s+common\s+stock)?|common\s+stock|ordinary\s+shares).*$/i, "")
    .replace(/,\s*/g, " "))
    .replace(/\.com$/i, "").trim();
}

/**
 * Upstream search finds candidates, not proof that the story is about an asset.
 * Finnhub has returned an Amazon-only headline with `related: TSLA`. Require
 * the subject in the visible title, across both tiers and on every cache read.
 * A CEO name, product, summary aside or provider tag alone is not sufficient.
 * This deliberately prefers fewer relevant rows to a full panel of guesses.
 */
export function researchMatcher(rawSymbol: string, name: string | null): (headline: string) => boolean {
  const symbol = underlyingOf(rawSymbol) ?? normalise(rawSymbol);
  const crypto = classify(symbol) === "CRYPTO";
  const ticker = crypto ? symbol.split("/")[0]! : symbol;
  const tickerPattern = escape(ticker);
  const boundary = "[\\p{L}\\p{N}_]";
  // Parentheses alone do not identify a stock: "artificial intelligence (AI)"
  // and "information technology (IT)" are common unrelated headline text.
  const explicit = new RegExp(`(?:\\$${tickerPattern}(?!${boundary})|\\b(?:NASDAQ|NYSE|AMEX|NYSEARCA)\\s*:\\s*${tickerPattern}(?!${boundary}))`, "iu");
  const bare = ticker.length >= 3 && !WORD_TICKERS.has(ticker)
    ? new RegExp(`(?<!${boundary})${tickerPattern}(?!${boundary})`, "u") : null;
  const entity = crypto ? cryptoResearchName(symbol, name) : companyName(name);
  const normalizedEntity = entity.toLowerCase();
  const ambiguousCompany = !crypto && AMBIGUOUS_COMPANY_NAMES.has(normalizedEntity);
  // A missing profile must not turn its raw ticker back into a case-insensitive name.
  const usableName = entity.length >= 3 && entity.toUpperCase() !== ticker && entity !== symbol;
  const fork = crypto && ticker === "BTC" ? "(?!\\s+(?:cash|sv|gold)\\b)"
    : crypto && ticker === "ETH" ? "(?!\\s+(?:classic|pow)\\b)" : "";
  const named = usableName
    ? new RegExp(`(?<!${boundary})${entity.split(/\s+/).map(escape).join("\\s+")}(?!${boundary})${fork}`, "iu") : null;
  const properCompany = ambiguousCompany
    ? new RegExp(`(?<!${boundary})(?:${escape(normalizedEntity[0]!.toUpperCase() + normalizedEntity.slice(1))}|${escape(normalizedEntity.toUpperCase())})(?!${boundary})`, "u") : null;

  return (headline) => {
    const title = stripMarkup(headline);
    if (explicit.test(title) || bare?.test(title)) return true;
    if (!named?.test(title)) return false;
    if (crypto && AMBIGUOUS_COIN_NAMES.has(normalizedEntity)) return COIN_CONTEXT.test(title);
    if (ambiguousCompany) {
      return properCompany!.test(title) && (COMPANY_CONTEXT.test(title) || COMPANY_PRODUCTS.test(title));
    }
    return true;
  };
}
