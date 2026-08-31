-- =============================================================================
-- Finance Club Terminal — resting orders
--
-- Until now an order was a single instant: the Worker priced it, place_order()
-- filled it, done. Anything outside market hours was refused. That is wrong for
-- a club whose members do their thinking on a Sunday afternoon, so an order can
-- now be *queued* and filled later by the sweep in worker/orders/sweep.ts.
--
-- The thing to be clear about, because it is the most common misunderstanding
-- here: nothing fills on a weekend. US equities trade 09:30-16:00 ET on
-- weekdays. A limit order placed on Saturday is not "waiting to be matched" —
-- there is no session, no volume and no counterparty, and Friday's close simply
-- sits there until Monday. A resting order is an instruction stored until the
-- market can act on it, and that is all it is.
--
-- Two new obligations come with storing that instruction:
--
--   1. RESERVATIONS. If a member queues six buys on Sunday against $10,000,
--      only some of them can fill on Monday. Finding that out on Monday is a
--      bad experience, so buying power is held at the moment the order is
--      queued and the sixth one is refused there and then. Cash reservations
--      live in `reserved_cash`; share reservations, which stop the same 40
--      shares being sold twice, live in `reserved_qty`.
--
--   2. RELEASE. Every reservation must be given back — on fill, on cancel, on
--      expiry, and on rejection. A leaked reservation is invisible money the
--      member can never spend again, so every status transition out of PENDING
--      goes through one of the functions below and none of them are optional.
--
-- The Worker computes the size of the reservation (see reserveFor() in
-- worker/orders/engine.ts, which is unit tested) and passes it in. Postgres
-- enforces that the member has it; it does not guess at prices.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pending_orders — instructions, not fills. A fill still lands in `trades`.
-- -----------------------------------------------------------------------------
create table if not exists pending_orders (
  id             uuid primary key default gen_random_uuid(),
  portfolio_id   uuid          not null references portfolios (id) on delete cascade,
  symbol         text          not null,
  side           text          not null check (side in ('BUY', 'SELL', 'SHORT', 'COVER')),
  order_type     text          not null check (order_type in ('MARKET', 'LIMIT')),

  -- The price condition. Null on a market order, required on a limit.
  limit_price    numeric(20,6) check (limit_price is null or limit_price > 0),

  -- Exactly one of these. A share count, or a dollar amount the Worker converts
  -- at the price it fetches when the order finally fills.
  qty            numeric(20,6) check (qty is null or qty > 0),
  notional       numeric(20,2) check (notional is null or notional > 0),

  time_in_force  text          not null check (time_in_force in ('DAY', 'GTC')),
  status         text          not null default 'PENDING'
                   check (status in ('PENDING', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')),

  -- Held while PENDING, released on every exit. See the header.
  reserved_cash  numeric(20,2) not null default 0 check (reserved_cash >= 0),
  reserved_qty   numeric(20,6) not null default 0 check (reserved_qty >= 0),

  -- A DAY order expires at the close of the next session it was eligible for,
  -- which the Worker reads off Alpaca's calendar — so one placed on Saturday
  -- dies at Monday's 16:00, not immediately. Null means GTC.
  expires_at     timestamptz,

  trade_id       uuid references trades (id) on delete set null,
  reject_reason  text,
  placed_at      timestamptz   not null default now(),
  resolved_at    timestamptz,

  constraint pending_orders_amount_xor
    check ((qty is null) <> (notional is null)),
  constraint pending_orders_limit_price_required
    check ((order_type = 'LIMIT') = (limit_price is not null)),
  -- A resolved order holds nothing. This is the leak check, enforced by the
  -- database rather than trusted to the functions below.
  constraint pending_orders_released
    check (status = 'PENDING' or (reserved_cash = 0 and reserved_qty = 0))
);

create index if not exists pending_orders_portfolio_idx
  on pending_orders (portfolio_id, placed_at desc);

-- The sweep's index: it only ever asks for open orders, grouped by symbol.
create index if not exists pending_orders_working_idx
  on pending_orders (symbol) where status = 'PENDING';

alter table pending_orders enable row level security;

-- -----------------------------------------------------------------------------
-- The one table members cannot read across the club.
--
-- Every other table is deliberately open: seeing each other's positions and
-- fills is the point of a learning club. A resting order is different, because
-- it is intent rather than history. Publishing that someone has a buy limit at
-- $95 invites the rest of the club to trade in front of it, which teaches
-- exactly the wrong lesson. Owner-only.
-- -----------------------------------------------------------------------------
drop policy if exists pending_orders_read on pending_orders;
create policy pending_orders_read on pending_orders
  for select to authenticated
  using (
    portfolio_id in (select id from portfolios where user_id = auth.uid())
  );

-- =============================================================================
-- Reservation accounting
--
-- One place that answers "what is actually available", so queue_order() and
-- place_order() cannot drift into disagreeing about it.
-- =============================================================================

/**
 * Buying power already promised to resting orders.
 *
 * p_exclude is the order currently being filled: its reservation is about to be
 * spent, so counting it would make the member look poorer than they are and
 * reject their own queued order at the moment it came good.
 */
create or replace function reserved_cash_for(p_portfolio_id uuid, p_exclude uuid default null)
returns numeric
language sql
stable
as $fn$
  select coalesce(sum(o.reserved_cash), 0)::numeric(20,2)
  from pending_orders o
  where o.portfolio_id = p_portfolio_id
    and o.status = 'PENDING'
    and (p_exclude is null or o.id <> p_exclude)
$fn$;

/** Shares of one symbol already promised to resting closing orders. */
create or replace function reserved_qty_for(
  p_portfolio_id uuid,
  p_symbol       text,
  p_exclude      uuid default null
)
returns numeric
language sql
stable
as $fn$
  select coalesce(sum(o.reserved_qty), 0)::numeric(20,6)
  from pending_orders o
  where o.portfolio_id = p_portfolio_id
    and o.symbol = p_symbol
    and o.status = 'PENDING'
    and (p_exclude is null or o.id <> p_exclude)
$fn$;

-- =============================================================================
-- queue_order()
--
-- Stores an instruction and holds the buying power or shares it will need.
-- Validates everything place_order() would except the price, which does not
-- exist yet.
--
-- Errors reuse the SQLSTATEs from 0002 so the Worker maps one set of codes:
--   FC001 insufficient buying power   FC002 position too small
--   FC003 wrong side                  FC004 trading locked
--   FC005 no portfolio                FC006 malformed order
-- =============================================================================
create or replace function queue_order(
  p_user_id       uuid,
  p_symbol        text,
  p_side          text,
  p_order_type    text,
  p_limit_price   numeric,
  p_qty           numeric,
  p_notional      numeric,
  p_time_in_force text,
  -- What the Worker calculated this order could cost at worst. See reserveFor().
  p_reserve_cash  numeric,
  -- Shares of an existing position this order will consume (SELL and COVER).
  p_reserve_qty   numeric,
  p_expires_at    timestamptz default null
)
returns table (
  order_id       uuid,
  symbol         text,
  side           text,
  order_type     text,
  limit_price    numeric,
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
  if v_type is null or v_type not in ('MARKET', 'LIMIT') then
    raise exception 'Order type must be MARKET or LIMIT.' using errcode = 'FC006';
  end if;
  if v_tif is null or v_tif not in ('DAY', 'GTC') then
    raise exception 'Time in force must be DAY or GTC.' using errcode = 'FC006';
  end if;
  if v_type = 'LIMIT' and (p_limit_price is null or p_limit_price <= 0) then
    raise exception 'A limit order needs a limit price.' using errcode = 'FC006';
  end if;
  if v_type = 'MARKET' and p_limit_price is not null then
    raise exception 'A market order cannot carry a limit price.' using errcode = 'FC006';
  end if;
  if (p_qty is null) = (p_notional is null) then
    raise exception 'Enter either a share count or a dollar amount, not both.'
      using errcode = 'FC006';
  end if;
  if p_reserve_cash is null or p_reserve_cash < 0 or p_reserve_qty is null or p_reserve_qty < 0 then
    raise exception 'Order reservation is missing.' using errcode = 'FC006';
  end if;

  -- Same lock as place_order(), for the same reason: the reservation is read,
  -- added to, and written, and two tabs must not both fit into the same cash.
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
  --
  -- A queued order is validated against what the member holds NOW, not against
  -- what some other queued order might leave them holding. Queueing a BUY and a
  -- SELL of the same flat symbol is therefore refused, which is the honest
  -- answer: the sweep fills in price order, not in the order things were typed,
  -- so a chain of dependent orders would fill in an order nobody predicted.
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
  --
  -- Without this a member holding 40 shares could queue two SELL 40 orders on
  -- Sunday and watch one of them fail on Monday for reasons that look arbitrary.
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
  -- Cash reservation, for the opening sides. Closing sides reserve nothing
  -- because they can only improve buying power — the same argument as 0002.
  -- ---------------------------------------------------------------------------
  select round(coalesce(sum(abs(pos.qty) * pos.avg_cost), 0), 2) into v_short_mv
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
    portfolio_id, symbol, side, order_type, limit_price,
    qty, notional, time_in_force, reserved_cash, reserved_qty, expires_at
  )
  values (
    v_portfolio.id, v_symbol, v_side, v_type, p_limit_price,
    p_qty, p_notional, v_tif, p_reserve_cash, p_reserve_qty, p_expires_at
  )
  returning * into v_order;

  return query select
    v_order.id,
    v_order.symbol,
    v_order.side,
    v_order.order_type,
    v_order.limit_price,
    v_order.qty,
    v_order.notional,
    v_order.time_in_force,
    v_order.reserved_cash,
    v_order.reserved_qty,
    v_order.expires_at,
    v_order.placed_at,
    greatest(v_buying_power - p_reserve_cash, 0)::numeric(20,2);
end $fn$;

-- =============================================================================
-- cancel_pending_order() — the member changed their mind.
-- =============================================================================
create or replace function cancel_pending_order(p_user_id uuid, p_order_id uuid)
returns table (order_id uuid, symbol text, side text, buying_power numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_portfolio portfolios%rowtype;
  v_order     pending_orders%rowtype;
  v_short_mv  numeric(20,2);
begin
  select p.* into v_portfolio
  from portfolios p
  join seasons s on s.id = p.season_id
  where p.user_id = p_user_id and s.is_active
  for update of p;

  if not found then
    raise exception 'You do not have a portfolio in the active season.'
      using errcode = 'FC005';
  end if;

  select * into v_order
  from pending_orders o
  where o.id = p_order_id and o.portfolio_id = v_portfolio.id
  for update;

  if not found then
    raise exception 'That order does not exist.' using errcode = 'FC002';
  end if;
  if v_order.status <> 'PENDING' then
    -- Not an error worth shouting about: the sweep almost certainly filled it a
    -- moment before the click landed, and the member should be told which.
    raise exception 'That order is already %.', lower(v_order.status)
      using errcode = 'FC002';
  end if;

  update pending_orders
  set status = 'CANCELLED', reserved_cash = 0, reserved_qty = 0, resolved_at = now()
  where pending_orders.id = v_order.id;

  select round(coalesce(sum(abs(pos.qty) * pos.avg_cost), 0), 2) into v_short_mv
  from positions pos
  where pos.portfolio_id = v_portfolio.id and pos.qty < 0;

  return query select
    v_order.id,
    v_order.symbol,
    v_order.side,
    greatest(
      v_portfolio.cash
        - round(reg_t_margin_multiplier() * v_short_mv, 2)
        - reserved_cash_for(v_portfolio.id),
      0
    )::numeric(20,2);
end $fn$;

-- =============================================================================
-- expire_pending_orders() — the DAY sweep.
--
-- Run by the same cron as the fill sweep. Releasing the reservation is the
-- whole job; the status is almost incidental.
-- =============================================================================
create or replace function expire_pending_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  with expired as (
    update pending_orders
    set status = 'EXPIRED', reserved_cash = 0, reserved_qty = 0, resolved_at = now()
    where status = 'PENDING'
      and expires_at is not null
      and expires_at <= now()
    returning 1
  )
  select count(*) into v_count from expired;

  return v_count;
end $fn$;

-- =============================================================================
-- reject_pending_order() — the sweep could not fill it and never will.
--
-- Used when place_order() refuses a resting order on grounds that will not
-- improve by waiting: the member sold the position out from under a queued SELL,
-- say. The reservation is released and the reason is kept for the blotter.
-- =============================================================================
create or replace function reject_pending_order(p_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update pending_orders
  set status = 'REJECTED',
      reserved_cash = 0,
      reserved_qty = 0,
      reject_reason = left(p_reason, 500),
      resolved_at = now()
  where pending_orders.id = p_order_id
    and pending_orders.status = 'PENDING';
end $fn$;

-- =============================================================================
-- place_order(), revised: it can now settle a resting order.
--
-- The signature gains p_pending_order_id, so the old one has to go rather than
-- become an overload — two candidates differing only by a defaulted argument
-- make every call ambiguous.
--
-- Two things change inside. Buying power now subtracts what other resting
-- orders have reserved, so an immediate order cannot spend money already
-- promised. And when p_pending_order_id is given, that order's own reservation
-- is excluded from the total (it is being spent right now, not competing with
-- itself) and the order is marked FILLED in the same transaction as the trade.
-- =============================================================================
drop function if exists place_order(uuid, text, text, numeric, numeric, jsonb);

create or replace function place_order(
  p_user_id uuid,
  p_symbol  text,
  p_side    text,
  p_qty     numeric,
  p_price   numeric,
  p_marks   jsonb default '{}'::jsonb,
  -- When set, this fill settles that resting order: its reservation is released
  -- and it is marked FILLED here, inside the lock, so a crash cannot leave a
  -- trade without its order or a reservation without its order.
  p_pending_order_id uuid default null
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
  reserved_cash     numeric,
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
  v_pending      pending_orders%rowtype;
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
  v_reserved     numeric(20,2);
  v_buying_power numeric(20,2);
  v_available    numeric(20,2);
  v_free_qty     numeric(20,6);
  v_trade_id     uuid;
  v_executed_at  timestamptz   := now();
begin
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

  -- THE LOCK. See 0002 — everything below reads a consistent portfolio.
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

  -- The resting order being settled, if this is a sweep fill. Locked so two
  -- concurrent sweeps cannot both fill it.
  if p_pending_order_id is not null then
    select * into v_pending
    from pending_orders o
    where o.id = p_pending_order_id
      and o.portfolio_id = v_portfolio.id
    for update;

    if not found then
      raise exception 'That working order does not exist.' using errcode = 'FC002';
    end if;
    if v_pending.status <> 'PENDING' then
      raise exception 'That order is already %.', lower(v_pending.status)
        using errcode = 'FC002';
    end if;
  end if;

  select * into v_position
  from positions
  where positions.portfolio_id = v_portfolio.id
    and positions.symbol = v_symbol
  for update;

  v_held     := found;
  v_prev_qty := coalesce(v_position.qty, 0);
  v_prev_avg := v_position.avg_cost;

  -- ---------------------------------------------------------------------------
  -- What the fill does to the position. Unchanged from 0002.
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
        fmt_qty(v_prev_qty), v_symbol, fmt_qty(p_qty)
        using errcode = 'FC002';
    end if;

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
        fmt_qty(abs(v_prev_qty)), v_symbol, fmt_qty(p_qty)
        using errcode = 'FC002';
    end if;

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
  -- Shares promised to OTHER resting orders are not available to this one.
  --
  -- An immediate SELL must not spend shares a queued SELL is already holding,
  -- or Monday's sweep finds the position gone.
  -- ---------------------------------------------------------------------------
  if v_side in ('SELL', 'COVER') then
    v_free_qty := abs(v_prev_qty) - reserved_qty_for(v_portfolio.id, v_symbol, p_pending_order_id);

    if p_qty > v_free_qty then
      raise exception
        'You hold % % but % is committed to working orders, leaving %.',
        fmt_qty(abs(v_prev_qty)), v_symbol,
        fmt_qty(abs(v_prev_qty) - greatest(v_free_qty, 0)),
        fmt_qty(greatest(v_free_qty, 0))
        using errcode = 'FC002';
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- Post-trade valuation, marked at the prices the Worker passed in.
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

  v_margin_held := round(reg_t_margin_multiplier() * v_short_mv, 2);

  -- Money promised to other resting orders is already spent as far as this one
  -- is concerned. The order being settled is excluded: its reservation is what
  -- is paying for this fill, so counting it would have the order reject itself.
  v_reserved     := reserved_cash_for(v_portfolio.id, p_pending_order_id);
  v_buying_power := v_cash - v_margin_held - v_reserved;

  if v_side in ('BUY', 'SHORT') and v_buying_power < 0 then
    v_available := greatest(v_portfolio.cash
                            - round(reg_t_margin_multiplier()
                                    * (v_short_mv - case when v_side = 'SHORT'
                                                    then v_notional else 0 end), 2)
                            - v_reserved, 0);

    -- The trailing placeholders are separated by the full stop deliberately:
    -- `$%%` would read as an escaped literal percent sign rather than two
    -- substitutions, and PL/pgSQL rejects the function at compile time for
    -- having more arguments than places to put them.
    raise exception 'Not enough buying power. % % needs $%, and you have $%.%',
      v_side, v_symbol,
      fmt_money(case when v_side = 'SHORT' then round(v_notional / 2, 2) else v_notional end),
      fmt_money(v_available),
      case when v_reserved > 0
        then ' (' || fmt_money(v_reserved) || ' is held by working orders)'
        else '' end
      using errcode = 'FC001';
  end if;

  -- ---------------------------------------------------------------------------
  -- Writes.
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

  -- Settle the resting order in the same transaction as the trade it produced.
  if p_pending_order_id is not null then
    update pending_orders
    set status = 'FILLED',
        reserved_cash = 0,
        reserved_qty = 0,
        trade_id = v_trade_id,
        resolved_at = v_executed_at
    where pending_orders.id = p_pending_order_id;
  end if;

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
    v_reserved,
    v_executed_at;
end $fn$;

-- Only the Worker's service-role key may trade or queue.
revoke all on function place_order(uuid, text, text, numeric, numeric, jsonb, uuid)
  from public, anon, authenticated;
revoke all on function queue_order(uuid, text, text, text, numeric, numeric, numeric, text, numeric, numeric, timestamptz)
  from public, anon, authenticated;
revoke all on function cancel_pending_order(uuid, uuid) from public, anon, authenticated;
revoke all on function expire_pending_orders() from public, anon, authenticated;
revoke all on function reject_pending_order(uuid, text) from public, anon, authenticated;
