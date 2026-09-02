/**
 * Squarified treemap layout.
 *
 * Bruls, Huizing and van Wijk's algorithm: fill the rectangle a row at a time,
 * always laying the next row along whichever side is currently shorter, and
 * close the row as soon as adding another tile would make its worst aspect
 * ratio worse. The result is tiles that are close to square, which is the only
 * reason a treemap is readable — area is very hard to compare across long thin
 * slivers, and comparing area is the entire job.
 *
 * The obvious alternative, slice-and-dice, needs no measurement and no
 * arithmetic: nested flex boxes with `flex-grow` set to each value would lay
 * out for free. It also turns a sector holding six names into six slivers, and
 * a map made of slivers is a barcode.
 *
 * Pure geometry — no React, no DOM, no units. Callers pass pixels, because the
 * aspect-ratio objective is meaningless without the container's real shape: the
 * same layout computed on a unit square and then stretched into a wide, short
 * panel gives back exactly the slivers this is here to avoid.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapItem {
  key: string;
  /** Any positive magnitude. Zero and negative values are dropped. */
  value: number;
}

export interface TreemapTile<T> extends Rect {
  item: T;
}

/**
 * The worst aspect ratio in a row of areas summing to `sum`, laid along `side`.
 *
 * Both extremes have to be checked: the row's thickness is fixed by the sum, so
 * the largest tile is the one at risk of being too wide and the smallest the one
 * at risk of being too narrow. `rows` is sorted descending, so those are the
 * first and last entries.
 */
function worstRatio(areas: number[], sum: number, side: number): number {
  if (areas.length === 0 || sum <= 0 || side <= 0) return Infinity;

  const max = areas[0]!;
  const min = areas[areas.length - 1]!;
  if (min <= 0) return Infinity;

  const sum2 = sum * sum;
  const side2 = side * side;

  return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
}

export function squarify<T extends TreemapItem>(items: T[], rect: Rect): TreemapTile<T>[] {
  if (rect.w <= 0 || rect.h <= 0) return [];

  const usable = items.filter((item) => item.value > 0);
  if (usable.length === 0) return [];

  const total = usable.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return [];

  // Values become areas in the caller's own pixel space, so a tile's share of
  // the rectangle is its share of the total by construction rather than by a
  // second scaling step at draw time.
  const area = (rect.w * rect.h) / total;
  const queue = [...usable]
    .sort((a, b) => b.value - a.value)
    .map((item) => ({ item, area: item.value * area }));

  const tiles: TreemapTile<T>[] = [];
  let free: Rect = { ...rect };
  let row: { item: T; area: number }[] = [];
  let rowSum = 0;

  function flushRow() {
    if (row.length === 0) return;

    if (free.w <= free.h) {
      // The short side is horizontal, so the row runs across the top and its
      // thickness comes out of the height.
      const h = rowSum / free.w;
      let x = free.x;
      for (const entry of row) {
        const w = entry.area / h;
        tiles.push({ item: entry.item, x, y: free.y, w, h });
        x += w;
      }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h };
    } else {
      const w = rowSum / free.h;
      let y = free.y;
      for (const entry of row) {
        const h = entry.area / w;
        tiles.push({ item: entry.item, x: free.x, y, w, h });
        y += h;
      }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h };
    }

    row = [];
    rowSum = 0;
  }

  for (let i = 0; i < queue.length; ) {
    const side = Math.min(free.w, free.h);

    // Nothing left to lay into: hand the remainder to the open row rather than
    // dropping tiles on a rounding error.
    if (side <= 0) {
      row.push(queue[i]!);
      rowSum += queue[i]!.area;
      i += 1;
      continue;
    }

    const next = queue[i]!;
    const areas = row.map((entry) => entry.area);
    const current = worstRatio(areas, rowSum, side);
    const extended = worstRatio([...areas, next.area], rowSum + next.area, side);

    if (row.length === 0 || extended <= current) {
      row.push(next);
      rowSum += next.area;
      i += 1;
    } else {
      flushRow();
    }
  }

  flushRow();

  return tiles;
}

/** Shrink a rect on every side. Used to leave a hairline gutter between tiles. */
export function inset(rect: Rect, by: number): Rect {
  return {
    x: rect.x + by,
    y: rect.y + by,
    w: Math.max(0, rect.w - by * 2),
    h: Math.max(0, rect.h - by * 2),
  };
}
