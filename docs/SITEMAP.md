# Sitemap

Every path that is not `/api/*` serves the same HTML shell. Workers Assets
answers it directly — the Worker is never invoked for a page request — and
`src/App.tsx` decides what is on screen from there. So this is a map of a
router, not of a directory.

**There is no `sitemap.xml`, and adding one would be a mistake.** The app is
auth-gated to one address: with no session, `App` renders `Login` instead of
the shell at every path except `/legal`, so a crawler that followed a sitemap
would find one login form six times over and two documents once. Nothing else
here is public, indexable, or worth sharing by URL.

---

## The shell

Rendered around every authenticated screen, in `src/App.tsx`:

```
StatusRail      app name · market session · connection · display name · role · sign out
FunctionNav     F1 … F5, the screen switcher, and Legal at the far end
<main>          the routed screen
CommandBar      "/" to focus. A screen name, a ticker, or a whole order
```

Unauthenticated there is no shell at all. `Login` takes the full viewport — at
every address but `/legal`, which renders either way, because the terms have to
be readable before there is an account to agree to them with.

---

## Screens

| Key | Path | Screen | File | Audience |
|---|---|---|---|---|
| — | any | Login | `src/routes/Login.tsx` | signed out |
| F1 | `/` | Positions | `src/routes/Positions.tsx` | members |
| F2 | `/trade` | Trade | `src/routes/Trade.tsx` | members |
| F3 | `/leaderboard` | Leaderboard | `src/routes/Leaderboard.tsx` | members |
| F4 | `/sectors` | Sectors | `src/routes/Sectors.tsx` | members |
| F5 | `/admin` | Admin | `src/routes/Admin.tsx` | officers |
| — | `/legal`, `/legal/:doc` | Legal | `src/routes/Legal.tsx` | anyone |
| — | `*` | Not found | `src/routes/NotFound.tsx` | members |

Eight paths, and that is the whole client surface. `screensFor()` in
`FunctionNav.tsx` filters F5 out for a member — the route still resolves and
the API still checks, because hiding a link is presentation and not a
permission.

### Login — no path

Replaces the entire app whenever `session` is null, which is why it has no
address of its own. Two modes on one screen:

- **Sign in** — email + password, straight to Supabase Auth.
- **Sign up** — email, password, display name, invite code, posted to
  `/api/auth/signup` and then signed in immediately. No confirmation step.

A third state: if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` are missing
from the build, the screen names the missing variables instead of offering a
form it knows cannot work.

### F1 `/` — Positions

The default screen, and the one a member lands on.

```
PortfolioStats      equity, cash, buying power, day P/L, total return
MarginWarning       only when buying power is negative
EquityCurve         you vs SPY, QQQ, club average — in dollars
                    ranges 1D · 1W · 1M · 3M · 1Y · ALL
Positions grid      symbol, qty, avg cost, price, market value, day P/L, P/L, weight
```

The curve and the grid answer the two halves of one question — how the season
has gone, and what is carrying it right now — so they share a screen rather
than a tab. **Exit:** clicking a position row goes to `/trade` with the ticket
already on that symbol.

### F2 `/trade` — Trade

```
PortfolioStats      the same strip, so buying power never disagrees
MarginWarning
OrderTicket         BUY · SELL · SHORT · COVER, shares or dollars, market or limit
Blotter             fills, newest first
WorkingOrders       resting orders, cancellable
```

**Entrances:** a row click from Positions or Sectors, or a typed order from the
command bar. Both arrive as router `state`, not as a query string.

### F3 `/leaderboard` — Leaderboard

```
StatStrip           your rank, your return, club average, SPY, QQQ
Locked banner       only while an officer has paused the season
Standings grid      rank, member, equity, return, with the return drawn as a bar
                    against a shared axis and SPY through it as a hairline
```

**Drill-down:** clicking a member swaps the grid for `MemberBook` — their
positions and fills, in place. Their resting orders are not in it and must not
be.

### F4 `/sectors` — Sectors

```
PortfolioStats
MarginWarning
ConcentrationWarning   any sector over 40% of gross
Exposure map           every position as a tile, sized by exposure and grouped
                       into sectors, coloured by its own day return. Cash is a
                       tile too, in neutral grey
Concentration          top sector, top three, effective bets (1/HHI), largest
                       position, long/short/cash, funds, sectors held
Sector exposure grid   gross, net, weight, P/L, with the bar and the 40% line,
                       and the day's move drawn against SPY as a hairline
Holdings drill-down    the positions inside the selected sector, with Finnhub's
                       industry label. Unfiltered it lists the whole book
