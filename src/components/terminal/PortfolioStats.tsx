import { money, moneySigned, percent } from "@/lib/format";
import type { PortfolioTotals } from "@/lib/portfolio";
import { StatStrip, type Stat } from "./StatStrip";
import { Value } from "./Value";

/**
 * The account summary, shared by every screen that has one.
 *
 * It is the same six figures everywhere on purpose. A member glancing up from
 * the order ticket and a member glancing up from the positions grid should be
 * reading the identical strip in the identical order, so the numbers become
 * something they know the position of rather than something they re-read.
 */
export function PortfolioStats({
  totals,
  positionCount,
  /** Buying power held by resting orders. Spent money as far as a new order goes. */
  reservedCash = 0,
}: {
  totals: PortfolioTotals;
  positionCount: number;
  reservedCash?: number;
}) {
  const free = Math.max(0, totals.netBuyingPower - reservedCash);

  const stats: Stat[] = [
    {
      label: "Net asset value",
      hero: true,
      value: <Value value={totals.equity}>{money(totals.equity)}</Value>,
      sub: (
        <Value value={totals.totalPnl} colorBySign>
          {`${moneySigned(totals.totalPnl)}  ${percent(totals.totalPnlPercent)}`}
        </Value>
      ),
    },
    {
      label: "Day P/L",
      value: (
        <Value value={totals.dayPnl} colorBySign>
          {moneySigned(totals.dayPnl)}
        </Value>
      ),
    },
    {
      label: "Cash",
      value: <Value value={totals.cash}>{money(totals.cash)}</Value>,
    },
    {
      // What is actually spendable: the Reg T margin is already netted off, and
      // so is anything a working order has claimed. Showing the gross figure
      // here and refusing the order later would be the worst of both.
      label: "Buying power",
      value: (
        <Value
          value={free}
          className={totals.netBuyingPower - reservedCash < 0 ? "text-loss" : ""}
        >
          {money(free)}
        </Value>
      ),
      sub:
        totals.marginHeld > 0 || reservedCash > 0 ? (
          <span className="label label-ink">
            {[
              totals.marginHeld > 0 ? `${money(totals.marginHeld)} margin` : null,
              reservedCash > 0 ? `${money(reservedCash)} working orders` : null,
            ]
              .filter(Boolean)
              .join(" · ")}{" "}
            held
          </span>
        ) : undefined,
    },
    {
      // Two figures in one cell, which is already the widest thing here, and
      // F4 draws the same split as a bar a member can actually read. It is the
      // first cell to go on a phone.
      label: "Long / Short",
      hideOnMobile: true,
      value: (
        <span className="num">
          {money(totals.longMv)}
          <span className="text-ink-faint"> / </span>
          {money(totals.shortMv)}
        </span>
      ),
    },
    {
      // The positions panel header on F1 says "N holdings" a few pixels below
      // this, so on a phone it is the same number twice.
      label: "Positions",
      hideOnMobile: true,
      value: <span className="num">{positionCount}</span>,
    },
  ];

  return <StatStrip stats={stats} />;
}

/**
 * Shown when shorts have moved far enough against a member that their margin
 * requirement exceeds their cash.
 *
 * v1 has no forced liquidation, deliberately: a school club learns more from
 * watching a bad short get worse than from a system that quietly closes it.
 * What the system does instead is stop new risk and say so plainly.
 */
export function MarginWarning({ totals }: { totals: PortfolioTotals }) {
  if (totals.netBuyingPower >= 0) return null;

  return (
    // The label and the sentence are a block on a phone rather than a run-on
    // line: at 390px the inline version puts "Margin call" alone on the first
    // line with the explanation flowing under it anyway, only without the
    // spacing that would make it read as a heading.
    <div
      role="status"
      className="shrink-0 border-b border-loss bg-panel-hi px-3 py-1.5 sm:flex sm:items-baseline sm:gap-2"
    >
      <span className="label block shrink-0 text-loss sm:inline">Margin call</span>
      <span className="block text-ink-dim">
        Your shorts require {money(totals.marginHeld)} of margin against {money(totals.cash)} of
        cash. New buys and shorts are blocked until you close some of it — selling and covering
        still work.
      </span>
    </div>
  );
}
