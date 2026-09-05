# Finance Club Paper Trading Terminal

## Context

The club currently runs its yearly stock simulation on Investopedia, which means no control over the
UI, no club-specific analytics, and no way to see the group's collective sector exposure. This project
replaces it with a self-hosted terminal-style dashboard: every member signs in, gets their own paper
portfolio with a starting cash balance, places trades by ticker + dollar amount or share count, and
sees live P/L, sector breakdown, and a leaderboard ranked against SPY, QQQ, and the club average.

Built for ~30–100 members, deployed on Cloudflare, black/amber Bloomberg-terminal aesthetic.

**Decisions locked in (from planning conversation):**

| Decision | Choice |
|---|---|
| Portfolio model | One portfolio per member + leaderboard |
| Visual direction | Bloomberg terminal — dense grid, monospace numerics |
| Accent | Amber/gold on true black |
| Trading rules | Fractional shares, market-hours-only, short selling, admin-only reset/starting cash |
| Signup gate | Shared club invite code |
| Scale / assets | 30–100 members, US stocks + ETFs |
| Liveness | Auto-refresh ~20s |
| Benchmarks | SPY, QQQ, and club-wide average |

---

## Market data: why not Google Finance

**Google Finance has no public API.** It was deprecated in 2011 and shut down October 2012. The only
surviving official access is the `GOOGLEFINANCE()` formula inside Google Sheets, which cannot be called
from a web app. Everything marketed as a "Google Finance API" today (SerpApi, Scrapingdog, Apify) is a
paid scraper — fragile, against Google's ToS, and unnecessary.

### Chosen provider split

**Alpaca (primary — prices)** · free "Basic" plan, paper account, no KYC, no deposit, signup in minutes.

- `GET data.alpaca.markets/v2/stocks/snapshots?symbols=A,B,C…&feed=iex` — **batch** snapshot. Returns
  `latestTrade`, `latestQuote`, `minuteBar`, `dailyBar`, `prevDailyBar` per symbol. Request cap is
  effectively ~16,000 bytes of URL, i.e. well over 100 tickers per call.
- **Key detail:** on the free plan `dailyBar` and `prevDailyBar` are the *same consolidated data* paid
  users get — only `latestTrade`/`latestQuote`/`minuteBar` are IEX-only. So daily change %, previous
  close, and OHLCV are fully accurate; only the intraday last-tick comes from IEX's slice of volume.
- `GET /v2/stocks/bars?symbols=SPY,QQQ&timeframe=1Day&start=…` — free historical daily bars, batched.
  This is what powers the benchmark curves.
- `GET paper-api.alpaca.markets/v2/clock` — authoritative market open/closed + next open/close. Drives
  the market-hours-only rule, including holidays, for free.
- `GET /v2/assets?status=active&asset_class=us_equity` — the tradable ticker universe for validation
  and autocomplete.
- **200 requests/minute** on the free tier.

**Finnhub (secondary — sector classification)** · free tier, 60 calls/min.

- `GET /stock/profile2?symbol=X` — company name, `finnhubIndustry`, logo, market cap, exchange.
  Called **once per ticker ever**, then cached permanently in Postgres. Alpaca has no fundamentals,
  and this is the only way to get the sector breakdown.
- Note: Finnhub's `/stock/candle` is now premium (403 on free keys) and its free tier is licensed for
  personal/non-commercial use — a school club qualifies; do not monetize.

### Rate-limit math (this is why the split exists)

Worst case ~200 unique symbols held across 100 members. Alpaca batches that into **2 requests**. One
shared server-side cache with a 20s TTL means 100 concurrent members still trigger those same 2
requests → **~6 requests/min against a 200/min ceiling.**

Finnhub alone could not do this: it has no batch quote endpoint, so 200 symbols every 20s would need
600 calls/min against a 60/min limit — 10× over. Hence Alpaca for prices, Finnhub for sectors only.