```

Computed in the browser from positions, quotes and the `securities` table —
three things the dashboard already holds, so there is no endpoint behind this
screen and none should appear. The one exception is a single quote for SPY, for
the benchmark hairline.

**Selection:** clicking a sector filters the drill-down and dims the rest of the
map. **Exit:** clicking a holding — in the drill-down or on the map — opens the
ticket on that symbol.

### F5 `/admin` — Admin

Officer-only. The role is read from the database on every request, never from
the session token.

```
Season panel        name, starting cash for new joiners, trading lock
Invite code panel   the live code, rotation, universe size and last sync
Lifecycle panel     start a season · reset a season (armed, name typed out)
MemberRoster        promote and demote
Corrections         void or amend a fill, then replay the portfolio
```

### `/legal` — Terms of use and privacy policy

Two documents behind one panel with two tabs, and **deliberately not an F6**.
A function key would rank a legal document alongside the trade ticket, and the
member who wants it is never looking for it in a hurry. It is reached from the
quiet end of the nav row, from the login screen, and from the command bar.

`/legal/terms` and `/legal/privacy` are separate addresses rather than one
screen with a hidden tab — this is the one thing in the app somebody genuinely
pastes into a chat, and the link has to land on the document it names. An
unknown slug shows the terms rather than a 404.

It is also the only screen that is prose, so it is the one place the grid's
density loses an argument: the panel hugs a 68-character measure and the body
is set at 13px on 1.7. The two tables — what is held about you, and who else
touches it — are the point of the privacy document, because those are the only
two questions anyone opens one with.

### `*` — Not found

A 404 panel pointing back to F1 and the command bar. Unknown *API* paths never
reach it: `worker/index.ts` answers `/api/*` misses with JSON, because falling
through to the SPA shell would have the client parsing HTML as JSON.

---

## Ways in that are not links

The terminal is keyboard-first, so most navigation never touches an anchor.

| Gesture | Effect |
|---|---|
| `F1`–`F5` | switch screens; suppressed while a text field has focus |
| `/` | focus the command bar |
| `POSITIONS`, `F3`, … | a screen name or key in the command bar navigates |
| `LEGAL`, `TERMS`, `PRIVACY` | the legal screen, which has no key of its own |
| `NVDA` | any other word is a ticker lookup, priced inline |
| `BUY 10 NVDA`, `SHORT $500 TSLA @ 240` | opens `/trade` with the ticket filled |
| row click | Positions and Sectors both land on the ticket |
| `Esc` | clear the command bar |

---

## What has no URL, deliberately

The open member book, the ticket's prefill, the login mode, and the chart's
range are component state. None can be linked to or bookmarked, and none
survive a refresh. For an instrument this size that is the right trade — the
alternative is five query parameters that exist only so a member can send
somebody else a link to a screen they can both reach with one keystroke.

---

## API

The other half of the map. Every route is under `/api`, which `wrangler.jsonc`
routes to the Worker with `run_worker_first`; everything else is served from
the asset store.

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | none — liveness + market session |
| POST | `/api/auth/signup` | invite code |
| GET | `/api/auth/me` | member |
| GET | `/api/quotes?symbols=A,B` | member |
| GET | `/api/market/clock` | member |
| GET | `/api/market/symbols?q=` | member |
| GET | `/api/market/securities?symbols=` | member |
| GET | `/api/market/universe` | member |
| POST | `/api/market/universe/sync` | officer |
| GET | `/api/portfolio` | member — unpriced, on purpose |
| GET | `/api/portfolio/history?range=` | member — priced; `1D` is a different chart |
| POST | `/api/portfolio/snapshot` | officer |
| POST | `/api/orders` | member — no price field, ever |
| GET | `/api/orders` | member |
| GET | `/api/orders/working` | member — owner only |
| DELETE | `/api/orders/working/:id` | member — owner only |
| POST | `/api/orders/sweep` | officer |
| GET | `/api/leaderboard` | member |
| GET | `/api/leaderboard/:portfolioId` | member |
| GET | `/api/admin` | officer |
| POST | `/api/admin/seasons` | officer |
| PATCH | `/api/admin/seasons/:id` | officer |
| POST | `/api/admin/seasons/:id/reset` | officer |
| POST | `/api/admin/invite` | officer |
| POST | `/api/admin/members/:userId/role` | officer |
| GET | `/api/admin/trades` | officer |
| DELETE | `/api/admin/trades/:id` | officer |
| PATCH | `/api/admin/trades/:id` | officer |

`requireAuth` is mounted on the whole group for quotes, market, portfolio,
orders and leaderboard; `requireAdmin` sits on the whole admin group and on the
four officer routes that live outside it.

---

## Scheduled, and reachable by no URL at all

Two cron triggers in `wrangler.jsonc`, matched by expression in
`worker/index.ts` so neither runs the other's work.

| Cron | Job |
|---|---|
| `* 13-21 * * 1-5` | sweep resting orders, calendar-gated |
| `15 22 * * 1-5` | resync the tradable universe · write the nightly snapshots |

Both jobs also have a forced-run endpoint above (`/api/orders/sweep`,
`/api/portfolio/snapshot`), which is how a deploy is verified.
