import { useEffect, useMemo, useRef } from "react";
import type { ChainContract, ChainResponse } from "@/lib/api";
import { compact, money } from "@/lib/format";

interface OptionChainProps {
  chain: ChainResponse | null;
  expiration: string | null;
  onExpirationChange: (expiration: string) => void;
  /** The contract currently loaded in the ticket, marked in the ladder. */
  selected: string | null;
  onSelect: (contract: ChainContract) => void;
  isLoading: boolean;
  isError: boolean;
}

/** One strike, with whichever of its two contracts exist. */
interface Rung {
  strike: number;
  call: ChainContract | null;
  put: ChainContract | null;
}

/**
 * The option chain.
 *
 * Not a `DataGrid`, because this is not a list of rows — it is a ladder with an
 * axis down the middle. Calls on the left, puts on the right, strikes between
 * them, and the two sides mirrored so bid and ask sit against the axis on both
 * halves. That layout is the vernacular every chain in the world uses, and it
 * exists because the question a member is asking is "at this strike, what do
 * the two sides cost" — which a flat table makes you scan for and this one puts
 * on one line.
 *
 * It borrows the app's tokens rather than inventing any: 28px rows, `label`
 * headers, hairline separators, `.num` tabular figures, amber for interface.
 *
 * **The strike is amber because it is the axis, not because it is a result.**
 * Same rule as everywhere else. In-the-money contracts are tinted with
 * `panel-hi` and never with green or red — those two mean gain and loss on
 * every other screen in this app, and a chain that used them for moneyness
 * would be saying something else with the same colour.
 *
 * **There are no greeks and no implied volatility**, and their absence is a
 * fact about the data rather than a gap in the design: this key gets the
 * indicative feed, which carries neither, and `feed=opra` needs a signed
 * agreement. Four columns a side is what the feed can honestly fill.
 */
