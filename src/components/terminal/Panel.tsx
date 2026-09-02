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
    <section className={`flex min-h-0 flex-col border border-line bg-panel ${className}`}>
      <header className="row flex shrink-0 items-center justify-between gap-3 border-b border-line px-2.5">
        {tabs && tabs.length > 0 ? (
          <div role="tablist" aria-label={title} className="flex h-full items-stretch gap-3">
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onTabChange?.(tab.id)}
                  className={`label flex items-center border-b-2 transition-colors ${
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
          <h2 className="label">{title}</h2>
        )}
        {meta ? <div className="label label-ink truncate">{meta}</div> : null}
      </header>
      <div className={`min-h-0 flex-1 ${flush ? "overflow-auto" : "p-2.5"}`}>{children}</div>
    </section>
  );
}
