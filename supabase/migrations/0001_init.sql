-- =============================================================================
-- Finance Club Terminal — initial schema
--
-- Two rules shape everything below:
--
--   1. The client never writes. There is not a single INSERT, UPDATE or DELETE
--      policy in this file. Members read; the Worker writes using the
--      service-role key, which bypasses RLS. If a policy were ever added by
--      mistake, that is the line to look at.
--
--   2. Position quantity is SIGNED. A short is negative qty, which makes
--      unrealised P/L one formula in both directions: (price - avg_cost) * qty.
--      Never add a long/short branch on top of this.
--
-- Money is numeric, never float.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles — one row per member, keyed to Supabase's auth.users
-- -----------------------------------------------------------------------------
create table if not exists profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null check (length(trim(display_name)) between 1 and 40),
  role         text        not null default 'member' check (role in ('member', 'admin')),
  created_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- seasons — one competition. Only one may be active at a time.
-- -----------------------------------------------------------------------------
create table if not exists seasons (
  id             uuid primary key default gen_random_uuid(),
  name           text          not null,
  starting_cash  numeric(20,2) not null default 100000 check (starting_cash > 0),
  starts_at      timestamptz   not null default now(),
  ends_at        timestamptz,
  is_active      boolean       not null default false,
  trading_locked boolean       not null default false,
  created_at     timestamptz   not null default now()
);

-- Partial unique index: at most one row may have is_active = true.
create unique index if not exists seasons_single_active
  on seasons (is_active) where is_active;

-- -----------------------------------------------------------------------------
-- portfolios — one per member per season
-- -----------------------------------------------------------------------------
create table if not exists portfolios (
  id         uuid primary key default gen_random_uuid(),
  season_id  uuid          not null references seasons (id) on delete cascade,
  user_id    uuid          not null references profiles (id) on delete cascade,
  cash       numeric(20,2) not null,
  created_at timestamptz   not null default now(),
  unique (season_id, user_id)
);

create index if not exists portfolios_season_idx on portfolios (season_id);
create index if not exists portfolios_user_idx   on portfolios (user_id);

-- -----------------------------------------------------------------------------
-- positions — current holdings. qty is SIGNED; negative means short.
-- -----------------------------------------------------------------------------
create table if not exists positions (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid          not null references portfolios (id) on delete cascade,
  symbol       text          not null,
  qty          numeric(20,6) not null check (qty <> 0),
  avg_cost     numeric(20,6) not null check (avg_cost > 0),
  updated_at   timestamptz   not null default now(),
  unique (portfolio_id, symbol)
);

create index if not exists positions_portfolio_idx on positions (portfolio_id);
create index if not exists positions_symbol_idx    on positions (symbol);

-- -----------------------------------------------------------------------------
-- trades — immutable fill log. qty is always positive here; `side` carries
-- the direction, unlike positions.qty which carries it in the sign.
-- -----------------------------------------------------------------------------
create table if not exists trades (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid          not null references portfolios (id) on delete cascade,
  symbol       text          not null,
  side         text          not null check (side in ('BUY', 'SELL', 'SHORT', 'COVER')),
  qty          numeric(20,6) not null check (qty > 0),
  price        numeric(20,6) not null check (price > 0),
  notional     numeric(20,2) not null,
  realized_pnl numeric(20,2) not null default 0,
  executed_at  timestamptz   not null default now()
);

create index if not exists trades_portfolio_idx on trades (portfolio_id, executed_at desc);

-- -----------------------------------------------------------------------------
-- securities — Finnhub profile cache. Fetched once per ticker, ever.
-- -----------------------------------------------------------------------------
create table if not exists securities (
  symbol     text primary key,
  name       text,
  sector     text,
  industry   text,
  asset_type text,
  logo_url   text,
  fetched_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- snapshots — nightly history, written by the cron trigger in Phase 7
-- -----------------------------------------------------------------------------
create table if not exists portfolio_snapshots (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid          not null references portfolios (id) on delete cascade,
  as_of        date          not null,
  equity       numeric(20,2) not null,
  cash         numeric(20,2) not null,
  long_mv      numeric(20,2) not null,
  short_mv     numeric(20,2) not null,
  unique (portfolio_id, as_of)
);

create table if not exists benchmark_snapshots (
  symbol text          not null,
  as_of  date          not null,
  close  numeric(20,6) not null,
  primary key (symbol, as_of)
);

-- =============================================================================
-- Row level security
--
-- Members can read every portfolio, position and trade in the club. That is
-- deliberate: seeing each other's picks is the point of a learning club.
-- Nobody can write anything — there are no write policies at all.
-- =============================================================================

alter table profiles            enable row level security;
alter table seasons             enable row level security;
alter table portfolios          enable row level security;
alter table positions           enable row level security;
alter table trades              enable row level security;
alter table securities          enable row level security;
alter table portfolio_snapshots enable row level security;
alter table benchmark_snapshots enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'seasons', 'portfolios', 'positions',
    'trades', 'securities', 'portfolio_snapshots', 'benchmark_snapshots'
  ]
  loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_read', t
    );
  end loop;
end $$;

-- =============================================================================
-- bootstrap_member()
--
-- Called by the Worker immediately after it creates an auth user. Creates the
-- profile and this season's portfolio in ONE transaction, so a member can never
-- exist without a portfolio.
--
-- The first account ever created becomes admin. The advisory lock makes that
-- race-free: two people hitting signup simultaneously cannot both be promoted.
-- =============================================================================
create or replace function bootstrap_member(
  p_user_id      uuid,
  p_display_name text
)
returns table (portfolio_id uuid, role text, starting_cash numeric)
language plpgsql
security definer
set search_path = public
as $$
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

  insert into portfolios (season_id, user_id, cash)
  values (v_season.id, p_user_id, v_season.starting_cash)
  returning id into v_portfolio_id;

  return query select v_portfolio_id, v_role, v_season.starting_cash;
end $$;

revoke all on function bootstrap_member(uuid, text) from public, anon, authenticated;

-- =============================================================================
-- Seed the first season so signup has something to attach a portfolio to.
-- Change the name and starting cash from the admin console in Phase 6.
-- =============================================================================
insert into seasons (name, starting_cash, is_active)
select '2026-2027 Season', 100000, true
where not exists (select 1 from seasons);
