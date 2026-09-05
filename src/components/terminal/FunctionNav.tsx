import { useEffect, useMemo } from "react";
import { NavLink, useNavigate } from "react-router-dom";

export interface Screen {
  key: string;
  label: string;
  path: string;
  /** Officers only. Hidden from members rather than shown and then refused. */
  admin?: boolean;
}

export const SCREENS: Screen[] = [
  { key: "F1", label: "Positions", path: "/" },
  { key: "F2", label: "Trade", path: "/trade" },
  { key: "F3", label: "Leaderboard", path: "/leaderboard" },
  { key: "F4", label: "Research", path: "/research" },
  { key: "F5", label: "Sectors", path: "/sectors" },
  { key: "F6", label: "Admin", path: "/admin", admin: true },
];

/**
 * The screens this member can actually use.
 *
 * F6 is not merely disabled for a member — an officer-only screen that is
 * visible and refuses is a worse answer than one that is not offered. The
 * route still exists and the API still checks, because hiding a link is not a
 * permission.
 */
export function screensFor(isAdmin: boolean): Screen[] {
  return SCREENS.filter((screen) => !screen.admin || isAdmin);
}

/**
 * Function-key navigation.
 *
 * The keys are real: F1–F6 switch screens. Browsers bind some of these by
 * default (F1 help, F3 find, F5 reload), so we take them over — which is the
 * point of emulating a dedicated instrument, and every screen is still one
 * click away for anyone who would rather not. Bindings are suppressed while a
 * text field has focus so typing a ticker never navigates.
 */
export function FunctionNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const navigate = useNavigate();
  // Memoised: it is a keydown-effect dependency, and a fresh array every render
  // would tear down and re-add the window listener on every tick of the clock.
  const screens = useMemo(() => screensFor(isAdmin), [isAdmin]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

      const screen = screens.find((s) => s.key === event.key);
      if (!screen) return;

      event.preventDefault();
      navigate(screen.path);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, screens]);

  /*
    On a phone the keycaps come off.

    A function key is a promise about a keyboard, and a phone has none — F1
    printed on a tab there is decoration standing where the label should be,
    and five of them are most of a 390px row. So below `sm` the tab is its name
    and nothing else, which is also what makes the six of them fit. Above it
    the keys are real and the keycap is how a member learns that.

    The row scrolls sideways rather than wrapping. Wrapping would give the nav
    a second line on exactly the screens with the least height, and it would
    move under a thumb as the active tab changed width.
  */
  return (
    <nav
      aria-label="Screens"
      className="rail-scroll pad-safe-x flex shrink-0 items-stretch overflow-x-auto border-b border-line bg-canvas"
    >
      {screens.map((screen) => (
        <NavLink
          key={screen.key}
          to={screen.path}
          end={screen.path === "/"}
          className={({ isActive }) =>
            `row flex shrink-0 items-center gap-1.5 border-r border-line px-3 transition-colors ${
              isActive
                ? "bg-accent-wash text-accent"
                : "text-ink-dim hover:bg-panel-hi hover:text-ink"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span className={`keycap hidden sm:inline-flex ${isActive ? "keycap-active" : ""}`}>
                {screen.key}
              </span>
              <span className="label whitespace-nowrap" style={{ color: "inherit" }}>
                {screen.label}
              </span>
            </>
          )}
        </NavLink>
      ))}

      {/*
        Not a screen, and deliberately not a seventh key: F7 would rank a legal
        document alongside the trade ticket, and the member who wants it is
        never looking for it in a hurry. It rides the empty end of a row that
        already exists, so it costs no height — a keycap would have claimed it
        is somewhere you go, and this is somewhere you refer to.

        `ml-auto` only once there is spare room to push it into. In a scroller
        there is none by definition, and an auto margin there would either do
        nothing or strand the link past the last tab, so on a phone it simply
        follows the screens as the last item on the rail — still at the end,
        still keyless, still plain dim text.
      */}
      <NavLink
        to="/legal"
        className={({ isActive }) =>
          `row flex shrink-0 items-center border-line px-3 transition-colors sm:ml-auto sm:border-l ${
            isActive ? "text-accent" : "text-ink-faint hover:text-ink-dim"
          }`
        }
      >
        <span className="label" style={{ color: "inherit" }}>
          Legal
        </span>
      </NavLink>
    </nav>
  );
}
