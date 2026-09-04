import { useSyncExternalStore } from "react";

/**
 * A media query, as React state.
 *
 * Most of this app's responsive behaviour is CSS, and should be: a class that
 * changes at a breakpoint costs nothing and cannot get out of step with the
 * paint. This hook is for the cases CSS cannot reach — where the *content*
 * differs rather than its layout. A data grid on a phone does not want its
 * eleventh column shrunk, it wants it gone, and `display: none` on a table cell
 * still lays the column out, still renders every row's value, and still leaves
 * the header measuring the width it no longer shows.
 *
 * `useSyncExternalStore` rather than an effect: the subscription *is* the
 * store, so there is no first frame drawn at the wrong width and corrected
 * afterwards — which on a grid would be a visible column reshuffle on every
 * mount.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      // Guarded because this also runs under `node --test` and anywhere else
      // without a window; a hook that throws on import would take the whole
      // module graph with it.
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(query).matches),
    // Server snapshot. Nothing renders this app on a server, but the hook must
    // still answer, and "desktop" is the layout every other default assumes.
    () => false,
  );
}

/**
 * Tailwind's `md` breakpoint, from the other side.
 *
 * 768px is where this app stops being able to show a wide grid at all: below
 * it every route stacks into one column, the data grids drop their secondary
 * columns, and the option chain loses a field per side. Keeping the number in
 * one place is what stops the CSS breakpoints and the JS ones drifting apart
 * and producing a screen that is neither layout.
 */
export const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
