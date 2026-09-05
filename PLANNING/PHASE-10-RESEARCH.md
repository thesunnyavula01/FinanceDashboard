# Phase 10 — Research on F4

The build sheet. The *why* is in [`DIRECTIONS.MD`](./DIRECTIONS.MD) under
"Research: six sources" and in [`docs/PLAN.md`](../docs/PLAN.md) under
"Phase 10"; this file is the order of work.

**Status: code implemented and verified, 2026-09-05.** No new credential or
migration is needed. Deployment is pending a real SEC contact and the live
browser/Cloudflare checks below.

---

## 0. Before writing any code

Two questions the documentation does not settle. Answer them with `curl` and
write the answers down here — the same habit that made Phase 8 worth reading.

- [x] **Is Finnhub `stock/earnings` free on this key?** Verified 2026-09-05:
      `stock/earnings?symbol=TSLA` returned HTTP 200 with four quarters and
      `estimate`, `actual`, `period`, `surprise`, `surprisePercent`, `year` and
      `quarter`. No additional subscription was needed. They paywalled
      `stock/candle` and `worker/market/finnhub.ts` carries a comment saying so.
      Free → the EARNINGS panel is a numeric grid. 403 → the numbers come from
      SEC XBRL company-facts instead, which is free, authoritative, already in
      the lineup, and changes no credential.
- [x] **Does GDELT answer from a Worker?** Verified 2026-09-05 using
      `wrangler dev --local` and its workerd `fetch`: HTTP 429, with a
      plain-text request to allow five seconds between calls. The adapter must
      treat this as an unavailable source and retain the other feeds. This
      verifies the Worker runtime on local egress; deployed Cloudflare egress
      still needs the post-deploy check. It rate-limits by IP and refused a
      shared cloud egress during research. Test from `wrangler dev`, not a
      laptop. Unreliable → Hacker News and the two wire sources still fill the
      panel, which is the partial-failure design doing its job.
- [x] **Probe EDGAR without a `User-Agent`.** On 2026-09-05,
      `www.sec.gov/files/company_tickers.json` from the local workerd probe
      returned HTTP 403, "Request Rate Threshold Exceeded". That confirms this
      request was refused; the response alone does not prove which check
      caused the refusal.
- [ ] Set `SEC_CONTACT` in `wrangler.jsonc` to a real reachable address and
      repeat the identified request before shipping. The existing placeholder
      is rejected by the adapter, so SEC is reported missing until configured.
      This remains the **only** setup step the phase has.

---

## 1. Credentials

**There are none.** This phase adds no key, no signup and no secret.

| Source | Where its credential comes from |
|---|---|
| Alpaca news | `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`, already in `.dev.vars` |
| Finnhub news + earnings | `FINNHUB_API_KEY`, already in `.dev.vars` |
| GDELT | none — open endpoint |
| SEC EDGAR | none — open endpoint, but requires a `User-Agent` |
| Hacker News | none — open endpoint |

The one thing to set is `SEC_CONTACT` in `wrangler.jsonc`, which is a **var and
not a secret**: the SEC requires a reachable contact address and answers 403 to
an unidentified caller, so being public is the point of it. It ships with the
code and needs no `wrangler secret put`.

Do not go looking for keys for GDELT, EDGAR or Hacker News. They have none.

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
`NEGATIVE_TTL_SECONDS` in `quotes.ts`. One obscure ticker must not send five
providers a request on every visit for the rest of the season.

### The response shape

```jsonc
{ "symbol": "TSLA", "assetClass": "EQUITY", "name": "Tesla Inc",
  "headlines": [...], "earnings": [...], "filings": [...], "discussion": [...],
  "sources": ["alpaca", "finnhub", "edgar", "hackernews"],
  "missing": ["gdelt"],
  "asOf": "2026-09-05T14:02:11.318Z" }
```

`Promise.allSettled` across every source. A rejection is `console.error`'d;
`describeMarketError` runs **only when every source failed**. Dedupe by URL
host+path, keeping the earliest `publishedAt` — the same wire story arrives from
three of them. **One live-feed exception:** Finnhub's company-news links can
all be `finnhub.io/api/news?id=…`. That `id` is the article identity, not a
tracking parameter, and must survive deduplication. The first integration check
collapsed forty different Finnhub stories into one without it; a regression
test now pins the distinction.

