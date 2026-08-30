import { useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";

export const SCREENS = [
  { key: "F1", label: "Positions", path: "/" },
  { key: "F2", label: "Trade", path: "/trade" },
  { key: "F3", label: "Leaderboard", path: "/leaderboard" },
  { key: "F4", label: "Sectors", path: "/sectors" },
  { key: "F5", label: "Admin", path: "/admin" },
] as const;

/**
 * Function-key navigation.
 *
 * The keys are real: F1–F5 switch screens. Browsers bind some of these by
 * default (F1 help, F3 find, F5 reload), so we take them over — which is the
 * point of emulating a dedicated instrument, and every screen is still one
 * click away for anyone who would rather not. Bindings are suppressed while a
 * text field has focus so typing a ticker never navigates.
 */
export function FunctionNav() {
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

      const screen = SCREENS.find((s) => s.key === event.key);
      if (!screen) return;

      event.preventDefault();
      navigate(screen.path);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <nav
      aria-label="Screens"
      className="flex shrink-0 items-stretch border-b border-line bg-canvas"
    >
      {SCREENS.map((screen) => (
        <NavLink
          key={screen.key}
          to={screen.path}
          end={screen.path === "/"}
          className={({ isActive }) =>
            `row flex items-center gap-1.5 border-r border-line px-3 transition-colors ${
              isActive
                ? "bg-accent-wash text-accent"
                : "text-ink-dim hover:bg-panel-hi hover:text-ink"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span className={`keycap ${isActive ? "keycap-active" : ""}`}>{screen.key}</span>
              <span className="label" style={{ color: "inherit" }}>
                {screen.label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
