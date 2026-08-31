import { useMemo, useState } from "react";
import { Panel } from "@/components/terminal/Panel";
import { DataGrid, type Column } from "@/components/terminal/DataGrid";
import { MemberBook } from "@/components/terminal/MemberBook";
import { ReturnBar, returnScale } from "@/components/terminal/ReturnBar";
import { StatStrip, type Stat } from "@/components/terminal/StatStrip";
import { Value } from "@/components/terminal/Value";
import { useStandings } from "@/hooks/useLeaderboard";
import { useAuth } from "@/lib/auth";
import { clockET, compact, money, moneySigned, percent, signColor } from "@/lib/format";
import type { StandingsRow } from "@/lib/api";

/**
 * F3 — the standings.
 *
 * Every member's account on one shared axis, ranked by return, with the market
 * drawn through it as a hairline. The bar is the point of the screen: a sorted
 * column of percentages tells you your number, but it makes you work out
 * whether the club is beating the market or all of it is riding the same rally.
 * One axis answers both at a glance.
 *
 * Clicking a member opens their book. Seeing what everyone else bought is not
 * a leak here, it is the reason a club runs a simulation together.
 */
export function Leaderboard() {
  const { session } = useAuth();
  const { standings, mine, note, isLoading, isError } = useStandings(session?.user.id);
  const [openMember, setOpenMember] = useState<StandingsRow | null>(null);

  const rows = standings?.rows ?? [];
  const summary = standings?.summary;
  const spy = standings?.benchmarks.spy ?? null;
  const qqq = standings?.benchmarks.qqq ?? null;

  // One axis for the whole table, including the benchmarks, so every bar is
  // measured against the same ruler and the SPY hairline lands in the same
  // place on every row.
  const scale = useMemo(
    () => returnScale(rows.map((row) => row.totalReturn), spy),
    [rows, spy],
  );

  const columns: Column<StandingsRow>[] = [
    {
      key: "rank",
      header: "#",
      width: "3rem",
      align: "right",
      sortValue: (r) => r.rank,
      render: (r) => (
        <span className={`num ${r.userId === session?.user.id ? "text-accent" : "text-ink-dim"}`}>
          {r.rank}
        </span>
      ),
    },
    {
      key: "member",
      header: "Member",
      width: "13rem",
      sortValue: (r) => r.displayName,
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate text-ink">{r.displayName}</span>
          {r.userId === session?.user.id && <span className="keycap">YOU</span>}
        </span>
      ),
    },
    {
      key: "spread",
      header: "Return vs market",
      sortValue: (r) => r.totalReturn,
      render: (r) => (
        <ReturnBar
          value={r.totalReturn}
          scale={scale}
          benchmark={spy}
          isMe={r.userId === session?.user.id}
        />
      ),
    },
    {
      key: "totalReturn",
      header: "Return",
      align: "right",
      width: "5.5rem",
      sortValue: (r) => r.totalReturn,
      render: (r) => (
        <Value value={r.totalReturn} colorBySign>
          {percent(r.totalReturn)}
        </Value>
      ),
    },
    {
      key: "excess",
      header: "vs SPY",
      align: "right",
      width: "5.5rem",
      sortValue: (r) => r.excess ?? 0,
      render: (r) =>
        r.excess === null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <Value value={r.excess} colorBySign>
            {percent(r.excess)}
          </Value>
        ),
    },
    {
      key: "equity",
      header: "NAV",
      align: "right",
      width: "7.5rem",
      sortValue: (r) => r.equity,
      render: (r) => <Value value={r.equity}>{money(r.equity)}</Value>,
    },
    {
      key: "dayPnl",
      header: "Day",
      align: "right",
      width: "6.5rem",
      sortValue: (r) => r.dayPnl,
      render: (r) => (
        <Value value={r.dayPnl} colorBySign flash>
          {moneySigned(r.dayPnl)}
        </Value>
      ),
    },
    {
      key: "top",
      header: "Largest position",
      width: "11rem",
      sortValue: (r) => r.top?.symbol ?? "",
      render: (r) =>
        r.top ? (
          <span className="flex items-center gap-1.5">
            <span className="num text-ink">{r.top.symbol}</span>
            {r.top.isShort && (
              <span className="label text-loss" title="Short position">
                S
              </span>
            )}
            <span className="num text-ink-faint">{r.top.weight.toFixed(0)}%</span>
          </span>
        ) : (
          <span className="text-ink-faint">All cash</span>
        ),
    },
    {
      key: "positions",
      header: "Pos",
      align: "right",
      width: "3.5rem",
      sortValue: (r) => r.positions,
      render: (r) => (
        <Value value={r.positions} dim>
          {String(r.positions)}
        </Value>
      ),
    },
  ];

  const stats: Stat[] = [
    {
      label: "Your rank",
      hero: true,
      value: mine ? (
        <span className="num text-ink">
          {mine.rank}
          <span className="text-ink-faint"> / {summary?.members ?? rows.length}</span>
        </span>
      ) : (
        <span className="num text-ink-faint">—</span>
      ),
      sub: mine ? (
        <Value value={mine.totalReturn} colorBySign>
          {`${percent(mine.totalReturn)}  ${moneySigned(mine.totalPnl)}`}
        </Value>
      ) : undefined,
    },
    {
      label: "Club average",
      value:
        summary?.averageReturn === null || summary?.averageReturn === undefined ? (
          <span className="num text-ink-faint">—</span>
        ) : (
          <Value value={summary.averageReturn} colorBySign>
            {percent(summary.averageReturn)}
          </Value>
        ),
      sub:
        summary?.medianReturn === null || summary?.medianReturn === undefined ? undefined : (
          <span className="label label-ink">{percent(summary.medianReturn)} median</span>
        ),
    },
    {
      label: "SPY",
      value: <Benchmark value={spy} />,
      sub:
        summary?.beatingBenchmark === null || summary?.beatingBenchmark === undefined ? undefined : (
          <span className="label label-ink">
            {summary.beatingBenchmark} of {summary.members} ahead
          </span>
        ),
    },
    {
      label: "QQQ",
      value: <Benchmark value={qqq} />,
    },
    {
      label: "Best / worst",
      value:
        summary && summary.bestReturn !== null && summary.worstReturn !== null ? (
          <span className="num">
            <span className={signColor(summary.bestReturn)}>{percent(summary.bestReturn)}</span>
            <span className="text-ink-faint"> / </span>
            <span className={signColor(summary.worstReturn)}>{percent(summary.worstReturn)}</span>
          </span>
        ) : (
          <span className="num text-ink-faint">—</span>
        ),
    },
    {
      label: "Club assets",
      value: <span className="num text-ink">{compact(summary?.totalEquity ?? 0)}</span>,
      sub: <span className="label label-ink">{summary?.members ?? 0} members</span>,
    },
  ];

  if (isLoading && rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label pulse-dot">Loading the standings</span>
      </div>
    );
  }

  if (note) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-ink-dim">{note}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <StatStrip stats={stats} />

      {standings?.season.tradingLocked && (
        <div role="status" className="border-b border-accent-dim bg-accent-wash px-3 py-1.5">
          <span className="label text-accent">Trading locked</span>
          <span className="ml-2 text-ink-dim">
            An officer has paused the season. Positions still move with the market; new orders are
            refused.
          </span>
        </div>
      )}

      {openMember ? (
        <MemberBook row={openMember} onClose={() => setOpenMember(null)} />
      ) : (
        <div className="min-h-0 flex-1 p-2.5">
          <Panel
            title="Standings"
            meta={
              <span className="flex items-center gap-2">
                {isError ? (
                  <span className="text-loss">Standings unavailable</span>
                ) : (
                  <>
                    <span className="text-ink-dim">
                      {rows.length} member{rows.length === 1 ? "" : "s"} since{" "}
                      {new Date(standings!.season.startsAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span className="text-ink-faint">·</span>
                    <span className="text-ink-faint">bar is return, hairline is SPY</span>
                    {standings?.asOf && (
                      <>
                        <span className="text-ink-faint">·</span>
                        <span className="text-ink-faint">
                          {clockET(new Date(standings.asOf))} ET
                        </span>
                      </>
                    )}
                  </>
                )}
              </span>
            }
            flush
          >
            <DataGrid
              columns={columns}
              rows={rows}
              rowKey={(r) => r.portfolioId}
              defaultSort="rank"
              defaultDirection="asc"
              onRowClick={(r) => setOpenMember(r)}
              empty="Nobody has joined this season yet."
            />
          </Panel>
        </div>
      )}
    </div>
  );
}

/**
 * A benchmark figure.
 *
 * Not a <Value colorBySign>: an index is the ruler, and colouring it green
 * would put it in the same visual language as a member's P/L two cells over.
 * It reads in plain ink, which is what makes the members' colours mean
 * something.
 */
function Benchmark({ value }: { value: number | null }) {
  if (value === null) return <span className="num text-ink-faint">—</span>;
  return <span className="num text-ink-dim">{percent(value)}</span>;
}