Both providers sit behind a `MarketDataProvider` interface in `worker/market/provider.ts` so swapping
to a paid feed later is a one-file change.

### News providers (Phase 10), and the doors that closed in 2026

Research needs *coverage*, which is the opposite requirement to prices: breadth of publisher rather
than freshness of tick. The 2026 survey is mostly a list of options that stopped being free.
**X/Twitter** ended its free tier in February 2026 — reads are now roughly half a cent per post with
no free search, and the legacy Basic plan was retired outright in June. **CoinDesk Data
(CryptoCompare)** retired free access in May 2026. **CoinGecko's** news endpoint is Analyst-plan-only.
**Marketaux** allows 100 requests/day and returns three articles per response. **Polygon.io** free is
5 requests/minute. None of those is buyable at club scale.

What survived is broader than what was lost, and **none of the six needs a signup**:

| Source | Credential | Ceiling | Brings |
|---|---|---|---|
| Alpaca `v1beta1/news` | **the existing Alpaca key** | 200/min | Benzinga wire, stocks **and** crypto, batched by symbol, back to 2015 |
| Finnhub `company-news`, `news?category=crypto` | **the existing Finnhub key** | 60/min | a different mix: Reuters, CNBC, MarketWatch, Yahoo, Seeking Alpha |
| Finnhub `stock/earnings` | same key | 60/min | actual-vs-estimate (**probe first**, see Phase 10) |
| **GDELT DOC 2.0** | **none, ever** | courtesy | 100,000+ outlets worldwide — TechCrunch, The Verge, Ars Technica, trade and local press |
| **SEC EDGAR** (`efts` + `data.sec.gov`) | **none, ever** | 10/sec | the primary documents: 8-K, 10-Q, 10-K, XBRL actuals |
| **Hacker News** (Algolia) | **none, ever** | courtesy | tech-community discussion, and the discussion slot X can no longer fill |

EDGAR's condition is a `User-Agent` naming a reachable contact, or it answers 403 rather than
throttling. That is `SEC_CONTACT`, a var rather than a secret because being contactable is the point.

**Rate-limit math, again.** Five upstreams behind one `/api/research` call, cached 5–15 minutes at the
edge, means a hundred members reading TSLA cost **one round of five calls, not five hundred** — the same
sum the quote cache does at 20 seconds. The binding constraint is Finnhub's 60/min, shared with the
sector enrichment `securities.ts` already budgets against: ~30 distinct tickers viewed in a 5-minute
window is ~6 Finnhub calls/min. Alpaca's 200/min and EDGAR's 10/sec are never approached.

---

## Stack

- **Frontend:** Vite + React 19 + TypeScript, Tailwind CSS v4, TanStack Query (polling), Recharts.
- **Backend:** Hono API inside the *same* Cloudflare Worker that serves the SPA via Workers Assets.
- **Data/auth:** Supabase Postgres + Supabase Auth (email + password, email confirmation **off**).
- **Cache:** Cloudflare KV for the shared quote cache. **Cron Triggers** for daily snapshots.

**Vite + Hono, not Next.js.** Cloudflare now recommends Workers Assets over Pages, and the app is a
fully auth-gated dashboard with zero SEO or SSR needs. Next-on-Cloudflare (OpenNext/vinext) adds an
adapter layer whose failure modes are hard to debug for no benefit here.

**All secrets stay server-side.** The browser only ever receives `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`. Alpaca, Finnhub, the Supabase service-role key, and the invite code are
Worker secrets and are never bundled into client code.

---

## Data model (Supabase Postgres)

