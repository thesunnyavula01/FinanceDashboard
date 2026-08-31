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
import { SERIES, axisDate, type Point } from "./series";

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
export default function CurvePlot({ points, live }: { points: Point[]; live: boolean }) {
  const lastIndex = points.length - 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} syncId="equity" margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis dataKey="date" hide />
            <YAxis
              // The price axis sits on the right, where the instrument this is
              // imitating puts it and where the eye is already looking: at the
              // latest value, not the oldest.
              orientation="right"
              width={40}
              // "auto", not the data extremes. Pinning the domain to dataMin
              // and dataMax makes the top and bottom ticks whatever the data
              // happened to reach — 113, 110, 104, 98 — and an index axis that
              // does not count in round numbers is harder to read than one tick
              // of wasted space. Never [0, auto]: that flattens the whole curve
              // against the bottom of the panel.
              domain={["auto", "auto"]}
              tickCount={5}
              allowDecimals={false}
              tickFormatter={(value: number) => value.toFixed(0)}
              tick={{ fill: "var(--color-ink-faint)", fontSize: 10, fontFamily: "var(--font-mono)" }}
              axisLine={false}
              tickLine={false}
            />
            {/* Where every line started. Above it is a gain; below it is not. */}
            <ReferenceLine
              y={100}
              stroke="var(--color-line-hi)"
              strokeDasharray="2 3"
              ifOverflow="extendDomain"
            />
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
                // A benchmark with no bar for a session should not break its
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
        session, above the line when you were ahead. `syncId` gives it the same
        crosshair as the chart above, so the two read as one instrument.
      */}
      <div className="mt-1 h-11 shrink-0 border-t border-line pt-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} syncId="equity" margin={{ top: 0, right: 4, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="date"
              tickFormatter={axisDate}
              tick={{ fill: "var(--color-ink-faint)", fontSize: 10, fontFamily: "var(--font-mono)" }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
              height={14}
            />
            {/* Matches the line chart's axis width so the two share an x-scale. */}
            <YAxis orientation="right" width={40} hide />
            <ReferenceLine y={0} stroke="var(--color-line-hi)" />
            <Bar dataKey="excess" isAnimationActive={false}>
              {points.map((point) => (
                <Cell
                  key={point.date}
                  fill={(point.excess ?? 0) >= 0 ? "var(--color-gain)" : "var(--color-loss)"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-0.5 flex shrink-0 items-center justify-between">
        <span className="label label-ink">Excess return vs SPY, in index points</span>
        {live && <span className="label text-accent-dim">Last point is live</span>}
      </div>
    </div>
  );
}

/**
 * The crosshair readout.
 *
 * It shows the dollar value of the account alongside the indexed figures,
 * because "112.4" is the comparison and "$112,400" is the thing the member
 * actually owns, and the chart is the one place both are worth having at once.
 */
function CurveTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload as Point | undefined;
  if (!point) return null;

  return (
    <div className="border border-line-hi bg-panel px-2 py-1.5">
      <div className="label mb-1">{axisDate(String(label))}</div>
      <div className="num mb-1 text-ink">{money(point.equity)}</div>

      {SERIES.map((series) => {
        const value = point[series.key];
        if (value === null || value === undefined) return null;
        return (
          <div key={series.key} className="flex items-center justify-between gap-4">
            <span className="label" style={{ color: series.color }}>
              {series.label}
            </span>
            <span className={`num ${signColor(value - 100)}`}>{value.toFixed(1)}</span>
          </div>
        );
      })}

      {point.excess !== null && (
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1">
          <span className="label label-ink">vs SPY</span>
          <span className={`num ${signColor(point.excess)}`}>
            {moneySigned(point.excess.toFixed(1))}
          </span>
        </div>
      )}
    </div>
  );
}
