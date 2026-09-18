# Functional audit — 2026-09-17

Prompted by two reports: the terminal "defaults and fails at moments", and the
leaderboard "crashes for certain users when the market is live". Reviewed
`DIRECTIONS.MD` against the client screens, the Worker routes, the market-data
caches, the order engine, the analytics replay and the scheduled jobs.
`DIRECTIONS.MD` is authoritative where older notes disagree.

Four of the five findings below match the reported symptoms directly. The fifth
is what turned a broken panel into a blank terminal.

## Fixed

| Failure | Result after the fix |
|---|---|
| The standings computed a member's day P/L and largest-holding weight without the contract multiplier, while `gross` came from `marketValues()`, which applies it. A member holding options saw a day figure a hundredth of the one F1 prints for the same book, and a weight whose numerator was premiums and whose denominator was dollars — so a contract could never be reported as the largest position. Visible only while the market is live, because it needs both a previous close and a current price, and only to members holding a contract. | `worker/lib/leaderboard.ts` applies `contractSize()` to both. F1 and F3 agree about the same holding. |
| The 1D replay recorded each symbol's contract size for fills that happened *before* the session but not for fills during it, so a contract bought this morning was valued at one share rather than a hundred: the premium left cash in full and returned as a hundredth of a position, stepping the line down at the fill and leaving it there. F1 opens on 1D, so this was the default screen. | `replayIntraday()` records the multiplier on the during-session pass as well. A contract bought this morning and one carried in from yesterday now value identically. |
| The isolate-memory tier of the daily-bar, intraday-bar and chain caches was a plain `Map` with a TTL check on read. Nothing deleted an expired entry, and those keys carry a date or an OCC symbol rather than repeating: `bars.ts` keys on `feed/symbol/start/end` with `end` being today, so every symbol got a fresh key every day holding a season of bars, and `chain.ts` kept every underlying and contract anyone ever opened. A Cloudflare isolate that crosses its memory ceiling is torn down along with the requests in flight on it — which lands on whoever happens to share that isolate, and fills fastest while the market is live and every chart is polling. | All three use `BoundedCache` (`worker/lib/cache.ts`): an LRU with a hard cap, and callers release an entry the moment they find it stale. The benchmark series every member's chart wants stay hot; the long tail falls off the back. |
| A render fault anywhere unmounted the whole React tree, so one bad field in one payload took the status rail, the function keys and the command bar with it — a black page with no way to navigate off the broken screen. | An `ErrorBoundary` sits inside the shell and around the routed screen, keyed on the path. The broken screen says so and offers RETRY; every other function key still works. |
| Several reads on F3 assumed a complete payload — a non-null assertion on `season`, a bare `benchmarks.spy`, `rows.find`, `top.weight.toFixed`, and `clockET` on an unvalidated `asOf` (`Intl.DateTimeFormat` throws on an invalid date rather than printing "Invalid Date"). The standings are the one response built from a database read, a batched quote fetch and two bar series, memoised per season and served to the whole club, so a missing field is missing for everybody at once. | Every one of those is optional, `clockET` guards its input the way `stampET` already did, and the panel draws thin rather than throwing. |
| The sweep discarded the error from its positions read. Without those rows `p_marks` carries only the symbol being filled, so `place_order()` margins every other short at what it was sold for — understating the requirement on exactly the position that has moved against the member, silently. | The failure is logged. The sweep still runs, and an odd fill is now explainable afterwards. |

## Verification

- Baseline before any change: 368 tests and all three TypeScript configurations
  passed.
- After: **382 tests pass**, `npm run typecheck` passes, and `npm run build`
  passes. The build keeps its existing advisory about the main client chunk
  exceeding 500 kB.
- New coverage:
  - `worker/lib/leaderboard.test.ts` values a book of contracts and stock and
    pins the day figure, the largest holding and its weight — including the case
    where the contract *is* the largest position, which bare premiums got wrong.
  - `worker/analytics/curve.test.ts` replays a contract bought during the drawn
    session and asserts it values identically to one carried in from yesterday.
  - `worker/lib/cache.test.ts` pins LRU eviction, the cap under five thousand
    writes, and that a re-set key moves rather than duplicates.
  - `worker/market/bar-routing.test.ts` walks two hundred rolling windows over a
    twenty-symbol club — four thousand distinct keys — and asserts both bar tiers
    stay under their cap while the most recent window is still served from
    memory.
  - `scripts/leaderboard-render.test.ts` renders the real F3 against seven
    degraded payloads, and reads `App.tsx` to pin the boundary inside the shell
    with the chrome outside it. Server rendering rethrows rather than falling
    back to a boundary, so the placement is asserted over the source — the same
    shape as `expiry.test.ts` reading `index.ts`.

## Deployment and data boundaries

No migration and no credential change. Nothing here alters how an order is
priced, sized or settled: `place_order()`, `queue_order()` and
`settle_option_expiry()` are untouched, and the tests use fixtures rather than
placing live orders.

Two of the fixes change figures already on screen. The standings' day P/L and
largest-position weight will move for any member holding a contract, and the 1D
curve will move for anyone who bought one during a session — in both cases from
a wrong number to a right one. Stored balances are unaffected, because neither
figure was ever written to the database.

The cache caps are per isolate and take effect on deploy; there is nothing to
clear. The Cache API tier is unchanged, so a colo stays as warm as it was.

The note from 2026-09-12 still stands: option fills created before migration
0006 carry multiplier 1 and are not repaired by a code deploy. They need their
actual contract metadata, not a blanket multiplication by 100.
