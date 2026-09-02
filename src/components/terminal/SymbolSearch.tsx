import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SymbolMatch } from "@/lib/api";
import type { AssetClass } from "@/lib/symbols";

interface SymbolSearchProps {
  value: string;
  onChange: (symbol: string) => void;
  /** Fired when a symbol is committed — picked from the list or typed and entered. */
  onCommit?: (match: SymbolMatch | null) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** What an empty field suggests. Differs per asset class — AAPL, BTC/USD. */
  placeholder?: string;
  /**
   * Which instrument to search. The crypto ticket must not offer stocks, and an
   * option's underlying must not be a coin, so this is never left off from the
   * order ticket — only the command bar means "anything".
   */
  assetClass?: AssetClass;
}

/**
 * Ticker entry with autocomplete over Alpaca's tradable asset list.
 *
 * A combobox rather than a plain input, because the ticker is the one field a
 * member is most likely to get wrong and the list is the cheapest possible way
 * to tell them so before they submit. It is deliberately not a required
 * selection: a member who knows the ticker types four letters and presses
 * Enter, and the list never gets in the way of that.
 *
 * Keyboard: arrows move, Enter takes the highlighted row or commits what was
 * typed, Escape closes the list without clearing the field.
 */
export function SymbolSearch({
  value,
  onChange,
  onCommit,
  autoFocus,
  disabled,
  placeholder = "NVDA",
  assetClass,
}: SymbolSearchProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState(value);
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);

  // Alpaca's list is in KV and the search is cheap, but a keystroke is cheaper
  // still. 150ms is under the threshold where typing feels laggy.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(timer);
  }, [value]);

  const { data } = useQuery({
    queryKey: ["symbols", debounced, assetClass ?? "ANY"],
    queryFn: () => api.searchSymbols(debounced, 8, assetClass),
    enabled: debounced.trim().length > 0 && !disabled,
    // The asset list is rewritten once a night, so a match found now is still a
    // match in an hour.
    staleTime: 60 * 60_000,
    retry: false,
  });

  const results = data?.results ?? [];
  const warming = data?.warming ?? false;

  useEffect(() => setActive(0), [debounced]);

  // Clicking anywhere else closes the list. Focusout alone would fire before a
  // click on a row could register.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function choose(match: SymbolMatch) {
    onChange(match.symbol);
    onCommit?.(match);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (results.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((index) => {
        const next = event.key === "ArrowDown" ? index + 1 : index - 1;
        return (next + results.length) % results.length;
      });
      return;
    }

    if (event.key === "Escape" && open) {
      // Stops the global handler in CommandBar from clearing the whole ticket.
      event.stopPropagation();
      setOpen(false);
      return;
    }

    if (event.key === "Enter") {
      const match = open ? results[active] : undefined;
      if (match) {
        event.preventDefault();
        choose(match);
      } else {
        // Falls through to the form's submit. A member who typed a ticker they
        // know should not have to pick it off a list first.
        setOpen(false);
        onCommit?.(results.find((r) => r.symbol === value.toUpperCase()) ?? null);
      }
    }
  }

  return (
    <div ref={wrapper} className="relative">
      <input
        id="order-symbol"
        value={value}
        onChange={(event) => {
          onChange(event.target.value.toUpperCase());
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        // An OCC contract is twenty-one characters at its longest
        // (GOOGL260116P00150000), so the old ten-character cap would silently
        // truncate a pasted contract into an equity ticker that then fails to
        // price. The classifier is what refuses junk, not the length.
        maxLength={21}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && results[active] ? `${listId}-${results[active]!.symbol}` : undefined
        }
        className="num w-full border border-line bg-canvas px-2 py-1.5 text-lede uppercase text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:text-ink-faint"
      />

      {open && (results.length > 0 || warming) && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching tickers"
          className="absolute inset-x-0 top-full z-20 max-h-64 overflow-auto border border-line-hi bg-panel"
        >
          {warming && results.length === 0 && (
            <li className="label label-ink px-2 py-2">
              <span className="pulse-dot">Loading the ticker list</span>
            </li>
          )}

          {results.map((match, index) => (
            <li
              key={match.symbol}
              id={`${listId}-${match.symbol}`}
              role="option"
              aria-selected={index === active}
              onPointerDown={(event) => {
                // Keeps focus in the input so the click does not blur-close first.
                event.preventDefault();
                choose(match);
              }}
              onPointerEnter={() => setActive(index)}
              className={`row flex cursor-pointer items-center gap-2 border-b border-line/60 px-2 last:border-b-0 ${
                index === active ? "bg-accent-wash" : "hover:bg-panel-hi"
              }`}
            >
              <span className="num w-16 shrink-0 text-ink">{match.symbol}</span>
              <span className="truncate text-ink-dim">{match.name}</span>
              {/* Only the constraints that change what a member can do are
                  shown, and only when they bite. */}
              {!match.fractionable && (
                <span className="label ml-auto shrink-0" title="Whole shares only">
                  WHOLE
                </span>
              )}
              {!match.shortable && (
                <span
                  className={`label shrink-0 ${match.fractionable ? "ml-auto" : ""}`}
                  title="Cannot be sold short"
                >
                  NO SHORT
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
