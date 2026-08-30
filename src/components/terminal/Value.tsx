import { useEffect, useRef, useState } from "react";
import { signColor, type Numeric } from "@/lib/format";

interface ValueProps {
  /** Pre-formatted text to display. */
  children: string;
  /**
   * The underlying number. Drives the colour when `colorBySign` is set, and
   * drives the tick flash when it changes between renders.
   */
  value?: Numeric | null;
  colorBySign?: boolean;
  /** Flash the cell when `value` changes. Off by default; on for live prices. */
  flash?: boolean;
  dim?: boolean;
  className?: string;
}

/**
 * A number on the terminal.
 *
 * The flash is the app's only ambient motion: when a live price updates, the
 * cell washes green or red for 600ms. That is how a trader's eye finds the row
 * that moved without reading every line — it encodes change, so it earns the
 * animation. Disabled under prefers-reduced-motion via CSS.
 */
export function Value({
  children,
  value,
  colorBySign = false,
  flash = false,
  dim = false,
  className = "",
}: ValueProps) {
  const [tick, setTick] = useState<"gain" | "loss" | null>(null);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    if (!flash || value === null || value === undefined) return;
    const next = typeof value === "number" ? value : Number.parseFloat(value);
    if (!Number.isFinite(next)) return;

    const prev = previous.current;
    previous.current = next;
    if (prev === null || prev === next) return;

    setTick(next > prev ? "gain" : "loss");
    const timer = setTimeout(() => setTick(null), 600);
    return () => clearTimeout(timer);
  }, [value, flash]);

  const color = colorBySign ? signColor(value) : dim ? "text-ink-dim" : "text-ink";
  const tickClass = tick === "gain" ? "tick-gain" : tick === "loss" ? "tick-loss" : "";

  return <span className={`num ${color} ${tickClass} ${className}`}>{children}</span>;
}
