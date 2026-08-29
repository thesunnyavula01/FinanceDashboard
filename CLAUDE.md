# Finance Club Terminal

A paper-trading dashboard that replaces Investopedia for a high-school finance
club's yearly stock simulation. Each member signs in, gets their own portfolio
with a starting cash balance, trades US stocks and ETFs by ticker + dollar amount
or share count, and sees live P/L, sector exposure, and a leaderboard measured
against SPY, QQQ, and the club average.

Scale target: 30-100 members. Deployed on Cloudflare Workers.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript, Tailwind CSS v4, TanStack Query, Recharts |
| Backend | Hono, running inside the **same** Worker that serves the SPA via Workers Assets |
| Database + auth | Supabase Postgres, Supabase Auth (email + password, **email confirmation off**) |
| Cache | Cloudflare KV (shared quote cache) |
| Scheduled work | Cloudflare Cron Triggers (nightly portfolio snapshots) |

**Why Vite + Hono and not Next.js:** Cloudflare now recommends Workers Assets over
Pages, and this app is entirely auth-gated with no SEO or SSR requirement. The
Next-on-Cloudflare adapters (OpenNext / vinext) add a translation layer whose
failure modes are painful to debug and buy us nothing here.

---

## Non-negotiable rules

1. **Secrets never reach the browser.** Only `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` may be `VITE_`-prefixed. The Alpaca keys, Finnhub key,
   Supabase service-role key, JWT secret, and invite code are Worker-only. Never
   import them into anything under `src/`.
2. **The client never writes to the database.** Client-side Supabase is read-only
   plus auth. Every mutation goes through a Worker route using the service-role
   key. RLS enforces this at the database level as a second line of defence.
3. **Never trust a client-supplied price.** The Worker fetches the execution price
   itself on every order. A client that posts `{symbol, qty, price}` gets its
   `price` field ignored.
4. **Never read-modify-write cash in application code.** All balance mutation
   happens inside the `place_order()` Postgres function, which takes a
   `SELECT ... FOR UPDATE` row lock. Two browser tabs firing at once must not be
   able to spend the same dollar twice.
5. **Money is `numeric`, never float.** In TypeScript, format at the edge; never
   accumulate portfolio values through repeated float addition.

---

## Market data: two providers, on purpose

Google Finance has **no public API** - deprecated 2011, shut down 2012. The only
official access left is the `GOOGLEFINANCE()` formula inside Google Sheets, which
a web app cannot call. Anything advertised as a "Google Finance API" is a paid
scraper. Do not go down that road.

### Alpaca - all prices (free Basic plan, paper account, 200 req/min)

- `GET data.alpaca.markets/v2/stocks/snapshots?symbols=A,B,C&feed=iex`
  **Batched** - 100+ tickers per request (~16KB URL cap). Returns `latestTrade`,
  `latestQuote`, `minuteBar`, `dailyBar`, `prevDailyBar` per symbol.
- `GET data.alpaca.markets/v2/stocks/bars?symbols=SPY,QQQ&timeframe=1Day&start=...`
  Free historical daily bars. Powers the benchmark curves.
- `GET paper-api.alpaca.markets/v2/clock` - market open/closed + next open/close.
  Drives the market-hours-only rule, holidays included, for free.
- `GET paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity`
  The tradable universe, for ticker validation and autocomplete.

**Free-tier nuance worth knowing:** `dailyBar` and `prevDailyBar` are the same
full consolidated data paid subscribers get. Only `latestTrade`, `latestQuote`,
and `minuteBar` are restricted to the IEX feed. So daily change %, previous close,
and every historical bar are accurate; only the intraday last-tick is IEX-sourced
and can trail slightly on thin names.

### Finnhub - sector classification only (free tier, 60 req/min)

- `GET finnhub.io/api/v1/stock/profile2?symbol=X` - name, `finnhubIndustry`, logo.
  Called **once per ticker ever**, then persisted to the `securities` table
  permanently. Alpaca has no fundamentals; this is the only source for sectors.
- `stock/candle` is premium now (403 on free keys). Do not call it.
- Free tier is personal / non-commercial use. A school club qualifies.

### Why not Finnhub for prices too

Finnhub has no batch quote endpoint - one HTTP call per symbol. At ~200 unique
symbols across the club refreshing every 20s that is 600 calls/min against a
60/min ceiling: 10x over. Alpaca batches the same 200 symbols into 2 requests,
and one shared 20s KV cache means 100 simultaneous members still trigger only
those 2 -> **~6 req/min against a 200/min ceiling.**

Both live behind the `MarketDataProvider` interface in `worker/market/provider.ts`
so switching to a paid feed later is a one-file change.

---

## Domain model

### Signed quantity

A short position is stored as **negative `qty`**. This is deliberate and
load-bearing: unrealized P/L becomes one formula correct in both directions.

