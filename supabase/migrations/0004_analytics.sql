-- =============================================================================
-- Finance Club Terminal — analytics
--
-- One function, for one line on one chart: the club average on the equity
-- curve. Everything else Phase 5 draws is computed in the Worker from data it
-- already has — the member's own curve is a replay of their blotter against
-- daily bars, and the sector breakdown is their positions crossed with the
-- `securities` table. Neither needs the database to do anything new.
--
-- The club average does, and the reason is arithmetic. A hundred members over a
-- full season is roughly twenty-five thousand snapshot rows, and there is no
-- version of "average them per day" that is sane to do by pulling all of them
-- across the wire — PostgREST would page it, the Worker would hold it in
-- memory, and the answer is one number per session. Postgres already has the
-- rows and already knows how to group them.
--
-- Nothing here writes. It is `stable`, not `volatile`, so the planner is free
-- to treat it as the read it is.
--
-- Safe to re-run: create or replace, and a guarded index.
-- =============================================================================

-- The curve filters snapshots by date within a season. The unique constraint
-- already indexes (portfolio_id, as_of); this covers the other direction, and
-- Phase 7's nightly job will want it too when it checks what it has written.
create index if not exists portfolio_snapshots_as_of_idx
  on portfolio_snapshots (as_of);

-- -----------------------------------------------------------------------------
-- club_equity_curve() — average account value per session, across one season.
--
-- Every member in a season starts from the same `starting_cash`, so a plain
-- average of equity is already a fair index of how the club as a whole did.
-- No weighting is needed and none is applied: this is one member, one vote,
-- which is the right shape for a learning club rather than for a fund.
--
-- `members` comes back alongside so the chart can say what the average is an
-- average *of*. Early in a season that number moves as people sign up, and a
-- line that quietly changes meaning is worse than one that says so.
-- -----------------------------------------------------------------------------
create or replace function club_equity_curve(
  p_season_id uuid,
  p_start     date
)
returns table (
  as_of      date,
  avg_equity numeric,
  members    int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.as_of,
    round(avg(s.equity), 2) as avg_equity,
    count(*)::int           as members
  from portfolio_snapshots s
  join portfolios p on p.id = s.portfolio_id
  where p.season_id = p_season_id
    and s.as_of >= p_start
  group by s.as_of
  order by s.as_of;
$$;

-- Same posture as every other function in this schema: the Worker is the only
-- caller. Members can already read `portfolio_snapshots` directly under RLS, so
-- nothing is being hidden here — the route simply stays the one place that
-- decides what a screen is allowed to ask for.
revoke all on function club_equity_curve(uuid, date) from public, anon, authenticated;
