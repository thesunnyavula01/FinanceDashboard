import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  hasLimit,
  hasStop,
  stopFiresOnRise,
  ORDER_SIDES,
  ORDER_TYPES,
  ORDER_TYPE_KEY,
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
import { money, moneySigned, percent, premium, shares, signColor, stampET } from "@/lib/format";
import { usePlaceOrder } from "@/hooks/usePortfolio";
import { useQuotes, useSecurities } from "@/hooks/useQuotes";
import {
  ASSET_CLASSES,
  CLASS_COPY,
  allowsShort,
  classify,
  formatContract,
  isTradableSymbol,
  multiplierFor,
  underlyingOf,
  type AssetClass,
} from "@/lib/symbols";
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
  /**
   * Fired whenever the instrument changes — the class or the symbol.
   *
   * F2 follows it: OPTION shows the chain, and the chain follows whatever
   * underlying is in the field, so typing AAPL here loads AAPL's contracts
   * without a second place to type it.
   */
  onInstrumentChange?: (symbol: string, assetClass: AssetClass) => void;
}

type AmountMode = "SHARES" | "USD";

/**
 * What survives an instrument switch.
 *
 * Exported-shaped as a pure function so the rule is one place and readable:
 * everything is dropped except the two directions between a stock and its own
 * options, where the symbol on screen is still about the same company.
 */
function carryOver(symbol: string, from: AssetClass, to: AssetClass): string {
  if (!symbol) return "";
  if (classify(symbol) === to) return symbol;
  // AAPL -> the chain's underlying.
  if (to === "OPTION" && classify(symbol) === "EQUITY") return symbol;
  // AAPL260116C00150000 -> AAPL.
  if (from === "OPTION" && to === "EQUITY") return underlyingOf(symbol) ?? "";
  return "";
}

