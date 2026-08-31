-- =============================================================================
-- Finance Club Terminal — the admin console
--
-- Five things an officer has to be able to do, and one schema fix that has to
-- land before the first of them is safe:
--
--   * start a season, and reset one that went wrong
--   * change the starting cash
--   * lock trading
--   * rotate the invite code
--   * promote a member, and void or correct a bad fill
--
-- THE SCHEMA FIX: portfolios.starting_cash.
--
-- Total return is (equity - starting_cash) / starting_cash, and until now the
-- denominator was read off the *season*. That was fine while nobody could edit
-- it. The moment an officer can, a season-level baseline is a lie: raising the
-- starting cash for members who join in March silently rewrites the return of
-- everyone who joined in January, and the leaderboard — the one screen that
-- puts those numbers side by side — would be ranking them against baselines
-- that no longer match what they were funded with. So the baseline moves onto
-- the portfolio, where it is stamped once at signup and never changes unless
-- the season is reset.
--
-- Errors raise with a SQLSTATE, the same convention place_order() uses:
--
--   FC010  the action would leave the club with no officer
--   FC011  the row named does not exist
--   FC012  the request is malformed
--   FC013  the replay cannot produce a possible portfolio
--
-- Safe to re-run: every statement is `if not exists`, `create or replace`, or
-- guarded by a catalogue lookup.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- portfolios.starting_cash — what this member was funded with, on the day.
-- -----------------------------------------------------------------------------
alter table portfolios add column if not exists starting_cash numeric(20,2);

-- Backfill from the season. Correct for every portfolio that exists today,
-- because until this migration the two were the same number by construction.
update portfolios p
set starting_cash = s.starting_cash
from seasons s
where s.id = p.season_id
  and p.starting_cash is null;

alter table portfolios alter column starting_cash set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'portfolios_starting_cash_positive'
  ) then
    alter table portfolios
      add constraint portfolios_starting_cash_positive check (starting_cash > 0);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- club_settings — one row, for what belongs to the club rather than to a season.
--
-- Right now that is the invite code. It lives here rather than in the Worker's
-- environment because a secret you cannot change without a deploy is not
-- rotatable, and rotating it is the whole point: an officer reads the code out
-- at a meeting, it ends up in a group chat, and the club needs a new one that
-- afternoon.
--
-- The env var CLUB_INVITE_CODE stays as the seed. It is what signup uses until
-- a code is set here, which is what lets the very first officer create their
-- account before there is anyone with permission to set one. Once a row exists
-- it is the ONLY code that works — a fallback that kept honouring the old code
-- would not be a rotation.
--
-- No RLS policy, deliberately. Every other table in this schema has a blanket
-- read policy because seeing each other's trading is the point of the club.
-- This one holds the key to the front door.
-- -----------------------------------------------------------------------------
create table if not exists club_settings (
  id          boolean     primary key default true check (id),
  invite_code text        check (invite_code is null
                                 or length(trim(invite_code)) between 6 and 64),
  updated_at  timestamptz not null default now(),
  updated_by  uuid        references profiles (id) on delete set null
);

alter table club_settings enable row level security;

