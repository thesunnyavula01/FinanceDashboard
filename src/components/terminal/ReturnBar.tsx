import { percent } from "@/lib/format";

/**
 * The spread.
 *
 * Every member's return drawn on one shared axis, with the market marked on it
 * as a hairline. A column of numbers tells you your return; this tells you
 * where you sit in the club and which side of SPY the whole room is on, which
 * is the question a leaderboard exists to answer and the one a sorted list of
 * percentages makes you compute in your head.
 *
 * The colour rule is the app's: green and red mean gain and loss and nothing
 * else, so the bar carries the sign. Amber is the interface and never a number,
 * so the benchmark is drawn in grey — it is the ruler, not a result.
 */

export interface ReturnScale {
  min: number;
  max: number;
  /** Where 0% sits, as a percentage of the track's width. */
  zero: number;
}

/**
 * The narrowest axis a bar is ever drawn on, in percentage points. Below this
 * the scale stops zooming in, so a club that has barely moved draws short bars
 * rather than loud ones.
 */
const MIN_SPAN = 2;

/**
 * The axis every row shares.
 *
 * Zero is always inside the domain, so the origin is visible even when the
 * whole club is up — a bar that starts off-screen has no length to read. The
 * domain is padded slightly, or a club with one member would draw a bar that
 * fills the track exactly and tells you nothing.
 */
export function returnScale(values: number[], ...marks: (number | null)[]): ReturnScale {
  const points = [0, ...values, ...marks.filter((mark): mark is number => mark !== null)];

  let low = Math.min(...points);
  let high = Math.max(...points);

  // A floor on the domain keeps a club that has barely traded from drawing wild
  // bars off a 0.01% spread. It has to widen the domain itself and not just the
  // padding: a season two days old whose only member is down 0.26% would
  // otherwise get a 0.58-point-wide axis and a bar across half the track, which
  // reads as a catastrophe rather than as noise. The widening is symmetric, and
  // 0 is already one of the points, so the origin stays inside the domain.
  const short = MIN_SPAN - (high - low);
  if (short > 0) {
    low -= short / 2;
    high += short / 2;
  }

  const pad = (high - low) * 0.08;

  const min = low - pad;
  const max = high + pad;

  return { min, max, zero: position(0, { min, max }) };
}

/** Where a value sits on the track, 0-100. */
function position(value: number, scale: Pick<ReturnScale, "min" | "max">): number {
  const span = scale.max - scale.min || 1;
  return Math.min(100, Math.max(0, ((value - scale.min) / span) * 100));
}

interface ReturnBarProps {
  value: number;
  scale: ReturnScale;
  /** The benchmark's return, drawn as a hairline in the same coordinates. */
  benchmark: number | null;
  /** This row is the signed-in member. Draws the bar a shade brighter. */
  isMe?: boolean;
}

export function ReturnBar({ value, scale, benchmark, isMe = false }: ReturnBarProps) {
  const at = position(value, scale);
  const from = Math.min(at, scale.zero);
  const width = Math.abs(at - scale.zero);

  return (
    <div
      className="relative h-2.5 w-full bg-panel-hi"
      role="img"
      aria-label={`${percent(value)}${
        benchmark === null ? "" : `, against the market at ${percent(benchmark)}`
      }`}
    >
      {/*
        inset-0 rather than a shrink-to-fit box: the percentages below have to
        measure the whole track, not a width derived from themselves.
      */}
      <div className="absolute inset-0">
        <span
          className={`absolute inset-y-0 ${value < 0 ? "bg-loss" : "bg-gain"} ${
            isMe ? "" : "opacity-70"
          }`}
          style={{ left: `${from}%`, width: `${Math.max(width, 0.4)}%` }}
        />
      </div>

      {/* Zero. Always drawn, so a bar's direction is readable without the axis. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-px bg-line-hi"
        style={{ left: `${scale.zero}%` }}
      />

      {/* The market. Grey, because a benchmark is the ruler and not a result. */}
      {benchmark !== null && (
        <span
          aria-hidden="true"
          className="absolute -inset-y-0.5 w-px bg-ink-faint"
          style={{ left: `${position(benchmark, scale)}%` }}
        />
      )}
    </div>
  );
}