```
profiles              id → auth.users, display_name, role ('member'|'admin'), created_at
seasons               id, name, starting_cash, starts_at, ends_at, is_active, trading_locked
portfolios            id, season_id, user_id, cash, UNIQUE(season_id, user_id)
positions             id, portfolio_id, symbol, qty (SIGNED), avg_cost, UNIQUE(portfolio_id, symbol)
trades                id, portfolio_id, symbol, side, qty, price, notional, realized_pnl, executed_at
securities            symbol PK, name, sector, industry, asset_type, logo_url, fetched_at
portfolio_snapshots   portfolio_id, as_of DATE, equity, cash, long_mv, short_mv, UNIQUE(portfolio_id, as_of)
benchmark_snapshots   symbol, as_of DATE, close, PK(symbol, symbol)
```

**Signed quantity is the core trick.** A short is stored as negative `qty`, which makes P/L a single
uniform formula for both directions: `(price - avg_cost) * qty`. For a short, `qty` is negative, so a
price *drop* yields a positive number automatically. No branching anywhere in the analytics layer.

All monetary columns are `numeric`, never float.

### Short-selling margin model (Reg T, simplified)

Shorting $X credits $X to cash **and** locks `1.5 * X` as `margin_held`, recomputed on every price
refresh from live short market value.

```
long_mv       = Σ(qty * price) for qty > 0
short_mv      = Σ(|qty| * price) for qty < 0
equity        = cash + long_mv - short_mv
margin_held   = 1.5 * short_mv
buying_power  = max(0, cash - margin_held)
```

Net effect: shorting $X consumes $0.5X of buying power — exactly Reg T, and explainable to a member in
one sentence. If `buying_power` goes negative from adverse moves, new orders are blocked and a margin
warning banner appears. No forced liquidation in v1 (deliberate scope cut — flagged, not hidden).

### RLS

Members read all portfolios, positions, and trades in the active season — seeing each other's picks is
a feature for a learning club, not a leak. **No client writes at all.** Every mutation goes through the
Worker using the service-role key. Client-side Supabase is read-only plus auth.

---

## Trade execution (the part that must be correct)

`POST /api/orders` in the Worker:

1. Verify the Supabase JWT → resolve `user_id`.
2. Check `seasons.trading_locked` and Alpaca `/v2/clock` → reject if market closed.
3. Fetch a **fresh** price server-side (`latestTrade.p`, falling back to `latestQuote` midpoint, then
   `dailyBar.c`).
4. Call Postgres RPC `place_order(...)` — `SECURITY DEFINER`, which does `SELECT … FOR UPDATE` on the
   portfolio row and applies validation + cash/position/trade mutation in one transaction.
5. Return the fill.

**Never trust a client-supplied price**, and never do read-modify-write of cash in application code —
two browser tabs firing simultaneously would double-spend. The row lock inside the RPC is what makes
this safe.

Sides: `BUY`, `SELL`, `SHORT`, `COVER`. Order entry accepts either a share count (fractional allowed,
6 dp) or a dollar notional, converted server-side at the fetched price.

---

## Phases

### Phase 0 — Foundation & credentials
- `git init`, `.gitignore` (must cover `.env`, `.dev.vars`, `.wrangler/`).
- **`PLANNING/DIRECTIONS.MD`** — stack, provider split and the rate-limit reasoning, signed-qty convention, margin
  formulas, the "secrets never reach the client" rule, commands, file layout.
- **`.env.example`** (committed) and **`.env` / `.dev.vars`** (ignored):
  ```
  VITE_SUPABASE_URL=            # public
  VITE_SUPABASE_ANON_KEY=       # public
  SUPABASE_SERVICE_ROLE_KEY=    # WORKER SECRET
  ALPACA_API_KEY_ID=            # WORKER SECRET
  ALPACA_API_SECRET_KEY=        # WORKER SECRET
  FINNHUB_API_KEY=              # WORKER SECRET
  CLUB_INVITE_CODE=             # WORKER SECRET
  ```
- **Signup checklist for you** (all free, ~15 min): Supabase project → turn **off** "Confirm email"
  under Authentication → Providers → Email; Alpaca **paper** account → generate key + secret;
  Finnhub account → copy key; Cloudflare account + `wrangler login`.

