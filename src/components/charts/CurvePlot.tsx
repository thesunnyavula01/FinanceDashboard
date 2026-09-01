import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { money, moneySigned, signColor } from "@/lib/format";
import { SERIES, type Point } from "./series";

/**
 * How much precision the price axis needs, from how far the chart travels.
 *
 * A season that runs from $100,000 to $126,000 wants "100K / 113K / 126K": the
 * cents are noise and the K keeps the axis narrow. A single session that moves
 * $180 on the same account wants "100,240", because at one decimal of a
 * thousand every tick on that chart reads "100.2K" and the axis stops saying
 * anything at all. Recharts hands the formatter a value and not a domain, so
 * the span is measured here, once, from the data the chart was given.
 */
function axisMoney(points: Point[], base: number | null): (value: number) => string {
  let low = base ?? Number.POSITIVE_INFINITY;
  let high = base ?? Number.NEGATIVE_INFINITY;

  for (const point of points) {
    for (const value of [point.me, point.spy, point.qqq, point.club]) {
      if (value === null || value === undefined) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }

  const span = Number.isFinite(high - low) ? high - low : 0;

  if (span >= 20_000) return (value) => `${Math.round(value / 1000)}K`;
  if (span >= 2_000) return (value) => `${(value / 1000).toFixed(1)}K`;
  return (value) => Math.round(value).toLocaleString("en-US");
}

/**
 * The plot itself. Loaded on demand.
 *
 * Recharts is roughly two-thirds of this app's JavaScript, and the login screen
 * has no chart on it. Splitting the plot out of the panel means the sign-in
 * page, the order ticket and the positions grid never pay for it: the panel,
 * its range toggles and its legend render immediately from the main bundle and
 * the plot area fills in behind them. See EquityCurve.tsx for the Suspense
 * boundary.
 *
 * Nothing here animates. The terminal's one piece of motion is the tick flash
 * on a price that changed, and a line that draws itself on every range toggle
 * would be decoration competing with it.
 */
export default function CurvePlot({
  points,
  base,
  live,
}: {
  points: Point[];
  /** The dollar baseline every line starts from. Drawn as the dashed rule. */
  base: number | null;
  live: boolean;
}) {
  const lastIndex = points.length - 1;
  const tick = axisMoney(points, base);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} syncId="equity" margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis dataKey="label" hide />
            <YAxis
              // The price axis sits on the right, where the instrument this is
              // imitating puts it and where the eye is already looking: at the
              // latest value, not the oldest.
              orientation="right"
              width={46}
              // "auto", not the data extremes. Pinning the domain to dataMin
              // and dataMax makes the top and bottom ticks whatever the data
              // happened to reach, and an axis that does not count in round
              // numbers is harder to read than one tick of wasted space. Never
              // [0, auto]: a $100,000 account moving $2,000 in a week would be
              // a flat line pinned to the top of the panel, which is the exact
              // opposite of what a member is looking for.
              domain={["auto", "auto"]}
              tickCount={5}
              tickFormatter={tick}
              tick={{ fill: "var(--color-ink-faint)", fontSize: 10, fontFamily: "var(--font-mono)" }}
              axisLine={false}
              tickLine={false}
            />
            {/*
              Where the money started. On 1D that is yesterday's close, on every
              other range it is the left edge of the window — either way, above
              this line is a gain and below it is not, which is the one thing
              this chart has to make unmissable.
            */}
            {base !== null && (
              <ReferenceLine
                y={base}
                stroke="var(--color-line-hi)"
                strokeDasharray="2 3"
                ifOverflow="extendDomain"
              />
            )}
            <Tooltip content={CurveTooltip} cursor={{ stroke: "var(--color-accent-dim)" }} />

            {SERIES.map((series) => (
              <Line
                key={series.key}
                type="linear"
                dataKey={series.key}
                name={series.label}
                stroke={series.color}
                strokeWidth={series.width}
                strokeDasharray={series.dash}
                dot={
                  // One dot, on the last point of your own line: you are here.
                  series.key === "me"
                    ? (props: { cx?: number; cy?: number; index?: number }) =>
                        props.index === lastIndex && props.cx !== undefined ? (
                          <circle
                            key="head"
                            cx={props.cx}
                            cy={props.cy}
                            r={2.5}
                            fill="var(--color-accent)"
                          />
                        ) : (
                          <g key={`empty-${props.index}`} />
                        )
                    : false
                }
                activeDot={{ r: 2.5, strokeWidth: 0 }}
                // A benchmark with no bar for a bucket should not break its
                // line in half; the gap is missing data, not a missing market.
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/*
        The excess-return strip. Four overlapping lines answer "am I beating the
        market?" only once you trace them; this answers it directly, one bar per
        point, above the line when you were ahead. In dollars, because both
        lines are: it is the money you are up on the index, not an abstract
        index-point spread. `syncId` gives it the same crosshair as the chart
        above, so the two read as one instrument.
      */}
      <div className="mt-1 h-11 shrink-0 border-t border-line pt-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} syncId="equity" margin={{ top: 0, right: 4, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--color-ink-faint)", fontSize: 10, fontFamily: "var(--font-mono)" }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
              height={14}
            />
            {/* Matches the line chart's axis width so the two share an x-scale. */}
            <YAxis orientation="right" width={46} hide />
            <ReferenceLine y={0} stroke="var(--color-line-hi)" />
            <Bar dataKey="excess" isAnimationActive={false}>
              {points.map((point) => (
                <Cell
                  key={point.t}
                  fill={(point.excess ?? 0) >= 0 ? "var(--color-gain)" : "var(--color-loss)"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-0.5 flex shrink-0 items-center justify-between">
        <span className="label label-ink">Ahead of SPY, in dollars</span>
        {live && <span className="label text-accent-dim">Last point is live</span>}
      </div>
    </div>
  );
}

/**
 * The crosshair readout.
 *
 * Everything on it is money, because everything on the chart is: "$104,820" is
 * what the member owns and "$102,140" is what the same money would have been
 * worth in SPY, and the difference between those two numbers is the entire
 * point of drawing them together.
 */
function CurveTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload as Point | undefined;
  if (!point) return null;

  return (
    <div className="border border-line-hi bg-panel px-2 py-1.5">
      <div className="label mb-1">{String(label)}</div>

      {SERIES.map((series) => {
        const value = point[series.key];
        if (value === null || value === undefined) return null;
        return (
          <div key={series.key} className="flex items-center justify-between gap-4">
            <span className="label" style={{ color: series.color }}>
              {series.label}
            </span>
            <span className="num text-ink">{money(value)}</span>
          </div>
        );
      })}

      {point.excess !== null && (
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1">
          <span className="label label-ink">vs SPY</span>
          <span className={`num ${signColor(point.excess)}`}>{moneySigned(point.excess)}</span>
        </div>
      )}
    </div>
  );
}
