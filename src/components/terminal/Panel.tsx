import type { ReactNode } from "react";

export interface PanelTab {
  id: string;
  label: string;
}

interface PanelProps {
  title: string;
  /** Right-aligned metadata in the title bar: counts, timestamps, status. */
  meta?: ReactNode;
  /**
   * Two or more views behind one panel. Renders in place of the title, so a
   * tabbed panel costs no extra height — the title bar was already there.
   */
  tabs?: PanelTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  /** Removes the body padding, for panels whose child is a full-bleed grid. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The only container in the app. A hairline border, a title bar, and content —
 * no shadow, no radius, no gradient. Panels butt directly against each other,
 * which is what makes the layout read as one instrument rather than a page of
 * floating cards.
 *
 * A panel can carry tabs, and they sit where the title was rather than above
 * it: the screen is dense on purpose, and a tab strip that pushed the content
 * down by a row would be paid for on every panel that never grows one. The
 * active tab is amber and underlined — the same treatment the order ticket's
 * instrument selector uses, so "which view am I in" reads the same way twice
 * rather than twice differently.
 */
export function Panel({
  title,
  meta,
  tabs,
  activeTab,
  onTabChange,
  flush,
  className = "",
  children,
}: PanelProps) {
  return (
    // `min-w-0` alongside `min-h-0`, and for the same reason. A flex or grid
    // item's automatic minimum size is its content's, so without this a panel
    // holding a wide grid refuses to be narrower than that grid and pushes the
    // whole screen sideways — taking the status rail and the command bar with
    // it. Nothing about that is visible on a desktop, where the panels have
    // the room; it is the difference between a table that scrolls inside its
    // panel and a page that scrolls under its own chrome.
    <section className={`flex min-h-0 min-w-0 flex-col border border-line bg-panel ${className}`}>
      {/*
        `overflow-hidden`, and it is load-bearing rather than tidy. The header
        is exactly one grid row tall, and the meta slot is free text that gets
        narrower on every screen — a sector panel that names its gross, its
        legend and SPY's day has three lines of content and 28px of room. Left
        to itself it wraps *over* the grid below and the title underneath it.
        Clipped, the header stays a header and the meta reads as far as there
        is room for it, which is the same bargain every other truncated label
        in this app makes. Callers keep their meta on one line for that to be
        a truncation rather than a guillotine.
      */}
      <header className="row flex shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-line px-2.5">
        {tabs && tabs.length > 0 ? (
          <div
            role="tablist"
            aria-label={title}
            // Scrolls rather than wraps, for the same reason: two tabs and a
            // meta on a 390px panel is more than one row of width, and the
            // legal screen's "Terms of use" / "Privacy policy" is the pair
            // that proves it.
            className="rail-scroll flex h-full shrink-0 items-stretch gap-3 overflow-x-auto"
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onTabChange?.(tab.id)}
                  className={`label flex shrink-0 items-center whitespace-nowrap border-b-2 transition-colors ${
                    selected
                      ? "border-accent text-accent"
                      : "border-transparent hover:text-ink-dim"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        ) : (
          <h2 className="label truncate">{title}</h2>
        )}
        {meta ? (
          <div className="label label-ink min-w-0 truncate whitespace-nowrap">{meta}</div>
        ) : null}
      </header>
      <div className={`min-h-0 flex-1 ${flush ? "overflow-auto" : "p-2.5"}`}>{children}</div>
    </section>
  );
}
