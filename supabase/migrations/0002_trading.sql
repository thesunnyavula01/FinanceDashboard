-- =============================================================================
-- Finance Club Terminal — the trading engine
--
-- One function, place_order(), and it is the only thing in the system allowed
-- to move money. Non-negotiable rule 4 in CLAUDE.md exists because of a very
-- specific failure: a member with two browser tabs open presses BUY in both.
-- If cash were read into application code, decremented there and written back,
-- both tabs would read the same balance and both would succeed, and the club
-- would have invented money. So the read, the arithmetic and the write all
-- happen inside one transaction that opens by taking a row lock on the
-- portfolio. The second tab blocks on that lock until the first commits, then
-- reads the balance the first one left behind.
--
-- Everything else here follows from three rules already stated elsewhere:
--
--   * qty is SIGNED. A short is negative. There is no long/short branch in the
--     P/L arithmetic, only in the four side handlers that decide what a fill
--     does to a position.
--   * The caller supplies the price. The Worker fetched it from Alpaca a moment
--     ago; a browser cannot reach this function at all. See
--     worker/routes/orders.ts.
--   * Money is numeric. Cash and notionals carry 2 decimals, quantities and
--     prices 6.
--
-- worker/orders/engine.ts states the same rules in TypeScript, where they can
-- be unit tested without a database, and the Worker checks them before it gets
-- here so a member sees a useful message rather than a database error. THIS
-- FILE IS THE AUTHORITY. The check up there is a courtesy; this one is under
-- the lock. worker/orders/engine.test.ts reads this file and asserts the two
-- still agree on the constants.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reg T, as a function so the SQL and the drift test have one place to read it
-- from. Shorting $X credits $X to cash and locks 1.5X, so it consumes half the
-- notional in buying power.
-- -----------------------------------------------------------------------------
create or replace function reg_t_margin_multiplier()
returns numeric
language sql
immutable
as $fn$ select 1.5::numeric $fn$;

-- -----------------------------------------------------------------------------
-- Number formatting for the rejection messages below, which members read.
--
-- to_char's FM prefix strips trailing zeros from the fraction but leaves the
-- decimal point behind, so a whole share count comes out as "15." — the rtrim is
-- what turns that back into "15".
-- -----------------------------------------------------------------------------
create or replace function fmt_qty(p_value numeric)
returns text
language sql
immutable
as $fn$ select rtrim(to_char(p_value, 'FM999999999990.999999'), '.') $fn$;

create or replace function fmt_money(p_value numeric)
returns text
language sql
immutable
as $fn$ select to_char(p_value, 'FM999,999,999,990.00') $fn$;

