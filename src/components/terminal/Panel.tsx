import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  /** Right-aligned metadata in the title bar: counts, timestamps, status. */
  meta?: ReactNode;
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
 */
export function Panel({ title, meta, flush, className = "", children }: PanelProps) {
  return (
    <section className={`flex min-h-0 flex-col border border-line bg-panel ${className}`}>
      <header className="row flex shrink-0 items-center justify-between border-b border-line px-2.5">
        <h2 className="label">{title}</h2>
        {meta ? <div className="label label-ink">{meta}</div> : null}
      </header>
      <div className={`min-h-0 flex-1 ${flush ? "" : "p-2.5"} ${flush ? "overflow-auto" : ""}`}>
        {children}
      </div>
    </section>
  );
}
