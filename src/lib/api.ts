/**
 * Typed client for the Worker API.
 *
 * Everything the browser needs comes through /api/*. The client never talks to
 * Alpaca, Finnhub, or the database directly — those need secrets, and secrets
 * stay in the Worker.
 */

import { accessToken } from "./supabase";
import type { AssetClass } from "./symbols";

export type SessionState = "OPEN" | "CLOSED" | "PRE" | "POST";

export interface HealthResponse {
  ok: boolean;
  app: string;
  phase: number;
  serverTime: string;
  session: MarketSession;
}

export interface MarketSession {
  state: SessionState;
  label: string;
  /**
   * True when it came from the exchange calendar, which knows holidays and
   * half-days. False means Alpaca was unreachable and this is a guess from New
   * York clock hours, which the status rail labels as an estimate.
   */
  authoritative: boolean;
  nextOpen: string | null;
  nextClose: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * A machine-readable reason, when the route sent one. Order rejections use
     * it so the ticket can style "you cannot afford this" differently from "the
     * market is shut" without matching on message text.
     */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface MeResponse {
  id: string;
  email: string | null;
  displayName: string;
  role: "member" | "admin";
  portfolio: {
    id: string;
    cash: string;
    season_id: string;
    seasons: {
      name: string;
      starting_cash: string;
      trading_locked: boolean;
      is_active: boolean;
    } | null;
  } | null;
}

interface RequestOptions extends RequestInit {
  /** Attach the current session token. Required by every route behind auth. */
  authed?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { authed, ...init } = options;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  if (authed) {
    const token = await accessToken();
    if (!token) throw new ApiError("Sign in to continue.", 401);
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api${path}`, { ...init, headers });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    throw new ApiError(
      body?.error ?? `Request failed (${response.status})`,
      response.status,
      body?.code ?? null,
    );
  }

  return response.json() as Promise<T>;
}

/**
 * A live price. Every field is priced by the Worker — a client that invents a
 * price gets it ignored, which is why nothing here is ever sent back up.
 */
export interface Quote {
  symbol: string;
  price: number;
  /**
   * Which field upstream produced `price`. "bar" outside market hours means
   * the official close rather than a thin extended-hours print.
   */
  source: "trade" | "quote" | "bar" | "prev-bar";
  prevClose: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  asOf: string | null;
}

export interface QuotesResponse {
  quotes: Record<string, Quote>;
  /** Valid-looking tickers no provider could price. */
  unknown: string[];
  /** Malformed tickers, dropped before they reached a provider. */
  rejected: string[];
  asOf: string;
  cache: { memory: number; edge: number; fetched: number };
  limit: number;
}

export interface Security {
  symbol: string;
  name: string | null;
  sector: string;
  industry: string | null;
  assetType: "STOCK" | "ETF";
  logoUrl: string | null;
}

export interface SecuritiesResponse {
  securities: Record<string, Security>;
  /** Symbols being looked up right now. They arrive on a later request. */
  pending: string[];
  rejected: string[];
}

/** One row of the option chain. No greeks — see `worker/market/options.ts`. */
export interface ChainContract {
  symbol: string;
  underlying: string;
  expiration: string;
  type: "CALL" | "PUT";
  strike: number;
  multiplier: number;
  openInterest: number | null;
  tradable: boolean;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** What an order would fill against — the midpoint where there is one. */
  mark: number | null;
}

export interface ChainResponse {
  underlying: string;
  underlyingPrice: number | null;
  expirations: string[];
  expiration: string | null;
  contracts: ChainContract[];
}

export interface SymbolMatch {
  symbol: string;
  name: string;
  fractionable: boolean;
  shortable: boolean;
  easyToBorrow: boolean;
  /**
   * The smallest order the venue will take. Alpaca publishes it per crypto
   * pair and not at all for equities, where one share is the floor and
   * `fractionable` already says so.
   */
  minOrderSize?: number;
}

export interface SymbolSearchResponse {
  results: SymbolMatch[];
  /** The asset universe has never been synced; a sync was just kicked off. */
  warming: boolean;
}

export interface ClockResponse extends MarketSession {
  isOpen: boolean;
  serverTime: string;
}

export type OrderSide = "BUY" | "SELL" | "SHORT" | "COVER";

export const ORDER_SIDES: OrderSide[] = ["BUY", "SELL", "SHORT", "COVER"];

/**
 * What the blotter can contain, which is one more thing than can be ordered.
 *
 * An option reaching its expiration date is settled for cash at intrinsic
 * value by the nightly job. Nobody placed it, and the price can be zero, so it
 * is its own side rather than a SELL a member never asked for.
 */
export type TradeSide = OrderSide | "EXPIRE";

/**
 * A holding. `qty` is signed — negative is short — which is what lets one P/L
 * formula, (price - avgCost) * qty, be correct in both directions.
 */
export interface PositionRow {
  symbol: string;
  qty: number;
  /** Per share. For an option this is the premium, not the contract cost. */
  avgCost: number;
  /** Shares per unit: 100 for an option contract, 1 for everything else. */
  multiplier?: number;
}

export interface PortfolioResponse {
  portfolio: {
    id: string;
    cash: number;
    /**
     * What this member was funded with — the denominator of their total return.
     * Not the season's figure: an officer can change that from the admin
     * console, and a member's baseline must not move when they do.
     */
    startingCash: number;
    season: {
      id: string;
      name: string;
      /** What a member joining now would be funded with. Display only. */
      defaultStartingCash: number;
      tradingLocked: boolean;
    };
  } | null;
  positions: PositionRow[];
  /** Why the portfolio is null, when it is. Shown to the member as-is. */
  note?: string;
}

export type CurveRange = "1D" | "1W" | "1M" | "3M" | "1Y" | "ALL";

export const CURVE_RANGES: CurveRange[] = ["1D", "1W", "1M", "3M", "1Y", "ALL"];

/**
 * One point on the equity curve.
 *
 * Every series is in dollars. `me` is the account as it is; the benchmarks are
 * what the same money would have been worth had it gone there instead, which is
 * how a $640 share of SPY ends up drawable on an axis of account values. Null
 * where a series has no data for that point yet.
 */
export interface CurveRow {
  /** Session date on the session ranges; an RFC-3339 instant on 1D. */
  t: string;
  /** What the axis and the crosshair show: "08/30", or "10:35" on 1D. */
  label: string;
  me: number;
  spy: number | null;
  qqq: number | null;
  club: number | null;
}

/** Percentage move from the baseline to the last point, per line. */
export interface CurveSummary {
  me: number | null;
  spy: number | null;
  qqq: number | null;
  club: number | null;
}

export interface HistoryResponse {
  range: CurveRange;
  /** True when this is one session at five-minute resolution rather than many. */
  intraday: boolean;
  /** Which session 1D drew. Null on every other range. */
  sessionDate: string | null;
  /**
   * The date the baseline was taken at: the first session in the window, or on
   * 1D the *previous* session, whose close the day is measured against.
   */
  baseDate: string | null;
  /** The baseline in dollars. Every line is scaled to start here. */
  base: number | null;
  /** The account's latest value. */
  value: number | null;
  /** `value` less `base`. The dollar figure at the top of the panel. */
  change: number | null;
  seasonStart: string;
  startingCash: number;
  rows: CurveRow[];
  summary: CurveSummary;
  /**
   * Where the member's own line came from. "reconstructed" means it was
   * replayed from the blotter against daily closes, which is the honest answer
   * until the nightly snapshot job has run for a while.
   */
  source: "reconstructed" | "snapshots" | "mixed";
  /** Why the club average is missing, when it is. */
  clubNote: string | null;
  /** The final point is a live mark rather than a settled close. */
  live: boolean;
  /** Daily bars were unavailable, so the curve is shorter than it should be. */
  degraded: boolean;
  asOf: string;
  /** Why there is no curve, when there is not one. Shown as-is. */
  note?: string;
}

export interface Trade {
  id: string;
  symbol: string;
  side: TradeSide;
  /** Always positive; `side` carries the direction. */
  qty: string;
  price: string;
  notional: string;
  /** Booked at the moment of the fill. Does not move when prices do. */
  realizedPnl: string;
  multiplier?: string;
  executedAt: string;
}

export interface BlotterResponse {
  trades: Trade[];
  note?: string;
}

export type OrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP";
export type TimeInForce = "DAY" | "GTC";

export const ORDER_TYPES: OrderType[] = [
  "MARKET",
  "LIMIT",
  "STOP",
  "STOP_LIMIT",
  "TRAILING_STOP",
];
export const TIME_IN_FORCE: TimeInForce[] = ["DAY", "GTC"];

/** Short labels for the type rail. Four characters or fewer, so the row fits. */
export const ORDER_TYPE_KEY: Record<OrderType, string> = {
  MARKET: "MKT",
  LIMIT: "LMT",
  STOP: "STP",
  STOP_LIMIT: "STPL",
  TRAILING_STOP: "TRL",
};

/** The three types that wait for a trigger. Mirrors `hasStop()` in the engine. */
export function hasStop(orderType: OrderType): boolean {
  return orderType === "STOP" || orderType === "STOP_LIMIT" || orderType === "TRAILING_STOP";
}

/** The two types that end as a limit order. Mirrors `hasLimit()` in the engine. */
export function hasLimit(orderType: OrderType): boolean {
  return orderType === "LIMIT" || orderType === "STOP_LIMIT";
}

/**
 * Which way a stop fires. The mirror of the limit rule, and the sentence the
 * whole feature rests on:
 *
 *     a LIMIT buys cheaper than the market and sells dearer.
 *     a STOP  buys dearer  than the market and sells cheaper.
 *
 * Mirrored from the Worker's `stopFiresOnRise()`, which is the authority. The
 * ticket needs it to say which side of the market a stop has to sit on before
 * the member submits an order the Worker would refuse.
 */
export function stopFiresOnRise(side: OrderSide): boolean {
  return side === "BUY" || side === "COVER";
}

/**
 * What the member is asking for. There is no execution-price field, and that is
 * the point: the Worker fetches the price itself. See rule 3 in DIRECTIONS.MD — a
 * client that posts a price gets it ignored, so this one does not bother.
 *
 * `limitPrice` is not an exception. It is a *condition*, not an execution price:
 * it says which side of a number the member is willing to trade on, and the
 * Worker still fetches what the market actually did.
 */
export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  orderType?: OrderType;
  /** Required for LIMIT and STOP_LIMIT. A condition, not the fill price. */
  limitPrice?: number;
  /** Required for STOP and STOP_LIMIT. The trigger, not the fill price. */
  stopPrice?: number;
  /** TRAILING_STOP only, in dollars. Mutually exclusive with `trailPercent`. */
  trailAmount?: number;
  /** TRAILING_STOP only, as a percent of the anchor. */
  trailPercent?: number;
  /** Share count. Mutually exclusive with `notional`. */
  qty?: number;
  /** Dollar amount, converted by the Worker at the price it fetched. */
  notional?: number;
  timeInForce?: TimeInForce;
}

/** A resting order: an instruction the market has not reached yet. */
export interface WorkingOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  limitPrice: string | null;
  /** The trigger. Derived and re-derived each sweep on a trailing stop. */
  stopPrice: string | null;
  trailAmount: string | null;
  trailPercent: string | null;
  /** Best price seen since placement — what a trailing stop measures from. */
  trailAnchor: string | null;
  /** Set once the stop fired. A triggered stop-limit is a limit order. */
  triggeredAt: string | null;
  qty: string | null;
  notional: string | null;
  timeInForce: TimeInForce;
  status: "PENDING" | "FILLED" | "CANCELLED" | "EXPIRED" | "REJECTED";
  /** Buying power held while it rests. Released on every exit. */
  reservedCash: string;
  /** Shares of the position held while it rests. */
  reservedQty: string;
  expiresAt: string | null;
  placedAt: string;
  resolvedAt: string | null;
  rejectReason: string | null;
}

export interface WorkingOrdersResponse {
  orders: WorkingOrder[];
  note?: string;
}

/** The order traded immediately. */
export interface FilledOrderResponse {
  ok: true;
  status: "FILLED";
  trade: {
    id: string;
    symbol: string;
    side: OrderSide;
    qty: string;
    price: string;
    notional: string;
    realizedPnl: string;
    executedAt: string;
  };
  /** The position after the fill. Null when it closed out. */
  position: { symbol: string; qty: string; avgCost: string } | null;
  /** Balances the database computed under its row lock. These are the true ones. */
  portfolio: {
    cash: string;
    longMv: string;
    shortMv: string;
    equity: string;
    marginHeld: string;
    buyingPower: string;
    reservedCash: string;
  };
}

/**
 * The order is resting. It did not fill because the market is shut, or because
 * a limit has not been reached — and it will not fill over a weekend, since
 * there is no session for it to trade in.
 */
export interface QueuedOrderResponse {
  ok: true;
  status: "QUEUED";
  order: {
    id: string;
    symbol: string;
    side: OrderSide;
    orderType: OrderType;
    limitPrice: string | null;
    qty: string | null;
    notional: string | null;
    timeInForce: TimeInForce;
    reservedCash: string;
    reservedQty: string;
    expiresAt: string | null;
    placedAt: string;
  };
  buyingPower: string;
  /** Why it is resting rather than filled. Shown verbatim. */
  reason: string;
  nextOpen: string | null;
  /** The price the reservation was sized against. */
  referencePrice: number;
}

export type OrderResponse = FilledOrderResponse | QueuedOrderResponse;

/**
 * Why an order was refused, when it was. The Worker sends the same codes
 * whether the refusal came from its pre-flight check or from the database, so
 * the ticket only has to handle one set.
 */
export type OrderRejectCode =
  | "INSUFFICIENT_BUYING_POWER"
  | "POSITION_TOO_SMALL"
  | "WRONG_SIDE"
  | "TRADING_LOCKED"
  | "NO_PORTFOLIO"
  | "INVALID_ORDER"
  | "MARKET_CLOSED";

const ORDER_REJECT_CODES: OrderRejectCode[] = [
  "INSUFFICIENT_BUYING_POWER",
  "POSITION_TOO_SMALL",
  "WRONG_SIDE",
  "TRADING_LOCKED",
  "NO_PORTFOLIO",
  "INVALID_ORDER",
  "MARKET_CLOSED",
];

/**
 * Narrow whatever the Worker sent to a code the ticket knows. An unrecognised
 * one becomes null rather than being trusted into the type — the message is
 * still shown either way, so a new server-side code degrades to "shown but not
 * specially styled" instead of a lie about the union.
 */
function asRejectCode(code: string | null): OrderRejectCode | null {
  return ORDER_REJECT_CODES.find((known) => known === code) ?? null;
}

/** An ApiError carrying a rejection the member can act on. */
export class OrderError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly code: OrderRejectCode | null,
  ) {
    super(message, status);
    this.name = "OrderError";
  }
}

/* -------------------------------------------------------------------------- */
/* Leaderboard                                                                 */
/* -------------------------------------------------------------------------- */

/** A member's largest holding by absolute market value. */
export interface TopHolding {
  symbol: string;
  marketValue: number;
  weight: number;
  isShort: boolean;
}

/**
 * One line in the standings, already valued by the Worker.
 *
 * Priced server-side, unlike the positions grid: valuing the club in the
 * browser would mean every member polling quotes for every symbol anyone
 * holds. Here it is one shared response off a cache the Worker keeps warm.
 */
export interface StandingsRow {
  /** Competition ranking: a tie shares a number and the next one skips. */
  rank: number;
  portfolioId: string;
  userId: string;
  displayName: string;
  role: "member" | "admin";
  equity: number;
  cash: number;
  longMv: number;
  shortMv: number;
  positions: number;
  totalPnl: number;
  /** Percent since this member was funded. What the ranking is by. */
  totalReturn: number;
  dayPnl: number;
  dayReturn: number;
  /** Total return minus SPY's over the same window. Null with no benchmark. */
  excess: number | null;
  top: TopHolding | null;
  /** Positions carried at cost because nothing could price them. */
  unpriced: number;
}

export interface ClubSummary {
  members: number;
  /** One member, one vote — not weighted by account size. */
  averageReturn: number | null;
  medianReturn: number | null;
  bestReturn: number | null;
  worstReturn: number | null;
  beatingBenchmark: number | null;
  totalEquity: number;
}

export interface StandingsResponse {
  season: { id: string; name: string; startsAt: string; tradingLocked: boolean };
  rows: StandingsRow[];
  summary: ClubSummary;
  /** Each benchmark's move over the same window the members are measured on. */
  benchmarks: { spy: number | null; qqq: number | null };
  unpriced: number;
  asOf: string;
  /** Why there is nothing to rank, when there is not. Shown as-is. */
  note?: string;
}

/**
 * Another member's book. Deliberately unpriced, exactly like /api/portfolio:
 * the browser already knows how to value positions against quotes, so the
 * detail panel reuses that rather than growing a second copy of the arithmetic.
 */
export interface MemberBookResponse {
  member: {
    portfolioId: string;
    userId: string;
    displayName: string;
    role: "member" | "admin";
  };
  cash: number;
  startingCash: number;
  positions: PositionRow[];
  trades: Trade[];
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

export interface AdminSeason {
  id: string;
  name: string;
  /** What a member joining now is funded with. Existing members keep theirs. */
  startingCash: number;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  tradingLocked: boolean;
}

export interface AdminMember {
  userId: string;
  displayName: string;
  role: "member" | "admin";
  joinedAt: string;
  /** Null when this member has no portfolio in the active season. */
  portfolioId: string | null;
  cash: number | null;
  startingCash: number | null;
}

export interface AdminOverview {
  seasons: AdminSeason[];
  members: AdminMember[];
  invite: {
    code: string | null;
    /** "environment" means it has never been rotated — the seed is still live. */
    source: "database" | "environment" | "none";
    updatedAt: string | null;
  };
  universe: { count: number; syncedAt: string | null };
}

/** A club-wide fill, for correction. */
export interface AdminTrade {
  id: string;
  portfolioId: string;
  member: string;
  symbol: string;
  side: OrderSide;
  qty: string;
  price: string;
  notional: string;
  realizedPnl: string;
  executedAt: string;
}

/** What a correction's replay left behind. */
export interface RebuildResult {
  ok: true;
  portfolioId: string | null;
  cash: string | null;
  positions: number;
  trades: number;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
  me: () => request<MeResponse>("/auth/me", { authed: true }),

  portfolio: () => request<PortfolioResponse>("/portfolio", { authed: true }),

  /** The equity curve, already indexed and aligned against SPY, QQQ and the club. */
  history: (range: CurveRange) =>
    request<HistoryResponse>(`/portfolio/history?range=${range}`, { authed: true }),

  blotter: (limit = 100) => request<BlotterResponse>(`/orders?limit=${limit}`, { authed: true }),

  /** Resting orders, plus the recently resolved ones for context. */
  workingOrders: () => request<WorkingOrdersResponse>("/orders/working", { authed: true }),

  /** Cancel a resting order and get its reservation back. */
  cancelOrder: async (id: string): Promise<{ ok: true; buyingPower: string | null }> => {
    try {
      return await request<{ ok: true; buyingPower: string | null }>(
        `/orders/working/${encodeURIComponent(id)}`,
        { authed: true, method: "DELETE" },
      );
    } catch (err) {
      if (err instanceof ApiError && !(err instanceof OrderError)) {
        throw new OrderError(err.message, err.status, asRejectCode(err.code));
      }
      throw err;
    }
  },

  /**
   * Place an order. Rejections arrive as OrderError with a code, so the ticket
   * can tell "you cannot afford this" from "the market is shut" without
   * matching on message text.
   */
  placeOrder: async (order: OrderRequest): Promise<OrderResponse> => {
    try {
      return await request<OrderResponse>("/orders", {
        authed: true,
        method: "POST",
        body: JSON.stringify(order),
      });
    } catch (err) {
      if (err instanceof ApiError && !(err instanceof OrderError)) {
        throw new OrderError(err.message, err.status, asRejectCode(err.code));
      }
      throw err;
    }
  },

  quotes: (symbols: string[]) =>
    request<QuotesResponse>(`/quotes?symbols=${encodeURIComponent(symbols.join(","))}`, {
      authed: true,
    }),

  securities: (symbols: string[]) =>
    request<SecuritiesResponse>(
      `/market/securities?symbols=${encodeURIComponent(symbols.join(","))}`,
      { authed: true },
    ),

  /**
   * Ticker autocomplete. `assetClass` narrows it to one instrument — omit it
   * only where the caller genuinely means "anything", like the command bar.
   */
  searchSymbols: (query: string, limit = 20, assetClass?: AssetClass) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (assetClass) params.set("class", assetClass);
    return request<SymbolSearchResponse>(`/market/symbols?${params}`, { authed: true });
  },

  clock: () => request<ClockResponse>("/market/clock", { authed: true }),

  /**
   * One underlying's option chain. Omit `expiration` for the front month.
   *
   * One expiration at a time, always: the whole surface for a liquid name is
   * tens of thousands of contracts, and a member reads one ladder.
   */
  chain: (underlying: string, expiration?: string) => {
    const params = new URLSearchParams({ underlying });
    if (expiration) params.set("expiration", expiration);
    return request<ChainResponse>(`/market/chain?${params}`, { authed: true });
  },

  /** The standings. Identical for every member, so the Worker memoises it. */
  standings: () => request<StandingsResponse>("/leaderboard", { authed: true }),

  /** One member's positions and fills, read-only. */
  memberBook: (portfolioId: string) =>
    request<MemberBookResponse>(`/leaderboard/${encodeURIComponent(portfolioId)}`, {
      authed: true,
    }),

  admin: {
    overview: () => request<AdminOverview>("/admin", { authed: true }),

    createSeason: (season: { name: string; startingCash: number; startsAt?: string }) =>
      request<{ ok: true; seasonId: string; name: string; portfolios: number }>("/admin/seasons", {
        authed: true,
        method: "POST",
        body: JSON.stringify(season),
      }),

    /** Every field is optional; an omitted one is left exactly as it was. */
    updateSeason: (
      id: string,
      changes: { name?: string; startingCash?: number; tradingLocked?: boolean },
    ) =>
      request<{ ok: true; season: AdminSeason }>(`/admin/seasons/${encodeURIComponent(id)}`, {
        authed: true,
        method: "PATCH",
        body: JSON.stringify(changes),
      }),

    /**
     * Wipe a season back to its starting line. `confirm` must be the season's
     * exact name — a confirmation the browser could generate is not one.
     */
    resetSeason: (id: string, confirm: string) =>
      request<{ ok: true; portfolios: number; tradesDeleted: number; positionsDeleted: number }>(
        `/admin/seasons/${encodeURIComponent(id)}/reset`,
        { authed: true, method: "POST", body: JSON.stringify({ confirm }) },
      ),

    /** Rotate the invite code. Omit `code` to have one generated. */
    rotateInvite: (code?: string) =>
      request<{ ok: true; code: string; source: "database"; updatedAt: string }>("/admin/invite", {
        authed: true,
        method: "POST",
        body: JSON.stringify(code ? { code } : {}),
      }),

    setRole: (userId: string, role: "member" | "admin") =>
      request<{ ok: true; userId: string; displayName: string | null; role: "member" | "admin" }>(
        `/admin/members/${encodeURIComponent(userId)}/role`,
        { authed: true, method: "POST", body: JSON.stringify({ role }) },
      ),

    trades: (filters: { portfolio?: string; symbol?: string; limit?: number } = {}) => {
      const query = new URLSearchParams();
      if (filters.portfolio) query.set("portfolio", filters.portfolio);
      if (filters.symbol) query.set("symbol", filters.symbol);
      query.set("limit", String(filters.limit ?? 100));
      return request<{ trades: AdminTrade[]; note?: string }>(`/admin/trades?${query}`, {
        authed: true,
      });
    },

    /** Remove a fill. The portfolio is replayed from what is left of the blotter. */
    voidTrade: (id: string) =>
      request<RebuildResult>(`/admin/trades/${encodeURIComponent(id)}`, {
        authed: true,
        method: "DELETE",
      }),

    /** Correct a fill's quantity or price. Same replay as a void. */
    amendTrade: (id: string, changes: { qty?: number; price?: number }) =>
      request<RebuildResult>(`/admin/trades/${encodeURIComponent(id)}`, {
        authed: true,
        method: "PATCH",
        body: JSON.stringify(changes),
      }),

    /** Force an asset-universe resync. The cron does this nightly. */
    syncUniverse: () =>
      request<{ ok: true; count: number; syncedAt: string }>("/market/universe/sync", {
        authed: true,
        method: "POST",
      }),

    /** Force a sweep of resting orders. The cron does this every minute. */
    sweep: () =>
      request<{ filled: number; rejected: number; expired: number; resting: number }>(
        "/orders/sweep",
        { authed: true, method: "POST" },
      ),

    /**
     * Force tonight's snapshot. The cron does this at 22:15 UTC on weekdays.
     *
     * `ran: false` with a reason is the ordinary answer on a weekend or a
     * holiday — the job refuses to record a session the exchange did not hold.
     * Writes upsert on (portfolio_id, as_of), so pressing it twice is the same
     * as pressing it once.
     */
    snapshot: () =>
      request<{
        ran: boolean;
        reason: string | null;
        asOf: string | null;
        portfolios: number;
        benchmarks: number;
        unpriced: number;
      }>("/portfolio/snapshot", { authed: true, method: "POST" }),
  },
};
