import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The mobile layout rules that are invisible on the machine they get broken on.
 *
 * Every screen in this app was drawn for a wide viewport and about half the
 * club reads it on a phone. The failures that matter are not ugly — they are
 * *silent*: a grid track that quietly sizes to its content pushes a panel wider
 * than the screen, the whole page starts scrolling sideways, and the status
 * rail and the command bar slide off with it. On a 1440px desktop every one of
 * those looks perfect, which is why they belong in a test rather than in a
 * reviewer's eye.
 *
 * These are text assertions over the source, the same shape as
 * `symbols.test.ts` reading the browser's copy of the classifier and
 * `schedule.test.ts` reading `wrangler.jsonc`. They cannot prove a screen looks
 * right; they can prove the four decisions that stop it going wrong are still
 * there.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * Every layout grid that becomes a single column on a phone.
 *
 * A bare `grid` has one implicit `auto` track, and an `auto` track is at least
 * its content's min-content width — so a panel holding an eleven-column table
 * makes the track 511px wide inside a 360px screen and the page scrolls
 * sideways under its own chrome. Tailwind's `grid-cols-1` is
 * `repeat(1, minmax(0, 1fr))`, and the `0` is the entire point: it lets the
 * track be narrower than the table, which then scrolls inside its own panel
 * where it belongs.
 */
const STACKING_GRIDS: Array<[file: string, marker: string]> = [
  ["src/routes/Positions.tsx", "md:grid-rows-"],
  ["src/routes/Trade.tsx", "lg:grid-cols-"],
  ["src/routes/Research.tsx", "xl:grid-cols-"],
  ["src/routes/Research.tsx", "xl:grid-rows-"],
  ["src/routes/Sectors.tsx", "xl:grid-rows-"],
  ["src/routes/Sectors.tsx", "xl:grid-cols-[1fr_minmax(17rem,20rem)]"],
  ["src/routes/Sectors.tsx", "xl:grid-cols-[1fr_minmax(22rem,28rem)]"],
  ["src/routes/Admin.tsx", "lg:grid-cols-3"],
  ["src/components/terminal/MemberBook.tsx", "md:grid-rows-"],
];

test("every stacking layout grid clamps its single column to minmax(0, 1fr)", () => {
  for (const [file, marker] of STACKING_GRIDS) {
    const source = read(file);
    const line = source
      .split("\n")
      .find((candidate) => candidate.includes(marker) && candidate.includes("grid"));

    assert.ok(line, `${file}: no grid line carrying ${marker} — did the layout move?`);
    assert.match(
      line,
      /\bgrid-cols-1\b/,
      `${file}: the grid at ${marker} has no unprefixed grid-cols-1, so on a phone its ` +
        `single track sizes to its widest child and the page scrolls sideways.`,
    );
  }
});

test("Panel can be narrower than the grid inside it", () => {
  const panel = read("src/components/terminal/Panel.tsx");

  // A flex/grid item's automatic minimum size is its content's. Without
  // min-w-0 a panel refuses to shrink below its widest table and pushes the
  // screen out from the inside — the same trap min-h-0 already covers
  // vertically, and for exactly the same reason.
  assert.match(
    panel,
    /<section className=\{`flex min-h-0 min-w-0 flex-col/,
    "Panel's <section> must carry both min-h-0 and min-w-0.",
  );

  // The header is one grid row tall and the meta slot is free text. Unclipped,
  // a three-line meta wraps over the grid below it.
  assert.match(
    panel,
    /<header className="row [^"]*overflow-hidden/,
    "Panel's header must clip: its meta is free text in a fixed-height row.",
  );
});

test("DataGrid drops columns on a phone and scrolls what is left", () => {
  const grid = read("src/components/terminal/DataGrid.tsx");

  assert.match(grid, /hideOnMobile\?: boolean/, "Column must offer hideOnMobile.");
  assert.match(
    grid,
    /columns\.filter\(\(col\) => !col\.hideOnMobile\)/,
    "Marked columns must be filtered out of the render, not hidden with CSS — a " +
      "display:none cell still lays out its column and renders every row's value.",
  );
  assert.match(
    grid,
    /<div className="grid-scroll">/,
    "The table must sit in a .grid-scroll box, so a grid too wide for the phone " +
      "scrolls inside its panel instead of taking the page with it.",
  );

  // Sorting reads `columns`, never `visible`. A grid sorted by a column the
  // phone happens not to draw is still sorted by it; re-sorting the rows when
  // someone rotates their phone would be a different table.
  assert.match(
    grid,
    /const col = columns\.find\(\(c\) => c\.key === sortKey\)/,
    "Sorting must resolve against the full column list, not the visible one.",
  );
});

test("the mobile CSS rules that stop iOS reflowing the terminal are present", () => {
  const css = read("src/styles/terminal.css");

  // Safari zooms the page whenever a focused input's text is under 16px and
  // never zooms back. On the order ticket that puts the buying-power line the
  // member was reading off the screen.
  assert.match(
    css,
    /@media \(max-width: 767px\) \{\s*input,\s*select,\s*textarea \{\s*font-size: 16px;/,
    "Form fields must be 16px below 768px or iOS zooms on focus.",
  );

  // `height: 100%` resolves against the *large* viewport, which assumes the
  // address bar has already scrolled away — so the command bar sits a bar's
  // height below the fold on a page that does not scroll.
  assert.match(css, /height: 100dvh/, "The app shell must be sized in dvh, not %.");

  // A 28px row is a comfortable line of data and a poor target for a thumb.
  assert.match(
    css,
    /@media \(pointer: coarse\) \{\s*:root \{\s*--spacing-row: 2\.25rem;/,
    "Grid rows must step up under a coarse pointer.",
  );

  assert.match(css, /\.pad-safe-bottom \{/, "The command bar needs a safe-area inset.");
});

test("the function-key nav survives a phone", () => {
  const nav = read("src/components/terminal/FunctionNav.tsx");

  // A function key is a promise about a keyboard, and a phone has none — five
  // keycaps are also most of a 390px row.
  assert.match(
    nav,
    /keycap hidden sm:inline-flex/,
    "The F-key caps must be hidden below sm; the label is the tab on a phone.",
  );
  assert.match(
    nav,
    /className="rail-scroll [^"]*overflow-x-auto/,
    "The nav must scroll sideways rather than wrap onto a second row.",
  );
  // `ml-auto` in a scroller either does nothing or strands the link past the
  // last tab, so LEGAL only floats right once there is spare room.
  assert.match(nav, /sm:ml-auto/, "LEGAL floats right only from sm up.");
});
