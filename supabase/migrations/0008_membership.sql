-- =============================================================================
-- Finance Club Terminal — membership, and the one way a member disappears
--
-- A member is on the leaderboard if and only if they hold a portfolio in the
-- active season. `loadClub()` reads `portfolios` filtered by `season_id`, so a
-- member without one is not a row that renders badly — they are not a row at
-- all. Nothing tells them, nothing tells the officers, and nothing in the app
-- can put them back. That is what "a user was deleted off the leaderboard for
-- no reason" actually is.
--
-- Two functions create portfolios and they are the whole of the invariant:
--
--   bootstrap_member()  one portfolio, in the active season, at signup
--   create_season()     one portfolio per existing profile, at rollover
--
-- Between them every member should always have exactly one. They took
-- DIFFERENT advisory locks — hashtext('bootstrap_member') and
-- hashtext('seasons') — which means they do not serialise against each other,
-- and that is the hole:
--
--   1. create_season() deactivates the old season, inserts the new one, and
--      begins its backfill `select ... from profiles`.
--   2. A signup commits in the same window. bootstrap_member() reads
--      `seasons where is_active` before the new season is visible, so it funds
--      the member in the season that is about to become history.
--   3. create_season()'s backfill had already read `profiles` and does not
--      include the member who has only just appeared in it.
--
-- Both transactions succeed. The member can sign in, has a portfolio, and is
-- absent from the standings forever — the shape of the bug being fixed.
--
-- The fix is that the two take the SAME lock, so one of them runs whole before
-- the other starts, and both orders are then correct: a signup first is picked
-- up by the backfill, and a rollover first is what the signup reads as active.
-- Each takes exactly one lock, so there is no ordering between locks to get
-- wrong and no deadlock to have.
--
-- That closes the hole for the future. It does not help a member already
-- stranded on the wrong side of it, and there was no way to repair one — which
-- is why ensure_season_portfolios() is here too.
--
-- Re-runnable, like every migration in this directory: two `create or replace`
-- and one `create ... or replace`, each with its EXECUTE grant revoked again
-- afterwards, because a replaced function comes back with PUBLIC EXECUTE.
-- =============================================================================

-- The one lock that guards "who holds a portfolio in which season". Named for
-- the invariant rather than for either function, because the point is that
-- neither of them owns it.
--
-- Deliberately NOT the lock set_member_role() takes: that one guards "the club
-- has at least one officer", which is a different invariant over a different
-- column, and folding the two together would make every promotion wait behind
-- every signup for no reason.

-- =============================================================================
-- bootstrap_member() — 0005's function, on the shared lock.
--
-- Kept whole rather than patched for the same reason 0005 kept it whole: a
-- signup that half-runs is the exact failure it exists to prevent, and it
-- should be readable end to end in one place.
--
-- The lock still serialises concurrent signups, so the "first account is admin"
-- check and the insert that satisfies it cannot interleave. It now also
-- serialises them against a rollover.
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
  perform pg_advisory_xact_lock(hashtext('club_membership'));

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
-- create_season() — 0005's function, on the shared lock.
--
-- Unchanged apart from the lock. The backfill is still `on conflict do
-- nothing`, so it stays safe against a signup that got there first.
-- =============================================================================
create or replace function create_season(
  p_name          text,
  p_starting_cash numeric,
  p_starts_at     timestamptz default now()
)
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
  perform pg_advisory_xact_lock(hashtext('club_membership'));

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

revoke all on function create_season(text, numeric, timestamptz)
  from public, anon, authenticated;

-- =============================================================================
-- ensure_season_portfolios() — put a stranded member back on the board.
--
-- The same insert create_season() ends with, addressable on its own. Before
-- this there was no repair at all: portfolios were created at signup and at
-- rollover, and a member who fell between the two had no route back into the
-- season short of an officer writing SQL by hand.
--
-- **It funds at the season's CURRENT starting cash, and that is a real
-- consequence, not a detail.** A member repaired in March is funded with what
-- March's default is, exactly as a member who signed up in March would be, and
-- `portfolios.starting_cash` stamps it so their return is measured against
-- their own baseline — which is the whole reason migration 0005 split the two
-- figures. It is not an attempt to reconstruct what they would have had.
--
-- `on conflict do nothing` is what makes it safe to press twice: a member who
-- already has a portfolio in the season is untouched, cash and all. It can
-- never overwrite a balance, only add a missing row, so the worst an officer
-- can do by running it repeatedly is nothing.
--
-- Takes the same lock as the other two, so it cannot interleave with a
-- rollover and fund somebody into a season that is being retired underneath it.
-- =============================================================================
create or replace function ensure_season_portfolios(p_season_id uuid)
returns table (season_id uuid, created integer, members integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_season  seasons%rowtype;
  v_created integer;
  v_members integer;
begin
  perform pg_advisory_xact_lock(hashtext('club_membership'));

  select * into v_season from seasons where id = p_season_id;
  if not found then
    raise exception 'No such season.' using errcode = 'FC011';
  end if;

  insert into portfolios (season_id, user_id, cash, starting_cash)
  select v_season.id, p.id, v_season.starting_cash, v_season.starting_cash
  from profiles p
  on conflict (season_id, user_id) do nothing;

  get diagnostics v_created = row_count;

  select count(*) into v_members from portfolios p where p.season_id = v_season.id;

  return query select v_season.id, v_created, v_members;
end $fn$;

revoke all on function ensure_season_portfolios(uuid) from public, anon, authenticated;
