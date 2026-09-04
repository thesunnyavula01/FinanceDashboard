import { useMemo, useState, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/useMediaQuery";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  /** Any CSS width; omit to let the column take its share of the remainder. */
  width?: string;
  render: (row: T) => ReactNode;
  /** Return a sortable primitive to make the column sortable. */
  sortValue?: (row: T) => number | string;
  /**
   * Dropped entirely below `md`.
   *
   * Not hidden — dropped. A phone has room for four or five columns and every
   * grid here was drawn with eight or eleven, so the choice is which ones a
   * member actually came for. Mark the context: the name beside a ticker, the
   * sector beside a name, the average cost beside a live price. Never mark the
   * figure the screen exists to answer.
   */
  hideOnMobile?: boolean;
}

interface DataGridProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Column key to sort by on first render. */
  defaultSort?: string;
  defaultDirection?: "asc" | "desc";
  onRowClick?: (row: T) => void;
  /**
   * `rowKey` of the row the rest of the screen is filtered to. Marked amber,
   * because a selection is interface and amber is what interface is drawn in.
   */
  selectedKey?: string;
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
}

/**
 * The dense table that every screen is built from. 28px rows, monospace
 * numerics, uppercase amber headers, hairline separators. Under a coarse
 * pointer the row steps to 36px, from one variable in terminal.css, because a
 * 28px row is a comfortable line of data and a poor target for a thumb.
 *
 * Sorting is client-side because the largest grid in this app is one member's
 * positions — a few dozen rows at most. Nothing here needs pagination.
 *
 * **On a phone it drops columns and then scrolls.** In that order, and the
 * order matters. Scrolling alone would leave a member swiping past four
 * columns of context to reach the P/L they opened the screen for. Dropping
 * alone would still overflow on a long ticker and take the page sideways with
 * it, which carries the status rail and the command bar off the screen. So the
 * secondary columns go first, and whatever is left scrolls inside the panel if
 * it still has to.
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  defaultDirection = "desc",
  onRowClick,
  selectedKey,
  empty = "No rows",
}: DataGridProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSort);
  const [dir, setDir] = useState<"asc" | "desc">(defaultDirection);
  const isMobile = useIsMobile();

  const visible = useMemo(
    () => (isMobile ? columns.filter((col) => !col.hideOnMobile) : columns),
    [columns, isMobile],
  );

  const sorted = useMemo(() => {
    // Sorting reads the full column list, not the visible one. A grid sorted by
    // a column a phone happens not to draw is still sorted by it — dropping a
    // column is a decision about width, not about order, and re-sorting the
    // rows under a member who rotated their phone would be a different table.
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const getValue = col.sortValue;

    return [...rows].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
  }, [rows, columns, sortKey, dir]);

  function toggleSort(col: Column<T>) {
    if (!col.sortValue) return;
    if (col.key === sortKey) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setDir("desc");
    }
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center px-4 text-center text-ink-faint">
        {empty}
      </div>
    );
  }

  return (
    // No min-width, and none is needed: an auto-layout table already refuses
    // to render narrower than its own min-content, so the floor is exactly the
    // narrowest the surviving columns can honestly be drawn at, computed per
    // grid from the headers and figures actually in it. A hand-picked figure
    // here would only ever be wrong in one of the two directions — forcing a
    // swipe on a grid that fitted, or clipping one that did not.
    <div className="grid-scroll">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            {visible.map((col) => {
              const sortable = Boolean(col.sortValue);
              const active = col.key === sortKey;
              return (
                <th
                  key={col.key}
                  scope="col"
                  // Widths are a desktop instruction. On a phone the surviving
                  // columns divide what there is, because a fixed 18rem "Name"
                  // beside a 4rem figure is how a table ends up with one
                  // readable column and a scrollbar.
                  style={col.width && !isMobile ? { width: col.width } : undefined}
                  className={`label h-6 px-2 whitespace-nowrap ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${active ? "text-accent" : ""}`}
                  aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col)}
                      className="cursor-pointer uppercase hover:text-accent"
                    >
                      {col.header}
                      {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey !== undefined && key === selectedKey;

            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                aria-current={selected ? "true" : undefined}
                className={`row border-b border-line/60 hover:bg-panel-hi ${
                  onRowClick ? "cursor-pointer" : ""
                } ${selected ? "bg-panel-hi" : ""}`}
              >
                {visible.map((col, index) => (
                  <td
                    key={col.key}
                    className={`px-2 ${col.align === "right" ? "text-right" : "text-left"} ${
                      // An amber rule down the leading edge. Painted as an inset
                      // shadow on the first cell rather than a border on the row:
                      // under border-collapse a <tr>'s own border is not drawn.
                      selected && index === 0
                        ? "shadow-[inset_2px_0_0_var(--color-accent)]"
                        : ""
                    }`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
