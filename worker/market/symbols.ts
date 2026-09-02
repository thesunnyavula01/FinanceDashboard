/**
 * What kind of thing is this ticker?
 *
 * Three asset classes share one `positions` table, one `trades` table and one
 * `place_order()`. Nothing in the database says which class a row belongs to,
 * and nothing needs to: the symbol itself is the discriminator, and this file
 * is the only place that reads it.
 *
 * That is a deliberate choice over an `asset_class` column. A column would have
 * to be written correctly at every insert, backfilled for every existing row,
 * kept consistent by the replay in `rebuild_portfolio()`, and added to the
 * uniqueness key before it earned its keep — and it would still be derivable
 * from the symbol. A total function is cheaper and cannot drift.
 *
 * Collision is impossible rather than merely unlikely:
 *
 *   - Alpaca writes class shares with a dot (`BRK.B`), never a slash, so a
 *     slash means a crypto pair and nothing else.
 *   - The OCC form ends in fifteen fixed characters — six date digits, C or P,
 *     eight strike digits. No listed ticker has that shape.
 *
 * Alpaca's OCC symbols do NOT pad the root to six characters the way the raw
 * OCC standard does, so the root is variable-length and everything here parses
 * from the right. Pinned by `symbols.test.ts`.
 */

export const ASSET_CLASSES = ["EQUITY", "CRYPTO", "OPTION"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** Shares per option contract. The one number that makes options not stocks. */
export const OPTION_MULTIPLIER = 100;

/**
 * `YYMMDD` + `C`|`P` + strike x 1000 padded to 8. Fixed width, which is what
 * lets the root be whatever length it likes.
 */
const CONTRACT_TAIL = 15;

/** Equities, and the shape three other files validate against. */
export const EQUITY_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** `BTC/USD`. A base can carry digits; the quote currency never does. */
export const CRYPTO_SYMBOL = /^[A-Z0-9]{1,10}\/[A-Z]{2,6}$/;
/** `AAPL260116C00150000`. */
export const OPTION_SYMBOL = /^[A-Z][A-Z0-9]{0,5}\d{6}[CP]\d{8}$/;

export interface OptionContract {
  /** The full OCC symbol, as stored. */
  symbol: string;
  /** `AAPL`. Not necessarily a tradable equity ticker — `BRKB` has no dot. */
  underlying: string;
  /** `YYYY-MM-DD`, in exchange-local terms. */
  expiration: string;
  type: "CALL" | "PUT";
  strike: number;
}

/** Upper-cased and trimmed. Every function here takes raw input. */
export function normalise(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Which class a symbol belongs to. Total: anything unrecognisable is an equity
 * ticker, because that is the class whose validity is decided elsewhere — by
 * the tradable universe — rather than by shape.
 */
export function classify(symbol: string): AssetClass {
  const raw = normalise(symbol);
  if (raw.includes("/")) return "CRYPTO";
  if (parseContract(raw)) return "OPTION";
  return "EQUITY";
}

/**
 * Split an OCC symbol into its parts, or `null` if it is not one.
 *
 * Parses from the right because the root is variable-length. A malformed date
 * (month 13, February 31st) is rejected rather than carried forward — an expiry
 * that does not exist would settle on a day that never comes.
 */
export function parseContract(symbol: string): OptionContract | null {
  const raw = normalise(symbol);
  // At least one root character has to survive the fixed tail.
  if (raw.length <= CONTRACT_TAIL) return null;

  const root = raw.slice(0, raw.length - CONTRACT_TAIL);
  const tail = raw.slice(raw.length - CONTRACT_TAIL);

  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(root)) return null;

  const parts = /^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(tail);
  if (!parts) return null;

  const yy = parts[1] as string;
  const mm = parts[2] as string;
  const dd = parts[3] as string;
  const kind = parts[4] as string;
  const strikeDigits = parts[5] as string;

  // OCC has been two-digit since 1973 and rolls at 2000. A contract dated "73"
  // would be 2073 — wrong by a century, and also not tradable, so the simple
  // window is the honest one.
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);

  // Round-trip through UTC to reject dates that pass a range check but do not
  // exist. `Date` silently rolls February 31st forward into March.
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }

  const strike = Number(strikeDigits) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;

  return {
    symbol: raw,
    underlying: root,
    expiration: `${year}-${mm}-${dd}`,
    type: kind === "C" ? "CALL" : "PUT",
    strike,
  };
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/**
 * `AAPL260116C00150000` -> `AAPL 16JAN26 150C`.
 *
 * The stored symbol is what settles money and what the API takes, so it is
 * never rewritten — but nobody reads twenty characters of zero-padded strike in
 * a grid. Anything that is not a contract comes back unchanged, so callers can
 * run every symbol through this with no branch.
 */
export function formatContract(symbol: string): string {
  const contract = parseContract(symbol);
  if (!contract) return normalise(symbol);

  const mm = contract.expiration.slice(5, 7);
  const dd = contract.expiration.slice(8, 10);
  const month = MONTHS[Number(mm) - 1] ?? mm;
  const yy = contract.expiration.slice(2, 4);
  const letter = contract.type === "CALL" ? "C" : "P";

  return `${contract.underlying} ${dd}${month}${yy} ${trimStrike(contract.strike)}${letter}`;
}

/** 150 -> "150", 152.5 -> "152.5". Strikes carry 3dp at most. */
function trimStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : String(Number(strike.toFixed(3)));
}

/**
 * The equity ticker an option is written on, or `null` for anything else.
 *
 * Callers asking "whose profile describes this position" want
 * `underlyingOf(symbol) ?? symbol`: an AAPL call belongs in the same sector
 * bucket as AAPL, and that `securities` row is already there.
 */
export function underlyingOf(symbol: string): string | null {
  return parseContract(symbol)?.underlying ?? null;
}

/** `BTC/USD` -> `BTC`. `null` for anything that is not a pair. */
export function cryptoBase(symbol: string): string | null {
  const raw = normalise(symbol);
  if (!CRYPTO_SYMBOL.test(raw)) return null;
  return raw.slice(0, raw.indexOf("/"));
}

/**
 * Shares per unit. 100 for an option, 1 for everything else — which is why the
 * `multiplier` column defaults to 1 and every pre-existing row is already
 * correct without a backfill.
 */
export function multiplierFor(symbol: string): number {
  return classify(symbol) === "OPTION" ? OPTION_MULTIPLIER : 1;
}

/**
 * Could this string name something tradable? Shape only — whether it actually
 * exists is the universe's question, and for an option the chain's.
 */
export function isTradableSymbol(symbol: string): boolean {
  const raw = normalise(symbol);
  switch (classify(raw)) {
    case "CRYPTO":
      return CRYPTO_SYMBOL.test(raw);
    case "OPTION":
      return OPTION_SYMBOL.test(raw);
    default:
      return EQUITY_SYMBOL.test(raw);
  }
}

/**
 * Can a member go short this class?
 *
 * Only equities. An option is long-only because the flat Reg T multiplier is
 * not a margin model for a naked short call — it would hold about $3 against a
 * $2 premium carrying unlimited risk. Crypto is long-only because there is no
 * borrow and no locate to model. Both are the same call the codebase already
 * made about forced liquidation: refuse what needs machinery that does not
 * exist, rather than approximate it.
 */
export function allowsShort(symbol: string): boolean {
  return classify(symbol) === "EQUITY";
}

/** Crypto never closes. Everything else defers to the exchange calendar. */
export function tradesAroundTheClock(symbol: string): boolean {
  return classify(symbol) === "CRYPTO";
}
