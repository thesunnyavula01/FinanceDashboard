# FinanceDashboard

A paper-trading terminal for a high-school finance club's yearly stock
simulation — built to replace Investopedia with something the club actually
controls.

Each member signs in, gets their own portfolio with a starting cash balance,
trades US stocks and ETFs by ticker and dollar amount, and sees live P/L, sector
exposure, and a leaderboard measured against SPY, QQQ, and the club average.

## Features

- **Per-member portfolios** with a shared starting balance and a live leaderboard
- **Real order types** — buy, sell, short, and cover, with fractional shares
- **Market-hours enforcement**, holidays included
- **Reg T margin** on short positions
- **Live prices** refreshing every ~20 seconds
- **Sector breakdown** with concentration warnings
- **Equity curve** benchmarked against SPY, QQQ, and the club average
- **Invite-code signup** — no email confirmation, no magic links
- **Admin console** for season resets, starting cash, and trading locks

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
| [`CLAUDE.md`](./CLAUDE.md) | Architecture, invariants, design system |
| [`docs/PLAN.md`](./docs/PLAN.md) | Full build plan, phase by phase |

## Status

Phase 0 of 7 complete — repository hygiene, environment scaffolding, and
credential documentation. The application itself starts at Phase 1.