### Phase 1 — Scaffold & terminal design system
- Vite + React + TS + Tailwind v4; Hono mounted at `/api/*`; `wrangler.jsonc` with Assets + SPA
  fallback + KV binding. Verify `npm run dev` and a `/api/health` round-trip.
- Design tokens: `#000000` canvas, `#0B0B0B` panels, `#1C1C1C` hairline borders, amber `#FFB000`
  accent, gain `#26D07C`, loss `#FF4D4D`. IBM Plex Mono (`font-variant-numeric: tabular-nums`) for all
  numerics, Inter uppercase-tracked for labels. 28px grid rows, 12px type.
- Function-key top nav (`F1 POSITIONS · F2 TRADE · F3 LEADERBOARD · F4 SECTORS · F5 ADMIN`) and a
  `/`-to-focus command bar — cheap, and it sells the terminal feel on a projector.
- Load the **`frontend-design`** skill before writing this layer.

### Phase 2 — Auth
- `POST /api/auth/signup` — Worker validates `CLUB_INVITE_CODE`, then service-role
  `createUser({ email_confirm: true })` so no confirmation mail is ever sent, and seeds `profiles` +
  a `portfolios` row at the active season's `starting_cash`, atomically.
- Client sign-in via `supabase.auth.signInWithPassword`. Session context + protected routes.
- Terminal-styled auth screen; first account created is promoted to `admin`.

### Phase 3 — Market data layer
- `worker/market/provider.ts` — the swappable interface. Alpaca client (snapshots, bars, clock,
  assets) + Finnhub client (profile2).
- `GET /api/quotes?symbols=…` — dedupes, reads KV (20s TTL), batch-fetches only the misses.
- Nightly asset-universe sync into KV for instant local ticker autocomplete.
- Sector enrichment: on first sight of a symbol, fetch Finnhub profile2, normalize `finnhubIndustry`
  → 11 GICS sectors via a lookup map, ETFs → `ETF / Fund`, persist to `securities` forever.

### Phase 4 — Trading engine
- `place_order()` Postgres RPC (row-locking, signed-qty math, weighted avg cost, realized P/L on close,
  Reg T check). `POST /api/orders` as described above.
- Order ticket: ticker autocomplete → live quote → BUY/SELL/SHORT/COVER → shares-or-dollars toggle →
  cost preview and resulting buying power → confirm. Keyboard-first.
- Trade blotter with per-fill realized P/L.
- **Test explicitly:** short → price falls → P/L positive; partial cover; oversell rejection;
  insufficient-buying-power rejection; closed-market rejection; two simultaneous orders don't
  double-spend.

### Phase 5 — Analytics dashboard
- Positions grid: `SYM · QTY · AVG · LAST · MKT VAL · DAY Δ · P/L · P/L% · WT%`, sortable, amber
  headers, green/red numerics, short rows marked. 20s `refetchInterval` with previous-value flash.
- Header strip: NAV, day change, total P/L, cash, buying power, margin held, position count.
- Sector breakdown: horizontal bars + concentration warning when any sector exceeds 40%.
- Equity curve from `portfolio_snapshots`, overlaid with SPY, QQQ, and club average, normalized to
  100 at season start. Range toggles 1W/1M/3M/YTD/ALL.
- Load the **`dataviz`** skill before writing any chart code.

### Phase 6 — Leaderboard & admin
- Leaderboard: rank, member, NAV, total return %, day change, vs SPY, top holding. Click through to
  any member's read-only portfolio.
- Admin console (admin role only): create/reset season, set starting cash, lock trading, rotate the
  invite code, promote members, correct or void a bad trade.

### Phase 7 — Snapshots & deploy
- Cron Trigger daily ~21:30 UTC: if the market traded today, write one `portfolio_snapshots` row per
  portfolio and SPY/QQQ closes into `benchmark_snapshots`. Idempotent on `(portfolio_id, as_of)` so a
  re-run is harmless.