-- =============================================================================
-- bootstrap_member() — replaced, to stamp the new baseline.
--
-- Identical to 0001 apart from starting_cash. Kept whole rather than patched,
-- because a signup that half-runs is the exact failure this function exists to
-- prevent, and it should be readable end to end in one place.
-- =============================================================================
create or replace function bootstrap_member(
  p_user_id      uuid,
  p_display_name text
)
returns table (portfolio_id uuid, role text, starting_cash numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_role         text;
  v_season       seasons%rowtype;
  v_portfolio_id uuid;
begin
  -- Serialises concurrent signups so the "first account is admin" check and the
  -- insert that satisfies it cannot interleave.
  perform pg_advisory_xact_lock(hashtext('bootstrap_member'));

  select * into v_season from seasons where is_active limit 1;
  if not found then
    raise exception 'No active season. An admin must create one before members can join.'
      using errcode = 'P0002';
  end if;

  if exists (select 1 from profiles) then
    v_role := 'member';
  else
    v_role := 'admin';
  end if;

  insert into profiles (id, display_name, role)
  values (p_user_id, trim(p_display_name), v_role);

  insert into portfolios (season_id, user_id, cash, starting_cash)
  values (v_season.id, p_user_id, v_season.starting_cash, v_season.starting_cash)
  returning id into v_portfolio_id;

  return query select v_portfolio_id, v_role, v_season.starting_cash;
end $fn$;

revoke all on function bootstrap_member(uuid, text) from public, anon, authenticated;

-- =============================================================================
-- create_season() — start a new competition.
--
-- Deactivating the old season and activating the new one happen inside one
-- transaction because seasons_single_active is a unique index: there is no
-- window in which two are active, and none in which none is.
--
-- Every existing member gets a portfolio in the new season immediately. The
-- alternative — creating them lazily on first trade — means every member sees
-- "you do not have a portfolio in the active season" the morning after a
-- rollover, which is indistinguishable from a broken app.
-- =============================================================================
create or replace function create_season(
  p_name          text,
  p_starting_cash numeric,
  p_starts_at     timestamptz default now()
)
-- The output names avoid `name` and `portfolios`, which are a column and a
-- table this body also mentions. plpgsql resolves an ambiguous identifier by
-- raising, so an OUT parameter that shadows one is a runtime error waiting for
-- the first officer who uses it.
returns table (
  season_id       uuid,
  season_name     text,
  portfolio_count integer
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_name    text := trim(p_name);
  v_season  seasons%rowtype;
  v_created integer;
begin
  perform pg_advisory_xact_lock(hashtext('seasons'));

  if v_name is null or v_name = '' then
    raise exception 'A season needs a name.' using errcode = 'FC012';
  end if;
  if p_starting_cash is null or p_starting_cash <= 0 then
    raise exception 'Starting cash must be greater than zero.' using errcode = 'FC012';
  end if;

  -- The outgoing season keeps every row it ever had and simply stops being the
  -- one orders and portfolios resolve against. ends_at is stamped only if it
  -- was still open.
  update seasons
  set is_active = false,
      ends_at   = coalesce(ends_at, now())
  where is_active;

  insert into seasons (name, starting_cash, starts_at, is_active)
  values (v_name, round(p_starting_cash, 2), coalesce(p_starts_at, now()), true)
  returning * into v_season;

  insert into portfolios (season_id, user_id, cash, starting_cash)
  select v_season.id, p.id, v_season.starting_cash, v_season.starting_cash
  from profiles p
  on conflict (season_id, user_id) do nothing;

  get diagnostics v_created = row_count;

  return query select v_season.id, v_season.name, v_created;
end $fn$;

-- =============================================================================
-- update_season() — name, starting cash, the lock, the end date.
--
-- Null means "leave this alone", so the console can send one field without
-- restating the rest, and two officers on two laptops cannot overwrite each
-- other's change to a field neither of them touched.
--
-- Changing starting_cash does NOT touch any portfolio that already exists.
-- That is what portfolios.starting_cash is for: a member funded with $100,000
-- in January is still measured against $100,000 in March, whatever the season's
-- default has become since.
-- =============================================================================
create or replace function update_season(
  p_season_id      uuid,
  p_name           text        default null,
  p_starting_cash  numeric     default null,
  p_trading_locked boolean     default null,
  p_ends_at        timestamptz default null
)
returns seasons
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_season seasons%rowtype;
begin
  if p_name is not null and trim(p_name) = '' then
    raise exception 'A season needs a name.' using errcode = 'FC012';
  end if;
  if p_starting_cash is not null and p_starting_cash <= 0 then
    raise exception 'Starting cash must be greater than zero.' using errcode = 'FC012';
  end if;

  update seasons
  set name           = coalesce(trim(p_name), name),
      starting_cash  = coalesce(round(p_starting_cash, 2), starting_cash),
      trading_locked = coalesce(p_trading_locked, trading_locked),
      ends_at        = coalesce(p_ends_at, ends_at)
  where id = p_season_id
  returning * into v_season;

  if not found then
    raise exception 'No such season.' using errcode = 'FC011';
  end if;

  return v_season;
end $fn$;

-- =============================================================================
-- reset_season() — put every portfolio in a season back to the starting line.
--
-- Destructive and irreversible: positions, fills and resting orders in this
-- season are deleted, not archived. The console makes an officer type the
-- season's name before it will send this, which is the only safety there is.
--
-- Portfolios are re-funded at the season's CURRENT starting cash and their
-- baseline is stamped to match, so a reset is also how an officer changes the
-- starting cash of a season that has already traded.
-- =============================================================================
create or replace function reset_season(p_season_id uuid)
returns table (portfolio_count integer, trades_deleted integer, positions_deleted integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_season    seasons%rowtype;
  v_ids       uuid[];
  v_trades    integer;
  v_positions integer;
begin
  select * into v_season from seasons where id = p_season_id;
  if not found then
    raise exception 'No such season.' using errcode = 'FC011';
  end if;

  -- Lock every portfolio in the season before deleting anything. An order
  -- landing mid-reset would otherwise write its fill into a portfolio that is
  -- being emptied, and that fill would survive the delete.
  --
  -- Two statements rather than one: FOR UPDATE cannot be attached to a query
  -- with an aggregate in it, so the lock is taken first and the ids collected
  -- after, by which point nothing else can add or remove one.
  perform p.id from portfolios p where p.season_id = p_season_id order by p.id for update;

  select array_agg(p.id order by p.id) into v_ids
  from portfolios p
  where p.season_id = p_season_id;

  if v_ids is null then
    return query select 0, 0, 0;
    return;
  end if;

  delete from pending_orders where portfolio_id = any(v_ids);

  delete from trades where portfolio_id = any(v_ids);
  get diagnostics v_trades = row_count;

  delete from positions where portfolio_id = any(v_ids);
  get diagnostics v_positions = row_count;

  update portfolios
  set cash          = v_season.starting_cash,
      starting_cash = v_season.starting_cash
  where id = any(v_ids);

  return query select array_length(v_ids, 1), v_trades, v_positions;
end $fn$;

-- =============================================================================
-- set_member_role() — promote or demote.
--
-- The club must never end up with no officer. Two admins demoting each other
-- from two browsers at the same moment would each see one other admin and each
-- succeed, so the count and the update happen under an advisory lock.
-- =============================================================================
create or replace function set_member_role(p_user_id uuid, p_role text)
returns profiles
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_role    text := lower(trim(p_role));
  v_profile profiles%rowtype;
  v_admins  integer;
begin
  if v_role not in ('member', 'admin') then
    raise exception 'A role is either member or admin.' using errcode = 'FC012';
  end if;

  perform pg_advisory_xact_lock(hashtext('member_roles'));

  select * into v_profile from profiles where id = p_user_id;
  if not found then
    raise exception 'No such member.' using errcode = 'FC011';
  end if;

  if v_profile.role = 'admin' and v_role = 'member' then
    select count(*) into v_admins from profiles where role = 'admin';
    if v_admins <= 1 then
      raise exception
        'This is the only officer account. Promote someone else before stepping down.'
        using errcode = 'FC010';
    end if;
  end if;

  update profiles set role = v_role where id = p_user_id returning * into v_profile;
  return v_profile;
end $fn$;

-- =============================================================================
-- rebuild_portfolio() — replay the blotter and rewrite everything it implies.
--
-- Voiding a fill from the middle of a season is not a matter of handing the
-- cash back. Every later fill in the same symbol was priced against an average
-- cost the voided one helped set, and every later realised P/L was booked
-- against that average. Undo one trade in isolation and the share count is
-- right while the cost basis, and every realised figure after it, is quietly
-- wrong.
--
-- So a correction is not a patch, it is a replay: wipe the positions, start
-- from the portfolio's starting cash, and apply the surviving fills in order,
-- rewriting realized_pnl as it goes. The arithmetic below is place_order()'s,
-- duplicated rather than shared, because that function does its arithmetic
-- inside a lock it takes itself and is the authority for a live order. This one
-- is the authority for history.
--
-- A replay can turn out impossible — voiding the BUY that a later SELL sold out
-- of leaves that SELL selling shares nobody owns. It raises rather than
-- inventing a state, and the transaction takes the void down with it.
--
-- It opens on the same `SELECT ... FOR UPDATE` on the portfolio that
-- place_order() takes, which is what stops a member's order landing halfway
-- through their own season being replayed. One of the two waits for the other.
-- =============================================================================
create or replace function rebuild_portfolio(p_portfolio_id uuid)
-- `positions` and `trades` are tables this body reads, and `cash` a column it
-- writes. An OUT parameter that shadows one of those is how a function that
-- looks right fails the first time it runs, so none of them do.
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
    v_notional := round(v_trade.qty * v_trade.price, 2);
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
      v_realized := round((v_trade.price - v_prev_avg) * v_trade.qty, 2);
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
      v_realized := round((v_prev_avg - v_trade.price) * v_trade.qty, 2);
      v_new_qty  := v_prev_qty + v_trade.qty;
      v_new_avg  := v_prev_avg;
      v_cash     := v_cash - v_notional;
    end if;

    -- positions.avg_cost is CHECK (> 0), so a correction that rounds an average
    -- to zero would fail on the constraint with a message nobody can act on.
    -- The same guard place_order() applies, for the same reason.
    if v_new_qty <> 0 and (v_new_avg is null or v_new_avg <= 0) then
      raise exception 'The corrected price of % is too small to hold a position at.',
        v_trade.symbol
        using errcode = 'FC013';
    end if;

    if v_new_qty = 0 then
      delete from positions
      where portfolio_id = p_portfolio_id and symbol = v_trade.symbol;
    else
      insert into positions (portfolio_id, symbol, qty, avg_cost)
      values (p_portfolio_id, v_trade.symbol, v_new_qty, v_new_avg)
      on conflict (portfolio_id, symbol)
      do update set qty = excluded.qty, avg_cost = excluded.avg_cost, updated_at = now();
    end if;

    -- The realised figure moves whenever an earlier fill in the same symbol
    -- does, so it is rewritten rather than trusted. So is the notional, because
    -- an amended fill changes it.
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
-- void_trade() / amend_trade() — the two corrections an officer can make.
--
-- Both are the same move: change the blotter, then rebuild everything the
-- blotter implies. Neither touches cash directly, and that is the point — the
-- replay derives it, so a correction cannot leave the cash and the fills
-- disagreeing with each other.
--
-- A resting order that filled into a voided trade keeps its FILLED status.
-- pending_orders.trade_id is `on delete set null`, so the record of the order
-- survives with the fill it pointed at gone, which is exactly what happened.
-- =============================================================================
create or replace function void_trade(p_trade_id uuid)
returns table (portfolio uuid, new_cash numeric, position_count integer, trade_count integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_trade trades%rowtype;
  v_state record;
begin
  select * into v_trade from trades where id = p_trade_id;
  if not found then
    raise exception 'No such trade.' using errcode = 'FC011';
  end if;

  delete from trades where id = p_trade_id;

  select * into v_state from rebuild_portfolio(v_trade.portfolio_id);

  return query select v_trade.portfolio_id, v_state.new_cash, v_state.position_count, v_state.trade_count;
end $fn$;

create or replace function amend_trade(
  p_trade_id uuid,
  p_qty      numeric default null,
  p_price    numeric default null
)
returns table (portfolio uuid, new_cash numeric, position_count integer, trade_count integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_trade trades%rowtype;
  v_state record;
begin
  if p_qty is null and p_price is null then
    raise exception 'A correction has to change the quantity, the price, or both.'
      using errcode = 'FC012';
  end if;
  if p_qty is not null and p_qty <= 0 then
    raise exception 'Quantity must be greater than zero. To remove a fill, void it.'
      using errcode = 'FC012';
  end if;
  if p_price is not null and p_price <= 0 then
    raise exception 'Price must be greater than zero.' using errcode = 'FC012';
  end if;

  update trades
  set qty   = coalesce(round(p_qty, 6), qty),
      price = coalesce(round(p_price, 6), price)
  where id = p_trade_id
  returning * into v_trade;

  if not found then
    raise exception 'No such trade.' using errcode = 'FC011';
  end if;

  select * into v_state from rebuild_portfolio(v_trade.portfolio_id);

  return query select v_trade.portfolio_id, v_state.new_cash, v_state.position_count, v_state.trade_count;
end $fn$;

-- =============================================================================
-- Same posture as every other function in this schema: the Worker is the only
-- caller, and it has already established that the caller is an officer.
-- Nothing reachable from a browser session may execute any of these.
-- =============================================================================
revoke all on function create_season(text, numeric, timestamptz)
  from public, anon, authenticated;
revoke all on function update_season(uuid, text, numeric, boolean, timestamptz)
  from public, anon, authenticated;
revoke all on function reset_season(uuid)
  from public, anon, authenticated;
revoke all on function set_member_role(uuid, text)
  from public, anon, authenticated;
revoke all on function rebuild_portfolio(uuid)
  from public, anon, authenticated;
revoke all on function void_trade(uuid)
  from public, anon, authenticated;
revoke all on function amend_trade(uuid, numeric, numeric)
  from public, anon, authenticated;
