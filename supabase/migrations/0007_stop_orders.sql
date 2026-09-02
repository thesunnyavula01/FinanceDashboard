-- =============================================================================
-- 0007 — stop, stop-limit and trailing-stop orders.
--
-- The ticket had MARKET and LIMIT. A real broker's has five, and the three
-- missing ones are the ones a member reaches for to *protect* a position rather
-- than to open one — which is most of what a paper season is for.
--
-- THE ONE IDEA. A stop is the mirror of a limit, and everything below follows
-- from that single sentence:
--
--     a LIMIT buys cheaper than the market and sells dearer.
--     a STOP  buys dearer  than the market and sells cheaper.
--
-- So the trigger direction is the limit direction inverted. BUY and COVER are
-- marketable on a limit when the price falls to it, and trigger a stop when the
-- price *rises* to it. SELL and SHORT are the other way round. Getting this
-- backwards produces an order that looks completely reasonable and fires at
-- exactly the wrong moment, so `engine.ts` states it again and its tests check
-- all eight combinations.
--
-- WHAT A STOP IS NOT. A triggered stop does not fill at its stop price. It
-- becomes a market order (or, for STOP_LIMIT, a limit order) and fills wherever
-- the market is — which on a gap is nowhere near the stop. That is the whole
-- reason a stop-loss is not a guarantee, and it is worth a member learning it
-- here rather than with real money. Same rule 0003 already applies to limits.
--
-- TRAILING. `trail_anchor` is the best price the market has offered since the
-- order was placed — the highest for a SELL/SHORT trail, the lowest for a
-- BUY/COVER one — and it ratchets in the favourable direction only. The stop
-- is derived from it every sweep. It never moves against the member, which is
-- the property that makes a trailing stop worth having.
--
-- DIRECTION IS CHECKED IN THE WORKER, NOT HERE. A sell stop must sit below the
-- market and a buy stop above it, or the order fires on the next tick and the
-- member meant a market order. Postgres has no price feed, so the Worker makes
-- that call — the same split place_order() already lives with for its marks.
-- This file checks shape: which columns each type must and must not carry.
--
-- Re-runnable, like every migration here. Constraints are dropped by name and
-- recreated; queue_order() is dropped rather than overloaded, for the reason
-- 0003 documents — a defaulted extra argument makes every call ambiguous.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The columns.
-- -----------------------------------------------------------------------------
alter table pending_orders
  add column if not exists stop_price   numeric(20,6),
  add column if not exists trail_amount numeric(20,6),
  add column if not exists trail_percent numeric(9,4),
  add column if not exists trail_anchor numeric(20,6),
  add column if not exists triggered_at timestamptz;

comment on column pending_orders.stop_price is
  'The trigger. Set on STOP and STOP_LIMIT; derived each sweep on TRAILING_STOP.';
comment on column pending_orders.trail_anchor is
  'Best price seen since placement — highest for SELL/SHORT, lowest for BUY/COVER.';
comment on column pending_orders.triggered_at is
  'When the stop fired. Null while it is still waiting. A triggered stop is a market order.';

