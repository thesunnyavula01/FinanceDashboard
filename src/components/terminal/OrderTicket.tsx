import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ORDER_SIDES,
  ORDER_TYPES,
  OrderError,
  TIME_IN_FORCE,
  type OrderResponse,
  type OrderSide,
  type OrderType,
  type PositionRow,
  type SymbolMatch,
  type TimeInForce,
} from "@/lib/api";
import {
  availableSides,
  estimateReservation,
  isMarketable,
  REG_T_MARGIN_MULTIPLIER,
  type PortfolioTotals,
} from "@/lib/portfolio";
import { money, moneySigned, percent, shares, signColor, stampET } from "@/lib/format";
import { usePlaceOrder } from "@/hooks/usePortfolio";
import { useQuotes, useSecurities } from "@/hooks/useQuotes";
import { SymbolSearch } from "./SymbolSearch";
import { Panel } from "./Panel";
import { Value } from "./Value";

interface OrderTicketProps {
  positions: PositionRow[];
  totals: PortfolioTotals;
  tradingLocked: boolean;
  /** Buying power already held by resting orders. */
  reservedCash: number;
  /** Pre-fills the ticket, so the command bar can hand off a parsed order. */
  initial?: {
    symbol?: string;
    side?: OrderSide;
    qty?: number;
    notional?: number;
    orderType?: OrderType;
    limitPrice?: number;
  } | null;
}

type AmountMode = "SHARES" | "USD";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

/** How each side moves buying power per dollar of order value. */
const BUYING_POWER_FACTOR: Record<OrderSide, number> = {
  BUY: -1,
  SELL: 1,
  SHORT: -(REG_T_MARGIN_MULTIPLIER - 1),
  COVER: REG_T_MARGIN_MULTIPLIER - 1,
};

/** How each side moves the cash balance per dollar of order value. */
const CASH_FACTOR: Record<OrderSide, number> = { BUY: -1, SELL: 1, SHORT: 1, COVER: -1 };

/**
 * The order ticket.
 *
 * Built around one idea: a member should never press the button without knowing
 * what it will do to their account. So the ticket reads the order back as a
 * sentence and shows the balances it moves, live, as they type. That readback is
 * the button label too, which is the whole confirmation step.
 *
 * Since resting orders arrived it has a second job: saying honestly which of the
 * two things the button will do. An order placed at a weekend does not fill —
 * US equities trade 09:30-16:00 ET on weekdays, so there is no session and no
 * counterparty — it is queued, and the sweep fills it when the market opens.
 * The ticket says "queue" rather than "buy" in that case, and shows what will be
 * held in the meantime rather than a cash movement that is not going to happen.
 */
