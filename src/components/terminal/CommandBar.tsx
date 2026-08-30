import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { SCREENS } from "./FunctionNav";

type Response = { tone: "ok" | "error"; text: string } | null;

/**
 * The command line.
 *
 * A Bloomberg operator types a ticker and presses the amber GO key, and that
 * one gesture is the whole interaction model of the instrument. Reproducing it
 * gives the terminal a single fast path — screens now, tickers in Phase 3,
 * whole orders ("BUY 500 NVDA") in Phase 4 — instead of scattering entry points
 * across five screens.
 *
 * Press / from anywhere to focus.
 */
export function CommandBar() {
  const [entry, setEntry] = useState("");
  const [response, setResponse] = useState<Response>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape" && typing) {
        setEntry("");
        setResponse(null);
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function run(event: FormEvent) {
    event.preventDefault();
    const command = entry.trim().toUpperCase();
    if (!command) return;

    const screen = SCREENS.find(
      (s) => s.label.toUpperCase() === command || s.key === command,
    );
    if (screen) {
      navigate(screen.path);
      setResponse({ tone: "ok", text: `${screen.label.toUpperCase()}` });
      setEntry("");
      return;
    }

    if (command === "HELP" || command === "?") {
      setResponse({
        tone: "ok",
        text: `Screens: ${SCREENS.map((s) => s.label.toUpperCase()).join("  ")}`,
      });
      setEntry("");
      return;
    }

    setResponse({
      tone: "error",
      text: `${command} is not a screen. Ticker lookup and order entry arrive in Phase 3. Type HELP for screens.`,
    });
  }

  return (
    <form
      onSubmit={run}
      className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-3 py-1.5"
    >
      <label htmlFor="command" className="label shrink-0">
        CMD
      </label>

      <span className="num shrink-0 text-accent" aria-hidden="true">
        &gt;
      </span>

      <input
        id="command"
        ref={inputRef}
        value={entry}
        onChange={(e) => {
          setEntry(e.target.value);
          if (response) setResponse(null);
        }}
        placeholder="Type a screen name, then GO"
        autoComplete="off"
        spellCheck={false}
        className="num min-w-0 flex-1 bg-transparent text-ink uppercase placeholder:text-ink-faint placeholder:normal-case focus:outline-none"
      />

      {response ? (
        <span
          role="status"
          className={`truncate text-[0.6875rem] ${
            response.tone === "error" ? "text-loss" : "text-gain"
          }`}
        >
          {response.text}
        </span>
      ) : (
        <span className="label label-ink hidden shrink-0 sm:block">
          Press <span className="text-accent-dim">/</span> to focus
        </span>
      )}

      <button
        type="submit"
        className="keycap shrink-0 cursor-pointer transition-colors hover:border-accent hover:bg-accent hover:text-black"
      >
        GO
      </button>
    </form>
  );
}
