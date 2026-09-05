# FinanceDashboard

A paper-trading terminal for a high-school finance club's yearly stock
simulation — built to replace Investopedia with something the club actually
controls.

Each member signs in, gets their own portfolio with a starting cash balance,
trades US stocks, ETFs, crypto and long options by ticker and dollar amount, and
sees live P/L, sector exposure, and a leaderboard measured against SPY, QQQ, and
the club average.

## Features

- **Per-member portfolios** with a shared starting balance and a live leaderboard
- **Three asset classes** — stocks and ETFs, crypto pairs, and long options,
  classified from the symbol alone
- **Five order types** — market, limit, stop, stop-limit and trailing stop,
  across buy, sell, short and cover, with fractional shares or a dollar amount
- **Resting orders** — anything placed while the market is shut is queued with
  its cash reserved, and filled by a sweep that runs every minute
- **Market-hours enforcement**, holidays included — and 24/7 for crypto, which
  has no bell
- **Reg T margin** on short positions, and cash settlement at option expiry
- **Live prices** refreshing every ~20 seconds, batched and cached so a hundred
  members cost the same upstream calls as one
- **Sector exposure** as a treemap, a concentration rail and a drill-down, with
  warnings past 40%
- **Equity curve** in dollars against SPY, QQQ and the club average, from 1D at
  five-minute resolution out to the whole season
- **Invite-code signup** — no email confirmation, no magic links
- **Admin console** for season resets, starting cash, trading locks, and
  corrections that replay a portfolio rather than patching it

## Stack

Vite + React + TypeScript · Tailwind CSS · Hono on Cloudflare Workers ·
Supabase (Postgres + Auth) · Alpaca and Finnhub market data

## Getting started

1. Work through [`SETUP.md`](./SETUP.md) to create the four free accounts and
   fill in `.env` and `.dev.vars`. Takes about 15 minutes.
2. `npm install`
3. `npm run dev`

## Deploying

See [`DEPLOYMENT.md`](./DEPLOYMENT.md). The short version: build-time variables
and runtime secrets go in **two different places** in the Cloudflare dashboard,
and putting them in the wrong one is the most common way this breaks.

## Documentation

| File | What's in it |
|---|---|
| [`SETUP.md`](./SETUP.md) | One-time account and API key checklist |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Connecting the repo to Cloudflare |
| [`PLANNING/DIRECTIONS.MD`](./PLANNING/DIRECTIONS.MD) | Architecture, invariants, design system |
| [`docs/PLAN.md`](./docs/PLAN.md) | Full build plan, phase by phase |
| [`docs/SITEMAP.md`](./docs/SITEMAP.md) | Every screen and route, and the ways in |

## Status

**Phases 0–9 complete** and on `main`. Phase 10 is planned and scaffolded, not built:

| Phase | What it added |
|---|---|
| 0–1 | Repo, env guards, the black/amber terminal design system |
| 2 | Invite-code signup, ES256 session verification, protected routes |
| 3 | Market data — Alpaca proxy, three-tier quote cache, sector enrichment |
| 4 | The trading engine: `place_order()` under a row lock, ticket, blotter |
| 5 | Positions grid, sector exposure, equity curve against the benchmarks |
| 6 | Leaderboard and the admin console |
| 7 | Nightly portfolio and benchmark snapshots on a cron |
| 8 | Crypto and long options — the symbol classifier, the chain, expiry |
| 9 | Stop, stop-limit and trailing-stop orders, and a review-then-place ticket |
| 10 | **Planned** — Research on F4: news, filings and discussion for any ticker |

Both migrations past the initial schema — `0006_derivatives.sql` and
`0007_stop_orders.sql` — are applied and verified against `pg_proc`. The test
suite is 286 tests over the Worker and the build guards, and it passes.

Phase 10 adds no credential and no migration. Its plan, the six sources it
reads and the two things to `curl` before writing any of it are in
[`docs/PLAN.md`](./docs/PLAN.md), and step 7 of [`SETUP.md`](./SETUP.md) says
why there is nothing to sign up for.

What is left is operational rather than unbuilt: set the runtime secrets and
`npm run deploy`, then walk the checklist at the end of
[`DEPLOYMENT.md`](./DEPLOYMENT.md). The KV namespace already exists and its id
is in `wrangler.jsonc`.