- Backfill SPY/QQQ history from Alpaca daily bars when a season is created.
- `wrangler secret put` for each secret, deploy, smoke-test signup → trade → dashboard in production.

**Built** (`worker/analytics/snapshot.ts`), with three changes to the above:

- The cron runs at **22:15 UTC**, not 21:30. In winter the close is 21:00 UTC, so 21:30 leaves half an
  hour for Alpaca to publish the daily bars the job prices the club at; 22:15 is still the same
  exchange date and sits outside the sweep's 13:00–21:59 window.
- Prices come from **daily bar closes, not the quote cache**. After the bell `latestTrade` is a thin
  after-hours IEX print, and the curve merges snapshots into a replay valued at bar closes — a
  snapshot priced any other way would put a step in the chart.
- **No backfill of missed nights.** `mergeSnapshots()` prefers a snapshot to a replay because it was
  computed at the close; a reconstructed snapshot would silently retire that. The replay already
  covers the gap.

`POST /api/portfolio/snapshot` runs the job on demand for officers, which is how verification step 7
is carried out. No migration was needed — both tables have existed since `0001_init.sql`.

### Phase 8 — Derivatives and crypto on F2

Trade **crypto** and **long options** beside equities, without disturbing the equity path or
thickening the screen. Alpaca covers both on the free Basic key already in use — no second provider,
no second rate-limit budget.

**Built**, in two halves. 8a is the plumbing both classes share plus crypto; 8b is options.

Load-bearing decisions, each of which had a cheaper alternative that was rejected:

- **Asset class is derived from the symbol, never stored.** A slash means crypto, a fifteen-character
  OCC tail means an option. Collision is impossible — Alpaca writes class shares with a dot — so this
  buys a new asset class with no backfill, no uniqueness-key change and no replay drift.
- **`multiplier` is one column defaulting to 1.** Storing an option's premium pre-multiplied needs no
  DDL and makes the blotter print 525.00 for a contract the chain prints at 5.25. Two screens
  disagreeing about one number is the failure this codebase is written to prevent.
- **Long-only options, cash-settled at expiry.** A flat 1.5x Reg T multiplier is not a margin model
  for a naked short call. Auto-exercise can fail for want of cash; cash settlement always succeeds
  and produces the same P/L.
- **24/7 costs one cron, not two.** The sweep widened to every minute and gates each order on its own
  class. A second crypto-only cron would overlap, and the loser of a race on a PENDING row would
  write REJECTED over an order that had just filled.

Three things the live API said that the research did not:

- **A crypto daily bar is stamped 00:00Z, not 05:00Z.** Reading it through `exchangeDate()` — right
  for every other bar in the app — dates every crypto close a session early, silently.
- **There are no greeks and no implied volatility on a free options key**, under any feed parameter;
  `feed=opra` answers 403. The planned Δ and IV chain columns were dropped rather than faked.
- **`expiration_date_lte` defaults to next weekend**, so a request for a year of expirations answers
  with one date and looks like a thin underlying rather than a missing parameter.

One bug the new tests caught before anything ran: `resolveQuantity()` converted a dollar amount at the
premium rather than the contract cost, so `$300 of a $5.25 option` was 57 contracts instead of 0.

`0006_derivatives.sql` is written and **not yet applied**. Until it is, `/api/portfolio` answers 500
and F1, F2 and F3 are dark — the same deliberate hard cutover as 0005.

*(Applied and verified 2026-09-02.)*

---

### Phase 9 — The order ticket a real brokerage has

`STOP`, `STOP_LIMIT` and `TRAILING_STOP` beside `MARKET` and `LIMIT`, a Review-then-Place
confirmation step, and the crypto minimum-order-size floor surfaced before the press rather than at
the fill.

**Built.** Adds `0007_stop_orders.sql`, applied and verified 2026-09-02.