-- =============================================================================
-- place_order()
--
-- Raised errors carry a SQLSTATE the Worker maps to an HTTP status. The message
-- is written for a member to read, because it is shown to them verbatim.
--
--   FC001  insufficient buying power
--   FC002  the position is too small for this order (oversell / overcover)
--   FC003  wrong side for the position held (see "no accidental flips" below)
--   FC004  trading is locked
--   FC005  no portfolio in the active season
--   FC006  the order itself is malformed
-- =============================================================================
create or replace function place_order(
  p_user_id uuid,
  p_symbol  text,
  p_side    text,
  p_qty     numeric,
  p_price   numeric,
  -- symbol -> price, for every position the member holds. Postgres has no price
  -- feed, and marking a short at its average cost would understate the margin on
  -- exactly the position that has moved against the member. A symbol missing
  -- from this map falls back to its average cost.
  p_marks   jsonb default '{}'::jsonb
)
returns table (
  trade_id          uuid,
  portfolio_id      uuid,
  symbol            text,
  side              text,
  qty               numeric,
  price             numeric,
  notional          numeric,
  realized_pnl      numeric,
  cash              numeric,
  position_qty      numeric,
  position_avg_cost numeric,
  long_mv           numeric,
  short_mv          numeric,
  equity            numeric,
  margin_held       numeric,
  buying_power      numeric,
  executed_at       timestamptz
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_symbol       text          := upper(trim(p_symbol));
  v_side         text          := upper(trim(p_side));
  v_portfolio    portfolios%rowtype;
  v_locked       boolean;
  v_position     positions%rowtype;
  v_held         boolean;
  v_prev_qty     numeric(20,6);
  v_prev_avg     numeric(20,6);
  v_new_qty      numeric(20,6);
  v_new_avg      numeric(20,6);
  v_notional     numeric(20,2);
  v_realized     numeric(20,2) := 0;
  v_cash         numeric(20,2);
  v_long_mv      numeric(20,2);
  v_short_mv     numeric(20,2);
  v_margin_held  numeric(20,2);
  v_buying_power numeric(20,2);
  v_available    numeric(20,2);
  v_trade_id     uuid;
  v_executed_at  timestamptz   := now();
begin
  -- ---------------------------------------------------------------------------
  -- Shape of the order. None of this depends on any state, so it happens before
  -- the lock is taken.
  -- ---------------------------------------------------------------------------
  if v_side is null or v_side not in ('BUY', 'SELL', 'SHORT', 'COVER') then
    raise exception 'Unknown order side: %.', p_side using errcode = 'FC006';
  end if;

  if v_symbol is null or v_symbol = '' then
    raise exception 'An order needs a ticker.' using errcode = 'FC006';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'Order quantity must be greater than zero.' using errcode = 'FC006';
  end if;

  if p_price is null or p_price <= 0 then
    raise exception 'No usable price for %.', v_symbol using errcode = 'FC006';
  end if;

  -- ---------------------------------------------------------------------------
  -- THE LOCK.
  --
  -- Every order for this member passes through this statement, so from here to
  -- COMMIT the balance below cannot change underneath us. A second order
  -- arriving now waits here rather than reading a balance that is about to be
  -- spent.
  -- ---------------------------------------------------------------------------
  select p.* into v_portfolio
  from portfolios p
  join seasons s on s.id = p.season_id
  where p.user_id = p_user_id
    and s.is_active
  for update of p;

  if not found then
    raise exception 'You do not have a portfolio in the active season.'
      using errcode = 'FC005';
  end if;

  select s.trading_locked into v_locked from seasons s where s.id = v_portfolio.season_id;
  if v_locked then
    raise exception 'Trading is locked for this season.' using errcode = 'FC004';
  end if;

  -- Redundant while place_order() is the only writer — the portfolio lock
  -- already serialises this member — but it keeps the read repeatable if an
  -- admin tool ever touches positions directly.
  select * into v_position
  from positions
  where positions.portfolio_id = v_portfolio.id
    and positions.symbol = v_symbol
  for update;

  v_held     := found;
  v_prev_qty := coalesce(v_position.qty, 0);
  v_prev_avg := v_position.avg_cost;

  -- ---------------------------------------------------------------------------
  -- What the fill does to the position.
  --
  -- No accidental flips: BUY on a short is rejected rather than netted down and
  -- through zero. A member who types BUY meaning "close my short" is told to use
  -- COVER, which is one extra keystroke and teaches the vocabulary. A member who
  -- did it by accident does not silently end up long.
  --
  -- Increasing a position re-weights the average cost. Reducing one leaves it
  -- alone and books the difference as realised P/L — the average cost of what
  -- remains is not changed by selling part of it.
  -- ---------------------------------------------------------------------------
  if v_side = 'BUY' then
    if v_prev_qty < 0 then
      raise exception 'You are short % %. Use COVER to close a short position.',
        fmt_qty(abs(v_prev_qty)), v_symbol
        using errcode = 'FC003';
    end if;

    v_new_qty  := v_prev_qty + p_qty;
    v_new_avg  := round((v_prev_qty * coalesce(v_prev_avg, 0) + p_qty * p_price) / v_new_qty, 6);
    v_notional := round(p_qty * p_price, 2);
    v_cash     := v_portfolio.cash - v_notional;

  elsif v_side = 'SELL' then
    if v_prev_qty < 0 then
      raise exception 'You are short %. Use COVER to close it, or SHORT to add to it.',
        v_symbol using errcode = 'FC003';
    end if;
    if v_prev_qty = 0 then
      raise exception 'You do not hold any %.', v_symbol using errcode = 'FC002';
    end if;
    if p_qty > v_prev_qty then
      raise exception 'You hold % %, so you cannot sell %.',
        fmt_qty(v_prev_qty), v_symbol,
        fmt_qty(p_qty)
        using errcode = 'FC002';
    end if;

    -- Signed-qty note: for a long, (price - avg_cost) * qty_sold is the gain.
    v_realized := round((p_price - v_prev_avg) * p_qty, 2);
    v_new_qty  := v_prev_qty - p_qty;
    v_new_avg  := v_prev_avg;
    v_notional := round(p_qty * p_price, 2);
    v_cash     := v_portfolio.cash + v_notional;

  elsif v_side = 'SHORT' then
    if v_prev_qty > 0 then
      raise exception 'You hold % %. Use SELL to reduce a long position.',
        fmt_qty(v_prev_qty), v_symbol
        using errcode = 'FC003';
    end if;

    -- Shorting credits the proceeds to cash. The margin is not deducted; it is
    -- held, which is what the buying-power check below expresses.
    v_new_qty  := v_prev_qty - p_qty;
    v_new_avg  := round((abs(v_prev_qty) * coalesce(v_prev_avg, 0) + p_qty * p_price)
                        / abs(v_new_qty), 6);
    v_notional := round(p_qty * p_price, 2);
    v_cash     := v_portfolio.cash + v_notional;

  else -- COVER
    if v_prev_qty > 0 then
      raise exception 'You hold % long. Use SELL to reduce a long position.', v_symbol
        using errcode = 'FC003';
    end if;
    if v_prev_qty = 0 then
      raise exception 'You have no short position in % to cover.', v_symbol
        using errcode = 'FC002';
    end if;
    if p_qty > abs(v_prev_qty) then
      raise exception 'You are short % %, so you cannot cover %.',
        fmt_qty(abs(v_prev_qty)), v_symbol,
        fmt_qty(p_qty)
        using errcode = 'FC002';
    end if;

    -- The mirror of SELL. A short profits when the price falls, so the
    -- subtraction runs the other way round.
    v_realized := round((v_prev_avg - p_price) * p_qty, 2);
    v_new_qty  := v_prev_qty + p_qty;
    v_new_avg  := v_prev_avg;
    v_notional := round(p_qty * p_price, 2);
    v_cash     := v_portfolio.cash - v_notional;
  end if;

  if v_new_qty <> 0 and (v_new_avg is null or v_new_avg <= 0) then
    raise exception 'The price of % is too small to trade here.', v_symbol
      using errcode = 'FC006';
  end if;

  -- ---------------------------------------------------------------------------
  -- Post-trade valuation, marked at the prices the Worker passed in.
  --
  -- This projects the portfolio as it will be if this fill goes through: every
  -- other position as it stands, plus the new size of this one. Nothing has been
  -- written yet, so a rejection below costs nothing to undo.
  -- ---------------------------------------------------------------------------
  with post as (
    select
      pos.qty                                                             as qty,
      coalesce(nullif(p_marks ->> pos.symbol, '')::numeric, pos.avg_cost) as mark
    from positions pos
    where pos.portfolio_id = v_portfolio.id
      and pos.symbol <> v_symbol
    union all
    select v_new_qty, p_price
    where v_new_qty <> 0
  )
  select
    round(coalesce(sum(post.qty * post.mark)  filter (where post.qty > 0), 0), 2),
    round(coalesce(sum(-post.qty * post.mark) filter (where post.qty < 0), 0), 2)
  into v_long_mv, v_short_mv
  from post;

  v_margin_held  := round(reg_t_margin_multiplier() * v_short_mv, 2);
  v_buying_power := v_cash - v_margin_held;

  -- Only BUY and SHORT can make buying power worse, and the arithmetic says so:
  -- a SELL adds its notional to cash and changes no margin, and a COVER pays out
  -- its notional but releases 1.5x that in margin, so it nets +0.5x. Checking the
  -- closing sides would therefore only ever trap a member who is already
  -- underwater in the very position they are trying to get out of. There is no
  -- forced liquidation in v1, so the way out has to stay open — including where
  -- covering drives cash negative, which is the paper-trading equivalent of a
  -- margin call and shows as a warning rather than a block.
  if v_side in ('BUY', 'SHORT') and v_buying_power < 0 then
    -- What they had before this order, which is the number they are short of.
    v_available := greatest(v_portfolio.cash
                            - round(reg_t_margin_multiplier()
                                    * (v_short_mv - case when v_side = 'SHORT'
                                                    then v_notional else 0 end), 2), 0);

    -- A short only consumes half its notional, because the proceeds land in cash
    -- and only the 0.5x excess of the margin is new money. Quoting the whole
    -- notional would tell a member they need twice what they actually do.
    raise exception 'Not enough buying power. % % needs $%, and you have $%.',
      v_side, v_symbol,
      fmt_money(case when v_side = 'SHORT' then round(v_notional / 2, 2) else v_notional end),
      fmt_money(v_available)
      using errcode = 'FC001';
  end if;

  -- ---------------------------------------------------------------------------
  -- Writes. Everything above either succeeded or raised, so from here the fill
  -- is happening.
  -- ---------------------------------------------------------------------------
  if v_new_qty = 0 then
    delete from positions
    where positions.portfolio_id = v_portfolio.id
      and positions.symbol = v_symbol;
    v_new_avg := null;
  elsif v_held then
    update positions
    set qty = v_new_qty, avg_cost = v_new_avg, updated_at = now()
    where positions.portfolio_id = v_portfolio.id
      and positions.symbol = v_symbol;
  else
    insert into positions (portfolio_id, symbol, qty, avg_cost)
    values (v_portfolio.id, v_symbol, v_new_qty, v_new_avg);
  end if;

  update portfolios set cash = v_cash where portfolios.id = v_portfolio.id;

  insert into trades (portfolio_id, symbol, side, qty, price, notional, realized_pnl, executed_at)
  values (v_portfolio.id, v_symbol, v_side, p_qty, p_price, v_notional, v_realized, v_executed_at)
  returning trades.id into v_trade_id;

  return query select
    v_trade_id,
    v_portfolio.id,
    v_symbol,
    v_side,
    p_qty,
    p_price,
    v_notional,
    v_realized,
    v_cash,
    v_new_qty,
    v_new_avg,
    v_long_mv,
    v_short_mv,
    (v_cash + v_long_mv - v_short_mv)::numeric(20,2),
    v_margin_held,
    greatest(v_buying_power, 0)::numeric(20,2),
    v_executed_at;
end $fn$;

-- The service-role key bypasses RLS and is the only caller. Nothing reachable
-- from a browser session may execute this.
revoke all on function place_order(uuid, text, text, numeric, numeric, jsonb)
  from public, anon, authenticated;
