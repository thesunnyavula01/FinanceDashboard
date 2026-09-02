import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigError, serviceClient } from "../lib/supabase.ts";
import { dailyBars, MAX_BAR_SYMBOLS } from "../market/bars.ts";
import { exchangeDate } from "../market/provider.ts";
import { parseContract } from "../market/symbols.ts";
import { shiftDate } from "../analytics/curve.ts";
import type { Env } from "../types.ts";

/**
 * Option expiry, settled for cash.
 *
 * An option that never expires is not an option, and this is the job that makes
 * the third asset class honest. On its expiration date, after the close, every
 * long contract in the club is worth exactly its intrinsic value against the
 * underlying's official close and nothing else:
 *
 * ```
 * CALL   max(0, close - strike)
 * PUT    max(0, strike - close)
 * ```
 *
 * **Cash settlement, not exercise.** Assigning 100 shares of a $150 call needs
 * $15,000 the member may not have, so exercise can simply fail — and a member
 * left holding a dead contract because their cash was short has learned nothing
 * except that the software broke. Cash settlement always succeeds and produces
 * exactly the same P/L, which is the entire lesson an option is here to teach.
 * The trade-off is that this club cannot demonstrate assignment; that is the
 * right cut for a paper season.
 *
 * **A missing underlying close settles nothing.** The alternative is settling
 * at zero, which would delete a member's in-the-money contract and credit them
 * nothing — silently, overnight, with no way to tell it from a genuine
 * expiry. So a position whose underlying has no bar today is left alone and
 * reported, and the caller declines to snapshot on top of it.
 *
 * **It runs before the nightly snapshot, and a failure cancels it.**
 * `mergeSnapshots()` prefers a stored snapshot to a replay forever, so a
 * snapshot taken over a half-settled book is wrong in a way that never washes
 * out. `worker/index.ts` chains the two for that reason and no other.
 *
 * The money is moved by `settle_option_expiry()` in migration 0006, which takes
 * the same `SELECT ... FOR UPDATE` on the portfolio that `place_order()` does,
 * writes an `EXPIRE` trade at the intrinsic price, deletes the position and
 * rejects any resting order left on that symbol. Nothing here does arithmetic
 * on cash — rule 4.
 */

/** Contracts settled per run. A club this size will never approach it. */
const MAX_POSITIONS = 500;

/**
 * How far back to ask for the underlying's bars.
 *
 * Only today's close settles anything, but a week costs the same request and
 * makes the "is there a bar for today" check answerable rather than ambiguous:
 * an empty series means the symbol is gone, a series ending yesterday means the
 * exchange did not hold a session today.
 */
const LOOKBACK_DAYS = 7;

export interface SettlementRow {
  positionId: string;
  portfolioId: string;
  symbol: string;
  underlying: string;
  qty: number;
  strike: number;
  type: "CALL" | "PUT";
  underlyingClose: number;
  intrinsic: number;
}

export interface ExpiryResult {
  ran: boolean;
  reason: string | null;
  asOf: string | null;
  /** Contracts that settled and are now gone from `positions`. */
  settled: number;
  /** Contracts that expired at zero. A subset of `settled`, for the log line. */
  worthless: number;
  /** Cash credited across the club, for the log line only. */
  credited: number;
  /**
   * Contracts left in place because their underlying had no close today.
   * Non-zero means the book is not settled and must not be snapshotted.
   */
  skipped: number;
  /** Contracts the RPC refused. Same consequence as `skipped`. */
  failed: number;
}

/** A held contract, as this job reads it. */
interface HeldContract {
  positionId: string;
  portfolioId: string;
  symbol: string;
  qty: number;
}

/**
 * Intrinsic value of one contract at settlement, per share.
 *
 * Never negative: an out-of-the-money option expires worthless, it does not
 * owe anything. Pure, and exported so `expiry.test.ts` can pin both directions
 * without a database.
 */
export function intrinsicValue(
  type: "CALL" | "PUT",
  strike: number,
  underlyingClose: number,
): number {
  const raw = type === "CALL" ? underlyingClose - strike : strike - underlyingClose;
  // Two decimals, because that is what the `price` column holds and what the
  // constraint `price > 0 or side = 'EXPIRE'` is written around: a contract
  // worth a twentieth of a cent settles at zero, not at a rounding artefact.
  return raw <= 0 ? 0 : Math.round(raw * 100) / 100;
}

/**
 * Which of today's held contracts expire today, and what each is worth.
 *
 * Split out from the I/O so the arithmetic — the part with the sign errors in
 * it — is testable with three plain arrays.
 */
export function planSettlements(
  held: HeldContract[],
  closes: Map<string, number>,
  today: string,
): { rows: SettlementRow[]; skipped: SettlementRow[] } {
  const rows: SettlementRow[] = [];
  const skipped: SettlementRow[] = [];

  for (const position of held) {
    const contract = parseContract(position.symbol);
    if (!contract || contract.expiration !== today) continue;

    // Long-only is enforced at both ends of the order path, so a negative qty
    // here would mean the invariant has already been broken. Settling it would
    // move money in a direction nothing else in the app can produce, so it is
    // left alone and counted as a failure for someone to look at.
    if (position.qty <= 0) continue;

    const close = closes.get(contract.underlying);
    const row: SettlementRow = {
      positionId: position.positionId,
      portfolioId: position.portfolioId,
      symbol: position.symbol,
      underlying: contract.underlying,
      qty: position.qty,
      strike: contract.strike,
      type: contract.type,
      underlyingClose: close ?? 0,
      intrinsic: close === undefined ? 0 : intrinsicValue(contract.type, contract.strike, close),
    };

    if (close === undefined) skipped.push(row);
    else rows.push(row);
  }

  return { rows, skipped };
}