/** The keycap opposite USD. Four characters, so the two stay the same width. */
const UNIT_KEY: Record<AssetClass, string> = {
  EQUITY: "SHRS",
  OPTION: "CTRS",
  CRYPTO: "UNIT",
};


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
  onInstrumentChange,
}: OrderTicketProps) {
  const [symbol, setSymbol] = useState(initial?.symbol ?? "");
  const [side, setSide] = useState<OrderSide>(initial?.side ?? "BUY");
  const [orderType, setOrderType] = useState<OrderType>(initial?.orderType ?? "MARKET");
  const [limitPrice, setLimitPrice] = useState(
    initial?.limitPrice !== undefined ? String(initial.limitPrice) : "",
  );
  const [stopPrice, setStopPrice] = useState("");
  const [trail, setTrail] = useState("");
  const [trailMode, setTrailMode] = useState<"USD" | "PCT">("PCT");
  // Schwab never submits on one press: Review Order, then Place Order. The
  // readback below was already the confirmation, so review does not repeat it —
  // it freezes it, and puts the irreversible press behind a second deliberate
  // one on a panel the member has had a chance to read.
  const [reviewing, setReviewing] = useState(false);
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("DAY");
  const [mode, setMode] = useState<AmountMode>(initial?.notional !== undefined ? "USD" : "SHARES");
  const [amount, setAmount] = useState(
    initial?.qty !== undefined
      ? String(initial.qty)
      : initial?.notional !== undefined
        ? String(initial.notional)
        : "",
  );
  // The instrument being traded. Seeded from a prefilled symbol so the command
  // bar can still hand over "BUY 500 NVDA" without knowing this control exists.
  const [assetClass, setAssetClass] = useState<AssetClass>(
    initial?.symbol ? classify(initial.symbol) : "EQUITY",
  );
  const [asset, setAsset] = useState<SymbolMatch | null>(null);
  const [result, setResult] = useState<OrderResponse | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const place = usePlaceOrder();

  const valid = isTradableSymbol(symbol) && classify(symbol) === assetClass;
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
  const copy = CLASS_COPY[assetClass];
  const multiplier = multiplierFor(symbol);
  const alwaysOpen = assetClass === "CRYPTO";

  const disabledSides = useMemo(() => {
    const byPosition = availableSides(held);
    if (allowsShort(symbol) && assetClass === "EQUITY") return byPosition;

    // Options and crypto are long only: no margin model for a naked short call,
    // no borrow for a coin. Refused here as well as by the Worker, because a
    // disabled key with a reason on hover teaches more than a rejection does.
    const reason =
      assetClass === "OPTION"
        ? "Options are long only here — buy to open, sell to close."
        : "Crypto is long only here: there is no borrow to short against.";
    return { ...byPosition, SHORT: reason, COVER: reason };
  }, [held, symbol, assetClass]);

  // The distinct reasons behind the greyed-out keys. Deduplicated because the
  // long-only rule disables SHORT and COVER with the same sentence, and
  // printing it twice would read as two different rules.
  const sideReasons = useMemo(
    () => [
      ...new Set(
        ORDER_SIDES.map((candidate) => disabledSides[candidate]).filter(
          (reason): reason is string => Boolean(reason),
        ),
      ),
    ],
    [disabledSides],
  );

  // Crypto has no bell, so the exchange calendar has nothing to say about it.
  const marketOpen = alwaysOpen || Boolean(clock?.isOpen && clock.authoritative);
  const closing = side === "SELL" || side === "COVER";

  useEffect(() => {
    if (disabledSides[side]) {
      const next = ORDER_SIDES.find((candidate) => !disabledSides[candidate]);
      if (next) setSide(next);
    }
  }, [disabledSides, side]);

  const price = quote?.price ?? null;
  const limit = limitPrice.trim() === "" ? null : Number(limitPrice);
  const stop = stopPrice.trim() === "" ? null : Number(stopPrice);
  const trailValue = trail.trim() === "" ? null : Number(trail);
  const isStop = hasStop(orderType);
  const isTrailing = orderType === "TRAILING_STOP";

  // Where a trailing stop's trigger starts. It is derived from the market, not
  // typed, and the Worker recomputes it on the same quote when the order lands
  // — this is the member's preview of that number.
  const trailingTrigger =
    isTrailing && price !== null && trailValue !== null && trailValue > 0
      ? stopFiresOnRise(side)
        ? price + (trailMode === "USD" ? trailValue : (price * trailValue) / 100)
        : price - (trailMode === "USD" ? trailValue : (price * trailValue) / 100)
      : null;

  /** The trigger actually in play: typed for a stop, derived for a trail. */
  const trigger = isTrailing ? trailingTrigger : stop;

  /**
   * Is the stop on the correct side of the market?
   *
   * A stop is the mirror of a limit: BUY and COVER trigger when the price rises
   * to them, SELL and SHORT when it falls. Placed on the wrong side it would
   * fire on the next tick, which means the member meant a market order — so the
   * Worker refuses it, and the ticket says so first rather than letting them
   * press a button that cannot work.
   */
  const stopMisplaced =
    isStop && !isTrailing && stop !== null && price !== null && stop > 0
      ? stopFiresOnRise(side)
        ? stop <= price
          ? `A ${side} stop has to sit above the market. ${money(price)} or below is a market order.`
          : null
        : stop >= price
          ? `A ${side} stop has to sit below the market, which is ${money(price)}.`
          : null
      : null;
  const limitValid = orderType === "MARKET" || (Number.isFinite(limit) && (limit as number) > 0);

  const parsedAmount = Number(amount);
  const hasAmount = amount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount > 0;

  // Will this fill now, or rest? Two conditions, both of which the member can
  // see for themselves on this screen: is there a session, and has the price
  // reached the limit.
  // A stop never fills on the way in — its trigger is on the far side of the
  // market by construction, so it always rests and the sweep decides.
  const willQueue =
    isStop || !marketOpen || (price !== null && !isMarketable(side, orderType, limit, price));

  // A working close is entered in shares. The number of shares a dollar amount
  // closes is not known until it fills, and the conversion runs the wrong way —
  // the cheaper the fill, the more shares "$500" turns out to be.
  // A stop has no price until it triggers, so a dollar amount has nothing
  // honest to convert at — the same reason a working close is in shares.
  const dollarsBlocked = (willQueue && closing) || isStop;

  useEffect(() => {
    if (dollarsBlocked && mode === "USD") setMode("SHARES");
  }, [dollarsBlocked, mode]);

  /**
   * What the estimate is built on.
   *
   * A limit order sizes against its own price. A stop sizes against its
   * trigger, because that is the earliest it can trade and the last price is on
   * the wrong side of it. Everything else sizes against the market.
   */
  const sizingPrice = hasLimit(orderType) && limit ? limit : isStop && trigger ? trigger : price;

  const sized = useMemo(() => {
    if (!hasAmount || !sizingPrice) return null;

    // A dollar amount buys what one UNIT costs, which for a contract is a
    // hundred times the premium. Dividing by the premium would size the order a
    // hundredfold. Mirrors resolveQuantity() in the order engine.
    let qty =
      mode === "SHARES"
        ? parsedAmount
        : Math.floor((parsedAmount / (sizingPrice * multiplier)) * 1e6) / 1e6;
    // A contract is indivisible whatever the universe says — options are not in
    // the asset list at all, so `fractionable` never arrives for one.
    if (asset?.fractionable === false || multiplier > 1) qty = Math.floor(qty);
    if (!(qty > 0)) return null;

    return { qty, value: qty * multiplier * sizingPrice };
  }, [hasAmount, parsedAmount, sizingPrice, mode, asset, multiplier]);

  const reservation = useMemo(() => {
    if (!sized || !willQueue || !price) return null;
    return estimateReservation({
      side,
      orderType,
      limitPrice: limit,
      stopPrice: trigger,
      qty: mode === "SHARES" ? sized.qty : undefined,
      notional: mode === "USD" ? parsedAmount : undefined,
      referencePrice: price,
    });
  }, [sized, willQueue, price, side, orderType, limit, trigger, mode, parsedAmount]);

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

  // The venue publishes a floor per pair — 0.000001 BTC, 0.001 ETH — and an
  // order under it is refused at the exchange, not by us. Better to say so
  // while it can still be fixed than to queue something that cannot fill.
  const minSize = asset?.minOrderSize ?? null;
  const underMinimum =
    minSize !== null && sized !== null && sized.qty > 0 && sized.qty < minSize;

  const stopValid = !isStop || (isTrailing ? trailValue !== null && trailValue > 0 : stop !== null && stop > 0);

  const blocker = tradingLocked
    ? "Trading is locked for this season."
    : sideBlocked
      ? sideBlocked
      : !valid || !price
        ? null
        : !limitValid
          ? "Enter a limit price."
        : !stopValid
          ? isTrailing
            ? "Enter how far the stop should trail."
            : "Enter a stop price."
        : stopMisplaced
          ? stopMisplaced
        : underMinimum
          ? `The smallest ${symbol} order this venue takes is ${shares(minSize)}.`
          : cannotReserve
            ? `Queueing this holds ${money(reservation!.cash)}, and you have ${money(freeBuyingPower)} free.`
            : !willQueue && consequence?.unaffordable
              ? `That is more than your buying power of ${money(totals.buyingPower)}.`
              : null;

  const ready =
    valid &&
    Boolean(price) &&
    Boolean(sized) &&
    limitValid &&
    stopValid &&
    !blocker &&
    !place.isPending;

  // Any edit invalidates a review. Otherwise a member could open the review,
  // change the quantity behind it, and place an order the panel never showed
  // them — which is the one failure a confirmation step exists to prevent.
  useEffect(() => {
    setReviewing(false);
  }, [symbol, side, orderType, amount, mode, limitPrice, stopPrice, trail, trailMode, timeInForce]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || !sized) return;

    // First press reviews, second places. The readback was already the
    // confirmation — this freezes it, so the irreversible press lands on a
    // panel the member has had the chance to read rather than on a label that
    // was still changing under their cursor.
    if (!reviewing) {
      setReviewing(true);
      return;
    }

    setResult(null);
    place.mutate(
      {
        symbol,
        side,
        orderType,
        ...(hasLimit(orderType) ? { limitPrice: limit as number } : {}),
        ...(isStop && !isTrailing ? { stopPrice: stop as number } : {}),
        ...(isTrailing && trailMode === "USD" ? { trailAmount: trailValue as number } : {}),
        ...(isTrailing && trailMode === "PCT" ? { trailPercent: trailValue as number } : {}),
        ...(mode === "SHARES" ? { qty: parsedAmount } : { notional: parsedAmount }),
        timeInForce,
      },
      {
        onSuccess: (response) => {
          setResult(response);
          setReviewing(false);
          setAmount("");
          amountRef.current?.focus();
        },
        onError: () => setReviewing(false),
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

  function onClassKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = ASSET_CLASSES.indexOf(assetClass);
    switchClass(ASSET_CLASSES[(index + delta + ASSET_CLASSES.length) % ASSET_CLASSES.length]!);
  }

  /**
   * Change instrument, and keep only what still means something.
   *
   * A ticker left over from the previous class would sit in the field looking
   * valid and quietly price against the wrong venue — NVDA is not a pair, and
   * BTC/USD is not a stock. So it is dropped.
   *
   * The two option cases are the exception, because a ticker and a contract are
   * not unrelated. Switching **to** OPTION keeps an equity ticker, since the
   * field is now labelled Underlying and AAPL is exactly what the chain beside
   * it needs — clearing it would make the member retype the thing they had just
   * typed. Switching **away** from a contract keeps its underlying, so leaving
   * the chain to buy the stock outright does not start from an empty field.
   * Neither can be submitted as-is: the button stays disabled until the symbol
   * matches the class.
   *
   * The side goes back to BUY because it is the only one every class has.
   */
  function switchClass(next: AssetClass) {
    if (next === assetClass) return;
    const carried = carryOver(symbol, assetClass, next);
    setAssetClass(next);
    // F2's right-hand panel follows the instrument: picking OPTION shows the
    // chain, because a contract has to be found before it can be typed. Nothing
    // is lost — the blotter is one click back. The symbol goes too, since
    // switching class clears one that no longer belongs.
    onInstrumentChange?.(carried, next);
    if (carried !== symbol) {
      setSymbol(carried);
      setAsset(null);
    }
    setSide("BUY");
    setAmount("");
    // Crypto has no close to expire at, so a working crypto order is
    // good-til-cancelled and the choice is not offered.
    setTimeInForce(next === "CRYPTO" ? "GTC" : "DAY");
    reset();
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
        {/*
          Ticker, with the quote beside it — and under it on a phone. Side by
          side, the price box takes a fixed 9rem out of a 340px panel and the
          symbol field is left with barely room for the twenty-one characters
          of an OCC contract it is required to hold. Stacked, both are full
          width and the quote sits directly under the ticker it belongs to,
          which is the reading order anyway.
        */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            {/*
              The instrument selector rides on the label row rather than taking
              a row of its own, which is what keeps this screen the same height
              it was. It is drawn as underlined text, not as keycaps: a keycap
              here would read as a fourth verb next to BUY and SELL, and this is
              a mode rather than an action. Filled keycap = does something,
              underline = changes what the panel is.
            */}
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label htmlFor="order-symbol" className="label">
                {copy.field}
              </label>
              <div
                role="radiogroup"
                aria-label="Instrument"
                onKeyDown={onClassKeyDown}
                className="flex items-baseline gap-2"
              >
                {ASSET_CLASSES.map((candidate) => {
                  const selected = candidate === assetClass;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      disabled={tradingLocked}
                      onClick={() => switchClass(candidate)}
                      className={`label cursor-pointer border-b pb-0.5 transition-colors ${
                        selected
                          ? "border-accent text-accent"
                          : "border-transparent text-ink-faint hover:text-ink-dim"
                      } disabled:cursor-not-allowed`}
                    >
                      {candidate}
                    </button>
                  );
                })}
              </div>
            </div>
            <SymbolSearch
              value={symbol}
              onChange={(next) => {
                setSymbol(next);
                setAsset(null);
                reset();
                onInstrumentChange?.(next, assetClass);
              }}
              onCommit={setAsset}
              autoFocus
              disabled={tradingLocked}
              placeholder={copy.placeholder}
              // In OPTION mode the field holds an underlying, and an underlying
              // is an equity — a contract is picked off the chain, never typed,
              // and the option universe is far too large for autocomplete.
              assetClass={assetClass === "OPTION" ? "EQUITY" : assetClass}
            />
          </div>

          <div className="border border-line bg-canvas px-2 py-1.5 sm:min-w-[9rem]">
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
          {/*
            Four keycaps at 4.5rem apiece plus their gaps is 18.5rem, and the
            ticket panel on a 390px phone is about 20rem of usable width — so
            they fit, but only just, and a slightly narrower phone would wrap
            SHORT and COVER onto a second line with the first two stretched
            across the first. Sharing the row equally instead keeps the four
            sides one rank of equal keys at every width, which is what makes
            "the disabled ones are the ones this instrument does not have"
            readable at a glance.
          */}
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
                  className={`keycap flex-1 cursor-pointer transition-colors sm:min-w-[4.5rem] sm:flex-none ${
                    selected ? "keycap-active" : "hover:border-accent hover:text-accent"
                  } disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint`}
                >
                  {candidate}
                </button>
              );
            })}
          </div>

          {/*
            The reason, in text, on a phone.

            A disabled key with the reason on hover is the right answer on a
            desktop and no answer at all on a touch screen, where there is no
            hover and a `title` never fires. This ticket's whole argument is
            that a greyed-out SHORT which explains itself teaches more than a
            rejection does — so on a phone the explanation has to be on the
            screen. It is one line under the rail, and only when something is
            actually refused.
          */}
          {sideReasons.length > 0 && (
            <p className="label label-ink mt-1 normal-case tracking-normal md:hidden">
              {sideReasons.join(" ")}
            </p>
          )}
        </div>

        {/* Order type. Five of them now, so the rail wraps rather than squeezes. */}
        <div>
          <span className="label mb-1 block" id="order-type-label">
            Type
          </span>
          <div
            role="radiogroup"
            aria-labelledby="order-type-label"
            className="flex flex-wrap gap-1.5"
          >
            {ORDER_TYPES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={orderType === candidate}
                aria-label={candidate.replace("_", " ").toLowerCase()}
                disabled={tradingLocked}
                onClick={() => {
                  setOrderType(candidate);
                  // Each type owns its own fields, and a value left behind from
                  // the previous one would be submitted invisibly — the Worker
                  // refuses a market order carrying a limit price, and is right to.
                  if (!hasLimit(candidate)) setLimitPrice("");
                  if (!hasStop(candidate) || candidate === "TRAILING_STOP") setStopPrice("");
                  if (candidate !== "TRAILING_STOP") setTrail("");
                  reset();
                }}
                className={`keycap min-w-[3.25rem] cursor-pointer ${
                  orderType === candidate
                    ? "keycap-active"
                    : "hover:border-accent hover:text-accent"
                }`}
              >
                {ORDER_TYPE_KEY[candidate]}
              </button>
            ))}
          </div>
        </div>

        {/* The prices the chosen type implies. A stop-limit carries both. */}
        {(hasLimit(orderType) || isStop) && (
          // A stop-limit carries both prices. On a phone they stack: two
          // money fields sharing a 340px row leaves each about eight
          // characters wide, and "Pay at most" over a field holding 1,234.56
          // is the pair a member has to read most carefully.
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
            {isStop && (
              <div className={hasLimit(orderType) ? "" : "sm:col-span-2"}>
                <label htmlFor="order-stop" className="label mb-1 block">
                  {isTrailing
                    ? `Trail by ${trailMode === "USD" ? "dollars" : "percent"}`
                    : `Stop ${stopFiresOnRise(side) ? "above" : "below"}`}
                </label>

                {isTrailing ? (
                  <div className="flex items-center border border-line bg-canvas focus-within:border-accent">
                    <input
                      id="order-stop"
                      value={trail}
                      onChange={(event) => {
                        setTrail(event.target.value.replace(/[^0-9.]/g, ""));
                        reset();
                      }}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={trailMode === "USD" ? "1.00" : "5"}
                      disabled={tradingLocked}
                      className="num w-full bg-transparent px-2 py-1.5 text-ink placeholder:text-ink-faint focus:outline-none"
                    />
                    <div role="radiogroup" aria-label="Trail in" className="flex gap-1 pr-1.5">
                      {(["PCT", "USD"] as const).map((candidate) => (
                        <button
                          key={candidate}
                          type="button"
                          role="radio"
                          aria-checked={trailMode === candidate}
                          disabled={tradingLocked}
                          onClick={() => {
                            setTrailMode(candidate);
                            setTrail("");
                            reset();
                          }}
                          className={`keycap min-w-[2.25rem] cursor-pointer ${
                            trailMode === candidate
                              ? "keycap-active"
                              : "hover:border-accent hover:text-accent"
                          }`}
                        >
                          {candidate === "PCT" ? "%" : "$"}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center border border-line bg-canvas focus-within:border-accent">
                    <span className="num pl-2 text-ink-faint">$</span>
                    <input
                      id="order-stop"
                      value={stopPrice}
                      onChange={(event) => {
                        setStopPrice(event.target.value.replace(/[^0-9.]/g, ""));
                        reset();
                      }}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={price ? money(price) : "0.00"}
                      disabled={tradingLocked}
                      className="num w-full bg-transparent px-2 py-1.5 text-ink placeholder:text-ink-faint focus:outline-none"
                    />
                  </div>
                )}
              </div>
            )}

            {hasLimit(orderType) && (
              <div className={isStop ? "" : "sm:col-span-2"}>
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
        )}

        {/*
          What the trigger actually means, in the member's own numbers.

          The sentence says "then fills at the market — not at your stop"
          deliberately: a stop-loss is not a guaranteed price, and a gap through
          it is the single most expensive surprise in retail trading. Better
          learned on a paper account, from a line of text, than from a fill.
        */}
        {isStop && (
          <p className={stopMisplaced ? "text-loss" : "text-ink-dim"}>
            {stopMisplaced ??
              (isTrailing
                ? trailingTrigger !== null
                  ? `Follows the ${stopFiresOnRise(side) ? "low" : "high"} and triggers ${trailMode === "USD" ? money(Number(trail)) : `${trail}%`} ${stopFiresOnRise(side) ? "above" : "below"} it — ${money(trailingTrigger)} from here. The trigger only ever moves in your favour.`
                  : `Follows the ${stopFiresOnRise(side) ? "low" : "high"} and triggers a set distance ${stopFiresOnRise(side) ? "above" : "below"} it.`
                : stop !== null
                  ? `Triggers when ${symbol || "the price"} ${stopFiresOnRise(side) ? "reaches" : "falls to"} ${money(stop)}, then ${orderType === "STOP_LIMIT" ? "becomes a limit order" : "fills at the market"} — not at ${money(stop)}.`
                  : `Waits until the price ${stopFiresOnRise(side) ? "rises to" : "falls to"} your stop, then ${orderType === "STOP_LIMIT" ? "becomes a limit order" : "fills at the market"}.`)}
          </p>
        )}

        {/* Amount, in shares or dollars. */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="order-amount" className="label">
              {mode === "SHARES" ? copy.units : "Dollar amount"}
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
                      ? isStop
                        ? `A ${orderType.replace("_", " ").toLowerCase()} has no price until it triggers, so there is nothing to convert a dollar amount at. Enter ${copy.units.toLowerCase()}.`
                        : `A working ${side} is entered in ${copy.units.toLowerCase()} — how many a dollar amount closes is not known until it fills.`
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
                  {candidate === "USD" ? "USD" : UNIT_KEY[assetClass]}
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
                  : `≈ ${shares(sized.qty)} ${copy.units.toLowerCase()}`}
              </span>
            )}
          </div>

          {(asset?.fractionable === false || multiplier > 1) && mode === "USD" && (
            <p className="label label-ink mt-1">
              {multiplier > 1
                ? `One contract is ${multiplier} shares, so this rounds down to whole contracts.`
                : `${symbol} trades in whole shares, so this rounds down.`}
            </p>
          )}
        </div>

        {/*
          Time in force. Only meaningful once the order is going to rest — and
          for crypto there is nothing to choose: a day order needs a close, and
          there isn't one. It is stated instead of offered.
        */}
        {willQueue && alwaysOpen && (
          <div>
            <span className="label mb-1 block">Good for</span>
            <p className="text-ink-dim">
              Until you cancel it. {symbol} trades around the clock, so there is no close for a
              day order to expire at.
            </p>
          </div>
        )}

        {willQueue && !alwaysOpen && (
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
          // Wraps rather than truncating. Four fragments on one line is a
          // desktop row; on a phone "Short 100 AAPL260116C00150000 at $5.25"
          // is wider than the panel, and this is the line that tells a member
          // whether they are about to add to a position or close one.
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 border-line-hi bg-panel-hi px-2 py-1.5">
            <span className="label shrink-0">Position</span>
            <span className="num text-ink">
              {held.qty < 0 ? "Short " : ""}
              {shares(Math.abs(held.qty))} {formatContract(symbol)}
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
                <> at {premium(price, multiplier)}</>
              )}
              <span className="label label-ink ml-2">{willQueue && !alwaysOpen ? "when open" : "est."}</span>
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

        {/*
          The review panel, between the two presses.

          It repeats the order in full rather than summarising it, because the
          whole value of a second press is that the thing being confirmed is
          the thing that will happen. Every figure here is the same one the
          readback above was already showing — frozen, not recomputed.
        */}
        {reviewing && sized && (
          <div role="group" aria-label="Review your order" className="border border-accent-dim bg-panel-hi">
            <p className="label border-b border-line px-2.5 py-1.5 text-accent">Review your order</p>
            {/*
              One column on a phone. This panel is the second of the two
              presses and the only thing standing between a member and a live
              order, so every line of it has to be readable in full — a
              two-column review at 340px puts "Order" over a truncated
              "SELL 3 AAPL 16JA…" and the point of freezing the order was that
              what is confirmed is what will happen.
            */}
            <dl className="grid grid-cols-1 gap-x-3 gap-y-1 px-2.5 py-2 sm:grid-cols-2">
              <ReviewRow label="Order">
                {verb} {shares(sized.qty)} {formatContract(symbol)}
              </ReviewRow>
              <ReviewRow label="Type">
                {orderType.replace("_", " ")}
                {hasLimit(orderType) && limit ? ` at ${money(limit)}` : ""}
              </ReviewRow>
              {isStop && (
                <ReviewRow label={isTrailing ? "Trails by" : "Stop"}>
                  {isTrailing
                    ? trailMode === "USD"
                      ? money(trailValue ?? 0)
                      : `${trail}%`
                    : money(stop ?? 0)}
                  {trigger !== null && isTrailing ? ` — ${money(trigger)} now` : ""}
                </ReviewRow>
              )}
              <ReviewRow label="Good for">
                {alwaysOpen ? "Until cancelled" : timeInForce === "DAY" ? "The day" : "Until cancelled"}
              </ReviewRow>
              <ReviewRow label={willQueue ? "Est. when it fills" : "Est. principal"}>
                {money(sized.value)}
              </ReviewRow>
              {reservation && reservation.cash > 0 && (
                <ReviewRow label="Held while it rests">{money(reservation.cash)}</ReviewRow>
              )}
            </dl>
          </div>
        )}

        <div className="flex gap-2">
          {reviewing && (
            <button
              type="button"
              onClick={() => setReviewing(false)}
              className="row cursor-pointer border border-line px-3 font-medium uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-accent hover:text-accent"
            >
              Edit
            </button>
          )}
          <button
            type="submit"
            disabled={!ready}
            className="row flex flex-1 cursor-pointer items-center justify-center gap-2 border border-accent-dim bg-accent-wash font-medium uppercase tracking-[0.12em] text-accent transition-colors hover:border-accent hover:bg-accent hover:text-black disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint"
          >
            {place.isPending ? (
              <span className="pulse-dot">Sending</span>
            ) : !sized || !valid ? (
              <span>Enter an order</span>
            ) : reviewing ? (
              // The second press. Named for what it does, not for what it
              // reviews — "Place order" is the last thing the member reads.
              <span>Place order</span>
            ) : (
              // The first press still says exactly what the order will do, so
              // the review panel is a confirmation rather than a reveal.
              <span className="num">
                {verb} {shares(sized.qty)} {symbol}
              </span>
            )}
          </button>
        </div>
      </form>
    </Panel>
  );
}

/** One labelled figure in the review panel. */
/**
 * One line of the review panel.
 *
 * A `<div>` grouping its own `<dt>`/`<dd>` rather than a fragment dropped into
 * the parent grid — which is valid in a `<dl>` and is what lets the pair stay a
 * label-then-figure line whether the grid around it is one column or two. As
 * loose grid items they would separate the moment the grid narrowed, leaving a
 * right-aligned number under a left-aligned label with the full width of the
 * panel between them.
 */
function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="label shrink-0">{label}</dt>
      <dd className="num truncate text-right text-ink">{children}</dd>
    </div>
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
