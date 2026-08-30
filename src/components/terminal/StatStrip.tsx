import type { ReactNode } from "react";

export interface Stat {
  label: string;
  value: ReactNode;
  /** Smaller secondary line under the value, e.g. a percentage next to a dollar figure. */
  sub?: ReactNode;
  /** Renders the value at hero size. Reserved for NAV — exactly one per strip. */
  hero?: boolean;
}

/**
 * The always-visible account summary. Sits directly under the nav so the
 * numbers that matter never require scrolling or a click.
 *
 * Cells are separated by hairlines rather than gaps, which keeps the strip
 * reading as one instrument panel.
 */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <div className="flex flex-wrap border-b border-line bg-panel">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="min-w-[8.5rem] flex-1 border-r border-line px-3 py-2 last:border-r-0"
        >
          <div className="label">{stat.label}</div>
          <div className={`mt-0.5 leading-none ${stat.hero ? "text-hero" : "text-lede"}`}>
            {stat.value}
          </div>
          {stat.sub ? <div className="mt-1 text-[0.6875rem] leading-none">{stat.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
