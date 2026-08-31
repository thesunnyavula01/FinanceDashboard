import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type OrderSide, type SecuritiesResponse } from "@/lib/api";
import type { TicketPrefill } from "@/routes/Trade";
import { money, moneySigned, percent } from "@/lib/format";
import { screensFor } from "./FunctionNav";

type Response = { tone: "ok" | "error" | "busy"; text: string } | null;

/**
 * `BUY 10 NVDA` or `SHORT $500 TSLA`.
 *
 * A bare number is share count and a `$` prefix is dollars, which is the
 * distinction the ticket itself draws with its SHRS / USD toggle — the command
 * bar and the ticket have to mean the same thing by the same input or the
 * shortcut becomes a trap.
 *
 * Returns null for anything that is not an order, so the caller can fall
 * through to treating the input as a ticker.
 */
function parseOrder(command: string): TicketPrefill | null {
  const match = command.match(
    /^(BUY|SELL|SHORT|COVER)\s+(\$?)([\d,]*\.?\d+)\s+([A-Z][A-Z0-9.-]{0,9})(?:\s+(?:@|LMT|LIMIT)\s*([\d,]*\.?\d+))?$/,
  );
  if (!match) return null;

  const [, side, dollarSign, rawAmount, symbol, rawLimit] = match;
  const amount = Number(rawAmount!.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const limit = rawLimit === undefined ? null : Number(rawLimit.replace(/,/g, ""));
  if (limit !== null && !(Number.isFinite(limit) && limit > 0)) return null;

  return {
    side: side as OrderSide,
    symbol: symbol!,
    ...(dollarSign ? { notional: amount } : { qty: amount }),
    ...(limit === null ? {} : { orderType: "LIMIT" as const, limitPrice: limit }),
  };
}

/**
 * The command line.
 *
 * A Bloomberg operator types a ticker and presses the amber GO key, and that
 * one gesture is the whole interaction model of the instrument. Reproducing it
 * gives the terminal a single fast path — a screen, a ticker or a whole
 * order ("BUY 10 NVDA") from one field — instead of scattering entry points
 * across five screens.
 *
 * Press / from anywhere to focus.
 */
export function CommandBar({ isAdmin = false }: { isAdmin?: boolean }) {
  // The bar offers exactly what the nav does. A member who types ADMIN gets
  // "not a screen" rather than a screen that turns them away.
  const screens = screensFor(isAdmin);
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

  /**
   * Anything that is not a screen name is treated as a ticker, which is the
   * behaviour that makes the bar feel like a terminal rather than a menu.
   * Symbols and screen names cannot collide: the screens are all words longer
   * and more specific than a ticker.
   */
  async function lookUp(symbol: string) {
    setResponse({ tone: "busy", text: `${symbol} …` });

    try {
      const [{ quotes, unknown }, { securities }] = await Promise.all([
        api.quotes([symbol]),
        api
          .securities([symbol])
          .catch((): SecuritiesResponse => ({ securities: {}, pending: [], rejected: [] })),
      ]);

      const quote = quotes[symbol];
      if (!quote) {
        const missing = unknown.includes(symbol);
        setResponse({
          tone: "error",
          text: missing
            ? `${symbol} is not a symbol we can price.`
            : `No price for ${symbol} right now.`,
        });
        return;
      }

      const name = securities[symbol]?.name;
      const change =
        quote.dayChange === null
          ? ""
          : `  ${moneySigned(quote.dayChange)} ${percent(quote.dayChangePercent)}`;
      const closed = quote.source === "bar" || quote.source === "prev-bar" ? "  at close" : "";

      setResponse({
        tone: "ok",
        text: `${symbol}  ${money(quote.price)}${change}${closed}${name ? `  ${name}` : ""}`,
      });
    } catch (err) {
      setResponse({
        tone: "error",
        text: err instanceof ApiError ? err.message : `Could not look up ${symbol}.`,
      });
    }
  }

  function run(event: FormEvent) {
    event.preventDefault();
    const command = entry.trim().toUpperCase();
    if (!command) return;

    const screen = screens.find(
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
        text: `Screens: ${screens.map((s) => s.label.toUpperCase()).join("  ")}  ·  a ticker  ·  or an order: BUY 10 NVDA / SHORT $500 TSLA / BUY 10 NVDA @ 170`,
      });
      setEntry("");
      return;
    }

    const order = parseOrder(command);
    if (order) {
      // Loads the ticket rather than sending the order. The consequence line
      // there is the confirmation step, and a command line that spends money on
      // one keystroke is the wrong instrument for a club of beginners.
      navigate("/trade", { state: { order } });
      setResponse({ tone: "ok", text: `${command}  → check and send` });
      setEntry("");
      return;
    }

    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(command)) {
      void lookUp(command);
      setEntry("");
      return;
    }

    setResponse({
      tone: "error",
      text: `${command} is not a screen, a ticker, or an order. Type HELP to see what works.`,
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
        placeholder="Ticker, screen name, or an order like BUY 10 NVDA @ 170 — then GO"
        autoComplete="off"
        spellCheck={false}
        className="num min-w-0 flex-1 bg-transparent text-ink uppercase placeholder:text-ink-faint placeholder:normal-case focus:outline-none"
      />

      {response ? (
        <span
          role="status"
          className={`truncate text-[0.6875rem] ${
            response.tone === "error"
              ? "text-loss"
              : response.tone === "busy"
                ? "text-ink-dim"
                : "text-gain"
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
