import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { OrderTicket } from "@/components/terminal/OrderTicket";
import { Blotter } from "@/components/terminal/Blotter";
import { WorkingOrders } from "@/components/terminal/WorkingOrders";
import { MarginWarning, PortfolioStats } from "@/components/terminal/PortfolioStats";
import { usePortfolio, useWorkingOrders } from "@/hooks/usePortfolio";
import { api, type OrderSide, type OrderType } from "@/lib/api";

/** What the command bar hands over when it parses "BUY 500 NVDA". */
export interface TicketPrefill {
  symbol?: string;
  side?: OrderSide;
  qty?: number;
  notional?: number;
  orderType?: OrderType;
  limitPrice?: number;
}

/**
 * F2 — order entry.
 *
 * The ticket and the blotter sit side by side, because the two are read
 * together: a member checks the fill they just got while sizing the next one.
 * Working orders go underneath the blotter rather than beside the ticket — they
 * are a standing commitment rather than part of the act of trading, and on a
 * Monday morning they are the first thing worth looking at.
 */
export function Trade() {
  const location = useLocation();
  const prefill = (location.state as { order?: TicketPrefill } | null)?.order ?? null;

  const { positions, totals, season, note, isLoading } = usePortfolio();

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
          // Remounts the ticket when the command bar sends a new order, so a
          // second "BUY 500 NVDA" refills the fields rather than being ignored
          // as an unchanged prop.
          key={location.key}
          initial={prefill}
        />

        <div className="grid min-h-0 gap-2.5 lg:grid-rows-[1fr_auto]">
          <Blotter />
          <WorkingOrders marketOpen={marketOpen} />
        </div>
      </div>
    </div>
  );
}