Load-bearing decisions:

- **One sentence defines three order types.** *A limit buys cheaper than the market and sells dearer;
  a stop buys dearer and sells cheaper.* So a stop is a limit mirrored, and `stopFiresOnRise()` is
  the single definition. Getting it backwards yields an order that looks entirely reasonable and
  fires at exactly the wrong moment — a stop-loss selling into a rally — so `stops.test.ts`
  enumerates all eight side-by-direction combinations rather than sampling them.
- **Every stop is queued, never filled on the way in.** Its trigger is on the far side of the market
  by construction, so the ticket reads QUEUE the moment a stop type is picked, which is the honest
  label.
- **A stop is entered in shares.** There is no price to convert a dollar amount at until the trigger
  fires, and the conversion runs the wrong way: the cheaper the fill, the more shares a fixed dollar
  amount turns out to buy.
- **Reservations follow the trigger, not the last price.** A BUY stop sits above the market, so
  reserving against the last price understates the cost by the whole distance to it — the member
  queues an order they cannot pay for and finds out on the day it finally fires.
- **Trailing stops ratchet inside one locked statement.** `trail_pending_order()` says
  "greatest"/"least" in SQL rather than doing an UPDATE from the Worker, which is what stops a
  concurrent sweep walking the stop backwards and firing it early. The sweep trails *before* it tests
  the trigger, or it would evaluate today's price against yesterday's stop and fire one tick late.
- **Firing is recorded, not re-derived.** `triggered_at` is stamped once, or a STOP_LIMIT would
  un-fire when the price crossed back over its trigger and fill on whichever tick the sweep landed on.
- **Review, then Place.** This reversed Phase 4's decision that the readback *was* the confirmation.
  That held while the ticket had two order types and one price field; with five types, a stop price,
  a trail and a limit it no longer did, and the readback label was still changing under the cursor at
  the moment of the press. Any edit clears the review, so the panel can never describe an order other
  than the one that will be placed.

---

### Phase 10 — Research on F4

**Planned, not built.** One screen answering a question about the *asset* rather than the portfolio:
type a ticker, get coverage from across the web — financial wire, tech and general press, the
company's own SEC filings, and what retail is saying. Split by asset class the way everything else
here is, and at the same density.

Adds **no migration**. Nothing is persisted: news is ephemeral and lives in the edge cache, and
earnings and filings are hours-long entries. Like Phase 7, there is no `0008_*.sql` to go looking
for.

The provider table is under "News providers" above. The short version: **no new credential at all** —
two existing keys reused, and three sources that have none to obtain.

Load-bearing decisions, each of which had a cheaper alternative that was rejected:

- **Research takes F4; Sectors moves to F5 and Admin to F6.** The brief asked for F4 for members and
  F5 for officers, which would make a printed keycap mean two different screens depending on who is
  reading it — and `SCREENS` keys are static literals matched against `event.key`, so it would also
  make the command bar's `s.key === command` lookup answer differently per audience. A key means one
  screen for everyone; officers simply have one more. Legal stays keyless and is now deliberately not
  F7, which is the same argument moved up one place.
- **One endpoint, not five.** `/api/research?symbol=` fans out and merges, the way
  `/api/market/chain` assembles expirations and a priced chain from several upstream calls. Five
  client-side poll loops per member would multiply the club by five against the tightest ceiling in
  the stack.
- **Partial failure is reported, never fatal.** `Promise.allSettled` across every source, and the
  payload carries `sources` and `missing` so the panel can say *why* a feed is thin.
  `describeMarketError` runs only when every source failed. With five upstreams this matters far more
  than it did with two: the screen must not go dark because GDELT rate-limited us.
