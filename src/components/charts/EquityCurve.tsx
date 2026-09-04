import { Suspense, lazy, useMemo, type ReactNode } from "react";
import { CURVE_RANGES, type CurveRange, type HistoryResponse } from "@/lib/api";
import { money, moneySigned, percent, signColor } from "@/lib/format";
import { Panel } from "@/components/terminal/Panel";
import { SERIES, axisDate, type Point } from "./series";

/**
 * The equity curve.
 *
 * Four lines on one axis of dollars: the account as it is, and SPY, QQQ and the
 * club average each drawn as what the same money would have been worth had it
 * gone there instead. That is the question a member is actually asking — not
 * "how did the index do" but "would I have been better off in the index" — and
 * in dollars it is answerable by looking, because the vertical gap between two
 * lines *is* the amount.
 *
 * The baseline is the range start, not the season start, so switching to 1W
 * answers "how did this week go against the market" instead of redrawing the
 * same January comparison at a different zoom. The panel says which date the
 * lines start from, because a rescaled chart with an unstated baseline is a
 * chart you cannot check.
 *
 * **1D is a different chart wearing the same panel.** One session at
 * five-minute resolution, measured against the previous session's close rather
 * than against the first point on screen — so the account can be down on the
 * day while up since the bell, which is the truth and is what the day P/L on
 * the positions grid says too. The club average has no intraday figure and is
 * dimmed rather than dropped.
 *
 * Everything except the plot itself lives in the main bundle: the panel, the
 * range toggles, the legend and the summary all render on the first frame, and
 * the charting library streams in behind them. See CurvePlot.tsx.
 */

const CurvePlot = lazy(() => import("./CurvePlot"));

export function EquityCurve({
  history,
  range,
  onRangeChange,
  isLoading,
  isError,
}: {
  history: HistoryResponse | null;
  range: CurveRange;
  onRangeChange: (range: CurveRange) => void;
  isLoading: boolean;
  isError: boolean;
}) {
  const points = useMemo<Point[]>(
    () =>
      (history?.rows ?? []).map((row) => ({
        ...row,
        excess: row.spy === null ? null : row.me - row.spy,
      })),
    [history],
  );

  const hasClub = points.some((point) => point.club !== null);
  const last = points.at(-1);

  return (
    /*
      The floor, not a preference. A plot has no intrinsic height — Recharts
      measures its container — so in an auto-height row, which is what F1
      becomes below `md`, the panel would size to its own chrome and the chart
      would resolve to nothing. 19rem is the same height the desktop grid row
      already guarantees, so this changes only the stacked case, and it is
      what the toggles, the legend, the excess strip and the caption need
      before there is a line left to draw.
    */
    <Panel title="Performance" meta={<Headline history={history} />} className="min-h-[19rem]">
      <div className="flex h-full min-h-0 flex-col gap-1.5">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <RangeToggle range={range} onChange={onRangeChange} />
          <Legend hasClub={hasClub} clubNote={history?.clubNote ?? null} />
        </div>

        {isError ? (
          <Message>The curve is unavailable right now. It comes back on the next refresh.</Message>
        ) : isLoading && points.length === 0 ? (
          <Message pulse>Building your curve</Message>
        ) : history?.note ? (
          <Message>{history.note}</Message>
        ) : points.length < 2 ? (
          <Message>
            {history?.intraday
              ? "The session has only just opened. The line fills in every five minutes."
              : "One session so far. The curve fills in as the season does — check back tomorrow."}
          </Message>
        ) : (
          <Suspense fallback={<Message pulse>Drawing</Message>}>
            <CurvePlot
              points={points}
              base={history?.base ?? null}
              live={history?.live ?? false}
            />
          </Suspense>
        )}

        <Caption history={history} last={last} />
      </div>
    </Panel>
  );
}

/**
 * The number a member came to the screen for.
 *
 * What the account is worth, what it has made or lost over the range, and what
 * that is as a percentage — in that order, because the dollar figure is the one
 * that means something to a member and the percentage is the one that compares.
 * Green and red are earned here: this is a result, not an interface.
 */
function Headline({ history }: { history: HistoryResponse | null }) {
  if (!history || history.rows.length === 0) return null;

  const { value, change, summary, baseDate, intraday } = history;

  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      {value !== null && <span className="num text-ink">{money(value)}</span>}
      {change !== null && (
        <span className={`num ${signColor(change)}`}>
          {moneySigned(change)}
          {summary.me !== null && ` (${percent(summary.me)})`}
        </span>
      )}
      {baseDate && (
        <span className="text-ink-faint">
          {intraday ? `vs ${axisDate(baseDate)} close` : `since ${axisDate(baseDate)}`}
        </span>
      )}
    </span>
  );
}

function RangeToggle({
  range,
  onChange,
}: {
  range: CurveRange;
  onChange: (range: CurveRange) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Chart range">
      {CURVE_RANGES.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={option === range}
          className={`keycap cursor-pointer ${option === range ? "keycap-active" : ""}`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/**
 * The key to the lines.
 *
 * A line with no data is dimmed rather than dropped, and says why on hover.
 * Before the nightly snapshot job has run there is no club average to draw, and
 * on 1D there is no intraday club average to draw at all — a legend that
 * quietly loses an entry between two range tabs reads as a bug.
 */
function Legend({ hasClub, clubNote }: { hasClub: boolean; clubNote: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {SERIES.map((series) => {
        const missing = series.key === "club" && !hasClub;
        return (
          <span
            key={series.key}
            className={`label flex items-center gap-1.5 ${missing ? "opacity-40" : ""}`}
            title={missing ? (clubNote ?? undefined) : undefined}
          >
            <span
              aria-hidden="true"
              className="inline-block h-0 w-4"
              style={{ borderTop: `2px ${series.dash ? "dashed" : "solid"} ${series.color}` }}
            />
            {series.label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * What the curve is made of.
 *
 * A curve replayed from the blotter and a curve read from nightly snapshots
 * look identical on screen and are not the same claim, so the panel says which
 * one it drew rather than letting the member assume the stronger of the two.
 * On 1D it also names the session, because before the opening bell the chart is
 * showing yesterday and nothing else on screen would say so.
 */
function Caption({ history, last }: { history: HistoryResponse | null; last?: Point }) {
  if (!history || history.rows.length === 0) return null;

  const provenance = history.intraday
    ? "Replayed from your blotter against five-minute bars."
    : history.source === "snapshots"
      ? "From nightly snapshots."
      : history.source === "mixed"
        ? "Nightly snapshots, extended back through your blotter."
        : "Replayed from your blotter against each session's close.";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line pt-1.5">
      <span className="label label-ink">{provenance}</span>
      {history.intraday && history.sessionDate && (
        <span className="label label-ink">Session {axisDate(history.sessionDate)}</span>
      )}
      {history.degraded && (
        <span className="label text-loss">Bars unavailable — the curve is short.</span>
      )}
      {last && (
        <span className="label label-ink">
          Latest {money(last.me)} at {last.label}
        </span>
      )}
    </div>
  );
}

function Message({ children, pulse = false }: { children: ReactNode; pulse?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
      <span className={`text-ink-faint ${pulse ? "pulse-dot" : ""}`}>{children}</span>
    </div>
  );
}
