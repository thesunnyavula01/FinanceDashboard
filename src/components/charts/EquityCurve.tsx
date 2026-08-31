import { Suspense, lazy, useMemo, type ReactNode } from "react";
import { CURVE_RANGES, type CurveRange, type HistoryResponse } from "@/lib/api";
import { money, percent, signColor } from "@/lib/format";
import { Panel } from "@/components/terminal/Panel";
import { SERIES, axisDate, type Point } from "./series";

/**
 * The equity curve.
 *
 * Four lines, all indexed to 100 at the left edge, because the only question a
 * club is really asking is which line is on top. A $100,000 portfolio and a
 * $640 share of SPY cannot be plotted against each other in dollars; indexed,
 * the vertical distance between them *is* the answer.
 *
 * Indexing happens at the start of the visible range rather than at the season
 * start, so switching to 1W answers "how did this week go against the market"
 * instead of redrawing the same January baseline at a different zoom. The panel
 * says which date is the 100, because a normalised chart with an unstated
 * baseline is a chart you cannot check.
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
        excess: row.me === null || row.spy === null ? null : row.me - row.spy,
      })),
    [history],
  );

  const summary = history?.summary;
  const hasClub = points.some((point) => point.club !== null);
  const last = points.at(-1);

  return (
    <Panel
      title="Performance"
      meta={
        <span className="flex items-center gap-2">
          {summary?.me !== null && summary?.me !== undefined && (
            <span className={signColor(summary.me)}>You {percent(summary.me)}</span>
          )}
          {summary?.spy !== null && summary?.spy !== undefined && (
            <span className="text-ink-faint">SPY {percent(summary.spy)}</span>
          )}
          {history?.baseDate && (
            <span className="text-ink-faint">100 = {axisDate(history.baseDate)}</span>
          )}
        </span>
      }
      className="min-h-[16rem]"
    >
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
            One session so far. The curve fills in as the season does — check back tomorrow.
          </Message>
        ) : (
          <Suspense fallback={<Message pulse>Drawing</Message>}>
            <CurvePlot points={points} live={history?.live ?? false} />
          </Suspense>
        )}

        <Caption history={history} last={last} />
      </div>
    </Panel>
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
 * a legend that quietly loses an entry reads as a bug.
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
 */
function Caption({ history, last }: { history: HistoryResponse | null; last?: Point }) {
  if (!history || history.rows.length === 0) return null;

  const provenance =
    history.source === "snapshots"
      ? "From nightly snapshots."
      : history.source === "mixed"
        ? "Nightly snapshots, extended back through your blotter."
        : "Replayed from your blotter against each session's close.";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line pt-1.5">
      <span className="label label-ink">{provenance}</span>
      {history.degraded && (
        <span className="label text-loss">Daily bars unavailable — the curve is short.</span>
      )}
      {last && (
        <span className="label label-ink">
          Latest {money(last.equity)} on {axisDate(last.date)}
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