- **The wire/web split is labelled, not blended.** Alpaca and Finnhub search by ticker; GDELT and
  Hacker News search by *keyword*, so they need the company's name — which is why the asset card's
  `useSecurities` lookup is load-bearing rather than decorative, and why `ALL · WIRE · WEB` is on
  screen. Keyword search finds Apple the fruit and Gap the retailer, and a ticker-exact result must
  never look identical to a name-matched one. Same habit as the curve naming whether it was replayed
  or stored.
- **Summaries render as text, never HTML.** There is no sanitizer in this repo and no
  `dangerouslySetInnerHTML` anywhere; a news summary would be the first untrusted markup in the app.
  Tags are stripped in the Worker and the client receives a plain string.
- **Paywalls are marked, not filtered.** No API reports them, so a small domain set earns a dim
  marker and loses ties on sort. A WSJ headline is still information; hiding it would be the app
  deciding what a member may know.
- **Crypto drops the earnings/filings panel** and lets headlines take the space — the same "same
  instrument showing less" rule the phone layout already follows, applied to asset class. A coin has
  no 10-Q, and a panel reading an em-dash four times is worse than no panel.
- **The cache mirrors `chain.ts`, not `quotes.ts`.** Two tiers, a `.invalid` synthetic key, the
  `typeof caches === "undefined"` guard that keeps the module loadable under `node --test`, and a
  `forgetResearch()` export. There is no per-symbol batching to do here, so the class-based
  three-tier cache would be machinery without a job.

Two things to establish by `curl` before writing any panel — the habit that made Phase 8 worth
reading:

- **Is Finnhub `/stock/earnings` still free on this key?** They paywalled `/stock/candle` and
  `worker/market/finnhub.ts` carries a comment saying so; the documentation does not settle earnings
  either way. If it 403s, the numbers come from SEC XBRL company-facts instead — free, authoritative,
  already in the lineup, and no credential changes.
- **Does GDELT answer from a Worker?** It rate-limits by IP and refused a shared cloud egress during
  research. From Cloudflare's edge with a declared `User-Agent` it should be fine, but it is
  unverified. If it proves unreliable, Hacker News and the two wire sources still fill the panel —
  which is the partial-failure design doing exactly its job.

---

## Critical files

```
PLANNING/DIRECTIONS.MD
.env.example / .dev.vars
wrangler.jsonc
supabase/migrations/*.sql          -- schema, RLS, place_order() RPC
worker/index.ts                    -- Hono app + SPA fallback + scheduled handler
worker/market/research.ts          -- Phase 10: fan-out, merge, dedupe, two-tier cache
worker/market/gdelt.ts             -- Phase 10: global press, no credential
worker/market/edgar.ts             -- Phase 10: SEC filings + XBRL, no credential
worker/market/hackernews.ts        -- Phase 10: tech discussion, no credential
worker/routes/research.ts          -- Phase 10: GET /api/research?symbol=
src/routes/Research.tsx            -- Phase 10: F4
worker/market/provider.ts          -- swappable data-provider interface
worker/market/alpaca.ts            -- snapshots, bars, clock, assets
worker/market/finnhub.ts           -- profile2 → sector
worker/market/sectors.ts           -- finnhubIndustry → GICS-11 map
worker/market/symbols.ts           -- the classifier: OCC parse, class, multiplier
worker/market/{crypto,options}.ts  -- the two new adapters
worker/market/router.ts            -- one PriceProvider over three classes
worker/orders/expiry.ts            -- cash settlement, chained before the snapshot
worker/routes/{auth,quotes,orders,portfolio,leaderboard,admin}.ts
src/lib/{supabase,format}.ts
src/hooks/useQuotes.ts             -- TanStack Query, 20s interval
src/components/terminal/*          -- Panel, DataGrid, Ticker, StatStrip
src/routes/{Login,Dashboard,Trade,Leaderboard,Sectors,Admin}.tsx
```

## Verification

