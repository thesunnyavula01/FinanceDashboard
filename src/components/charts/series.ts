import type { CurveRow } from "@/lib/api";

/**
 * What the equity curve draws, shared by the panel and the plot.
 *
 * These live apart from both because the panel ships in the main bundle and the
 * plot does not — see CurvePlot.tsx. The legend has to name and colour the
 * lines before the charting library has finished loading, so the definition
 * cannot sit inside the chunk that is still in flight.
 *
 * The colours are the terminal's, used the way the terminal uses them. Amber is
 * the interface everywhere else in this app and never a number, so here it
 * marks the one line that is *you* — identity, not performance. The benchmarks
 * are greys: they are the ruler, and a ruler should not shout. Green and red
 * stay reserved for P/L, which on this chart means the change at the top of the
 * panel and the excess-return strip, and nothing else.
 */
export const SERIES = [
  { key: "me", label: "You", color: "var(--color-accent)", width: 1.75, dash: undefined },
  { key: "spy", label: "SPY", color: "var(--color-ink)", width: 1, dash: undefined },
  { key: "qqq", label: "QQQ", color: "var(--color-ink-faint)", width: 1, dash: undefined },
  { key: "club", label: "Club", color: "var(--color-accent-dim)", width: 1, dash: "3 3" },
] as const;

export interface Point extends CurveRow {
  /**
   * Your account less what the same money would be worth in SPY, in dollars.
   * The whole reason the bottom strip exists, and the one number on this screen
   * that answers "am I beating the market" without tracing two lines.
   */
  excess: number | null;
}

/** "2026-08-30" -> "08/30", without constructing a Date and inviting a timezone. */
export function axisDate(date: string): string {
  return date.slice(5).replace("-", "/");
}
