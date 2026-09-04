import type { ReactNode } from "react";

export interface Stat {
  label: string;
  value: ReactNode;
  /** Smaller secondary line under the value, e.g. a percentage next to a dollar figure. */
  sub?: ReactNode;
  /**
   * Renders the value at hero size: the one figure the screen exists to answer.
   * Exactly one per strip — NAV on the portfolio screens, rank on the
   * leaderboard. A second hero is two headlines and therefore none.
   */
  hero?: boolean;
  /**
   * Dropped below `sm`.
   *
   * Six cells wrap to three rows on a phone, which is a third of the viewport
   * spent before the screen below it has drawn anything. Mark the cells that
   * are restatements — a position count the panel header already gives, a
   * long/short split the sector map draws — never the account's own money.
   */
  hideOnMobile?: boolean;
}

/**
 * The always-visible account summary. Sits directly under the nav so the
 * numbers that matter never require scrolling or a click.
 *
 * On a desktop the cells are one row separated by hairlines rather than gaps,
 * which is what keeps the strip reading as one instrument panel. On a phone
 * that row cannot exist — six cells at their minimum are twice the width of
 * the screen — so it becomes a two-column grid, and the hairlines are drawn by
 * a 1px gap over a line-coloured ground rather than by borders, because
 * borders on a wrapping row leave the seams between rows unpainted and the
 * ends of them doubled.
 */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid shrink-0 grid-cols-2 gap-px border-b border-line bg-line sm:flex sm:flex-wrap sm:gap-0 sm:bg-panel">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className={`min-w-0 bg-panel px-3 py-2 sm:min-w-[8.5rem] sm:flex-1 sm:border-r sm:border-line sm:last:border-r-0 ${
            stat.hideOnMobile ? "hidden sm:block" : ""
          }`}
        >
          <div className="label">{stat.label}</div>
          {/*
            No `overflow-hidden` here, however tempting. These figures are set
            at `leading-none`, so a box clipped to its own line height shaves
            the descenders and the bottom of every comma off the one number on
            the screen a member is here to read. The `min-w-0` on the cell is
            what keeps a long value out of its neighbour's column instead.
          */}
          <div
            className={`mt-0.5 leading-none ${
              // 28px of NAV is eleven monospaced characters, and half a phone
              // is not eleven of them — a six-figure account would break the
              // cell out of its own column. It steps down to 22px below `sm`
              // and stays unmistakably the largest figure on the screen, which
              // is the whole job of the hero size.
              stat.hero ? "text-[1.375rem] sm:text-hero" : "text-lede"
            }`}
          >
            {stat.value}
          </div>
          {stat.sub ? <div className="mt-1 text-[0.6875rem] leading-none">{stat.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