-- -----------------------------------------------------------------------------
-- 2. The shape rules.
--
-- Dropped by name and recreated, so re-running this file is safe.
-- -----------------------------------------------------------------------------
alter table pending_orders drop constraint if exists pending_orders_order_type_check;
alter table pending_orders drop constraint if exists pending_orders_type_allowed;
alter table pending_orders add constraint pending_orders_type_allowed
  check (order_type in ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP'));

-- A limit price belongs to the two types that end in a limit order, and to
-- nothing else. The old constraint named LIMIT alone and would reject every
-- stop-limit ever placed.
alter table pending_orders drop constraint if exists pending_orders_limit_price_required;
alter table pending_orders add constraint pending_orders_limit_price_required
  check ((order_type in ('LIMIT', 'STOP_LIMIT')) = (limit_price is not null));

-- A stop price belongs to the three types that have a trigger.
alter table pending_orders drop constraint if exists pending_orders_stop_price_required;
alter table pending_orders add constraint pending_orders_stop_price_required
  check ((order_type in ('STOP', 'STOP_LIMIT', 'TRAILING_STOP')) = (stop_price is not null));

alter table pending_orders drop constraint if exists pending_orders_stop_price_positive;
alter table pending_orders add constraint pending_orders_stop_price_positive
  check (stop_price is null or stop_price > 0);

-- Exactly one way of expressing the trail, and only on a trailing order.
alter table pending_orders drop constraint if exists pending_orders_trail_required;
alter table pending_orders add constraint pending_orders_trail_required
  check (
    case when order_type = 'TRAILING_STOP'
      then (trail_amount is null) <> (trail_percent is null)
      else trail_amount is null and trail_percent is null
    end
  );

alter table pending_orders drop constraint if exists pending_orders_trail_positive;
alter table pending_orders add constraint pending_orders_trail_positive
  check (
    (trail_amount is null or trail_amount > 0)
    and (trail_percent is null or (trail_percent > 0 and trail_percent < 100))
  );

alter table pending_orders drop constraint if exists pending_orders_trail_anchor_required;
alter table pending_orders add constraint pending_orders_trail_anchor_required
  check ((order_type = 'TRAILING_STOP') = (trail_anchor is not null));

-- A stop is entered in shares. A dollar amount would have to be converted at a
-- price that does not exist until the trigger fires, and the conversion runs
-- the wrong way — the same reason 0003 gives for closing orders.
alter table pending_orders drop constraint if exists pending_orders_stop_needs_qty;
alter table pending_orders add constraint pending_orders_stop_needs_qty
  check (order_type in ('MARKET', 'LIMIT') or qty is not null);

-- -----------------------------------------------------------------------------
-- 3. The sweep needs to find working stops cheaply.
--
-- Every minute of every day now, so this index is the difference between a
-- sequential scan of the season's whole order history and touching the handful
-- of rows that are actually live.
-- -----------------------------------------------------------------------------
create index if not exists pending_orders_working_idx
  on pending_orders (status, symbol) where status = 'PENDING';

-- -----------------------------------------------------------------------------
-- 4. queue_order() — the same function, with the trigger columns threaded in.
--
-- Dropped first: a defaulted extra argument would make every existing call
-- ambiguous, which is exactly what 0003 hit and documented.
-- -----------------------------------------------------------------------------
drop function if exists queue_order(
  uuid, text, text, text, numeric, numeric, numeric, text, numeric, numeric, timestamptz, numeric
);

create or replace function queue_order(
  p_user_id       uuid,
  p_symbol        text,
  p_side          text,
  p_order_type    text,
  p_limit_price   numeric,
  p_qty           numeric,
  p_notional      numeric,
  p_time_in_force text,
  p_reserve_cash  numeric,
  p_reserve_qty   numeric,
  p_expires_at    timestamptz default null,
  p_multiplier    numeric default 1,
  p_stop_price    numeric default null,
  p_trail_amount  numeric default null,
  p_trail_percent numeric default null,
  p_trail_anchor  numeric default null
)
returns table (
  order_id       uuid,
  symbol         text,
  side           text,
  order_type     text,
  limit_price    numeric,
  stop_price     numeric,
  trail_amount   numeric,
  trail_percent  numeric,
  trail_anchor   numeric,
  qty            numeric,
  notional       numeric,
  time_in_force  text,
  reserved_cash  numeric,
  reserved_qty   numeric,
  expires_at     timestamptz,
  placed_at      timestamptz,
  buying_power   numeric
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_symbol       text := upper(trim(p_symbol));
  v_side         text := upper(trim(p_side));
  v_type         text := upper(trim(p_order_type));
  v_tif          text := upper(trim(p_time_in_force));
  v_multiplier   numeric(20,6) := coalesce(p_multiplier, 1);
  v_portfolio    portfolios%rowtype;
  v_locked       boolean;
  v_prev_qty     numeric(20,6);
  v_available    numeric(20,6);
  v_short_mv     numeric(20,2);
  v_margin_held  numeric(20,2);
  v_reserved     numeric(20,2);
  v_buying_power numeric(20,2);
  v_order        pending_orders%rowtype;
begin
  if v_side is null or v_side not in ('BUY', 'SELL', 'SHORT', 'COVER') then
    raise exception 'Unknown order side: %.', p_side using errcode = 'FC006';
  end if;
  if v_type is null
     or v_type not in ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP') then
    raise exception
      'Order type must be MARKET, LIMIT, STOP, STOP_LIMIT or TRAILING_STOP.'
      using errcode = 'FC006';
  end if;
  if v_tif is null or v_tif not in ('DAY', 'GTC') then
    raise exception 'Time in force must be DAY or GTC.' using errcode = 'FC006';
  end if;

  -- The limit price belongs to the two types that end in a limit order.
  if v_type in ('LIMIT', 'STOP_LIMIT') and (p_limit_price is null or p_limit_price <= 0) then
    raise exception 'A % order needs a limit price.', replace(v_type, '_', '-')
      using errcode = 'FC006';
  end if;
  if v_type not in ('LIMIT', 'STOP_LIMIT') and p_limit_price is not null then
    raise exception 'A % order cannot carry a limit price.', replace(v_type, '_', '-')
      using errcode = 'FC006';
  end if;

  -- The stop price belongs to the three types that have a trigger.
  if v_type in ('STOP', 'STOP_LIMIT', 'TRAILING_STOP')
     and (p_stop_price is null or p_stop_price <= 0) then
    raise exception 'A % order needs a stop price.', replace(v_type, '_', '-')
      using errcode = 'FC006';
  end if;
  if v_type in ('MARKET', 'LIMIT') and p_stop_price is not null then
    raise exception 'A % order cannot carry a stop price.', lower(v_type)
      using errcode = 'FC006';
  end if;

  -- The trail, and its anchor, belong to trailing stops alone.
  if v_type = 'TRAILING_STOP' then
    if (p_trail_amount is null) = (p_trail_percent is null) then
      raise exception 'A trailing stop needs either a trail amount or a trail percent.'
        using errcode = 'FC006';
    end if;
    if p_trail_amount is not null and p_trail_amount <= 0 then
      raise exception 'A trail amount must be greater than zero.' using errcode = 'FC006';
    end if;
    if p_trail_percent is not null and (p_trail_percent <= 0 or p_trail_percent >= 100) then
      raise exception 'A trail percent must be between 0 and 100.' using errcode = 'FC006';
    end if;
    if p_trail_anchor is null or p_trail_anchor <= 0 then
      raise exception 'A trailing stop needs a starting price to trail from.'
        using errcode = 'FC006';
    end if;
  elsif p_trail_amount is not null or p_trail_percent is not null or p_trail_anchor is not null then
    raise exception 'Only a trailing stop carries a trail.' using errcode = 'FC006';
  end if;

  if (p_qty is null) = (p_notional is null) then
    raise exception 'Enter either a share count or a dollar amount, not both.'
      using errcode = 'FC006';
  end if;

  -- A stop is entered in shares. Converting a dollar amount at a price that
  -- does not exist until the trigger fires runs the wrong way: the cheaper the
  -- fill, the more shares it turns out to be.
  if v_type not in ('MARKET', 'LIMIT') and p_qty is null then
    raise exception
      'A % order is entered in shares, not dollars — the fill price is not known until it triggers.',
      replace(v_type, '_', '-') using errcode = 'FC006';
  end if;

  if p_reserve_cash is null or p_reserve_cash < 0 or p_reserve_qty is null or p_reserve_qty < 0 then
    raise exception 'Order reservation is missing.' using errcode = 'FC006';
  end if;
  if v_multiplier <= 0 then
    raise exception 'Contract size must be greater than zero.' using errcode = 'FC006';
  end if;
  if v_side in ('SHORT', 'COVER') and not symbol_allows_short(v_symbol) then
    raise exception 'Short selling is not available for %, so only BUY and SELL apply here.',
      v_symbol using errcode = 'FC003';
  end if;

  -- Same lock as place_order(), for the same reason.
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

  select coalesce(pos.qty, 0) into v_prev_qty
  from positions pos
  where pos.portfolio_id = v_portfolio.id and pos.symbol = v_symbol;
  v_prev_qty := coalesce(v_prev_qty, 0);

  -- ---------------------------------------------------------------------------
  -- The no-flip rules, checked against the position as it stands.
  -- ---------------------------------------------------------------------------
  if v_side = 'BUY' and v_prev_qty < 0 then
    raise exception 'You are short % %. Use COVER to close a short position.',
      fmt_qty(abs(v_prev_qty)), v_symbol using errcode = 'FC003';
  end if;
  if v_side = 'SHORT' and v_prev_qty > 0 then
    raise exception 'You hold % %. Use SELL to reduce a long position.',
      fmt_qty(v_prev_qty), v_symbol using errcode = 'FC003';
  end if;
  if v_side = 'SELL' and v_prev_qty < 0 then
    raise exception 'You are short %. Use COVER to close it, or SHORT to add to it.',
      v_symbol using errcode = 'FC003';
  end if;
  if v_side = 'COVER' and v_prev_qty > 0 then
    raise exception 'You hold % long. Use SELL to reduce a long position.',
      v_symbol using errcode = 'FC003';
  end if;

  -- ---------------------------------------------------------------------------
  -- Share reservation, for the closing sides.
  -- ---------------------------------------------------------------------------
  if v_side in ('SELL', 'COVER') then
    if v_prev_qty = 0 then
      raise exception 'You do not hold any %.', v_symbol using errcode = 'FC002';
    end if;

    v_available := abs(v_prev_qty) - reserved_qty_for(v_portfolio.id, v_symbol);

    if p_reserve_qty > v_available then
      if v_available <= 0 then
        raise exception
          'Your whole % position is already committed to other working orders.', v_symbol
          using errcode = 'FC002';
      end if;
      raise exception
        'You hold % % but % is already committed to working orders, leaving %.',
        fmt_qty(abs(v_prev_qty)), v_symbol,
        fmt_qty(abs(v_prev_qty) - v_available), fmt_qty(v_available)
        using errcode = 'FC002';
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- Cash reservation, for the opening sides.
  -- ---------------------------------------------------------------------------
  select round(coalesce(sum(abs(pos.qty) * pos.multiplier * pos.avg_cost), 0), 2) into v_short_mv
  from positions pos
  where pos.portfolio_id = v_portfolio.id and pos.qty < 0;

  v_margin_held  := round(reg_t_margin_multiplier() * v_short_mv, 2);
  v_reserved     := reserved_cash_for(v_portfolio.id);
  v_buying_power := v_portfolio.cash - v_margin_held - v_reserved;

  if p_reserve_cash > 0 and p_reserve_cash > v_buying_power then
    raise exception 'Not enough buying power. % % needs $%, and you have $% free%.',
      v_side, v_symbol,
      fmt_money(p_reserve_cash),
      fmt_money(greatest(v_buying_power, 0)),
      case when v_reserved > 0
        then ' (' || fmt_money(v_reserved) || ' is held by working orders)'
        else '' end
      using errcode = 'FC001';
  end if;

  insert into pending_orders (
    portfolio_id, symbol, side, order_type, limit_price, stop_price,
    trail_amount, trail_percent, trail_anchor,
    qty, notional, time_in_force, reserved_cash, reserved_qty, expires_at, multiplier
  )
  values (
    v_portfolio.id, v_symbol, v_side, v_type, p_limit_price, p_stop_price,
    p_trail_amount, p_trail_percent, p_trail_anchor,
    p_qty, p_notional, v_tif, p_reserve_cash, p_reserve_qty, p_expires_at, v_multiplier
  )
  returning * into v_order;

  return query select
    v_order.id,
    v_order.symbol,
    v_order.side,
    v_order.order_type,
    v_order.limit_price,
    v_order.stop_price,
    v_order.trail_amount,
    v_order.trail_percent,
    v_order.trail_anchor,
    v_order.qty,
    v_order.notional,
    v_order.time_in_force,
    v_order.reserved_cash,
    v_order.reserved_qty,
    v_order.expires_at,
    v_order.placed_at,
    greatest(v_buying_power - p_reserve_cash, 0)::numeric(20,2);
end $fn$;

-- -----------------------------------------------------------------------------
-- 5. trail_pending_order() — the ratchet.
--
-- Called by the sweep for each working trailing stop, once per tick. It is a
-- function rather than an UPDATE in the Worker for the same reason everything
-- else is: the anchor must only ever move in the member's favour, and stating
-- that as `greatest`/`least` inside one statement makes a concurrent sweep
-- incapable of walking it backwards.
--
-- Returns the row's new stop so the caller can decide whether it has fired,
-- without a second read.
-- -----------------------------------------------------------------------------
create or replace function trail_pending_order(p_order_id uuid, p_price numeric)
returns table (order_id uuid, trail_anchor numeric, stop_price numeric, moved boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_order    pending_orders%rowtype;
  v_anchor   numeric(20,6);
  v_stop     numeric(20,6);
  v_rising   boolean;
begin
  if p_price is null or p_price <= 0 then
    raise exception 'A trailing stop needs a price to trail from.' using errcode = 'FC012';
  end if;

  select * into v_order from pending_orders o where o.id = p_order_id for update;

  if not found then
    raise exception 'That order does not exist.' using errcode = 'FC011';
  end if;
  if v_order.status <> 'PENDING' or v_order.order_type <> 'TRAILING_STOP' then
    raise exception 'That order is not a working trailing stop.' using errcode = 'FC003';
  end if;

  -- BUY and COVER trail a falling market and trigger on the way back up; SELL
  -- and SHORT trail a rising one and trigger on the way back down. The anchor
  -- is the best price seen, so it is a maximum in one case and a minimum in
  -- the other.
  v_rising := v_order.side in ('SELL', 'SHORT');

  v_anchor := case when v_rising
    then greatest(v_order.trail_anchor, p_price)
    else least(v_order.trail_anchor, p_price)
  end;

  v_stop := case
    when v_order.trail_amount is not null then
      case when v_rising then v_anchor - v_order.trail_amount
           else v_anchor + v_order.trail_amount end
    else
      case when v_rising then v_anchor * (1 - v_order.trail_percent / 100)
           else v_anchor * (1 + v_order.trail_percent / 100) end
  end;

  -- A trail wider than the price itself would put the stop at or below zero,
  -- where it can never fire. Held just above instead, so the order stays honest
  -- rather than silently becoming a good-til-cancelled no-op.
  v_stop := greatest(round(v_stop, 6), 0.000001);

  update pending_orders
     set trail_anchor = v_anchor,
         stop_price   = v_stop
   where id = p_order_id;

  return query select
    v_order.id,
    v_anchor,
    v_stop,
    (v_anchor is distinct from v_order.trail_anchor);
end $fn$;

-- -----------------------------------------------------------------------------
-- 6. trigger_pending_order() — record that a stop has fired.
--
-- Separate from the fill, because the two can be separated by a sweep: a
-- triggered STOP_LIMIT becomes a *limit* order, which may then wait. Stamping
-- the trigger is what stops it being re-evaluated as a stop on the next tick
-- and re-arming itself if the price crosses back.
-- -----------------------------------------------------------------------------
create or replace function trigger_pending_order(p_order_id uuid)
returns table (order_id uuid, triggered_at timestamptz)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_order pending_orders%rowtype;
begin
  select * into v_order from pending_orders o where o.id = p_order_id for update;

  if not found then
    raise exception 'That order does not exist.' using errcode = 'FC011';
  end if;
  if v_order.status <> 'PENDING' then
    raise exception 'That order is already %.', lower(v_order.status) using errcode = 'FC003';
  end if;
  if v_order.order_type not in ('STOP', 'STOP_LIMIT', 'TRAILING_STOP') then
    raise exception 'That order has no stop to trigger.' using errcode = 'FC003';
  end if;

  if v_order.triggered_at is null then
    update pending_orders set triggered_at = now() where id = p_order_id
      returning * into v_order;
  end if;

  return query select v_order.id, v_order.triggered_at;
end $fn$;

-- -----------------------------------------------------------------------------
-- 7. Permissions.
--
-- A dropped function comes back with EXECUTE granted to PUBLIC, so every
-- signature is revoked explicitly rather than trusting the drop to carry the
-- old grants. Rule 2: only the Worker's service role moves money.
-- -----------------------------------------------------------------------------
revoke all on function queue_order(
  uuid, text, text, text, numeric, numeric, numeric, text, numeric, numeric,
  timestamptz, numeric, numeric, numeric, numeric, numeric
) from public, anon, authenticated;

revoke all on function trail_pending_order(uuid, numeric) from public, anon, authenticated;
revoke all on function trigger_pending_order(uuid) from public, anon, authenticated;
