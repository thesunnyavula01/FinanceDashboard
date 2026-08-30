import { useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  /** Any CSS width; omit to let the column take its share of the remainder. */
  width?: string;
  render: (row: T) => ReactNode;
  /** Return a sortable primitive to make the column sortable. */
  sortValue?: (row: T) => number | string;
}

interface DataGridProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Column key to sort by on first render. */
  defaultSort?: string;
  defaultDirection?: "asc" | "desc";
  onRowClick?: (row: T) => void;
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
}

/**
 * The dense table that every screen is built from. 28px rows, monospace
 * numerics, uppercase amber headers, hairline separators.
 *
 * Sorting is client-side because the largest grid in this app is one member's
 * positions — a few dozen rows at most. Nothing here needs pagination.
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  defaultDirection = "desc",
  onRowClick,
  empty = "No rows",
}: DataGridProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSort);
  const [dir, setDir] = useState<"asc" | "desc">(defaultDirection);

  const sorted = useMemo(() => {
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
      <div className="flex h-24 items-center justify-center text-ink-faint">{empty}</div>
    );
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line">
          {columns.map((col) => {
            const sortable = Boolean(col.sortValue);
            const active = col.key === sortKey;
            return (
              <th
                key={col.key}
                scope="col"
                style={col.width ? { width: col.width } : undefined}
                className={`label h-6 px-2 ${col.align === "right" ? "text-right" : "text-left"} ${
                  active ? "text-accent" : ""
                }`}
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
        {sorted.map((row) => (
          <tr
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`row border-b border-line/60 ${
              onRowClick ? "cursor-pointer hover:bg-panel-hi" : "hover:bg-panel-hi"
            }`}
          >
            {columns.map((col) => (
              <td
                key={col.key}
                className={`px-2 ${col.align === "right" ? "text-right" : "text-left"}`}
              >
                {col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