Finnhub's crypto endpoint is category-wide. Those rows are filtered by coin
name/ticker and labelled **WEB**, since a keyword match must not claim the
ticker precision of Alpaca's crypto wire. Common crypto ticker aliases resolve
to names such as Bitcoin for GDELT and Hacker News too.

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
│ 12m  Reuters     Tesla opens …      │  │ 812↑ 4h   Inside the … │
│ 1h   TechCrunch  Inside the new …   │  │ 214↑ 9h   Why the new… │
└─────────────────────────────────────┘  └────────────────────────┘
```

| Panel | Columns (`~` = `hideOnMobile`) |
|---|---|
| Asset card | — · `useSecurities` + `useQuotes`, so no new endpoint |
| EARNINGS / FILINGS | two tabs of **one** `Panel` — it supports them natively and they cost no height |
| HEADLINES | Age · ~Source · Headline · ~Tier |
| DISCUSSION | Score · ~Age · Title · ~Comments — Hacker News |

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
- [x] one story arriving from three providers merges to one row, earliest kept
- [x] N readers inside the TTL cost one round of upstream calls
- [x] **one dead provider degrades to the rest and `missing` names it**
- [x] every provider dead throws, so the route can still answer 502
- [x] an empty result is negative-cached and does not re-poll
- [x] an OCC symbol researches its underlying
- [x] `BTC/USD` takes the crypto path and asks neither EDGAR nor Finnhub earnings
- [x] a summary containing markup comes back as text
- [x] wire and web results stay tagged with their tier through the merge

`worker/market/edgar.test.ts`
- [x] every request carries a `User-Agent`
- [x] ticker→CIK is looked up once and cached

`worker/market/hackernews.test.ts`
- [x] the query sorts by date with a recency filter, not by relevance

`scripts/mobile-layout.test.ts`
- [x] `Research.tsx`'s stacking grid carries `grid-cols-1`

Additional regressions cover the profile-enrichment race, independent fragment
TTLs, malformed/throwing edge caches, failed-source retry caches, authenticated
route validation, Finnhub redirect identities and paywall markers, unsafe URLs,
and SEC annual/YTD figures being excluded from quarterly EPS.

`worker/market/research-relevance.test.ts` covers direct company/ticker matching,
word boundaries, short and common-word tickers, markup, literal punctuation,
crypto names and fork exclusions. The aggregation regression seeds a warm cache
with Amazon-only articles tagged TSLA and confirms they disappear without an
upstream request. The same rule applies to discussion titles. Provider tags,
summaries and URLs alone cannot establish relevance; matching happens before
the merge and on every cache read. The browser query key is versioned to discard
unfiltered results retained during development.

### Verification results

- `npm test`: **335 passing**, including the pre-existing trading, valuation,
  auth, migration and build-guard tests.
- `npm run build`: passes. The existing large-client-chunk advisory remains;
  this phase adds no dependency and the chart stays in its separate chunk.
- A scan of the generated client JavaScript, source maps and HTML found no
  configured Worker secret values.
- Local React render smoke checks passed for equity, crypto, OCC underlyings,
  SEC actual-only EPS, complete research failure, mobile columns/discussion
  links, plain text, external-link attributes and tied paywall ordering.
- Live adapter integration after relevance filtering: TSLA returned **50 headlines, four earnings
  quarters and 18 discussion posts**. A second read made **zero upstream
  requests**. GDELT timed out and SEC was correctly missing while its contact
  remained a placeholder.
- BTC/USD returned **53 headlines across four link domains and both tiers**,
  plus three discussion posts. It made no SEC or earnings requests.
- Finnhub company-news URLs are redirect links, so counting their link host
  as a publisher understates breadth. TSLA's WEB coverage still needs the live
  GDELT check; it is not claimed as verified here.
- Browser screenshot/interaction checks, including actual 390px geometry,
  were unavailable in this session. The mobile layout guards and render checks
  passed; the browser walk-through remains in the deployment checklist.

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

- **Item 17** — inspect relevant headlines across both tiers and the source
  status. Four publisher domains is a breadth target when coverage permits;
  relevance filtering must never admit unrelated articles to meet a count.
- **Item 21** — point `gdelt.ts` at a dead host and restart. HEADLINES falls
  back to the wire sources, `missing` lists `gdelt`, the panel meta says so, and
  every other panel is unaffected. That is the whole partial-failure design,
  checked by hand.