```
pnl = (price - avg_cost) * qty
```

For a short, `qty < 0`, so a price *drop* produces a positive number automatically.
Do not add long/short branching to the analytics layer - it is not needed and will
introduce sign bugs.

### Portfolio math

```
long_mv      = sum(qty * price)   where qty > 0
short_mv     = sum(|qty| * price) where qty < 0
equity       = cash + long_mv - short_mv
margin_held  = 1.5 * short_mv
buying_power = max(0, cash - margin_held)
```

Shorting $X credits $X to cash and locks 1.5X as margin, so it consumes 0.5X of
buying power - real Reg T, and explainable to a member in one sentence. Negative
buying power blocks new orders and shows a warning banner; there is **no forced
liquidation in v1** (deliberate scope cut).

### Order sides

`BUY`, `SELL`, `SHORT`, `COVER`. Quantity may be entered as fractional shares
(6 dp) or as a dollar notional, which the Worker converts at the price it fetched.

### Tables

```
profiles             id -> auth.users, display_name, role ('member'|'admin')
seasons              id, name, starting_cash, starts_at, ends_at, is_active,
                     trading_locked
portfolios           id, season_id, user_id, cash        UNIQUE(season_id, user_id)
positions            id, portfolio_id, symbol, qty (SIGNED), avg_cost
                                                         UNIQUE(portfolio_id, symbol)
trades               id, portfolio_id, symbol, side, qty, price, notional,
                     realized_pnl, executed_at
securities           symbol PK, name, sector, industry, asset_type, logo_url,
                     fetched_at
portfolio_snapshots  portfolio_id, as_of DATE, equity, cash, long_mv, short_mv
                                                         UNIQUE(portfolio_id, as_of)
benchmark_snapshots  symbol, as_of DATE, close           PK(symbol, as_of)
```

Members can read every portfolio, position, and trade in the active season -
seeing each other's picks is a feature for a learning club, not a leak.

---

## Design system

Bloomberg-terminal density, amber on true black. Dense beats airy everywhere.

| Token | Value |
|---|---|
| canvas | `#000000` |
| panel | `#0B0B0B` |
| hairline border | `#1C1C1C` |
| accent (amber) | `#FFB000` |
| gain | `#26D07C` |
| loss | `#FF4D4D` |

- **All numerics** in IBM Plex Mono with `font-variant-numeric: tabular-nums` so
  columns stay aligned as values tick.
- Labels and column headers in Inter, uppercase, letter-spaced, amber-dimmed.
- 28px grid rows, 12px base type. Data density is the aesthetic - resist padding.
- Function-key top nav: `F1 POSITIONS / F2 TRADE / F3 LEADERBOARD / F4 SECTORS / F5 ADMIN`.
- Slash key focuses the command bar. Keyboard-first order entry.

Load the `frontend-design` skill before building UI, and the `dataviz` skill
before writing any chart code.

---

## Layout

```
worker/index.ts                 Hono app, SPA fallback, scheduled() handler
worker/market/provider.ts       swappable data-provider interface
worker/market/alpaca.ts         snapshots, bars, clock, assets
worker/market/finnhub.ts        profile2 -> sector
worker/market/sectors.ts        finnhubIndustry -> GICS-11 map, ETF bucket
worker/routes/                  auth, quotes, orders, portfolio, leaderboard, admin
supabase/migrations/*.sql       schema, RLS policies, place_order() RPC
src/lib/                        supabase client, formatters
src/hooks/useQuotes.ts          TanStack Query, 20s refetchInterval
src/components/terminal/        Panel, DataGrid, Ticker, StatStrip
src/routes/                     Login, Dashboard, Trade, Leaderboard, Sectors, Admin
```

## Commands

```
npm run dev        vite + wrangler dev together
npm run build      typecheck + production bundle
npm run deploy     build + wrangler deploy
npm run typecheck  tsc --noEmit
```

## Phase status

- [x] **Phase 0** - repo hygiene, env scaffolding, credential checklist (`SETUP.md`)
- [ ] **Phase 1** - scaffold + terminal design system
- [ ] **Phase 2** - auth (invite-code signup, protected routes)
- [ ] **Phase 3** - market data layer (Alpaca proxy, KV cache, sector enrichment)
- [ ] **Phase 4** - trading engine (`place_order()` RPC, order ticket, blotter)
- [ ] **Phase 5** - analytics (positions grid, sectors, equity curve vs benchmarks)
- [ ] **Phase 6** - leaderboard + admin console
- [ ] **Phase 7** - cron snapshots + deploy

## Reference docs

- `docs/PLAN.md` - full build plan, phase by phase
- `SETUP.md` - account + API key checklist
- `DEPLOYMENT.md` - Cloudflare connection. Build vars and runtime secrets live in
  two different dashboard stores; `VITE_*` must be build vars or the bundle ships
  with an undefined Supabase client.
