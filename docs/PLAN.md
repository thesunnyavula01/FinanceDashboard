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
- **`CLAUDE.md`** — stack, provider split and the rate-limit reasoning, signed-qty convention, margin
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

---

## Critical files

```
CLAUDE.md
.env.example / .dev.vars
wrangler.jsonc
supabase/migrations/*.sql          -- schema, RLS, place_order() RPC
worker/index.ts                    -- Hono app + SPA fallback + scheduled handler
worker/market/provider.ts          -- swappable data-provider interface
worker/market/alpaca.ts            -- snapshots, bars, clock, assets
worker/market/finnhub.ts           -- profile2 → sector
worker/market/sectors.ts           -- finnhubIndustry → GICS-11 map
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

## Open items (not blocking)

- Season start date and starting cash — set in the Phase 6 admin console, no code change needed.
- Dividends, splits, and margin calls are out of scope for v1.
- IEX intraday feed means the last tick on thin tickers can trail the consolidated tape slightly;
  daily change and previous close are unaffected. Fine for a club sim.
