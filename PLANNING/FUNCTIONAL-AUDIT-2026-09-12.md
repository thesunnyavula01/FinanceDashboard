# Functional audit — 2026-09-12

Reviewed the architecture, phase plan, research plan, sitemap, setup and deployment
documents against the client, Worker routes, data adapters, order engine, analytics
and SQL migrations. DIRECTIONS.MD is authoritative where older planning notes
describe superseded behavior.

## Fixed

| Failure | Result after the fix |
|---|---|
| A provider outage was treated as an unknown ticker and cached for five minutes. | Failed requests retry after the normal quote interval; actual missing symbols retain the longer negative cache. Successful asset classes remain available. |
| Alpaca requests had no timeout and could hold shared quote readers indefinitely. | Each request aborts after eight seconds and can recover on a subsequent poll. |
| Working-order polling stopped outside equity hours. | Pending orders poll every 20 seconds, idle lists every minute, including crypto fills, DAY expirations and cancellations. |
| Cron fills did not refresh the blotter/history; member details could remain stale indefinitely. | Order-list changes invalidate related account views; blotter and member books also poll every 30 seconds. Returning to a visible tab refreshes stale data. |
| F1 and F5 overstated spendable buying power by omitting reservations. | All three account screens subtract working-order reservations. |
| Private query caches survived sign-out/account switching. | Owner changes clear queries and pending results; the shell remounts for the new member. Same-member token refreshes retain caches. |
| STOP and TRAILING_STOP required an invisible limit-price field. | Only LIMIT and STOP_LIMIT require a limit price. |
| Prefilled crypto tickets sent DAY even though the control said GTC. | Crypto prefills initialize to GTC. |
| Immediate option orders omitted `p_multiplier`, so SQL defaulted to 1. | Immediate fills pass the verified contract multiplier to the locked RPC. |
| Dollar sizing used 100 for adjusted options regardless of their actual size. | Immediate and swept orders use the verified/stored multiplier. |
| Option reservation and realized-P/L previews omitted contract size. | Previews include it; a selected chain contract carries its multiplier into the ticket. Immediate buying-power previews also subtract existing reservations. |
| Picking an option prevented later command-bar prefills from replacing the ticket. | Each new navigation creates fresh trade-screen state. A newly entered underlying cannot display another underlying's cached chain. |
| Bare crypto symbols were rejected by the command bar. | Quote lookups use the shared symbol classifier. |
| The minimum execution price unnecessarily excluded six-decimal crypto prices. | Prices down to 0.000001 can trade, matching the supported storage precision. |
| A failed crypto asset download could overwrite the universe with equities only. | Incomplete downloads fail before replacing the stored universe. |
| Invalid JSON shapes crashed signup/order routes; failed member-book reads looked like empty books. | Invalid objects return 400; failed book reads return an explicit error. |

## Verification

- Baseline: all 335 existing tests and TypeScript checks passed before fixes.
- Regression coverage exercises real authenticated order routes and the sweep with
  database/provider fixtures, including actual RPC payloads, adjusted contract
  quantities, server-priced fills and low-priced crypto.
- Cache tests simulate provider recovery, mixed asset classes and a second isolate
  reading edge entries. Timeout tests abort hung requests without waiting in real time.
- Client tests verify cache ownership, invalidation, outside-hours polling and
  render the real order ticket for stop validation and option reservations.
- Final verification: all **350 tests passed**, `npm run build` passed (including
  all three TypeScript configurations), and `git diff --check` passed.
  The build retains its existing advisory about the main client chunk exceeding 500 kB.
- Render tests use the already-locked esbuild 0.28.1, now an explicit development
  dependency. In this Windows sandbox, esbuild needs an unsandboxed test invocation
  to resolve the project through the OneDrive parent directory.

## Deployment and data boundaries

No database migration or credential change is required. The tests use fixtures;
they do not place live trades or change production balances. Existing option fills
created with multiplier 1 are not retroactively repaired by a code deploy and should
be reviewed before correcting historical paper balances. Contract adjustments and
historical trades need their actual metadata, not a blanket multiplication by 100.

Expected cadence remains quotes about every 20 seconds and the resting-order sweep
once per minute. IEX coverage, provider availability and background-tab suspension
still affect freshness. The previously documented SEC contact/deployed research
checks remain deployment items; this audit does not claim live provider verification.

Implementation references: [TanStack focus refetching](https://tanstack.com/query/latest/docs/framework/react/guides/window-focus-refetching)
and [Fetch abort signals](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal).
