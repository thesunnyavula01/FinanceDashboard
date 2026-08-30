/**
 * Display formatting.
 *
 * Money arrives from the API as a string (Postgres `numeric`) to survive the
 * trip without float rounding. Parse it here, at the edge, purely to draw it.
 * Never sum formatted values, and never accumulate a portfolio total in JS —
 * that is the database's job.
 */

/** Postgres numeric columns come over the wire as strings. */
export type Numeric = string | number;

export function toNumber(value: Numeric | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

const money2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 127431.09 -> "127,431.09". No currency symbol; the column header says USD. */
export function money(value: Numeric | null | undefined): string {
  return money2.format(toNumber(value));
}

/** 9912.44 -> "+9,912.44"; -262.80 -> "-262.80". Used for every P/L figure. */
export function moneySigned(value: Numeric | null | undefined): string {
  const n = toNumber(value);
  return `${n > 0 ? "+" : ""}${money2.format(n)}`;
}

/** 8.4237 -> "+8.42%". Input is already a percentage, not a ratio. */
export function percent(value: Numeric | null | undefined, digits = 2): string {
  const n = toNumber(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** Unsigned percentage, for weights and allocations. */
export function weight(value: Numeric | null | undefined, digits = 1): string {
  return `${toNumber(value).toFixed(digits)}%`;
}

/**
 * Share counts. Fractional shares are stored to 6dp, but a member who owns
 * exactly 40 shares should see "40", not "40.000000".
 */
export function shares(value: Numeric | null | undefined): string {
  const n = toNumber(value);
  const abs = Math.abs(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return abs < 1 ? n.toFixed(6).replace(/0+$/, "") : n.toFixed(4).replace(/0+$/, "");
}

/** Large figures on the stat strip: 127431.09 -> "127.4K". */
export function compact(value: Numeric | null | undefined): string {
  const n = toNumber(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return money2.format(n);
}

/**
 * Which direction a number points. Returns null at exactly zero so a flat
 * position renders in neutral ink rather than claiming a gain.
 */
export function direction(value: Numeric | null | undefined): "gain" | "loss" | null {
  const n = toNumber(value);
  if (n > 0) return "gain";
  if (n < 0) return "loss";
  return null;
}

/** Tailwind text colour for a signed value. */
export function signColor(value: Numeric | null | undefined): string {
  const d = direction(value);
  if (d === "gain") return "text-gain";
  if (d === "loss") return "text-loss";
  return "text-ink-dim";
}

const timeET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Market time. The exchange runs on New York time, so the terminal does too. */
export function clockET(date: Date = new Date()): string {
  return timeET.format(date);
}

/** Seconds -> "03:41:12", for the countdown to the next open or close. */
export function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}
