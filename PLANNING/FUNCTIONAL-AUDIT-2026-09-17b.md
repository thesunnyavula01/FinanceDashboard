# Functional audit — 2026-09-17 (second pass)

Follows the audit earlier the same day. One further report: the leaderboard
"would delete a user off the leaderboard for no reason".

Traced every path by which a member can be absent from F3 — the PostgREST query,
the ranking arithmetic, the React render, and the two functions that create a
portfolio. The ranking never drops anybody: `rankClub()` returns one row per
portfolio handed to it. The disappearance happens one layer earlier and one
layer later.

## What was actually wrong

**A member is on the leaderboard if and only if they hold a portfolio in the
active season.** `loadClub()` reads `portfolios` filtered by `season_id`, so a
member without one is not a row that renders badly — they are not a row at all.
Nothing told them, nothing told the officers, and nothing in the app could put
them back.

Exactly two functions create portfolios, and between them every member should
always have exactly one:

- `bootstrap_member()` — one, in the active season, at signup
- `create_season()` — one per existing profile, at rollover

They took **different advisory locks** (`hashtext('bootstrap_member')` and
`hashtext('seasons')`), so they did not serialise against each other:

1. `create_season()` deactivates the old season, inserts the new one, and begins
   its backfill `select ... from profiles`.
2. A signup commits in that window. `bootstrap_member()` reads
   `seasons where is_active` before the new season is visible and funds the
   member into the season that is about to become history.
3. The backfill had already read `profiles` and does not include a member who
   has only just appeared in it.

Both transactions succeed. The member can sign in, has a portfolio, and is
absent from the standings permanently.

## Fixed

| Failure | Result after the fix |
|---|---|
| A signup and a season rollover could interleave and strand a member in the season being retired — absent from the leaderboard, forever, with both transactions reporting success. | `0008_membership.sql` puts `bootstrap_member()`, `create_season()` and the new repair on one `club_membership` advisory lock, so whichever runs first is seen whole by the other. Each takes exactly one lock, so there is no ordering between locks to get wrong. `migrations.test.ts` fails the build if they drift apart again. |
| A member with no portfolio in the season was simply missing from F3. A screen built only from what it found cannot tell "the club is one member smaller" from "somebody was deleted", which is exactly how it was reported. | The standings read `profiles` alongside `portfolios` and name anybody on the roster without a row. F3 says who is not ranked and that an officer can fix it. One small indexed query per twenty-second memo for the whole club. |
| There was no repair. Portfolios were created at signup and at rollover only, so a member who fell between the two stayed off the board until somebody wrote SQL by hand. | `ensure_season_portfolios()` is the insert `create_season()` already ends with, addressable on its own, behind one unarmed button in the roster panel. `on conflict do nothing` means it can add a missing row and never overwrite a balance, so a second press does nothing the first did not. |
| The 500-portfolio cap silently ranked whichever rows came back, in whatever order Postgres chose — so at that size a member could blink in and out between polls. | The query is ordered by id and the payload carries `truncated`, which F3 states rather than passing a partial club off as the standings. |
| `DataGrid` used `rowKey(row)` directly as the React key. React renders only the **last** of two siblings sharing a key, silently — one row fewer than the data has, no error. Eight grids hand in their own `rowKey`, each an assertion about uniqueness made somewhere else. | The grid derives a distinct key per row. A collision now costs a wasted re-render rather than a member. |
| A failed roster read would have been a failed leaderboard. | It is logged and reported as "nobody missing" — the standings still rank, which is what the screen did before the query existed. |

## Why the render tests could not have caught the key bug

`renderToStaticMarkup` is a single pass with no reconciliation, so it draws both
same-key rows and reports nothing wrong. The row-count assertion in
`scripts/leaderboard-render.test.ts` catches a grid that drops rows outright; the
source assertion beside it catches the key going back to being taken at face
value. Only the second half can see the guarantee.

## Verification

- **391 tests pass** (382 before this pass), `npm run typecheck` passes, and
  `npm run build` passes with its existing chunk-size advisory.
- New coverage:
  - `migrations.test.ts` reads the live definitions and asserts signup, rollover
    and the repair take the same lock; that all three stamp `starting_cash` on
    the portfolio they fund; and that the repair contains no `update` or
    `delete`, which is what makes the console's button safe to press twice.
  - `scripts/leaderboard-render.test.ts` renders F3 with one missing member, with
    five, with none, and with a truncated club, and pins the grid's key
    derivation.
- The existing revoke check already covers `ensure_season_portfolios`: it is
  `security definer` and EXECUTE is revoked from `anon` and `authenticated`.

## Deployment

**`0008_membership.sql` must be pasted into the Supabase SQL editor.** Migrations
are applied by hand here; there is no runner.

Unlike 0005 and 0006 this is not a hard cutover — it adds no column and changes
no signature, so nothing answers 500 without it. What it does is close the race
and add the repair. Until it is applied, the race is still open and the "fund
them" control answers 503 naming the file rather than a generic failure, so an
officer is sent to the deploy instead of hunting for a fault in the club.

Verify afterwards against `pg_proc` rather than trusting "Success. No rows
returned": both `bootstrap_member` and `create_season` contain
`hashtext('club_membership')`, `ensure_season_portfolios` exists and is
`prosecdef`, and EXECUTE on it is false for `anon` and `authenticated` — a
replaced function comes back with PUBLIC EXECUTE, which is why 0008 re-revokes
each one.

The reporting half needs no migration and is live on deploy: from that moment a
member cannot go missing without the screen naming them.

**After applying it, press "Fund them" once.** That is what recovers anybody the
race has already caught. It funds at the season's current starting cash and
stamps it on the portfolio, so a repaired member is measured against their own
baseline like everybody else — it does not attempt to reconstruct a history they
never had.
