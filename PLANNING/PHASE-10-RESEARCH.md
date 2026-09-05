# Phase 10 — Research on F4

The build sheet. The *why* is in [`DIRECTIONS.MD`](./DIRECTIONS.MD) under
"Research: seven sources" and in [`docs/PLAN.md`](../docs/PLAN.md) under
"Phase 10"; this file is the order of work.

**Status: planned, scaffolded, not built.** The credential slots exist and the
build guard covers them. No feature code has been written.

---

## 0. Before writing any code

Two questions the documentation does not settle. Answer them with `curl` and
write the answers down here — the same habit that made Phase 8 worth reading.

- [ ] **Is Finnhub `stock/earnings` free on this key?** They paywalled
      `stock/candle` and `worker/market/finnhub.ts` carries a comment saying so.
      Free → the EARNINGS panel is a numeric grid. 403 → the numbers come from
      SEC XBRL company-facts instead, which is free, authoritative, already in
      the lineup, and changes no credential.
- [ ] **Does GDELT answer from a Worker?** It rate-limits by IP and refused a
      shared cloud egress during research. Test from `wrangler dev`, not a
      laptop. Unreliable → Hacker News and the two wire sources still fill the
      panel, which is the partial-failure design doing its job.
- [ ] **Confirm EDGAR 403s without a `User-Agent`**, so the requirement is real
      and not folklore, and set `SEC_CONTACT` in `wrangler.jsonc` to a real
      address before anything ships.

---

## 1. Credentials

Done already — nothing to write, only to fill in.

| Where | What | State |
|---|---|---|
| `.dev.vars` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | slots documented in `.env.example`, **awaiting your key** |
| `wrangler.jsonc` | `SEC_CONTACT` | placeholder committed, **replace before deploy** |
| `worker/types.ts` | all three, secrets optional | done |
| `scripts/check-client-env.ts` | `"REDDIT"` in `SECRET_MARKERS` | done, and proven to fail the build |

GDELT, SEC EDGAR and Hacker News need no credential. Do not go looking for one.

---

## 2. Worker

### The seam

`worker/market/provider.ts` gains `NewsItem`, `EarningsQuarter`, `Filing`,
`DiscussionPost` and a `NewsProvider` interface beside `PriceProvider` and
`ProfileProvider`. `describeMarketError` then handles every new failure with no
new route code.

### Files

| File | Credential | Notes |
|---|---|---|
| `worker/market/alpaca.ts` | existing | add `news(symbols, opts)`. Same host, same `APCA-*` headers. |
| `worker/market/finnhub.ts` | existing | add `news(symbol)` and `earnings(symbol)`. Its header forbids adding **price** calls; extend the comment to say news is not one, so nobody strips this later. |
| `worker/market/gdelt.ts` | **none** | `mode=artlist&format=json`, declared `User-Agent`, keyword built from the resolved company name. |
| `worker/market/edgar.ts` | **none** | `efts.sec.gov` for filings, `data.sec.gov` for XBRL. Ticker→CIK from `www.sec.gov/files/company_tickers.json`, cached a week. **`User-Agent` or 403.** |
| `worker/market/hackernews.ts` | **none** | `search_by_date` with a `created_at_i` filter. The default relevance sort returns 2018 stories and the panel becomes a museum without saying so. |
| `worker/market/reddit.ts` | **the one** | `redditFromEnv()` throwing `MarketConfigError` naming `REDDIT_CLIENT_ID`. OAuth client-credentials token cached in the isolate (24h), one retry on 401, no loop. |
| `worker/market/research.ts` | — | fan-out, merge, dedupe, cache. Exports `loadResearch(env, symbol, waitUntil?)` and `forgetResearch()`. |
| `worker/routes/research.ts` | — | `GET /api/research?symbol=`, `research.use("*", requireAuth)`. |

`worker/index.ts`: one import, one `app.route("/api/research", research)` in the
existing block. `/api/*` already runs the Worker first, so `wrangler.jsonc`
needs no routing change and there is no new cron.

