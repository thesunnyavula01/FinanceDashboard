/**
 * The symbol classifier, browser side.
 *
 * A mirror of worker/market/symbols.ts, which is the authority. It exists for
 * the same reason src/lib/portfolio.ts mirrors the order engine: tsconfig.app
 * includes only `src`, so the Worker's copy cannot be imported here, and the
 * ticket has to know what a member is looking at before it asks the server.
 *
 * The duplication is one-directional. Nothing here decides anything — the
 * Worker classifies every order again, and `place_order()` refuses a short on a
 * contract whatever this file believes. This only shapes what the screen
 * offers.
 */

export const ASSET_CLASSES = ["EQUITY", "OPTION", "CRYPTO"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const OPTION_MULTIPLIER = 100;

/** `YYMMDD` + `C`|`P` + strike x 1000 padded to 8. */
const CONTRACT_TAIL = 15;

export const EQUITY_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const CRYPTO_SYMBOL = /^[A-Z0-9]{1,10}\/[A-Z]{2,6}$/;
const OPTION_SYMBOL = /^[A-Z][A-Z0-9]{0,5}\d{6}[CP]\d{8}$/;

export interface OptionContract {
  symbol: string;
  underlying: string;
  expiration: string;
  type: "CALL" | "PUT";
  strike: number;
}

export function normalise(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** A slash is a pair; a fifteen-character OCC tail is a contract. */
export function classify(symbol: string): AssetClass {
  const raw = normalise(symbol);
  if (raw.includes("/")) return "CRYPTO";
  if (parseContract(raw)) return "OPTION";
  return "EQUITY";
}

/** Parsed from the right, because Alpaca does not pad the root. */
export function parseContract(symbol: string): OptionContract | null {
  const raw = normalise(symbol);
  if (raw.length <= CONTRACT_TAIL) return null;

  const root = raw.slice(0, raw.length - CONTRACT_TAIL);
  const tail = raw.slice(raw.length - CONTRACT_TAIL);
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(root)) return null;

  const parts = /^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(tail);
  if (!parts) return null;

  const year = 2000 + Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);

  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }

  const strike = Number(parts[5]) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;

  return {
    symbol: raw,
    underlying: root,
    expiration: `${year}-${parts[2]}-${parts[3]}`,
    type: parts[4] === "C" ? "CALL" : "PUT",
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
 * Every grid in the app runs its symbols through this. Twenty characters of
 * zero-padded strike is what the API takes and what settles money; it is not
 * what anyone reads a position off. Non-contracts pass through unchanged, so
 * callers need no branch.
 */
export function formatContract(symbol: string): string {
  const contract = parseContract(symbol);
  if (!contract) return normalise(symbol);

  const mm = contract.expiration.slice(5, 7);
  const dd = contract.expiration.slice(8, 10);
  const month = MONTHS[Number(mm) - 1] ?? mm;
  const yy = contract.expiration.slice(2, 4);
  const strike = Number.isInteger(contract.strike)
    ? String(contract.strike)
    : String(Number(contract.strike.toFixed(3)));

  return `${contract.underlying} ${dd}${month}${yy} ${strike}${contract.type === "CALL" ? "C" : "P"}`;
}

/**
 * The ticker whose `securities` row describes this position.
 *
 * An AAPL call belongs in the same sector as AAPL. Callers want
 * `underlyingOf(symbol) ?? symbol`.
 */
export function underlyingOf(symbol: string): string | null {
  return parseContract(symbol)?.underlying ?? null;
}

export function multiplierFor(symbol: string): number {
  return classify(symbol) === "OPTION" ? OPTION_MULTIPLIER : 1;
}

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

/** Only equities. An option has no margin model here; a coin has no borrow. */
export function allowsShort(symbol: string): boolean {
  return classify(symbol) === "EQUITY";
}

export function tradesAroundTheClock(symbol: string): boolean {
  return classify(symbol) === "CRYPTO";
}

/** What each class calls the thing you type into the ticker field. */
export const CLASS_COPY: Record<
  AssetClass,
  { field: string; unit: string; units: string; placeholder: string }
> = {
  EQUITY: { field: "Ticker", unit: "share", units: "Shares", placeholder: "AAPL" },
  OPTION: { field: "Underlying", unit: "contract", units: "Contracts", placeholder: "AAPL" },
  CRYPTO: { field: "Pair", unit: "unit", units: "Units", placeholder: "BTC/USD" },
};