async function loadExpiringContracts(
  supabase: SupabaseClient,
  seasonId: string,
  today: string,
): Promise<HeldContract[]> {
  // Postgres cannot classify a symbol, but the OCC form always carries its
  // expiry as `YYMMDD` right after the root — so the date is a substring match,
  // which is enough to keep this from reading every position in the club.
  const yymmdd = today.slice(2).replace(/-/g, "");

  const { data, error } = await supabase
    .from("positions")
    .select("id, portfolio_id, symbol, qty, portfolios!inner(season_id)")
    .eq("portfolios.season_id", seasonId)
    .like("symbol", `%${yymmdd}%`)
    .gt("qty", 0)
    .limit(MAX_POSITIONS);

  if (error) throw new Error(`Could not read expiring contracts: ${error.message}`);

  return (data ?? []).map((row) => ({
    positionId: row.id as string,
    portfolioId: row.portfolio_id as string,
    symbol: row.symbol as string,
    qty: Number(row.qty),
  }));
}

/**
 * Settle everything expiring today across the active season.
 *
 * Returns without writing on a day nothing expires, which is most days.
 */
export async function settleExpiries(
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<ExpiryResult> {
  const empty: ExpiryResult = {
    ran: false,
    reason: null,
    asOf: null,
    settled: 0,
    worthless: 0,
    credited: 0,
    skipped: 0,
    failed: 0,
  };

  let supabase: SupabaseClient;
  try {
    supabase = serviceClient(env);
  } catch (err) {
    if (err instanceof ConfigError) return { ...empty, reason: err.message };
    throw err;
  }

  const { data: season } = await supabase
    .from("seasons")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  if (!season) return { ...empty, reason: "There is no active season." };

  const today = exchangeDate();
  const held = await loadExpiringContracts(supabase, season.id as string, today);
  if (held.length === 0) {
    return { ...empty, ran: true, asOf: today, reason: "Nothing expires today." };
  }

  // Only the underlyings, and only the ones a contract expiring today needs.
  const underlyings = [
    ...new Set(
      held
        .map((position) => parseContract(position.symbol))
        .filter((contract) => contract?.expiration === today)
        .map((contract) => contract!.underlying),
    ),
  ];

  if (underlyings.length === 0) {
    // The `LIKE` matched a date sitting somewhere else in a symbol. Not an
    // error — just nothing to do.
    return { ...empty, ran: true, asOf: today, reason: "Nothing expires today." };
  }

  const from = shiftDate(today, { days: LOOKBACK_DAYS });
  const closes = new Map<string, number>();

  for (let i = 0; i < underlyings.length; i += MAX_BAR_SYMBOLS) {
    const batch = await dailyBars(
      env,
      underlyings.slice(i, i + MAX_BAR_SYMBOLS),
      from,
      today,
      waitUntil,
    );
    for (const [symbol, series] of batch) {
      // Today's bar or nothing. A close carried forward from yesterday would
      // settle a contract against a price the exchange did not print on the day
      // that decided it.
      const bar = series.find((candidate) => candidate.date === today);
      if (bar && bar.close > 0) closes.set(symbol, bar.close);
    }
  }

  const { rows, skipped } = planSettlements(held, closes, today);

  if (rows.length === 0 && skipped.length === 0) {
    return { ...empty, ran: true, asOf: today, reason: "Nothing expires today." };
  }

  let settled = 0;
  let worthless = 0;
  let credited = 0;
  let failed = 0;

  for (const row of rows) {
    const { data, error } = await supabase.rpc("settle_option_expiry", {
      p_position_id: row.positionId,
      p_intrinsic: row.intrinsic,
    });

    if (error) {
      // Logged and counted, never rethrown: one member's stuck contract must
      // not leave the rest of the club unsettled overnight.
      console.error(`Expiry failed for ${row.symbol} (${row.positionId}):`, error.message);
      failed += 1;
      continue;
    }

    settled += 1;
    if (row.intrinsic === 0) worthless += 1;
    const fill = Array.isArray(data) ? data[0] : data;
    credited += Number(fill?.notional ?? 0);
  }

  return {
    ran: true,
    reason: null,
    asOf: today,
    settled,
    worthless,
    credited: Math.round(credited * 100) / 100,
    skipped: skipped.length,
    failed,
  };
}

/**
 * Whether the nightly snapshot may proceed on top of this result.
 *
 * A snapshot is preferred to a replay forever, so one taken over a book that is
 * half-settled is a permanent wrong answer rather than a transient one. Any
 * contract left unsettled — no underlying close, or an RPC that refused — stops
 * the snapshot for the night. The replay covers the gap in the meantime, which
 * is exactly the arrangement `snapshot.ts` already documents.
 */
export function bookIsSettled(result: ExpiryResult): boolean {
  return result.skipped === 0 && result.failed === 0;
}