### Cache — mirror `chain.ts`, not `quotes.ts`

Two tiers (isolate `Map`, then `caches.default`), a
`https://research-cache.invalid/v1/…` key with `encodeURIComponent` so `BTC/USD`
does not split into two path segments, the `typeof caches === "undefined"` guard
that keeps the module loadable under `node --test`, a cache throw treated as a
miss and never an outage, and a `forgetResearch()` export for tests.

There is no per-symbol batching here, so `quotes.ts`'s class-based three-tier
cache would be machinery without a job.

```ts
const NEWS_TTL_MS     = 5 * 60_000;            // news is not a price
const WEB_TTL_MS      = 15 * 60_000;           // gdelt + hn move slower
const EARNINGS_TTL_MS = 12 * 60 * 60_000;      // quarterly data
const FILINGS_TTL_MS  = 6 * 60 * 60_000;
const SOCIAL_TTL_MS   = 10 * 60_000;
const CIK_TTL_MS      = 7 * 24 * 60 * 60_000;  // a ticker's CIK is forever
const EMPTY_TTL_MS    = 30 * 60_000;           // negative cache
```

Keys slash-prefixed by kind, as in `chain.ts`: `wire/${symbol}`, `web/${symbol}`,
`earnings/${symbol}`, `filings/${symbol}`, `social/${symbol}`.

A symbol with nothing to show is cached too, for longer — the reasoning behind
`NEGATIVE_TTL_SECONDS` in `quotes.ts`. One obscure ticker must not send six
providers a request on every visit for the rest of the season.

### The response shape

```jsonc
{ "symbol": "TSLA", "assetClass": "EQUITY", "name": "Tesla Inc",
  "headlines": [...], "earnings": [...], "filings": [...], "discussion": [...],
  "sources": ["alpaca", "finnhub", "edgar", "hackernews", "reddit"],
  "missing": ["gdelt"],
  "asOf": "2026-09-05T14:02:11.318Z" }
```

`Promise.allSettled` across every source. A rejection is `console.error`'d;
`describeMarketError` runs **only when every source failed**. Dedupe by URL
host+path, keeping the earliest `publishedAt` — the same wire story arrives from
three of them.

---

## 3. Client

### Nav

`src/components/terminal/FunctionNav.tsx`, the `SCREENS` array:

```ts
{ key: "F4", label: "Research",  path: "/research" },
{ key: "F5", label: "Sectors",   path: "/sectors" },
{ key: "F6", label: "Admin",     path: "/admin", admin: true },
```

`screensFor()`, `CommandBar` and the keydown handler need no change beyond the
array. Update the "no F6" comment block at `FunctionNav.tsx:111` — the argument
survives and moves up one: Legal is still keyless and now deliberately not F7.

`src/App.tsx`: one route in the **signed-in** block only.

### `src/routes/Research.tsx`

```
RESEARCH                                          EQUITY · CRYPTO
SYMBOL [ TSLA                    ]

┌ TESLA INC · Consumer Discretionary ─┐  ┌ EARNINGS │ FILINGS ────┐
│  428.50   +2.14%   Automobiles      │  │ Q3  EST 0.62  ACT 0.72 │
└─────────────────────────────────────┘  └────────────────────────┘
┌ HEADLINES   ALL · WIRE · WEB ───────┐  ┌ DISCUSSION ────────────┐
│ 12m  Reuters     Tesla opens …      │  │ 340↑ r/stocks     …    │
│ 1h   TechCrunch  Inside the new …   │  │ 812↑ HN           …    │
└─────────────────────────────────────┘  └────────────────────────┘
```

| Panel | Columns (`~` = `hideOnMobile`) |
|---|---|
| Asset card | — · `useSecurities` + `useQuotes`, so no new endpoint |
| EARNINGS / FILINGS | two tabs of **one** `Panel` — it supports them natively and they cost no height |
| HEADLINES | Age · ~Source · Headline · ~Tier |
| DISCUSSION | Score · ~Venue · Title · ~Age — Reddit and HN in one list |

