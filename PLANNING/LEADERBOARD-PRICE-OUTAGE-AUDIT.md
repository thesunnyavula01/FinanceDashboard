# Leaderboard price outage follow-up

The user's screenshot showed Samuel Iros first at +5.58%, while Saras Totey
should have led. The earlier audits identified real defects but did not establish
the cause of this ranking failure. This investigation reproduced the screenshot
from the live books and captured the failing deployed Worker request.

## Evidence and root cause

Read-only production checks found 55 profiles, 55 portfolios and 119 positions,
with 83 unique requested symbols including SPY and QQQ. Saras's portfolio still
existed and its holdings had not disappeared.

| Valuation of the same books | Leader | Saras Totey |
| --- | --- | --- |
| Available market prices | Saras Totey, +14.37% | Rank 1; NAV $114,365.49 |
| Empty market-price map, old fallback | Samuel Iros, +5.58% | Tied rank 4; NAV $100,000.00 |

The empty-price calculation also reproduced Kellan at +2.11%, Chris c at
+0.39%, and the zero-return ties shown in the screenshot. All these values
describe observations during this investigation, not permanent expected ranks.

A filtered production log for an HTTP 200 `/api/leaderboard` response reported
`Too many subrequests by single Worker invocation` while fetching Alpaca prices.
The old cache issued one Cache API lookup per symbol before reaching the batched
provider call. Eighty-three lookups already exceed the Worker's 50-subrequest
budget. The exception was converted into missing quotes; the ranking code then
substituted purchase cost, removing unrealized gains from the standings. Warm
isolate memory could avoid those operations, explaining why a refresh sometimes
changed the result. This is an explanation supported by the reproduced numbers
and request trace; it does not establish that every historical disappearance had
the same cause.

Cloudflare explicitly counts `Cache API` operations in the same subrequest limit
as outbound fetches: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
The architecture document and quote-cache comment incorrectly described the
Cache API as having no operation limits; both are corrected.

## Why previous verification missed it

The September 21 live-data check ran in Node without `caches.default`. That
removed the layer consuming the budget. The quote-outage regression asserted
member counts and finite numbers but accepted purchase-cost valuations, so it
passed on a numerically wrong leaderboard. The replacement tests count cache
operations and outbound requests together, and assert actual ranks and NAV.

Reviewed Research commit `0b6766e` and subsequent fixes through `68471a8`, along
with the September 12, September 17 (both passes), and September 21 audits.
Research introduced no member deletion. Its unbounded cache, the standings
invalidation race, option multipliers and signup/rollover locking were genuine
independent defects. Their fixes remain, but they did not fix this price failure.
The September 21 audit now carries an explicit correction.

## Corrections

- Quotes, daily bars and intraday bars use one sorted-symbol-set edge envelope
  for requests larger than four symbols. Small reads retain individual entries.
  Each embedded value keeps its original timestamp, including negative and
  failed responses, so refreshing a batch cannot extend another price's life.
- Leaderboard and quote displays share bounded last-good-price recovery. A
  separate price-only KV copy retains observations for seven days, including
  SPY/QQQ, to bridge weekends. Private account checkpoints remain limited to
  24 hours. Saved observations never become fresh merely because they were read.
- Standings with any held symbol lacking a usable price return 503 and are not
  cached as rankings. The UI retains an earlier successful board, states the
  refresh failure, and labels saved-price rankings provisional. It also hides
  numeric ranks on a legacy cost-valued payload.
- A slower quote response can no longer override a newer observation held by
  another client query. The positions valuation test checks the displayed NAV,
  not just whether a quote object survives.
- Partial market-venue failures survive daily/intraday caching and batching.
  History reports degradation; nightly snapshots skip all writes on such a
  failure. The September 21 audit had identified this concern but left it open.
- Season invalidation redirects in-flight readers to the new season, including
  when the superseded lookup fails. This was the other deferred September 21
  issue. Admin membership/funding now shares one database snapshot and checks
  exact counts. Personal holdings also reject truncated responses.
- An expiry or holdings-read failure aborts the order sweep. Both execution
  paths defer opening exposure when a held short lacks a live mark; closing
  orders remain available. A failed rejection remains pending. The sweep
  reserves its full subrequest budget before mutation chains and rotates through
  orders, including on cold starts. The September 17 change that merely logged
  a failed holdings read was insufficient and is replaced with an abort.
- The pre-existing `0008_membership.sql` edits qualify PL/pgSQL name resolution
  in two season functions. They are included in this commit as requested. No
  ninth migration is introduced; editing an applied migration file does not
  execute it against a deployed database.

## Validation

The corrected actual Worker handler was run locally with live Supabase and
Alpaca reads plus an emulated Cache API that enforces a shared 50-call ceiling.
It used **12 calls including an authentication reserve**, returned **55 members,
zero unpriced positions and zero saved-price positions**, ranked **Saras first
at +14.37%**, and returned SPY **+1.12%** and QQQ **+3.56%**. The twelve calls
comprised five fetches, three cache reads, three cache writes and one reserved
authentication call. Authentication used a local diagnostic fixture; no user
session was minted for the deployed application.

Regression coverage includes 83/300-symbol cold quote requests, cold 1D history
with all three caches, mixed-age expiration, outage/recovery, exact Saras
holdings, expired/invalid saved prices, partial venue snapshots, season races,
incomplete books, and order-sweep budget/fairness. **All 468 tests pass** (52 more
than the previous 416-test audit), all three TypeScript projects pass, and the
production build passes. The existing client chunk-size advisory remains.
`git diff --check` passes. Cold-start sweep tests cover all 50 persistent
trailing orders within ten successive invocations while preserving the budget.

No production profiles, portfolios, cash, positions or trades were mutated by
the investigation. Live reads verify the pricing calculation, not the complete
signed-in browser flow. Deployment is performed through the repository's
existing Cloudflare build integration after the authorized push to `main`.