export function OptionChain({
  chain,
  expiration,
  onExpirationChange,
  selected,
  onSelect,
  isLoading,
  isError,
}: OptionChainProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const atTheMoney = useRef<HTMLDivElement>(null);

  const spot = chain?.underlyingPrice ?? null;

  const rungs = useMemo<Rung[]>(() => {
    const byStrike = new Map<number, Rung>();
    for (const contract of chain?.contracts ?? []) {
      const rung = byStrike.get(contract.strike) ?? {
        strike: contract.strike,
        call: null,
        put: null,
      };
      if (contract.type === "CALL") rung.call = contract;
      else rung.put = contract;
      byStrike.set(contract.strike, rung);
    }
    return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  }, [chain]);

  // The strike the spot price sits just below. The whole ladder is scrolled to
  // it, because a member opening a chain is looking at the money and everything
  // fifty strikes out is context they scroll to on purpose.
  const pivot = useMemo(() => {
    if (spot === null) return -1;
    return rungs.findIndex((rung) => rung.strike >= spot);
  }, [rungs, spot]);

  useEffect(() => {
    const target = atTheMoney.current;
    const view = scroller.current;
    if (!target || !view) return;
    // Measured with rects rather than `offsetTop`, which is relative to the
    // nearest *positioned* ancestor — not the scroller — and so lands the
    // ladder somewhere above the money by however tall the panel chrome is.
    // Centred rather than scrolled-into-view, so there are strikes on both
    // sides of the money instead of the ladder starting there.
    const row = target.getBoundingClientRect();
    const box = view.getBoundingClientRect();
    view.scrollTop += row.top - box.top - box.height / 2 + row.height / 2;
  }, [chain?.underlying, expiration, pivot]);

  if (isError) {
    return (
      <Empty>
        The chain could not be loaded. Check the ticker, or try again in a moment.
      </Empty>
    );
  }

  if (isLoading && !chain) {
    return <Empty pulse>Loading the chain</Empty>;
  }

  if (!chain) {
    return <Empty>Enter an underlying ticker to see its contracts.</Empty>;
  }

  if (chain.expirations.length === 0) {
    return <Empty>{chain.underlying} has no listed options.</Empty>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExpiryRail
        expirations={chain.expirations}
        active={expiration}
        onChange={onExpirationChange}
      />

      {/* Two headers, one for each half, mirrored around the strike. */}
      <div className="grid shrink-0 grid-cols-[1fr_4.5rem_1fr] border-b border-line">
        <div className="label px-2 py-1 text-center">Calls</div>
        <div className="label label-ink py-1 text-center">Strike</div>
        <div className="label px-2 py-1 text-center">Puts</div>
      </div>
      <div className="grid shrink-0 grid-cols-[1fr_4.5rem_1fr] border-b border-line">
        <Head columns={["OI", "Last", "Bid", "Ask"]} />
        <div />
        <Head columns={["Bid", "Ask", "Last", "OI"]} />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {rungs.map((rung, index) => {
          // A call is in the money below spot and a put above it. The tint is
          // per half, because moneyness is a property of the contract and not
          // of the strike.
          const callItm = spot !== null && rung.strike < spot;
          const putItm = spot !== null && rung.strike > spot;

          return (
            <div key={rung.strike}>
              {index === pivot && spot !== null && <SpotRule price={spot} chain={chain} />}
              <div
                ref={index === pivot ? atTheMoney : undefined}
                className="row grid grid-cols-[1fr_4.5rem_1fr] items-center border-b border-line/60 hover:bg-panel-hi"
              >
                <Side
                  contract={rung.call}
                  order={["oi", "last", "bid", "ask"]}
                  itm={callItm}
                  selected={selected === rung.call?.symbol}
                  onSelect={onSelect}
                />
                <div className="num text-center font-medium text-accent">{money(rung.strike)}</div>
                <Side
                  contract={rung.put}
                  order={["bid", "ask", "last", "oi"]}
                  itm={putItm}
                  selected={selected === rung.put?.symbol}
                  onSelect={onSelect}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The expirations, as text tabs.
 *
 * The same underline idiom as the ticket's instrument selector, deliberately:
 * F2 grows two new controls in this phase and they should read as one new
 * vocabulary rather than two. Keycaps are reserved for actions — BUY, MKT, GTC
 * — and a date is a filter, not an action.
 */
function ExpiryRail({
  expirations,
  active,
  onChange,
}: {
  expirations: string[];
  active: string | null;
  onChange: (expiration: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Expiration"
      className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-line px-2.5 py-1.5"
    >
      {expirations.map((date) => {
        const selected = date === active;
        return (
          <button
            key={date}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(date)}
            className={`num shrink-0 border-b text-[0.6875rem] transition-colors ${
              selected
                ? "border-accent text-accent"
                : "border-transparent text-ink-faint hover:text-ink-dim"
            }`}
          >
            {expiryLabel(date)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Where the underlying is trading, drawn between the two strikes that bracket
 * it.
 *
 * This is the one piece of chrome on the screen, and it earns its line: the
 * boundary between in and out of the money is the thing a member is orienting
 * against, and a tint alone says which side a row is on without saying where
 * the edge falls. It carries the price, so nothing else on the ladder has to.
 */
function SpotRule({ price, chain }: { price: number; chain: ChainResponse }) {
  return (
    <div className="flex items-center gap-2 px-2 py-0.5">
      <span className="h-px flex-1 bg-accent-dim" />
      <span className="num text-[0.6875rem] text-accent-dim">
        {chain.underlying} {money(price)}
      </span>
      <span className="h-px flex-1 bg-accent-dim" />
    </div>
  );
}

type Field = "oi" | "last" | "bid" | "ask";

function Head({ columns }: { columns: string[] }) {
  return (
    <div className="grid grid-cols-4 px-2">
      {columns.map((column) => (
        <span key={column} className="label py-1 text-right">
          {column}
        </span>
      ))}
    </div>
  );
}

/**
 * One half of one rung.
 *
 * A whole half is one click target rather than four cells, because the gesture
 * is "trade this contract" and asking a member to hit a particular column for
 * it would be a puzzle. The loaded contract carries the amber leading rule the
 * data grid already uses for a current row.
 */
function Side({
  contract,
  order,
  itm,
  selected,
  onSelect,
}: {
  contract: ChainContract | null;
  order: Field[];
  itm: boolean;
  selected: boolean;
  onSelect: (contract: ChainContract) => void;
}) {
  if (!contract) {
    // A strike listed on one side only. An empty half keeps the ladder aligned;
    // collapsing the row would put two different strikes on one line.
    return <div className={`h-full ${itm ? "bg-panel-hi" : ""}`} />;
  }

  const values: Record<Field, string> = {
    oi: contract.openInterest === null ? "—" : compact(contract.openInterest),
    last: contract.last === null ? "—" : money(contract.last),
    bid: contract.bid === null ? "—" : money(contract.bid),
    ask: contract.ask === null ? "—" : money(contract.ask),
  };

  return (
    <button
      type="button"
      onClick={() => onSelect(contract)}
      aria-current={selected ? "true" : undefined}
      aria-label={`${contract.type} ${money(contract.strike)}, ${
        contract.mark === null ? "no price" : `mark ${money(contract.mark)}`
      }`}
      className={`grid h-full w-full grid-cols-4 items-center px-2 text-left transition-colors ${
        itm ? "bg-panel-hi" : ""
      } ${selected ? "shadow-[inset_2px_0_0_0_var(--color-accent)]" : ""} hover:bg-accent-wash`}
    >
      {order.map((field) => (
        <span
          key={field}
          className={`num text-right ${
            field === "oi" ? "text-ink-faint" : field === "last" ? "text-ink-dim" : "text-ink"
          }`}
        >
          {values[field]}
        </span>
      ))}
    </button>
  );
}

function Empty({ children, pulse }: { children: React.ReactNode; pulse?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className={`max-w-xs text-center text-ink-dim ${pulse ? "pulse-dot" : ""}`}>{children}</p>
    </div>
  );
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * `2026-09-18` as `18 SEP`, with the year only when it is not this one.
 *
 * A rail of a dozen dates is scanned, not read, and the year is the same on
 * eleven of them. It appears exactly where it carries information.
 */
export function expiryLabel(date: string, today = new Date()): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  const label = `${String(day).padStart(2, "0")} ${MONTHS[month - 1] ?? "???"}`;
  return year === today.getFullYear() ? label : `${label} ${String(year).slice(2)}`;
}

