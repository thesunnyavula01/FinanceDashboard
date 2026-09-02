-- =============================================================================
-- 0006 — options and crypto.
--
-- Three asset classes now share one positions table, one trades table and one
-- place_order(). Two things had to change for that to be true.
--
-- 1. THE MULTIPLIER. An option contract is 100 shares. Every money expression
--    in this schema was `qty * price`, which is right for a stock and wrong by
--    two orders of magnitude for a contract. `multiplier` is added to
--    positions, trades and pending_orders with DEFAULT 1, so every row that
--    already exists is correct and the equity path is unchanged, and every
--    product below becomes `qty * multiplier * price`.
--
--    The alternative — storing an option's price pre-multiplied, 5.25 of
--    premium as 525.00 per contract — needs no column and no change here. It
--    also makes the blotter print 525.00 for a contract the chain, one panel
--    away, prints at 5.25. `price` has to mean the same thing on every row.
--
-- 2. EXPIRY. An option that never expires is not an option. `trades.side` gains
--    'EXPIRE', and the price check is relaxed for it alone, because a worthless
--    contract settles at exactly zero and rounding that up to a cent to satisfy
--    a constraint would be a lie in the ledger. Expiry is not a sale, so a
--    member reading the blotter should see which one happened.
--
-- There is no asset_class column, and that is deliberate: the symbol already
-- says what it is. `BTC/USD` has a slash, an OCC symbol ends in fifteen fixed
-- characters, and no listed ticker is either. worker/market/symbols.ts is the
-- authority; symbol_allows_short() below is its one mirror in SQL.
--
-- Options and crypto are LONG ONLY. The flat Reg T multiplier is not a margin
-- model for a naked short call — it would hold about $3 against a $2 premium
-- carrying unlimited risk — and crypto has no borrow to model. Refusing is the
-- same call this schema already made about forced liquidation.
--
-- Re-runnable, like every migration here. Postgres runs the whole script as one
-- implicit transaction, so a failure partway leaves nothing behind.
--
-- NOTE: place_order() and queue_order() are DROPPED and recreated rather than
-- overloaded, for the reason 0003 documents — a defaulted extra argument makes
-- every existing call ambiguous. This trips the SQL editor's "destructive
-- operation" warning. That is expected.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The multiplier column.
-- -----------------------------------------------------------------------------
alter table positions      add column if not exists multiplier numeric(20,6) not null default 1;
alter table trades         add column if not exists multiplier numeric(20,6) not null default 1;
alter table pending_orders add column if not exists multiplier numeric(20,6) not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'positions_multiplier_positive') then
    alter table positions add constraint positions_multiplier_positive check (multiplier > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trades_multiplier_positive') then
    alter table trades add constraint trades_multiplier_positive check (multiplier > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pending_orders_multiplier_positive') then
    alter table pending_orders add constraint pending_orders_multiplier_positive check (multiplier > 0);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 'EXPIRE' as a fifth side, and a zero price for it alone.
--
-- The old constraints are found by what they say rather than by name: an inline
-- column check is named by convention, but relying on the convention would
-- leave the original in place and silently keep rejecting EXPIRE.
-- -----------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'trades'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%COVER%'
      and pg_get_constraintdef(con.oid) not like '%EXPIRE%'
  loop
    execute format('alter table trades drop constraint %I', c.conname);
  end loop;

  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'trades'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%price%'
      and pg_get_constraintdef(con.oid) not like '%EXPIRE%'
  loop
    execute format('alter table trades drop constraint %I', c.conname);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'trades_side_allowed') then
    alter table trades add constraint trades_side_allowed
      check (side in ('BUY', 'SELL', 'SHORT', 'COVER', 'EXPIRE'));
  end if;

  -- A contract that finished out of the money is worth zero, and that is a
  -- price rather than a missing value.
  if not exists (select 1 from pg_constraint where conname = 'trades_price_allowed') then
    alter table trades add constraint trades_price_allowed
      check (price > 0 or side = 'EXPIRE');
  end if;
end $$;

-- =============================================================================
-- symbol_allows_short() — the one place SQL knows about asset classes.
--
-- A direct mirror of allowsShort() in worker/market/symbols.ts: a slash means a
-- crypto pair, a fifteen-character OCC tail means an option contract, and only
-- what is neither can be sold short. The Worker refuses these first and with a
-- better sentence; this is the second line, at the level that actually moves
-- the money.
-- =============================================================================
create or replace function symbol_allows_short(p_symbol text)
returns boolean
language sql
immutable
as $fn$
  select upper(trim(coalesce(p_symbol, ''))) not like '%/%'
     and upper(trim(coalesce(p_symbol, ''))) !~ '^[A-Z][A-Z0-9]{0,5}[0-9]{6}[CP][0-9]{8}$'
$fn$;

-- =============================================================================
-- place_order(), revised: it carries a contract multiplier.
-- =============================================================================
drop function if exists place_order(uuid, text, text, numeric, numeric, jsonb, uuid);

create or replace function place_order(
  p_user_id uuid,
  p_symbol  text,
  p_side    text,
  p_qty     numeric,
  p_price   numeric,
  p_marks   jsonb default '{}'::jsonb,
  p_pending_order_id uuid default null,
  -- Shares per unit. 1 for a stock or a coin, 100 for an option contract. The
  -- Worker derives it from the symbol and passes it; the position it lands on
  -- is the authority if the two ever disagree.
  p_multiplier numeric default 1
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
  v_multiplier   numeric(20,6) := coalesce(p_multiplier, 1);
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

  if v_multiplier <= 0 then
    raise exception 'Contract size must be greater than zero.' using errcode = 'FC006';
  end if;

  -- Long only off the equity board. See the header.
  if v_side in ('SHORT', 'COVER') and not symbol_allows_short(v_symbol) then
    raise exception 'Short selling is not available for %, so only BUY and SELL apply here.',
      v_symbol using errcode = 'FC003';
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

  -- A held position's contract size is the authority. If the caller disagrees,
  -- one of the two is wrong about what this symbol is, and guessing which would
  -- misprice the whole position rather than just this fill.
  if v_held and v_position.multiplier <> v_multiplier then
    raise exception 'The contract size for % is %, and this order says %.',
      v_symbol, fmt_qty(v_position.multiplier), fmt_qty(v_multiplier)
      using errcode = 'FC006';
  end if;

  -- ---------------------------------------------------------------------------
  -- What the fill does to the position.
  --
  -- avg_cost stays a per-share price — the premium, for an option — so the
  -- averaging below is unchanged. Only the money lines carry the multiplier.
  -- ---------------------------------------------------------------------------
  if v_side = 'BUY' then
    if v_prev_qty < 0 then
      raise exception 'You are short % %. Use COVER to close a short position.',
        fmt_qty(abs(v_prev_qty)), v_symbol
        using errcode = 'FC003';
    end if;

    v_new_qty  := v_prev_qty + p_qty;
    v_new_avg  := round((v_prev_qty * coalesce(v_prev_avg, 0) + p_qty * p_price) / v_new_qty, 6);
    v_notional := round(p_qty * v_multiplier * p_price, 2);
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

    v_realized := round((p_price - v_prev_avg) * p_qty * v_multiplier, 2);
    v_new_qty  := v_prev_qty - p_qty;
    v_new_avg  := v_prev_avg;
    v_notional := round(p_qty * v_multiplier * p_price, 2);
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
    v_notional := round(p_qty * v_multiplier * p_price, 2);
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

    v_realized := round((v_prev_avg - p_price) * p_qty * v_multiplier, 2);
    v_new_qty  := v_prev_qty + p_qty;
    v_new_avg  := v_prev_avg;
    v_notional := round(p_qty * v_multiplier * p_price, 2);
    v_cash     := v_portfolio.cash - v_notional;
  end if;

  if v_new_qty <> 0 and (v_new_avg is null or v_new_avg <= 0) then
    raise exception 'The price of % is too small to trade here.', v_symbol
      using errcode = 'FC006';
  end if;

  -- ---------------------------------------------------------------------------
  -- Shares promised to OTHER resting orders are not available to this one.
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
  --
  -- Each position carries its own contract size, so a book holding stock and
  -- contracts values correctly in one pass.
  -- ---------------------------------------------------------------------------
  with post as (
    select
      pos.qty                                                             as qty,
      pos.multiplier                                                      as mult,
      coalesce(nullif(p_marks ->> pos.symbol, '')::numeric, pos.avg_cost) as mark
    from positions pos
    where pos.portfolio_id = v_portfolio.id
      and pos.symbol <> v_symbol
    union all
    select v_new_qty, v_multiplier, p_price
    where v_new_qty <> 0
  )
  select
    round(coalesce(sum(post.qty * post.mult * post.mark)  filter (where post.qty > 0), 0), 2),
    round(coalesce(sum(-post.qty * post.mult * post.mark) filter (where post.qty < 0), 0), 2)
  into v_long_mv, v_short_mv
  from post;

  v_margin_held := round(reg_t_margin_multiplier() * v_short_mv, 2);

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
    set qty = v_new_qty, avg_cost = v_new_avg, multiplier = v_multiplier, updated_at = now()
    where positions.portfolio_id = v_portfolio.id
      and positions.symbol = v_symbol;
  else
    insert into positions (portfolio_id, symbol, qty, avg_cost, multiplier)
    values (v_portfolio.id, v_symbol, v_new_qty, v_new_avg, v_multiplier);
  end if;

  update portfolios set cash = v_cash where portfolios.id = v_portfolio.id;

  insert into trades (
    portfolio_id, symbol, side, qty, price, notional, realized_pnl, multiplier, executed_at
  )
  values (
    v_portfolio.id, v_symbol, v_side, p_qty, p_price, v_notional, v_realized,
    v_multiplier, v_executed_at
  )
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

-- =============================================================================
-- queue_order(), revised: it stores the contract multiplier with the order, so
-- the sweep fills it at the same size it was reserved at.
-- =============================================================================
drop function if exists queue_order(
  uuid, text, text, text, numeric, numeric, numeric, text, numeric, numeric, timestamptz
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
  p_multiplier    numeric default 1
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
    portfolio_id, symbol, side, order_type, limit_price,
    qty, notional, time_in_force, reserved_cash, reserved_qty, expires_at, multiplier
  )
  values (
    v_portfolio.id, v_symbol, v_side, v_type, p_limit_price,
    p_qty, p_notional, v_tif, p_reserve_cash, p_reserve_qty, p_expires_at, v_multiplier
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
-- cancel_pending_order() — unchanged except that the short market value it
-- quotes back now respects contract size.
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
    raise exception 'That order is already %.', lower(v_order.status)
      using errcode = 'FC002';
  end if;

  update pending_orders
  set status = 'CANCELLED', reserved_cash = 0, reserved_qty = 0, resolved_at = now()
  where pending_orders.id = v_order.id;

  select round(coalesce(sum(abs(pos.qty) * pos.multiplier * pos.avg_cost), 0), 2) into v_short_mv
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
-- settle_option_expiry() — what happens to a contract on its last day.
--
-- A long option is settled for CASH at intrinsic value, not exercised into
-- shares. Exercising an in-the-money call needs the full strike in cash and can
-- simply fail, which would leave a member holding a dead contract that no
-- longer has a price. Cash settlement always succeeds and produces the same
-- profit and loss, which is the whole lesson.
--
-- Out of the money settles at exactly zero. That is a price, not a missing
-- value, which is what trades_price_allowed exists for.
--
-- The Worker computes the intrinsic value — Postgres has no price feed — and
-- this takes the same portfolio lock place_order() does, in the same order, so
-- a member's order cannot land halfway through their own expiry.
-- =============================================================================
create or replace function settle_option_expiry(p_position_id uuid, p_intrinsic numeric)
returns table (
  trade_id     uuid,
  portfolio_id uuid,
  symbol       text,
  qty          numeric,
  price        numeric,
  notional     numeric,
  realized_pnl numeric,
  cash         numeric
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_owner      uuid;
  v_portfolio  portfolios%rowtype;
  v_position   positions%rowtype;
  v_notional   numeric(20,2);
  v_realized   numeric(20,2);
  v_cash       numeric(20,2);
  v_trade_id   uuid;
  v_settled_at timestamptz := now();
begin
  if p_intrinsic is null or p_intrinsic < 0 then
    raise exception 'A settlement price cannot be negative.' using errcode = 'FC012';
  end if;

  select pos.portfolio_id into v_owner from positions pos where pos.id = p_position_id;
  if v_owner is null then
    raise exception 'No such position.' using errcode = 'FC011';
  end if;

  -- Portfolio first, then the position — the same order place_order() takes, so
  -- the two can never deadlock against each other.
  select * into v_portfolio from portfolios where id = v_owner for update;
  if not found then
    raise exception 'No such portfolio.' using errcode = 'FC011';
  end if;

  select * into v_position from positions where id = p_position_id for update;
  if not found then
    raise exception 'No such position.' using errcode = 'FC011';
  end if;

  -- Options are long only here, so a negative quantity means something upstream
  -- is wrong and settling it would book the profit backwards.
  if v_position.qty <= 0 then
    raise exception 'Cannot settle a short position in %.', v_position.symbol
      using errcode = 'FC003';
  end if;

  v_notional := round(v_position.qty * v_position.multiplier * p_intrinsic, 2);
  v_realized := round((p_intrinsic - v_position.avg_cost)
                      * v_position.qty * v_position.multiplier, 2);
  v_cash     := v_portfolio.cash + v_notional;

  insert into trades (
    portfolio_id, symbol, side, qty, price, notional, realized_pnl, multiplier, executed_at
  )
  values (
    v_portfolio.id, v_position.symbol, 'EXPIRE', v_position.qty, p_intrinsic,
    v_notional, v_realized, v_position.multiplier, v_settled_at
  )
  returning trades.id into v_trade_id;

  delete from positions where id = p_position_id;

  update portfolios set cash = v_cash where portfolios.id = v_portfolio.id;

  -- A working order against a contract that no longer exists would hold its
  -- reservation forever, and an invisible dollar a member can never spend again
  -- is the exact failure the reservation design exists to prevent.
  update pending_orders
  set status = 'REJECTED',
      reserved_cash = 0,
      reserved_qty = 0,
      reject_reason = 'The contract expired before this order could fill.',
      resolved_at = v_settled_at
  where pending_orders.portfolio_id = v_portfolio.id
    and pending_orders.symbol = v_position.symbol
    and pending_orders.status = 'PENDING';

  return query select
    v_trade_id,
    v_portfolio.id,
    v_position.symbol,
    v_position.qty,
    p_intrinsic,
    v_notional,
    v_realized,
    v_cash;
end $fn$;

-- =============================================================================
-- rebuild_portfolio(), revised: the replay knows about contract size and about
-- expiry.
--
-- This is the sharpest edge in the migration. The replay rewrites `notional` on
-- every trade row from its own arithmetic, so a version that forgot the
-- multiplier would divide every option fill's notional by a hundred the first
-- time an officer voided anything — permanently, and with no error.
-- =============================================================================
create or replace function rebuild_portfolio(p_portfolio_id uuid)
returns table (new_cash numeric, position_count integer, trade_count integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_portfolio portfolios%rowtype;
  v_cash      numeric(20,2);
  v_trade     trades%rowtype;
  v_prev_qty  numeric(20,6);
  v_prev_avg  numeric(20,6);
  v_new_qty   numeric(20,6);
  v_new_avg   numeric(20,6);
  v_mult      numeric(20,6);
  v_notional  numeric(20,2);
  v_realized  numeric(20,2);
  v_count     integer := 0;
begin
  select * into v_portfolio from portfolios where id = p_portfolio_id for update;
  if not found then
    raise exception 'No such portfolio.' using errcode = 'FC011';
  end if;

  v_cash := v_portfolio.starting_cash;

  delete from positions where portfolio_id = p_portfolio_id;

  -- executed_at, then id. Two fills can share a timestamp — the sweep clears a
  -- whole queue in one pass — and a replay that reordered them would produce a
  -- different average cost than the one the member actually got.
  for v_trade in
    select * from trades where portfolio_id = p_portfolio_id order by executed_at, id
  loop
    select qty, avg_cost into v_prev_qty, v_prev_avg
    from positions
    where portfolio_id = p_portfolio_id and symbol = v_trade.symbol;

    v_prev_qty := coalesce(v_prev_qty, 0);
    v_mult     := coalesce(v_trade.multiplier, 1);
    v_notional := round(v_trade.qty * v_mult * v_trade.price, 2);
    v_realized := 0;

    if v_trade.side = 'BUY' then
      if v_prev_qty < 0 then
        raise exception
          'The replay reaches a BUY of % % on %, which is short by then. Void the later fills in that symbol first.',
          fmt_qty(v_trade.qty), v_trade.symbol,
          to_char(v_trade.executed_at, 'YYYY-MM-DD HH24:MI')
          using errcode = 'FC013';
      end if;
      v_new_qty := v_prev_qty + v_trade.qty;
      v_new_avg := round(
        (v_prev_qty * coalesce(v_prev_avg, 0) + v_trade.qty * v_trade.price) / v_new_qty, 6);
      v_cash    := v_cash - v_notional;

    elsif v_trade.side = 'SELL' then
      if v_prev_qty <= 0 or v_trade.qty > v_prev_qty then
        raise exception
          'The replay reaches a SELL of % % on %, and only % is held by then. Void the later fills in that symbol first.',
          fmt_qty(v_trade.qty), v_trade.symbol,
          to_char(v_trade.executed_at, 'YYYY-MM-DD HH24:MI'),
          fmt_qty(greatest(v_prev_qty, 0))
          using errcode = 'FC013';
      end if;
      -- Signed-qty note: for a long, (price - avg_cost) * qty_sold is the gain.
      v_realized := round((v_trade.price - v_prev_avg) * v_trade.qty * v_mult, 2);
      v_new_qty  := v_prev_qty - v_trade.qty;
      v_new_avg  := v_prev_avg;
      v_cash     := v_cash + v_notional;

    elsif v_trade.side = 'SHORT' then
      if v_prev_qty > 0 then
        raise exception
          'The replay reaches a SHORT of % % on %, which is held long by then. Void the later fills in that symbol first.',
          fmt_qty(v_trade.qty), v_trade.symbol,
          to_char(v_trade.executed_at, 'YYYY-MM-DD HH24:MI')
          using errcode = 'FC013';
      end if;
      v_new_qty := v_prev_qty - v_trade.qty;
      v_new_avg := round(
        (abs(v_prev_qty) * coalesce(v_prev_avg, 0) + v_trade.qty * v_trade.price)
        / abs(v_new_qty), 6);
      v_cash    := v_cash + v_notional;

    elsif v_trade.side = 'EXPIRE' then
      -- Settlement is a sale at intrinsic value, so it replays as one. The
      -- price may legitimately be zero, which is what makes the notional zero
      -- and leaves cash where it was.
      if v_prev_qty <= 0 or v_trade.qty > v_prev_qty then
        raise exception
          'The replay reaches an expiry of % % on %, and only % is held by then. Void the later fills in that symbol first.',
          fmt_qty(v_trade.qty), v_trade.symbol,
          to_char(v_trade.executed_at, 'YYYY-MM-DD HH24:MI'),
          fmt_qty(greatest(v_prev_qty, 0))
          using errcode = 'FC013';
      end if;
      v_realized := round((v_trade.price - v_prev_avg) * v_trade.qty * v_mult, 2);
      v_new_qty  := v_prev_qty - v_trade.qty;
      v_new_avg  := v_prev_avg;
      v_cash     := v_cash + v_notional;

    else -- COVER
      if v_prev_qty >= 0 or v_trade.qty > abs(v_prev_qty) then
        raise exception
          'The replay reaches a COVER of % % on %, and only % is short by then. Void the later fills in that symbol first.',
          fmt_qty(v_trade.qty), v_trade.symbol,
          to_char(v_trade.executed_at, 'YYYY-MM-DD HH24:MI'),
          fmt_qty(abs(least(v_prev_qty, 0)))
          using errcode = 'FC013';
      end if;
      -- The mirror of SELL. A short profits when the price falls, so the
      -- subtraction runs the other way round.
      v_realized := round((v_prev_avg - v_trade.price) * v_trade.qty * v_mult, 2);
      v_new_qty  := v_prev_qty + v_trade.qty;
      v_new_avg  := v_prev_avg;
      v_cash     := v_cash - v_notional;
    end if;

    if v_new_qty <> 0 and (v_new_avg is null or v_new_avg <= 0) then
      raise exception 'The corrected price of % is too small to hold a position at.',
        v_trade.symbol
        using errcode = 'FC013';
    end if;

    if v_new_qty = 0 then
      delete from positions
      where portfolio_id = p_portfolio_id and symbol = v_trade.symbol;
    else
      insert into positions (portfolio_id, symbol, qty, avg_cost, multiplier)
      values (p_portfolio_id, v_trade.symbol, v_new_qty, v_new_avg, v_mult)
      on conflict (portfolio_id, symbol)
      do update set qty = excluded.qty,
                    avg_cost = excluded.avg_cost,
                    multiplier = excluded.multiplier,
                    updated_at = now();
    end if;

    update trades
    set realized_pnl = v_realized, notional = v_notional
    where id = v_trade.id;

    v_count := v_count + 1;
  end loop;

  update portfolios set cash = v_cash where id = p_portfolio_id;

  return query
    select v_cash,
           (select count(*)::integer from positions where portfolio_id = p_portfolio_id),
           v_count;
end $fn$;

-- =============================================================================
-- Grants.
--
-- A dropped-and-recreated function comes back with PUBLIC EXECUTE, so these are
-- not decoration: without them 0006 would quietly open place_order() and
-- queue_order() to every signed-in browser session.
-- =============================================================================
revoke all on function place_order(uuid, text, text, numeric, numeric, jsonb, uuid, numeric)
  from public, anon, authenticated;
revoke all on function queue_order(
  uuid, text, text, text, numeric, numeric, numeric, text, numeric, numeric, timestamptz, numeric
) from public, anon, authenticated;
revoke all on function cancel_pending_order(uuid, uuid) from public, anon, authenticated;
revoke all on function settle_option_expiry(uuid, numeric) from public, anon, authenticated;
revoke all on function rebuild_portfolio(uuid) from public, anon, authenticated;