1. `npm run dev` → sign up with the invite code; a wrong code must be rejected.
2. Buy $500 of AAPL → cash drops, position appears, sector shows Information Technology.
3. Short 10 TSLA → cash rises, buying power drops by ~0.5 × notional, position shows negative qty.
4. Watch the grid for 60s during market hours → prices update ~3×; check the Worker log shows only
   batched Alpaca calls, not one per symbol.
5. Place an order with the market closed → rejected with next-open time.
6. Fire two orders simultaneously from two tabs → cash math stays correct (no double-spend).
7. Manually invoke the scheduled handler → snapshot rows written; re-run → no duplicates.
8. `wrangler deploy` → repeat 1–3 against the live URL; confirm via DevTools that no Alpaca, Finnhub,
   or service-role key appears in any client bundle or network request.

### Phase 8

9. Apply `0006_derivatives.sql`. **Check which editor tab has focus before pressing Run** — it runs
   the focused one, and "Success. No rows returned" is what a script you did not mean to run also
   says. Verify against `pg_proc`, not the success message.
10. Confirm no regression first: buy $500 of AAPL, check cash, position and blotter are exactly as
    before. Every existing row is `multiplier = 1`; if anything moved, stop.
11. Crypto: buy $250 of `BTC/USD`, confirm a fractional position, then place the same order **on a
    weekend** and confirm it fills rather than queues. Rest a GTC limit far from the market and
    confirm the sweep leaves it and the reservation shows in the stat strip.
12. Options: pick OPTION on F2, type AAPL, click a strike. Confirm the cost is `premium × 100`, the
    blotter's price is the **premium**, and F1 renders `AAPL 16JAN26 150C` with the raw OCC on hover.
13. Confirm SHORT is refused on a contract and on a pair, each with a sentence naming why.
14. Expiry: with a contract expiring today in a scratch portfolio, run the nightly branch. Confirm an
    `EXPIRE` row at intrinsic and the position gone. Then void an unrelated trade in that portfolio
    and confirm `rebuild_portfolio()` reproduces the same cash — this is the check that catches the
    multiplier being missed in the replay.

### Phase 10

15. **Probe before building.** `curl` Finnhub `/stock/earnings?symbol=TSLA` with the real key; GDELT
    from a `wrangler dev` Worker rather than a laptop; and EDGAR both with and without a
    `User-Agent`, to confirm the 403. Write down what they actually said.
16. `npm run build` and `npm test` — both clean. Phase 10 introduces no secret, so there is no new
    leak-guard case to add; the existing ones must still pass.
17. Press **F4**, type `TSLA`. Expect headlines from **four or more distinct domains spanning both
    tiers** — a wire name and a tech or general name — four earnings quarters, recent filings on the
    second tab, and a discussion list from Hacker News. The panel meta names the sources that
    answered.
18. Toggle `ALL · WIRE · WEB`: WIRE is ticker-exact, WEB is name-matched, and the counts change.
19. Type `BTC/USD` — the selector flips to CRYPTO, the earnings/filings panel is gone, headlines
    still populate, and EDGAR is never called.
20. Click through from an option position on F1: the field shows `AAPL 16JAN26 150C` and the screen
    researches `AAPL`.
21. **The partial-failure claim, by hand.** Point `gdelt.ts` at a dead host and restart: HEADLINES
    falls back to the wire sources, `missing` lists `gdelt`, the panel meta says so, and every other
    panel is unaffected. Repeat with `edgar.ts` to confirm FILINGS degrades the same way.
22. Hit `/api/research?symbol=TSLA` twice inside five minutes; the second is a cache hit.
23. At 390px: the nav scrolls, **the page does not scroll sideways**, grids drop to ~5 columns, and no
    panel header wraps.

## Open items (not blocking)

- Season start date and starting cash — set in the Phase 6 admin console, no code change needed.
- Dividends, splits, and margin calls are out of scope for v1.
- IEX intraday feed means the last tick on thin tickers can trail the consolidated tape slightly;
  daily change and previous close are unaffected. Fine for a club sim.