Rules that are not negotiable on this screen:

- **The instrument selector is F2's control reused verbatim** — underlined text,
  not keycaps. Modes are underlines; actions are keycaps.
- **`classify()` on the committed symbol also flips the mode**, because asset
  class is derived from the symbol everywhere else in this app.
- **An option researches its underlying** — `underlyingOf(symbol) ?? symbol`,
  the idiom `securities.ts` already uses. The field still shows
  `formatContract`.
- **`ALL · WIRE · WEB` is on screen** because WIRE is ticker-exact and WEB is
  name-matched, and a keyword search finds Apple the fruit.
- **Summaries render as text, never HTML.** No sanitizer exists in this repo and
  no `dangerouslySetInnerHTML` anywhere. Strip tags in the Worker. Links carry
  `target="_blank" rel="noreferrer noopener"`.
- **Paywalls are marked, not filtered** — a small domain set (`wsj.com`,
  `bloomberg.com`, `barrons.com`, `ft.com`, `seekingalpha.com`,
  `theinformation.com`, `economist.com`) gets a dim marker and loses ties on
  sort.
- **Crypto drops the earnings/filings panel** and headlines take the space.
- Layout follows `Sectors.tsx`, including the unprefixed **`grid-cols-1`** that
  `scripts/mobile-layout.test.ts` exists to enforce.

### One refactor

`SymbolSearch` hard-codes `id="order-symbol"`. Give it an optional `id` prop
defaulting to that value, so F2 is untouched and Research cannot collide.

---

## 4. Tests

House idiom: `node:test` + `assert/strict`, `.ts` import extensions, no
`describe`/`beforeEach`, lowercase full-sentence names stating the invariant,
`globalThis.fetch` saved and restored in a `finally`, and an opening block
comment naming the class of bug the file defends against, ending
`* Run with: npm test`.

`worker/market/research.test.ts`
- [ ] one story arriving from three providers merges to one row, earliest kept
- [ ] N readers inside the TTL cost one round of upstream calls
- [ ] **one dead provider degrades to the rest and `missing` names it**
- [ ] every provider dead throws, so the route can still answer 502
- [ ] an empty result is negative-cached and does not re-poll
- [ ] an OCC symbol researches its underlying
- [ ] `BTC/USD` takes the crypto path and asks neither EDGAR nor Finnhub earnings
- [ ] a summary containing markup comes back as text
- [ ] wire and web results stay tagged with their tier through the merge

`worker/market/edgar.test.ts`
- [ ] every request carries a `User-Agent`
- [ ] ticker→CIK is looked up once and cached

`worker/market/hackernews.test.ts`
- [ ] the query sorts by date with a recency filter, not by relevance

`worker/market/reddit.test.ts`
- [ ] the token is fetched once and reused
- [ ] a 401 refetches once and does not loop

`scripts/mobile-layout.test.ts`
- [ ] `Research.tsx`'s stacking grid carries `grid-cols-1`

`scripts/check-client-env.test.ts` — **already done**, both Reddit names covered.

---

## 5. Docs to update when it ships

Flip `[ ]` to `[x]` for Phase 10 in `DIRECTIONS.MD`, change "planned, not built"
in `docs/PLAN.md` and `README.md`, and record what the two `curl` probes in
step 0 actually returned. Everything else — the screens table, the API tables,
the layout tree, the nav line, the F6 renumbering — is **already written**.

---

## 6. Verification

The full walk-through is `docs/PLAN.md` → Verification → Phase 10, items 15–23.
The two that catch the most:

- **Item 17** — headlines from four or more distinct domains spanning both
  tiers. Fewer than that and the merge or a provider is silently failing.
- **Item 21** — comment `REDDIT_CLIENT_ID` out of `.dev.vars` and restart.
  DISCUSSION shows only Hacker News, `missing` lists `reddit`, every other panel
  is unaffected. That is the whole partial-failure design, checked by hand.
