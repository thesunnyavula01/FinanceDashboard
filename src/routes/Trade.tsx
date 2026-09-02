import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { OrderTicket } from "@/components/terminal/OrderTicket";
import { OptionChain } from "@/components/terminal/OptionChain";
import { Blotter } from "@/components/terminal/Blotter";
import { Panel } from "@/components/terminal/Panel";
import { WorkingOrders } from "@/components/terminal/WorkingOrders";
import { MarginWarning, PortfolioStats } from "@/components/terminal/PortfolioStats";
import { usePortfolio, useWorkingOrders } from "@/hooks/usePortfolio";
import { useChain } from "@/hooks/useChain";
import { underlyingOf } from "@/lib/symbols";
import { api, type ChainContract, type OrderSide, type OrderType } from "@/lib/api";

/** What the command bar hands over when it parses "BUY 500 NVDA". */
export interface TicketPrefill {
  symbol?: string;
  side?: OrderSide;
  qty?: number;
  notional?: number;
  orderType?: OrderType;
  limitPrice?: number;
}

/** The two views behind F2's top-right panel. */
const TABS = [
  { id: "blotter", label: "Blotter" },
  { id: "chain", label: "Chain" },
];

/**
 * F2 — order entry.
 *
 * The ticket and the blotter sit side by side, because the two are read
 * together: a member checks the fill they just got while sizing the next one.
 * Working orders go underneath the blotter rather than beside the ticket — they
 * are a standing commitment rather than part of the act of trading, and on a
 * Monday morning they are the first thing worth looking at.
 *
 * Options add the one affordance this screen has grown since it was built: the
 * top-right panel is tabbed, BLOTTER or CHAIN. A contract cannot be typed the
 * way a ticker can — the OCC form is twenty-one characters of mostly digits —
 * so it has to be found, and the chain is where. Choosing OPTION in the ticket
 * shows it; choosing anything else brings the blotter back. Neither is ever
 * lost, and no equity trade sees a pixel of it.
 */
export function Trade() {
  const location = useLocation();
  const prefill = (location.state as { order?: TicketPrefill } | null)?.order ?? null;

  const { positions, totals, season, note, isLoading } = usePortfolio();

  // Which of the two right-hand views is showing, and what the ticket is
  // loaded with. `picked` doubles as the remount key: loading a contract into
  // the ticket is the same gesture the command bar performs, so it uses the
  // same mechanism rather than a second one.
  const [view, setView] = useState<"blotter" | "chain">("blotter");
  const [picked, setPicked] = useState<{ symbol: string; key: string } | null>(null);
  // Mirrored up from the ticket so the chain can follow it. The ticket stays
  // the owner — this is a copy for the panel beside it, not a second source.
  const [instrument, setInstrument] = useState(prefill?.symbol ?? "");

  // A bare ticker is its own underlying; a contract resolves back to one. So
  // clicking a strike keeps the ladder where it was rather than emptying it.
  const underlying = underlyingOf(instrument) ?? instrument;
  const chainState = useChain(underlying, view === "chain");

  function loadContract(contract: ChainContract) {
    setPicked({ symbol: contract.symbol, key: `${contract.symbol}:${Date.now()}` });
    setInstrument(contract.symbol);
  }

  const { data: clock } = useQuery({
    queryKey: ["clock"],
    queryFn: api.clock,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const marketOpen = Boolean(clock?.isOpen && clock.authoritative);

  // Buying power held by resting orders. The ticket needs it to know what is
  // actually free, and the strip needs it so the two never disagree.
  const { reservedCash } = useWorkingOrders(marketOpen);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label pulse-dot">Loading your portfolio</span>
      </div>
    );
  }

  if (note) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-ink-dim">{note}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PortfolioStats
        totals={totals}
        positionCount={positions.length}
        reservedCash={reservedCash}
      />
      <MarginWarning totals={totals} />

      <div className="grid min-h-0 flex-1 gap-2.5 p-2.5 lg:grid-cols-[minmax(24rem,26rem)_1fr]">
        <OrderTicket
          positions={positions}
          totals={totals}
          tradingLocked={season?.tradingLocked ?? false}
          reservedCash={reservedCash}
          // Remounts the ticket when the command bar sends a new order or the
          // chain hands over a contract, so a second "BUY 500 NVDA" refills the
          // fields rather than being ignored as an unchanged prop.
          key={picked?.key ?? location.key}
          initial={picked ? { symbol: picked.symbol } : prefill}
          onInstrumentChange={(symbol, assetClass) => {
            setInstrument(symbol);
            setView(assetClass === "OPTION" ? "chain" : "blotter");
          }}
        />

        {/*
          The blotter is a list and reads fine short; a strike ladder is not.
          With `auto` on the second row, working orders size to their content
          and leave the chain about three rungs — which is a scrollbar, not a
          ladder. So the chain takes a fixed majority of the column and working
          orders keep a floor rather than a free hand. The blotter view is
          untouched, because nothing about it needed changing.
        */}
        <div
          className={`grid min-h-0 gap-2.5 ${
            view === "chain"
              ? "lg:grid-rows-[minmax(0,3fr)_minmax(0,1fr)]"
              : "lg:grid-rows-[1fr_auto]"
          }`}
        >
          {view === "chain" ? (
            <Panel
              title="Chain"
              tabs={TABS}
              activeTab="chain"
              onTabChange={(id) => setView(id as "blotter" | "chain")}
              meta={
                // The feed is stated once, where a member is deciding what a
                // contract is worth. The quotes are live and synthetic; the
                // prints are real and fifteen minutes old. The curve names
                // whether it was replayed or stored for the same reason.
                <span title="Alpaca indicative feed: quotes are real-time and Alpaca-derived, prints lag OPRA by 15 minutes.">
                  Indicative · quotes live, prints 15m delayed
                </span>
              }
              flush
            >
              <OptionChain
                chain={chainState.chain}
                expiration={chainState.expiration}
                onExpirationChange={chainState.setExpiration}
                selected={picked?.symbol ?? null}
                onSelect={loadContract}
                isLoading={chainState.isLoading}
                isError={chainState.isError}
              />
            </Panel>
          ) : (
            <Blotter tabs={TABS} activeTab="blotter" onTabChange={(id) => setView(id as "blotter" | "chain")} />
          )}
          <WorkingOrders marketOpen={marketOpen} />
        </div>
      </div>
    </div>
  );
}
