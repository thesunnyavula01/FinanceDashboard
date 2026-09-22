# Leaderboard and Research investigation — 2026-09-21

**Follow-up correction:** this pass did not resolve the reported ranking failure.
Its live check ran without a Cloudflare Cache API, and its missing-quote test
checked row counts rather than valuations. Both missed the production
subrequest exhaustion and the cost-based ranking that exactly reproduces the
user's screenshot. The cache race here is real, but was not the explanation for
that screenshot. See `LEADERBOARD-PRICE-OUTAGE-AUDIT.md` for the deployed-log
evidence, price comparison and corrected resource-budget tests.

The report was intermittent missing leaderboard members, sometimes restored by
refreshing, beginning after Research. Reviewed the frontend routes, hooks,
shared components and query lifecycle; Worker routes and caches; research and
market adapters; analytics, backups and scheduled orders; and all membership,
trading and admin migrations. Compared Research commit `0b6766e` and subsequent
fixes through `26f4279`.

## Evidence

- A read-only production database check found one active season, **55 profiles,
  55 portfolios, 119 positions, no missing owners and no duplicate owners**.
  This establishes the current state, not the state at every reported incident.
- Research introduced no profile/portfolio deletion or funding mutation. Its
  shared cache was an unbounded Map holding entire news feeds, including expired
  results. The later cache-bound fix covered bars and chains but missed Research.
- Reproduced an actual leaderboard cache race with the real route and controlled
  network timing: hold an old one-row build A; invalidate; finish newer two-row
  build B; finish A; the next reader receives A's one-row cached leaderboard.
  The previous memo had no pending-build guard or invalidation ownership check.
- The old roster and portfolio requests used separate database snapshots. An
  atomic signup between them could appear on the roster without its portfolio.
- HTTP 200 reads could be incomplete under PostgREST row limits. The old code
  did not check exact counts, including embedded holdings. A roster read error
  was explicitly turned into an empty missing-member list.
- The initial leaderboard failure state claimed nobody had joined. A failed
  member-book refresh hid retained positions; the fills panel could also imply
  an empty account when its read had failed.
- `/auth/me` did not filter portfolios to the active season and discarded its
  portfolio query error. Admin roster reads also discarded portfolio errors,
  incorrectly reporting unfunded members.

The old signup/season-rollover race remains a potential funding defect, but the
earlier audit did not prove it caused these incidents. There is only one season
in the live database checked here. Neither the reproduced cache race nor the
Research memory growth was captured during a user's production disappearance;
these are demonstrated code defects, not a claim that every incident has been
individually explained.

## Changes

`worker/routes/leaderboard.ts` now reads profiles, active-season portfolios and
holdings in one database snapshot. Left embedding retains genuinely unfunded
members; both portfolio rows and their aggregate count are season-filtered.
Exact top-level, portfolio and position counts must match before publication.
An incomplete read fails the refresh and cannot replace a complete cached club.
The legacy `truncated` response field remains false on successful responses.

Concurrent cold polls share one pending build. Invalidation detaches that build;
only the current build can populate or clear the memo. Both completion orders
are covered, including an old build finishing while its replacement still runs.

Research retains at most 250 fragments in isolate memory, with LRU eviction and
expired-on-read removal. Evicted fresh feeds remain reusable from the edge
cache, and the source-specific TTLs and failure behavior are unchanged.

Leaderboard and member-book error states now retain loaded data and offer a
retry. Failed initial reads describe the failure without asserting an empty
club/account. Auth filters to the active season; admin and auth portfolio read
failures are errors rather than fabricated missing portfolios.

## Validation

- **416 tests pass**, including 25 added regressions; all TypeScript projects
  and the production build pass. The existing large-client-chunk advisory remains.
- Twelve real Worker route tests cover 100 simultaneous polls, unavailable
  quotes retaining every member, truncated/missing counts, actual unfunded
  members, shared failure recovery and both invalidation races.
- Five component regressions use a real QueryClient with rejected fetches to
  verify retained standings, retained holdings/fills and initial-load errors.
- Six membership route tests cover multiple seasons, failed reads and genuinely
  absent portfolios. Two Research tests cover realistic feed capacity/eviction,
  edge reuse and expiry while providers are delayed.
- Verified the new embedded query against live Supabase: 55 complete profiles
  and 55 books, with exact embedded counts. The revised local route also read
  live market/database data and returned 55 unique members with finite values.

## Release boundary

These fixes require only an application deployment, with no new migration.
No production balances, holdings, profiles or trades were changed, and no
production deployment was performed during this investigation. The user's
pre-existing edits to `0008_membership.sql` were preserved. Its earlier
membership-lock/repair migration is separate from these read/cache fixes.

Two unrelated existing concerns found during review are outside this patch:
`activeSeason()` can repopulate its cache after invalidation during rollover;
partial market-venue bar failures can be carried at cost by nightly valuation.
Neither establishes a cause of missing members in the current single season.
