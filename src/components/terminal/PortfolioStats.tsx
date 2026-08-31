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
      label: "Long / Short",
      value: (
        <span className="num">
          {money(totals.longMv)}
          <span className="text-ink-faint"> / </span>
          {money(totals.shortMv)}
        </span>
      ),
    },
    {
      label: "Positions",
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
    <div role="status" className="border-b border-loss bg-panel-hi px-3 py-1.5">
      <span className="label text-loss">Margin call</span>
      <span className="ml-2 text-ink-dim">
        Your shorts require {money(totals.marginHeld)} of margin against {money(totals.cash)} of
        cash. New buys and shorts are blocked until you close some of it — selling and covering
        still work.
      </span>
    </div>
  );
}