export function OrderTicket({
  positions,
  totals,
  tradingLocked,
  reservedCash,
  initial,
}: OrderTicketProps) {
  const [symbol, setSymbol] = useState(initial?.symbol ?? "");
  const [side, setSide] = useState<OrderSide>(initial?.side ?? "BUY");
  const [orderType, setOrderType] = useState<OrderType>(initial?.orderType ?? "MARKET");
  const [limitPrice, setLimitPrice] = useState(
    initial?.limitPrice !== undefined ? String(initial.limitPrice) : "",
  );
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("DAY");
  const [mode, setMode] = useState<AmountMode>(initial?.notional !== undefined ? "USD" : "SHARES");
  const [amount, setAmount] = useState(
    initial?.qty !== undefined
      ? String(initial.qty)
      : initial?.notional !== undefined
        ? String(initial.notional)
        : "",
  );
  const [asset, setAsset] = useState<SymbolMatch | null>(null);
  const [result, setResult] = useState<OrderResponse | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const place = usePlaceOrder();

  const valid = SYMBOL_PATTERN.test(symbol);
  const { quotes } = useQuotes(valid ? [symbol] : [], valid);
  const { securities } = useSecurities(valid ? [symbol] : [], valid);

  const { data: clock } = useQuery({
    queryKey: ["clock"],
    queryFn: api.clock,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const quote = valid ? quotes[symbol] : undefined;
  const security = valid ? securities[symbol] : undefined;
  const held = positions.find((p) => p.symbol === symbol);
  const disabledSides = useMemo(() => availableSides(held), [held]);

  const marketOpen = Boolean(clock?.isOpen && clock.authoritative);
  const closing = side === "SELL" || side === "COVER";

  useEffect(() => {
    if (disabledSides[side]) {
      const next = ORDER_SIDES.find((candidate) => !disabledSides[candidate]);
      if (next) setSide(next);
    }
  }, [disabledSides, side]);

  const price = quote?.price ?? null;
  const limit = limitPrice.trim() === "" ? null : Number(limitPrice);
  const limitValid = orderType === "MARKET" || (Number.isFinite(limit) && (limit as number) > 0);

  const parsedAmount = Number(amount);
  const hasAmount = amount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount > 0;

  // Will this fill now, or rest? Two conditions, both of which the member can
  // see for themselves on this screen: is there a session, and has the price
  // reached the limit.
  const willQueue =
    !marketOpen || (price !== null && !isMarketable(side, orderType, limit, price));

  // A working close is entered in shares. The number of shares a dollar amount
  // closes is not known until it fills, and the conversion runs the wrong way —
  // the cheaper the fill, the more shares "$500" turns out to be.
  const dollarsBlocked = willQueue && closing;

  useEffect(() => {
    if (dollarsBlocked && mode === "USD") setMode("SHARES");
  }, [dollarsBlocked, mode]);

  /** A limit order sizes against its own price; a market order against the last. */
  const sizingPrice = orderType === "LIMIT" && limit ? limit : price;

  const sized = useMemo(() => {
    if (!hasAmount || !sizingPrice) return null;

    let qty =
      mode === "SHARES" ? parsedAmount : Math.floor((parsedAmount / sizingPrice) * 1e6) / 1e6;
    if (asset?.fractionable === false) qty = Math.floor(qty);
    if (!(qty > 0)) return null;

    return { qty, value: qty * sizingPrice };
  }, [hasAmount, parsedAmount, sizingPrice, mode, asset]);

  const reservation = useMemo(() => {
    if (!sized || !willQueue || !price) return null;
    return estimateReservation({
      side,
      orderType,
      limitPrice: limit,
      qty: mode === "SHARES" ? sized.qty : undefined,
      notional: mode === "USD" ? parsedAmount : undefined,
      referencePrice: price,
    });
  }, [sized, willQueue, price, side, orderType, limit, mode, parsedAmount]);

  /** What the order does to the balances, if it fills right now. */
  const consequence = useMemo(() => {
    if (!sized || !sizingPrice) return null;

    const cashAfter = totals.cash + CASH_FACTOR[side] * sized.value;
    const buyingPowerAfter = totals.netBuyingPower + BUYING_POWER_FACTOR[side] * sized.value;

    return {
      cashAfter,
      buyingPowerAfter,
      unaffordable: (side === "BUY" || side === "SHORT") && buyingPowerAfter < 0,
      realizing:
        held && closing
          ? (sizingPrice - held.avgCost) * (side === "SELL" ? sized.qty : -sized.qty)
          : null,
    };
  }, [sized, sizingPrice, totals, side, held, closing]);

  // Buying power free after what resting orders already hold.
  const freeBuyingPower = Math.max(0, totals.netBuyingPower - reservedCash);
  const cannotReserve = Boolean(reservation && reservation.cash > freeBuyingPower);

  const sideBlocked = disabledSides[side];

  const blocker = tradingLocked
    ? "Trading is locked for this season."
    : sideBlocked
      ? sideBlocked
      : !valid || !price
        ? null
        : !limitValid
          ? "Enter a limit price."
          : cannotReserve
            ? `Queueing this holds ${money(reservation!.cash)}, and you have ${money(freeBuyingPower)} free.`
            : !willQueue && consequence?.unaffordable
              ? `That is more than your buying power of ${money(totals.buyingPower)}.`
              : null;

  const ready = valid && Boolean(price) && Boolean(sized) && limitValid && !blocker && !place.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || !sized) return;

    setResult(null);
    place.mutate(
      {
        symbol,
        side,
        orderType,
        ...(orderType === "LIMIT" ? { limitPrice: limit as number } : {}),
        ...(mode === "SHARES" ? { qty: parsedAmount } : { notional: parsedAmount }),
        timeInForce,
      },
      {
        onSuccess: (response) => {
          setResult(response);
          setAmount("");
          amountRef.current?.focus();
        },
      },
    );
  }

  function onSideKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = ORDER_SIDES.indexOf(side);
    setSide(ORDER_SIDES[(index + delta + ORDER_SIDES.length) % ORDER_SIDES.length]!);
  }

  function reset() {
    setResult(null);
    place.reset();
  }

  const rejection = place.error instanceof OrderError ? place.error : null;
  const verb = willQueue ? "QUEUE" : side;

  return (
    <Panel
      title="Order ticket"
      meta={
        clock ? (
          <span className={marketOpen ? "text-gain" : "text-ink-dim"}>
            {marketOpen ? "Market open" : clock.label}
          </span>
        ) : null
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {/* Ticker, with the quote beside it. */}
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div>
            <label htmlFor="order-symbol" className="label mb-1 block">
              Ticker
            </label>
            <SymbolSearch
              value={symbol}
              onChange={(next) => {
                setSymbol(next);
                setAsset(null);
                reset();
              }}
              onCommit={setAsset}
              autoFocus
              disabled={tradingLocked}
            />
          </div>

          <div className="min-w-[9rem] border border-line bg-canvas px-2 py-1.5">
            <div className="label">{marketOpen ? "Last" : "Prev close"}</div>
            {price ? (
              <>
                <Value value={price} flash className="text-lede">
                  {money(price)}
                </Value>
                <div className="mt-0.5">
                  {quote?.dayChange === null ? (
                    <span className="label label-ink">No change today</span>
                  ) : (
                    <Value value={quote?.dayChange} colorBySign className="text-[0.6875rem]">
                      {`${moneySigned(quote?.dayChange)}  ${percent(quote?.dayChangePercent)}`}
                    </Value>
                  )}
                </div>
              </>
            ) : (
              <div className="text-lede text-ink-faint">
                {valid ? <span className="pulse-dot">····</span> : "····"}
              </div>
            )}
          </div>
        </div>

        {security?.name && (
          <div className="-mt-2 truncate text-ink-dim">
            {security.name}
            <span className="text-ink-faint"> · {security.sector}</span>
          </div>
        )}

        {/* Side. Keycaps, matching the function keys. */}
        <div>
          <span className="label mb-1 block" id="order-side-label">
            Side
          </span>
          <div
            role="radiogroup"
            aria-labelledby="order-side-label"
            onKeyDown={onSideKeyDown}
            className="flex gap-1.5"
          >
            {ORDER_SIDES.map((candidate) => {
              const why = disabledSides[candidate];
              const selected = candidate === side;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  disabled={Boolean(why) || tradingLocked}
                  title={why ?? undefined}
                  onClick={() => {
                    setSide(candidate);
                    reset();
                  }}
                  className={`keycap min-w-[4.5rem] cursor-pointer transition-colors ${
                    selected ? "keycap-active" : "hover:border-accent hover:text-accent"
                  } disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint`}
                >
                  {candidate}
                </button>
              );
            })}
          </div>
        </div>

        {/* Order type, and the limit price it implies. */}
        <div className="grid grid-cols-[auto_1fr] items-end gap-3">
          <div>
            <span className="label mb-1 block" id="order-type-label">
              Type
            </span>
            <div role="radiogroup" aria-labelledby="order-type-label" className="flex gap-1.5">
              {ORDER_TYPES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={orderType === candidate}
                  disabled={tradingLocked}
                  onClick={() => {
                    setOrderType(candidate);
                    if (candidate === "MARKET") setLimitPrice("");
                    reset();
                  }}
                  className={`keycap min-w-[4.5rem] cursor-pointer ${
                    orderType === candidate
                      ? "keycap-active"
                      : "hover:border-accent hover:text-accent"
                  }`}
                >
                  {candidate === "MARKET" ? "MKT" : "LMT"}
                </button>
              ))}
            </div>
          </div>

          {orderType === "LIMIT" && (
            <div>
              <label htmlFor="order-limit" className="label mb-1 block">
                {side === "BUY" || side === "COVER" ? "Pay at most" : "Take at least"}
              </label>
              <div className="flex items-center border border-line bg-canvas focus-within:border-accent">
                <span className="num pl-2 text-ink-faint">$</span>
                <input
                  id="order-limit"
                  value={limitPrice}
                  onChange={(event) => {
                    setLimitPrice(event.target.value.replace(/[^0-9.]/g, ""));
                    reset();
                  }}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={price ? money(price) : "0.00"}
                  disabled={tradingLocked}
                  className="num w-full bg-transparent px-2 py-1.5 text-ink placeholder:text-ink-faint focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>

        {/* Amount, in shares or dollars. */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="order-amount" className="label">
              {mode === "SHARES" ? "Shares" : "Dollar amount"}
            </label>
            <div role="radiogroup" aria-label="Enter the order in" className="flex gap-1">
              {(["SHARES", "USD"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={mode === candidate}
                  disabled={candidate === "USD" && dollarsBlocked}
                  title={
                    candidate === "USD" && dollarsBlocked
                      ? `A working ${side} is entered in shares — how many shares a dollar amount closes is not known until it fills.`
                      : undefined
                  }
                  onClick={() => {
                    setMode(candidate);
                    setAmount("");
                    amountRef.current?.focus();
                  }}
                  className={`keycap min-w-[3.5rem] cursor-pointer ${
                    mode === candidate ? "keycap-active" : "hover:border-accent hover:text-accent"
                  } disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint`}
                >
                  {candidate === "USD" ? "USD" : "SHRS"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center border border-line bg-canvas focus-within:border-accent">
            {mode === "USD" && <span className="num pl-2 text-ink-faint">$</span>}
            <input
              id="order-amount"
              ref={amountRef}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value.replace(/[^0-9.]/g, ""));
                reset();
              }}
              inputMode="decimal"
              autoComplete="off"
              placeholder={mode === "SHARES" ? "10" : "500"}
              disabled={tradingLocked}
              className="num w-full bg-transparent px-2 py-1.5 text-lede text-ink placeholder:text-ink-faint focus:outline-none"
            />
            {sized && (
              <span className="label label-ink shrink-0 whitespace-nowrap pr-2">
                {mode === "SHARES"
                  ? `≈ ${money(sized.value)} USD`
                  : `≈ ${shares(sized.qty)} shares`}
              </span>
            )}
          </div>

          {asset?.fractionable === false && mode === "USD" && (
            <p className="label label-ink mt-1">
              {symbol} trades in whole shares, so this rounds down.
            </p>
          )}
        </div>

        {/* Time in force. Only meaningful once the order is going to rest. */}
        {willQueue && (
          <div>
            <span className="label mb-1 block" id="order-tif-label">
              Good for
            </span>
            <div role="radiogroup" aria-labelledby="order-tif-label" className="flex gap-1.5">
              {TIME_IN_FORCE.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={timeInForce === candidate}
                  onClick={() => setTimeInForce(candidate)}
                  className={`keycap min-w-[4.5rem] cursor-pointer ${
                    timeInForce === candidate
                      ? "keycap-active"
                      : "hover:border-accent hover:text-accent"
                  }`}
                >
                  {candidate}
                </button>
              ))}
              <span className="label label-ink self-center">
                {timeInForce === "DAY"
                  ? clock?.nextClose
                    ? `Expires ${stampET(clock.nextClose)} ET`
                    : "Expires at the next close"
                  : "Rests until filled or cancelled"}
              </span>
            </div>
          </div>
        )}

        {/* What you already hold. */}
        {held && (
          <div className="flex items-baseline gap-2 border-l-2 border-line-hi bg-panel-hi px-2 py-1.5">
            <span className="label shrink-0">Position</span>
            <span className="num text-ink">
              {held.qty < 0 ? "Short " : ""}
              {shares(Math.abs(held.qty))} {symbol}
            </span>
            <span className="text-ink-faint">at</span>
            <span className="num text-ink-dim">{money(held.avgCost)}</span>
            {price && (
              <Value value={(price - held.avgCost) * held.qty} colorBySign className="ml-auto">
                {moneySigned((price - held.avgCost) * held.qty)}
              </Value>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* The consequence line.                                            */}
        {/*                                                                  */}
        {/* Two different things to say. An order that fills moves cash and   */}
        {/* buying power now. An order that rests moves neither — it holds    */}
        {/* buying power aside and waits, so showing a cash movement would be */}
        {/* a straight lie about what the button does.                        */}
        {/* ---------------------------------------------------------------- */}
        {sized && consequence && price && (
          <div
            className={`border-l-2 px-2.5 py-2 ${
              blocker ? "border-loss bg-panel-hi" : "border-accent bg-accent-wash"
            }`}
          >
            <p className="num text-lede text-ink">
              {side} {shares(sized.qty)} {symbol}
              {orderType === "LIMIT" && limit ? (
                <>
                  {" "}
                  <span className="text-accent">{side === "BUY" || side === "COVER" ? "≤" : "≥"}</span>{" "}
                  {money(limit)}
                </>
              ) : (
                <> at {money(price)}</>
              )}
              <span className="label label-ink ml-2">{willQueue ? "when open" : "est."}</span>
            </p>

            {willQueue ? (
              <>
                <p className="mt-1.5 text-ink-dim">
                  {marketOpen
                    ? `${symbol} is at ${money(price)}, so this rests until it reaches your limit.`
                    : `The market is closed, so this rests until it opens${
                        clock?.nextOpen ? ` on ${stampET(clock.nextOpen)} ET` : ""
                      }. Nothing trades at a weekend.`}
                </p>

                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {reservation && reservation.cash > 0 && (
                    <>
                      <dt className="label self-center">Holds</dt>
                      <dd className="num text-ink">
                        {money(reservation.cash)}
                        <span className="px-1 text-accent-dim">of</span>
                        {money(freeBuyingPower)}
                        <span className="label label-ink ml-1.5">free buying power</span>
                      </dd>
                    </>
                  )}

                  {reservation && reservation.qty > 0 && (
                    <>
                      <dt className="label self-center">Holds</dt>
                      <dd className="num text-ink">
                        {shares(reservation.qty)} {symbol}
                        <span className="label label-ink ml-1.5">of your position</span>
                      </dd>
                    </>
                  )}
                </dl>

                {reservation?.buffered && (
                  <p className="label label-ink mt-1.5">
                    {MARKET_BUFFER_NOTE}
                  </p>
                )}
              </>
            ) : (
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr_auto_1fr]">
                <dt className="label self-center">Order value</dt>
                <dd className="num text-ink">{money(sized.value)}</dd>

                <dt className="label self-center">Cash</dt>
                <dd className="num text-ink-dim">
                  {money(totals.cash)}
                  <span className="px-1 text-accent-dim">→</span>
                  <span className="text-ink">{money(consequence.cashAfter)}</span>
                </dd>

                <dt className="label self-center">Buying power</dt>
                <dd className="num text-ink-dim">
                  {money(totals.buyingPower)}
                  <span className="px-1 text-accent-dim">→</span>
                  <span className={consequence.unaffordable ? "text-loss" : "text-ink"}>
                    {money(Math.max(0, consequence.buyingPowerAfter))}
                  </span>
                </dd>

                {consequence.realizing !== null && (
                  <>
                    <dt className="label self-center">Realises</dt>
                    <dd>
                      <Value value={consequence.realizing} colorBySign>
                        {moneySigned(consequence.realizing)}
                      </Value>
                    </dd>
                  </>
                )}
              </dl>
            )}
          </div>
        )}

        {blocker && (
          <p role="status" className="border-l-2 border-loss bg-panel-hi px-2.5 py-1.5 text-loss">
            {blocker}
          </p>
        )}

        {rejection && (
          <p role="alert" className="border-l-2 border-loss bg-panel-hi px-2.5 py-1.5 text-loss">
            {rejection.message}
          </p>
        )}

        {result && <Receipt result={result} />}

        <button
          type="submit"
          disabled={!ready}
          className="row flex w-full cursor-pointer items-center justify-center gap-2 border border-accent-dim bg-accent-wash font-medium uppercase tracking-[0.12em] text-accent transition-colors hover:border-accent hover:bg-accent hover:text-black disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint"
        >
          {place.isPending ? (
            <span className="pulse-dot">Sending</span>
          ) : sized && valid ? (
            // The button says exactly what it will do, and the receipt says the
            // same words back in the past tense.
            <span className="num">
              {verb} {shares(sized.qty)} {symbol}
            </span>
          ) : (
            <span>Enter an order</span>
          )}
        </button>
      </form>
    </Panel>
  );
}

const MARKET_BUFFER_NOTE =
  "A market order in shares has no price until it fills, so 5% over the last price is held in case it opens higher. A dollar amount, or a limit, holds exactly its own number.";

/**
 * What happened. Two outcomes, deliberately worded so they cannot be confused:
 * a fill is in the past tense, a queue is in the future.
 */
function Receipt({ result }: { result: OrderResponse }) {
  if (result.status === "QUEUED") {
    const { order } = result;
    return (
      <div role="status" className="border-l-2 border-accent bg-panel-hi px-2.5 py-2">
        <p className="num text-ink">
          Queued {order.side} {order.qty ? shares(order.qty) : money(order.notional)}
          {order.notional ? " of " : " "}
          {order.symbol}
          {order.limitPrice && (
            <>
              {" "}
              <span className="text-accent">
                {order.side === "BUY" || order.side === "COVER" ? "≤" : "≥"}
              </span>{" "}
              {money(order.limitPrice)}
            </>
          )}
        </p>
        <p className="label label-ink mt-1">
          {result.reason}
          {Number(order.reservedCash) > 0 && ` · ${money(order.reservedCash)} held`}
          {Number(order.reservedQty) > 0 && ` · ${shares(order.reservedQty)} shares held`}
        </p>
      </div>
    );
  }

  const past: Record<OrderSide, string> = {
    BUY: "Bought",
    SELL: "Sold",
    SHORT: "Shorted",
    COVER: "Covered",
  };
  const realized = Number(result.trade.realizedPnl);

  return (
    <div role="status" className="border-l-2 border-gain bg-panel-hi px-2.5 py-2">
      <p className="num text-ink">
        {past[result.trade.side]} {shares(result.trade.qty)} {result.trade.symbol} at{" "}
        {money(result.trade.price)}
        {realized !== 0 && (
          <>
            <span className="text-ink-faint"> · </span>
            <span className={signColor(realized)}>{moneySigned(realized)} realised</span>
          </>
        )}
      </p>
      <p className="label label-ink mt-1">
        Cash {money(result.portfolio.cash)} · Buying power {money(result.portfolio.buyingPower)}
      </p>
    </div>
  );
}
