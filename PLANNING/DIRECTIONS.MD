# Finance Club Terminal

A paper-trading dashboard that replaces Investopedia for a high-school finance
club's yearly stock simulation. Each member signs in, gets their own portfolio
with a starting cash balance, trades US stocks, ETFs, crypto and long options by
ticker + dollar amount or share count, and sees live P/L, sector exposure, and a
leaderboard measured against SPY, QQQ, and the club average.

Scale target: 30-100 members. Deployed on Cloudflare Workers.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript, Tailwind CSS v4, TanStack Query, Recharts |
| Backend | Hono, running inside the **same** Worker that serves the SPA via Workers Assets |
| Database + auth | Supabase Postgres, Supabase Auth (email + password, **email confirmation off**) |
| Quote cache | Isolate memory + the Cache API (**not** KV — see below) |
| KV | Nightly copy of the tradable asset list, for ticker autocomplete |
| Scheduled work | Cloudflare Cron Triggers (asset-list sync, nightly portfolio snapshots) |

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

   The build enforces this rather than trusting it: `npm run build` fails on any
   `VITE_`-prefixed variable naming a Worker secret, and on a service-role key
   sitting in the anon slot. Those two public values are committed in
   `.env.production` — Vite inlines them at *build* time, so they cannot live in
   the Worker's runtime store, which is both unreadable to Vite and cleared by
   every deploy. That mistake is the one that kept breaking deploys; see
   DEPLOYMENT.md, "The one thing that breaks this app".
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
- The same endpoint at `timeframe=5Min` powers the 1D chart. Batched and paged
  identically. Unlike the daily bars these are **IEX only, not the consolidated
  tape**, so a thin name simply has no bar in plenty of five-minute buckets —
  fine for drawing the shape of a day, and never touched by anything that
  settles money.
- `GET paper-api.alpaca.markets/v2/clock` - market open/closed + next open/close.
  Drives the market-hours-only rule. Paired with
  `/v2/calendar?start=<today>&end=<today>`, which is what separates "closed
  because the session ended" from "closed because today is Thanksgiving" and
  gives the real close time on a half day. Both free. The 1D chart reads the
  same calendar over a range, to bound its axis to the session that was held.
- `GET paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity`
  The tradable universe, for ticker validation and autocomplete. ~13,000 listed
  rows after filtering OTC out.

**Free-tier nuance worth knowing:** `dailyBar` and `prevDailyBar` are the same
full consolidated data paid subscribers get. Only `latestTrade`, `latestQuote`,
and `minuteBar` are restricted to the IEX feed. So daily change %, previous close,
and every historical bar are accurate; only the intraday last-tick is IEX-sourced
and can trail slightly on thin names.

**The snapshot trap — read this before touching `quoteFromSnapshot`.**
`dailyBar` is *not* always today. Before the opening bell it still holds the
last completed session and `prevDailyBar` holds the one before that, so reading
`prevDailyBar.c` as "yesterday's close" at 8am is off by a whole session and
every day-change figure on the dashboard is silently wrong. The code checks the
bar's exchange date first, and everything follows from that:

- **During today's session**, the latest print is the price:
  `latestTrade` -> quote midpoint -> `dailyBar.c` -> `prevDailyBar.c`.
- **Outside it**, the official close is the price, and `latestTrade` is ignored.
  Thin after-hours IEX prints would otherwise move an overnight valuation for
  no real reason, and orders are rejected outside market hours anyway.
- A quote midpoint is used **only** when both sides are quoted and uncrossed.
  IEX publishes one-sided books outside deep liquidity, and averaging a real
  offer with a zero bid halves the price.

Pinned by `worker/market/alpaca.test.ts`.

### Alpaca - crypto (free, same key, no market-data subscription)

- `GET data.alpaca.markets/v1beta3/crypto/us/snapshots?symbols=BTC/USD,ETH/USD`
  Same `latestTrade` / `latestQuote` / `dailyBar` / `prevDailyBar` shape as the
  stock snapshot, so `quoteFromCryptoSnapshot()` is the equity function with the
  session branch deleted. There is no session, no `feed` parameter, and no
  holiday. ~56 pairs.
- `GET .../v1beta3/crypto/us/bars` — the same bars the equity curve replays
  against, at `1Day` and `5Min`.
- `GET paper-api.alpaca.markets/v2/assets?asset_class=crypto` — the pairs, with
  `min_order_size` and `price_increment`, merged into the nightly KV universe.

**The daily-bar boundary is the one trap.** Alpaca's documentation shows a
05:00Z stamp in a v1beta1-era example, which would make `exchangeDate()` read it
correctly. The live v1beta3 feed stamps **00:00Z**, and `exchangeDate()` turns
that into 20:00 the previous evening — dating every crypto close a session early,
silently, on a chart that still draws. So a crypto daily bar takes its date from
its own UTC timestamp and nothing else. Found by calling the API; pinned by
`crypto.test.ts`.

### Alpaca - options (free, same key, paper-enabled by default)

- `GET data.alpaca.markets/v1beta1/options/snapshots?symbols=<OCC,...>` — prices
  for held contracts, batched like every other quote.
- `GET .../v1beta1/options/snapshots/{underlying}?expiration_date=YYYY-MM-DD` —
  the chain. **One expiration at a time, always.** A whole liquid surface is tens
  of thousands of contracts; one expiration is ~200 and returns a null page token
  at `limit=1000`.
- `GET .../v1beta1/options/bars?symbols=...&timeframe=1Day` — sparse, which the
  replay already handles by carrying the last close forward.
- `GET paper-api.alpaca.markets/v2/options/contracts` — strike, expiry, type,
  multiplier and **open interest**, every numeric as a string. This is the option
  universe's stand-in for KV, which it cannot use: hundreds of thousands of rows,
  past the 25MB per-value ceiling and useless for autocomplete.

**`expiration_date_lte` defaults to next weekend.** Omit it and a request for a
year of expirations answers with this Friday's — a 200, a well-formed body, and a
rail with one date on it. Nothing about the response says the request was wrong.
Every contracts call sets the range explicitly.

**There are no greeks and no implied volatility on this key, and there is no
parameter that produces them.** The fields are absent under the default feed and
under `feed=indicative`; `feed=opra` answers 403 "OPRA agreement is not signed".
The chain therefore shows bid, ask, last and open interest, and Δ / IV columns
are not a missing feature to add back — they need a signed OPRA agreement first.
Verified against the live API, not the documentation.

**The option quote prefers the midpoint over the last print**, inverting the
equity precedence. On the indicative feed the quote is real-time and synthetic
while trades lag OPRA by fifteen minutes: a live response had a book quoted at
19:59:59Z against a print from 15:17Z. Taking the print — which is right for IEX,
where prints are real and current — would settle a paper fill against lunchtime.
The uncrossed-two-sided-book guard is kept and matters more here than anywhere,
because a chain quotes one side all day on the wings. F2's chain panel states the
feed once, the same habit as the curve naming whether it was replayed or stored.

### Finnhub - profiles and research (free tier, 60 req/min)

- `GET finnhub.io/api/v1/stock/profile2?symbol=X` - name, `finnhubIndustry`, logo.
  Called **once per ticker ever**, then persisted to the `securities` table
  permanently. Alpaca has no fundamentals; this is the only source for sectors.
- `stock/candle` is premium now (403 on free keys). Do not call it.
- Free tier is personal / non-commercial use. A school club qualifies.

### Research: six sources, none of which needs a signup (Phase 10)

**Implemented in Phase 10.** F4 answers a question about the asset rather than the
portfolio, and that needs breadth of publisher rather than freshness of tick —
the opposite requirement to a price.

The 2026 survey is mostly a list of doors that closed. **X/Twitter** ended its
free tier in February 2026: reads are now billed per post, there is no free
search, and the legacy Basic plan was retired in June. **CoinDesk Data
(CryptoCompare)** retired free access in May 2026 and **CoinGecko's** news
endpoint is Analyst-plan-only, so the dedicated crypto-news vendors are simply
gone. **Marketaux** returns three articles per response on free and
**Polygon.io** allows five requests a minute. None of that is buyable at club
scale.

What is left is broader than what was lost, and **none of it needs an account**:

- **Alpaca** `v1beta1/news` - the Benzinga wire, on the key already in use, at
  200 req/min. Batched by `symbols` and it covers **crypto pairs as well as
  equities**, which is what makes the collapse of the crypto vendors survivable.
- **Finnhub** `company-news` and `news?category=crypto` - a different publisher
  mix on the key already in use: Reuters, CNBC, MarketWatch, Yahoo, Seeking
  Alpha. Plus `stock/earnings` for actual-vs-estimate, **verified on the live key
  2026-09-05: HTTP 200 and four TSLA quarters**. SEC XBRL is the fallback and
  costs no credential; it supplies reported quarterly EPS without estimates.
- **GDELT DOC 2.0** - no key, no account, ever. Indexes 100,000+ outlets
  worldwide, which is where TechCrunch, The Verge, Ars Technica and the trade
  and local press come from.
- **SEC EDGAR** (`efts.sec.gov` + `data.sec.gov`) - no key, 10 req/sec. The
  primary documents: 8-K, 10-Q, 10-K and reported XBRL figures. **Every request
  must carry a `User-Agent` naming a reachable contact or the SEC answers 403**,
  which is what `SEC_CONTACT` is - a var and not a secret, because being
  contactable is the point of it.
- **Hacker News** (Algolia) - no key. Tech-community discussion, and what
  fills the slot X used to. Query `search_by_date` with a recency filter: the
  default relevance sort returns 2018 stories and the panel becomes a museum
  without saying so.

**Wire and web are not the same claim, and the screen says which.** Alpaca and
Finnhub search by *ticker*; GDELT and Hacker News search by *keyword*, so they
need the company name - which is why the asset card's profile lookup is
load-bearing rather than decorative. A keyword search finds Apple the fruit and
Gap the retailer, so `ALL · WIRE · WEB` is on screen and a ticker-exact row
never looks identical to a name-matched one. Same habit as the curve naming
whether it was replayed or stored.

**Provider tags are candidates, not relevance evidence.** Finnhub returned an
Amazon-only article tagged `TSLA` during verification. Both headline tiers and
discussion titles now require a direct company-name or ticker match in the
visible title. Summaries, URLs, CEO/product aliases and provider tags alone do
not qualify. Common-word tickers require explicit stock notation or a resolved
company name, and ambiguous names need context. Filtering runs after every
cache read, so old cached candidates obey the same rule. Fewer relevant rows
are preferable to filling the panel with loosely related stories.

Finnhub's crypto endpoint is category-wide rather than ticker-exact. Its rows
are filtered by the coin's name/ticker and labelled **WEB**; Alpaca's symbol
query remains WIRE. Common pair names resolve to Bitcoin, Ethereum and other
asset names before a keyword request.

**An article ID is not a tracker.** Finnhub company-news links can all share
`finnhub.io/api/news` and differ only by `?id=…`. Deduplication keeps that ID;
otherwise forty distinct stories collapse into one. Other URLs dedupe by
host and path, keeping the earliest publication time. Known paywalled domains
and recognized publishers behind Finnhub redirects carry a dim marker and lose
timestamp ties; articles are never fetched individually to resolve redirects.

**Five upstreams sit behind one `/api/research` call**, cached 5-15 minutes in
the same two tiers as the chain. A hundred members reading TSLA cost one round
of five requests, not five hundred. The binding ceiling is Finnhub's 60/min, shared
with the sector enrichment already budgeted against in `securities.ts`.

**Partial failure is reported, never fatal.** `Promise.allSettled` across every
source and a `sources` / `missing` pair in the payload, so a thin feed says
whether that is the news or the plumbing. `describeMarketError` runs only when
every source failed. With five upstreams this matters far more than with two:
the screen must not go dark because GDELT rate-limited us.

That failure was observed in the preflight: GDELT returned 429 from local
Wrangler workerd, while the SEC ticker list returned 403 without a User-Agent.
The real `SEC_CONTACT`, identified SEC probe, deployed egress check and browser
walk-through remain deployment work. The adapter refuses the placeholder and
names SEC as missing until configured. Results live in
`PLANNING/PHASE-10-RESEARCH.md`.

Fragments cache independently: news five minutes, web fifteen, discussion ten,
filings six hours and earnings twelve. Empty successful responses last at least
thirty minutes, failed fragments back off for one minute, and a source that
partly succeeds can appear in both `sources` and `missing`. `sectionMissing`
keeps each panel's explanation precise. Cold readers also share profile
resolution, so the web feeds get the company name on the first request.

**Summaries are text, never HTML.** There is no sanitizer in this repo and no
`dangerouslySetInnerHTML` anywhere; a news summary would be the first untrusted
markup in the app, so tags are stripped in the Worker.

### Why not Finnhub for prices too

Finnhub has no batch quote endpoint - one HTTP call per symbol. At ~200 unique
symbols across the club refreshing every 20s that is 600 calls/min against a
60/min ceiling: 10x over. Alpaca batches the same 200 symbols into 2 requests,
and one shared 20s cache means 100 simultaneous members still trigger only
those 2 -> **~6 req/min against a 200/min ceiling.**

### Where the quote cache actually lives (not KV)

The original plan said KV. It is the wrong store for this, and
`worker/market/quotes.ts` uses a three-tier cache instead:

1. **Isolate memory** - a Map, free and instant, absorbs every member served by
   the same Worker instance.
2. **The Cache API** (`caches.default`) - colo-local, shared across isolates,
   no operation limits and no per-write billing.
3. **Alpaca**, batched 100 symbols per request.

KV cannot do tier 2. A 20s TTL over ~200 symbols is roughly **234,000 writes a
day** against a free-tier ceiling of 1,000/day (and 1M/month on the paid plan).
KV also enforces a 60-second floor on `expirationTtl` and edge-caches reads for
at least that long, so a 20-second TTL is not expressible. KV keeps the job it
is good at: the nightly asset universe in `worker/market/universe.ts`, written
~55 times a day and read constantly.

A concurrent-fetch guard sits in front of tier 3, so twenty members arriving
together on a cold cache produce one upstream request rather than twenty. A
symbol nothing can price is negative-cached for 5 minutes, so one typo in a
portfolio does not poll Alpaca every 20 seconds for the rest of the season.

Both providers live behind the interfaces in `worker/market/provider.ts`
so switching to a paid feed later is a one-file change.

---

## Auth

Supabase signs session tokens with **ES256** on this project, not the legacy
HS256 shared secret. The public keys are published at
`/auth/v1/.well-known/jwks.json` and the token names its signer via `kid`.
`worker/lib/jwt.ts` verifies against JWKS (cached 10 min, refetched on a kid
miss) and still accepts HS256 if a project is ever migrated back. Pinning the
algorithm from a known set is what blocks `alg: none` and algorithm confusion.
Covered by `worker/lib/jwt.test.ts`.

Signup is server-side only: the Worker checks the invite code, calls
`createUser({ email_confirm: true })` so no mail is ever sent, then runs the
`bootstrap_member()` RPC which creates the profile and the funded portfolio in
one transaction. If that RPC fails the auth user is deleted, because a member
who can sign in but has no portfolio is worse than no member. The first account
ever created becomes admin, serialised by an advisory lock.

**The invite code lives in the database, not the environment.** `CLUB_INVITE_CODE`
is only the *seed*: it is what signup accepts until a code has ever been set in
`club_settings`, which is what lets the first officer create the account that
can then set one. After that the stored code is the only one that works —
`worker/lib/club.ts` does not fall back, because a fallback that kept honouring
the old code is not a rotation, it is a second door. A code reaching a group
chat is a Tuesday, not an incident, and rotating it must not need a deploy.

The project has email confirmation **on** in the dashboard
(`mailer_autoconfirm: false`) and it does not matter: that setting governs the
public signup endpoint, which this app never calls.

## Domain model

### Asset class is derived from the symbol, never stored

There is no `asset_class` column, and adding one would be a mistake. One pure
total function in `worker/market/symbols.ts` classifies anything:

```
contains "/"                           -> CRYPTO    BTC/USD
^[A-Z][A-Z0-9]{0,5}d{6}[CP]d{8}$      -> OPTION    AAPL260116C00150000
otherwise                              -> EQUITY    AAPL, BRK.B
```

Collision is impossible rather than merely unlikely: Alpaca writes class shares
with a dot (`BRK.B`) and never a slash, and the OCC tail is fifteen fixed
characters that no listed ticker has. That is what buys a new asset class with no
backfill, no change to `unique (portfolio_id, symbol)`, and no replay drift.

**Parse an OCC symbol from the right.** Alpaca does not space-pad the root to six
characters the way raw OCC does, so a fixed offset reads the wrong bytes on
anything but a four-letter root. `parseContract()` slices fifteen from the end,
validates the date by UTC round-trip (so February 31st is rejected rather than
rolled forward to March), and decodes the strike as thousandths.

`src/lib/symbols.ts` mirrors this for the browser — the same one-directional
mirror the client keeps of the order engine, with the Worker as the authority.
`symbols.test.ts` reads the mirror as text and fails the build if the three
regexes, the fifteen-character tail, the contract size or the long-only rule have
drifted between the two copies.

### The multiplier is one column, and it defaults to 1

An option contract is 100 shares. There is no seam to add that behind — eleven
places computed money as a bare `qty * price`, in SQL and TypeScript — so
`positions`, `trades` and `pending_orders` each carry
`multiplier numeric(20,6) not null default 1`. Every pre-existing row is correct
at 1, so the equity path is byte-identical after migration 0006. Every valuation
is `qty * multiplier * price`.

**Storing the premium pre-multiplied was rejected on purpose.** It needs no column
and no SQL change, and it makes the blotter print 525.00 for a contract the chain
one panel away prints at 5.25. Two screens disagreeing about the same number is
the failure this codebase is written to prevent. `price` means the same thing on
every row; the multiplier is carried beside it. `avg_cost` stays the premium per
share and `qty` is contracts.

The site that bites if missed is `rebuild_portfolio()`, which rewrites
`notional` on every trade during an officer's replay. Miss the multiplier there
and the first void silently divides every option fill's notional by 100, forever.
`migrations.test.ts` asserts it.

**The route reads the real multiplier from Alpaca, not from the constant.** A
contract adjusted by a split can be 1000 shares. `multiplierFor()` answers 100
and is right almost always; `lookupContract()` is what makes it right always.

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

`BUY`, `SELL`, `SHORT`, `COVER`, and `EXPIRE` — which is not an order side but
a trade side, written only by the settlement job. Quantity may be entered as
fractional shares (6 dp) or as a dollar notional, which the Worker converts at
the price it fetched, divided by the contract size so a $300 order for a $5.25
option buys 0 contracts rather than 57.

**Only equities have a short side.** `SHORT` and `COVER` on a coin or a contract
are refused in `engine.ts` with a sentence and in `place_order()` with `FC003`.
Crypto has no borrow and no locate to model. A naked short call is worse: the
flat 1.5x Reg T multiplier would hold about $3 against a $2 premium carrying
unlimited risk, so refusing is correct rather than merely cautious — the same
call this codebase already made about forced liquidation. Long options need no
margin model at all: a long contract is fully paid for, exactly like a stock, so
the existing buying-power arithmetic is already right once the multiplier is in.

**Crypto trades genuinely 24/7**, so `tradingWindow()` takes the symbol and
returns `null` for a pair always. Its working orders are GTC only: `DAY` needs a
close and there is not one, and a market crypto order fills immediately anyway,
so the only crypto order that ever rests is a GTC limit.

### Five order types, and the one sentence that defines three of them

`MARKET`, `LIMIT`, `STOP`, `STOP_LIMIT`, `TRAILING_STOP`. The last three arrived
with migration 0007 and they all rest on one line:

```
a LIMIT buys cheaper than the market and sells dearer.
a STOP  buys dearer  than the market and sells cheaper.
```

So a stop is the mirror of a limit, and the trigger direction is the limit
direction inverted. BUY and COVER are marketable on a limit when the price falls
to it, and trigger a stop when the price *rises* to it; SELL and SHORT are the
other way round. `stopFiresOnRise()` is the single definition, mirrored in
`src/lib/api.ts` for the ticket. Getting it backwards produces an order that
looks entirely reasonable and fires at exactly the wrong moment — a stop-loss
that sells into a rally — so `stops.test.ts` enumerates all eight
side-by-direction combinations rather than sampling them.

**A triggered stop does not fill at its stop price.** It becomes a market order,
or for `STOP_LIMIT` a limit order, and fills wherever the market is — which on a
gap is nowhere near the stop. That is why a stop-loss is not a guarantee, and
the ticket says so in as many words under the field, because it is the single
most expensive surprise in retail trading and much better met here.

**A stop on the wrong side of the market is refused, not fired instantly.** A
sell stop above the market would trigger on the next tick, which means the
member meant a market order. `checkStopPlacement()` says so with the price in
the sentence. This is a Worker check, not a SQL one: Postgres has no price feed,
the same split `place_order()` already lives with for its marks.

**A stop is always queued, never filled on the way in.** Its trigger is on the
far side of the market by construction, so `POST /api/orders` sends every stop
to `pending_orders` and the sweep decides. The ticket reads "QUEUE" the moment a
stop type is picked, which is the honest label.

**A stop is entered in shares.** There is no price to convert a dollar amount at
until the trigger fires, and the conversion runs the wrong way — the cheaper the
fill, the more shares "$500 of NVDA" turns out to be. Same reason a working
close is in shares, one step earlier in the order's life.

**Reservations follow the trigger, not the last price.** A BUY stop sits *above*
the market, so reserving against the last price understates the cost by the
whole distance to it — the member queues an order they cannot pay for and finds
out on the day it finally fires. A STOP_LIMIT buy is capped by its limit like
any other limit: the stop decides *when*, the limit still caps *what*.

**Trailing stops ratchet, and only in the member's favour.** `trail_anchor` is
the best price the market has offered since placement — the highest for a
SELL/SHORT trail, the lowest for a BUY/COVER one — and the stop is re-derived
from it every sweep. The move is `trail_pending_order()` rather than an UPDATE
in the Worker, because saying "greatest"/"least" inside one locked statement is
what stops a concurrent sweep walking the stop backwards and firing it early.
The sweep trails *before* it tests the trigger; the other order would evaluate
today's price against yesterday's stop and fire one tick late, every time.

**Firing is recorded, not re-derived.** `triggered_at` is stamped once. Without
it a STOP_LIMIT would un-fire when the price crossed back over its trigger,
turning a one-way event into something that flickers between two states and
fills on whichever tick the sweep happened to land on.

### Expiry is cash settlement, and it is a fifth side

An option that never expires is not an option. On its expiration date, after the
close, a long contract settles at intrinsic value against the underlying's
official daily close: `max(0, close - strike)` for a call, `max(0, strike - close)`
for a put. `trades.side` gains `'EXPIRE'` and the price check becomes
`price > 0 or side = 'EXPIRE'` — a worthless option settles at exactly zero, and
rounding that up to a cent to satisfy a constraint would be a lie in the ledger.
`EXPIRE` is its own side rather than a `SELL` because expiry is not a sale, and
the blotter should say which one happened.

**Settled for cash, never exercised into shares.** Auto-exercising an ITM call
needs $15,000 for 100 AAPL and can simply fail, leaving a member holding a dead
contract because their cash was short — which teaches nothing except that the
software broke. Cash settlement always succeeds and produces the same P/L, which
is the whole lesson. The cost is that this club cannot demonstrate assignment;
that is the right cut for a paper season.

**A missing underlying close settles nothing.** The alternative is settling at
zero, which deletes an in-the-money contract and credits nothing, overnight, in a
blotter row indistinguishable from an honest expiry. Those positions are left
alone and reported, and the caller declines to snapshot on top of them.

### Tables

```
profiles             id -> auth.users, display_name, role ('member'|'admin')
seasons              id, name, starting_cash, starts_at, ends_at, is_active,
                     trading_locked
portfolios           id, season_id, user_id, cash, starting_cash
                                                         UNIQUE(season_id, user_id)
club_settings        singleton: invite_code, updated_at, updated_by
positions            id, portfolio_id, symbol, qty (SIGNED), avg_cost,
                     multiplier (1, or 100 for a contract)
                                                         UNIQUE(portfolio_id, symbol)
trades               id, portfolio_id, symbol, side, qty, price, notional,
                     realized_pnl, multiplier, executed_at
                     side in (BUY, SELL, SHORT, COVER, EXPIRE)
securities           symbol PK, name, sector, industry, asset_type, logo_url,
                     fetched_at
portfolio_snapshots  portfolio_id, as_of DATE, equity, cash, long_mv, short_mv
                                                         UNIQUE(portfolio_id, as_of)
benchmark_snapshots  symbol, as_of DATE, close           PK(symbol, as_of)
```

Members can read every portfolio, position, and trade in the active season -
seeing each other's picks is a feature for a learning club, not a leak. The two
exceptions are `pending_orders`, which is intent rather than history, and
`club_settings`, which holds the key to the front door.

### The return baseline is per portfolio, not per season

`portfolios.starting_cash` is stamped at signup and is the denominator of that
member's total return. `seasons.starting_cash` is only the default a *new*
member is funded with.

They were the same number until an officer could edit one. The moment the admin
console can raise the starting cash for people joining in March, a season-level
baseline silently rewrites the return of everyone who joined in January - and
the leaderboard is exactly the screen that puts those numbers next to each
other. Migration 0005 splits them; `rebuild_portfolio()` and the equity-curve
replay both start from the portfolio's own figure, and `migrations.test.ts`
fails the build if either goes back to reading the season's.

---

## Trading engine

An order is executed in exactly one place: the `place_order()` function in
`supabase/migrations/0002_trading.sql`. It opens by taking
`SELECT ... FOR UPDATE` on the portfolio row and does the arithmetic and the
writes inside that lock, which is the whole answer to two tabs pressing BUY at
once — the second one blocks until the first commits and then reads the balance
it left. Nothing else may write `portfolios.cash`.

### The rules live in two languages, on purpose

`worker/orders/engine.ts` states the same rules in TypeScript. It exists because
`npm test` has no database, and because the route can then reject an order with
a sentence about the member's own position rather than a Postgres error. The
duplication is one-directional and pinned:

- The SQL is the authority. Where the two disagree, the member sees the SQL's
  message, because that is the one that ran under the lock.
- `engine.test.ts` reads the migration and fails the build if the Reg T
  multiplier, the SQLSTATE list, the row lock, or the opening-sides-only
  buying-power check have drifted.

### Decisions worth not relitigating

**No accidental flips.** A BUY on a short is rejected, not netted through zero,
and the message names COVER. Same for the other three crossings. A member who
typed the wrong verb learns the right one; a member who slipped does not wake up
long.

**Only BUY and SHORT are ever refused for buying power.** A SELL adds cash and
releases no margin; a COVER pays out its notional but releases 1.5x that in
margin, netting +0.5x. So the closing sides can only improve buying power, and
refusing them would trap a member inside the position they are trying to escape.
There is no forced liquidation in v1, so the exit has to stay open — including
where covering drives cash negative, which shows as a margin-call banner rather
than a block.

**Postgres has no price feed, so the Worker passes marks in.** `p_marks` carries
`symbol -> price` for every position the member holds, fetched from the same
quote cache the dashboard polls. Without it a short would be margined at what it
was sold for, understating the requirement on exactly the position that has moved
against the member. A symbol missing from the map falls back to its average cost.

**Dollar amounts round down, never up.** A $500 order must never cost $500.01.
Same for a whole-share-only symbol, where less than one share is a rejection
rather than a silent zero.

### Resting orders

**Nothing fills at a weekend.** US equities trade 09:30-16:00 ET on weekdays.
There is no Saturday session, no volume and no counterparty, so Friday's close
just sits there until Monday. A limit order placed on Sunday is not "waiting to
be matched" — it is a stored instruction, exactly like a queued market order,
and both come to life at Monday's open. This is the single most common thing to
get wrong about this feature; `worker/orders/sweep.ts` says it again at the top.

`POST /api/orders` therefore has two outcomes and one endpoint. If the market is
open and the order can trade now, it fills. Otherwise it is queued into
`pending_orders` and the sweep fills it later. A member must never be refused
for doing their thinking on a Sunday.

- **Reservations.** Queueing holds what the order will need — buying power in
  `reserved_cash`, shares in `reserved_qty` — so six buys against $10,000 are
  refused on Sunday rather than half-failing on Monday. Every exit from PENDING
  releases it (fill, cancel, expiry, rejection), and a table constraint enforces
  that a resolved row holds nothing, because a leaked reservation is invisible
  money the member can never spend again.
- **A market order in shares reserves 5% over the last price** — it has no cost
  until it fills and Monday need not open where Friday closed. A dollar amount
  or a limit price is its own cap and reserves exactly.
- **A working SELL or COVER must be entered in shares.** The dollar conversion
  runs the wrong way: the cheaper the fill, the more shares "$500 of NVDA" turns
  out to be, so there is no honest number to reserve. Immediate orders keep
  dollar entry, because there the price is known.
- **A limit fills at the market, not at the limit.** A buy limit at $105 against
  an open of $95 fills at $95. If it gaps to $110 it does not fill at all,
  however generous the limit looked on Sunday.
- **DAY expiry comes off the exchange calendar** (`clock.nextClose`), so an
  order placed Saturday dies at Monday's 16:00 rather than instantly.
- `pending_orders` is **the one table not readable across the club**. Everything
  else is deliberately open, but a resting order is intent, and publishing it
  invites the rest of the club to trade in front of it.

The sweep runs from the cron trigger **every minute of every day**, and gates
each order on its own asset class — a stock order at 3am on a Sunday stays
resting, a coin order fills. It was `"* 13-21 * * 1-5"` until crypto arrived,
which is a window that cannot contain a market that never closes.

A *second*, crypto-only cron was the obvious move and is wrong: it would overlap
the equity sweep, two sweeps could read the same PENDING row, and the loser's
`FC002` maps to a non-retryable code that would call `reject_pending_order()` on
an order that had just filled. One sweep, always. The idle cost stays at one
indexed query because the sweep selects pending orders *before* it fetches the
clock and returns early when there are none.

### Order flow

`POST /api/orders` takes `{symbol, side, qty}` or `{symbol, side, notional}` and
no price. Checks run cheapest-first: the market clock (a 30-second isolate cache
that refuses everything outside regular hours, and refuses a non-authoritative
estimate just as firmly — guessing the market is open on Thanksgiving is worse
than telling someone to retry), then the tradable universe, then the portfolio
and one batched quote request covering the traded symbol and every mark, then
pre-flight, then the RPC.

`place_order()` raises with a SQLSTATE per reason — `FC001` buying power,
`FC002` position too small, `FC003` wrong side, `FC004` trading locked, `FC005`
no portfolio, `FC006` malformed — which `worker/routes/orders.ts` maps to the
same codes and statuses its own pre-flight uses, so the client handles one set.

### Applying the migration

Migrations are applied by hand in the Supabase SQL editor. There is no migration
runner wired up and no direct Postgres connection string in the environment, so
"apply the migration" means pasting the file in and pressing Run.

Applied so far: `0001_init.sql`, `0002_trading.sql`, `0003_resting_orders.sql`,
`0004_analytics.sql`, `0005_admin.sql` (all 2026-08-30).

`0006_derivatives.sql` was applied 2026-09-02 and verified: the three
`multiplier` columns are present and default to 1, `place_order`, `queue_order`
and `settle_option_expiry` each resolve with `p_multiplier` and have exactly one
overload, every function is `prosecdef`, EXECUTE is false for `anon` and
`authenticated` (anon gets 42501 on a payload service_role gets past), and
`trades_side_allowed` carries `EXPIRE` with `price > 0 or side = 'EXPIRE'`.

`0007_stop_orders.sql` was applied 2026-09-02 and verified: `queue_order` has
exactly one overload and its identity arguments end
`p_multiplier, p_stop_price, p_trail_amount, p_trail_percent, p_trail_anchor`;
`trail_pending_order` and `trigger_pending_order` exist, are `prosecdef`, and
answer 42501 to `anon` on a payload `service_role` gets a cast error from; the
five trigger columns are on `pending_orders`; `pending_orders_type_allowed`
carries all five order types, and the limit/stop/trail constraints each bind to
exactly the types that own them.

*(The old note follows, kept because the two migrations share every hazard.)*

**`0006_derivatives.sql` was written and applied as described above.** Until it is,
`/api/portfolio` answers 500 — `loadPortfolio()` selects `positions.multiplier`
on every read — and F2, F1 and the leaderboard are all dark. Same deliberate hard
cutover as 0005: a permanent fallback to "assume 1" would be the exact bug the
column exists to prevent, kept alive forever in a code path nobody reads. It
trips the destructive-operations warning, because `place_order()` and
`queue_order()` gain a parameter and are dropped and recreated rather than
overloaded — a defaulted extra argument would make every call ambiguous, which is
what 0003 already documents. Verify against `pg_proc` afterwards rather than
trusting "Success. No rows returned": `place_order` has `p_multiplier`, all four
functions are `prosecdef`, and EXECUTE is false for `anon` and `authenticated`
(a dropped function comes back with PUBLIC EXECUTE, so 0006 re-revokes every
signature explicitly).

Every one is re-runnable — `create or replace`,
`create ... if not exists`, `drop ... if exists` followed by a create, or a
guarded insert — so pasting one again is safe if you are ever unsure. Postgres
runs a multi-statement script as a single implicit transaction, so a migration
that fails partway leaves nothing behind.

Phase 7 adds no migration. `portfolio_snapshots` and `benchmark_snapshots` have
been in `0001_init.sql` since the beginning, carrying exactly the unique
constraints the nightly upserts need, and the index the club average wants
arrived with `0004`. The cron had nothing left to ask the schema for.

`0005_admin.sql` adds `portfolios.starting_cash`, which `loadPortfolio()`
selects on every dashboard read, so `/api/portfolio`, `/api/leaderboard` and the
console all answer 500 until it is in. That is a hard cutover rather than a
graceful degrade on purpose: a permanent fallback to `seasons.starting_cash`
would be the exact bug the column exists to prevent, kept alive forever in a
code path nobody reads. Signup is unaffected either way — `club_settings`
failing to exist falls back to the env seed, which is the same path a fresh
deploy takes.

Verified in the database after applying 0005: `portfolios.starting_cash` exists
and is `not null`, the `portfolios_starting_cash_positive` constraint is
present, `club_settings` exists, all seven admin functions (`create_season`,
`update_season`, `reset_season`, `set_member_role`, `rebuild_portfolio`,
`void_trade`, `amend_trade`) are there and `prosecdef` true, EXECUTE on every
one of them is false for both `anon` and `authenticated`, and
`bootstrap_member` is 0005's version rather than 0001's — its body references
`starting_cash`, which is what stamps the baseline at signup.

`club_settings` holds zero rows, which is correct and not a gap: signup accepts
the `CLUB_INVITE_CODE` env seed until an officer rotates the code for the first
time, and the stored code takes over permanently from that moment.

**Two things that will bite you in the SQL editor.** It runs whichever tab has
focus, not the one you were last looking at — check the editor contents before
pressing Run, and verify against `pg_proc` afterwards rather than trusting
"Success. No rows returned", which is what a script you did not mean to run also
says. And `0003` trips the "destructive operations" warning, because
`place_order` gains a parameter and a defaulted extra argument would make every
call ambiguous, so the old signature is dropped and recreated.

Verified in the database after applying 0002: `reg_t_margin_multiplier()` returns
1.5, `fmt_qty(15)` returns `15` rather than `15.` (to_char's `FM` leaves a
trailing point behind, which is what the rtrim is for), and `place_order()` is
`security definer` with EXECUTE revoked from both `anon` and `authenticated` —
only `service_role` can call it, which is rule 2 holding at the database level.

Verified after applying 0004: exactly one `club_equity_curve` row in `pg_proc`
(so no stale overload), identity arguments `p_season_id uuid, p_start date`,
returning `TABLE(as_of date, avg_equity numeric, members integer)`, `prosecdef`
true, `provolatile` `s`, `proconfig` `search_path=public`, the
`portfolio_snapshots_as_of_idx` index present, and EXECUTE true for
`service_role` and false for both `anon` and `authenticated`.

---

## Analytics

### The equity curve is reconstructed, not just read

The plan said the curve comes from `portfolio_snapshots`. Those are written by
the nightly cron, which means that on the day Phase 5 landed there were none,
and a chart that shows nothing for a week is not a feature. So the curve is
**replayed**: walk the blotter forward, and value the resulting book at every
session's official close from Alpaca's daily bars. Both inputs already exist, so
the past is recoverable exactly.

Snapshots still win wherever they exist. They were computed at the close against
marks that were real at the time, and a replay cannot improve on that — a
delisted symbol has no bars left to replay but its snapshot is still true. The
route merges the two and reports which it used (`source`), and the panel says so
under the chart, because a replayed curve and a stored one look identical on
screen and are not the same claim.

`worker/analytics/curve.ts` holds the arithmetic and does no I/O, so
`curve.test.ts` pins all of it with no database and no network. The cases that
actually go wrong are the ones under test: a short drawn upside down, a halted
ticker read as worthless instead of carried forward, a position bought this
morning valued at zero because it has no close yet, and a benchmark indexed off
the wrong day.

**SPY's bar dates are the exchange calendar.** The x-axis is taken from them
rather than from a weekday count, which is what keeps Thanksgiving off the
chart. Today is appended only when today is genuinely a trading day — a curve
drawn on a Saturday ends on Friday, because that is when the account last had a
value that meant anything — and when it is, its final point is overwritten with
a live mark from the quote cache rather than a partial bar.

**Everything is in dollars, on the member's own scale.** The account is drawn as
it is, and SPY, QQQ and the club average are each drawn as what the *same money*
would have been worth had it gone there instead — `scaleTo()` rescales the line
without reshaping it, so a benchmark's percentage move on this chart is the same
number the leaderboard prints. That is the comparison a member can act on: not
"how did the index do" but "would I have been better off in the index", and in
dollars the answer is the vertical gap, readable by looking.

An index axis reading 98 / 100 / 104 was the earlier answer and it was a worse
one. It made the member do arithmetic to find out what they own, and it put the
one figure they came to the screen for — the money — nowhere on the chart.

**The baseline is the range start, not the season start.** A member switching to
1W is asking how this week went against the market; a chart still measuring from
January answers a different question. The panel states which date the lines
start from, because a rescaled chart with an unstated baseline cannot be
checked. Ranges are clamped to the season start, so a club that began in March
has no year behind it. There is no YTD tab: for a season that starts in the
autumn it is a second, worse spelling of ALL for most of the year, and `1Y` is
the tab a member actually reaches for. `parseRange()` still answers a stale
`?range=YTD` with ALL rather than a 500.

Unlike `/api/portfolio`, this endpoint *is* priced, and that is not a
contradiction of the split described above. The positions grid re-values on the
20-second quote poll and would re-read the database for nothing. A curve is a
day's worth of history that changes once a session, so it is assembled
server-side where the bars are already cached and the club average is one
aggregate rather than 25,000 rows over the wire. The client polls it every five
minutes — every minute on 1D, which is the one range whose newest point is
still being written.

### 1D is a different chart behind the same URL

Every other range is one point per session. 1D is one session at five-minute
resolution, and `buildHistory()` routes it to a separate builder that shares the
blotter, the snapshots and the shape of the answer with the session path, and
nothing else. Three things carry it:

**The session is discovered, not calculated.** Whichever session SPY last
printed intraday bars for is the session drawn. That is a weekend, a holiday, a
half day and a member opening the terminal at 7am all handled by one line of
code, with no calendar existing anywhere — the same trick the session axis plays
one resolution up. Before the opening bell the chart shows yesterday, which is
what every broker does and what a member means by "how did we do". The panel
names the session, because nothing else on screen would say so.

**The baseline is the previous close, not the open.** A day's change is measured
from where the account finished yesterday, so it can be down on the day while up
since the bell. That is the same number the positions grid prints as day P/L,
and the two must not disagree. The benchmarks are anchored the same way — on
their previous close rather than their first print — because on most days the
overnight gap is most of the move, and anchoring on the open would hide it.
A stored snapshot for the previous session wins over the replay for the baseline,
for the same reason it wins on the session chart.

**The axis is regular hours, and the calendar says where those are.** Alpaca's
five-minute bars run the full 04:00-20:00 extended day. Drawing them would
stretch a six-and-a-half-hour chart to sixteen and give its most prominent moves
to the thinnest prints of the day — and it would make this the one screen
treating pre-market as open, when `quoteFromSnapshot` ignores extended prints and
an order placed then is refused. So the buckets are filtered to the session the
exchange actually held, taken from `/v2/calendar` (cached an hour, since every
row but today's is settled history). That is also what ends the line at 13:00 on
the Friday after Thanksgiving rather than drawing three flat hours past the
close. Calendar unreachable falls back to 09:30-16:00: right on every day of the
year but those three.

**The club average has no intraday line**, because it is a nightly aggregate over
`portfolio_snapshots`. It is dimmed in the legend with the reason on hover
rather than dropped, since a legend that loses an entry between two range tabs
reads as a bug.

The right edge of every line is one instant: the account's last point takes a
live mark from the quote cache, and so do SPY and QQQ, because otherwise the
gap between the lines — the one thing the chart exists to show — would drift
every time a bar rolled over. `worker/market/intraday.ts` caches the bars in the
same two tiers as quotes and daily bars, for 60 seconds, keyed **per symbol** —
which is the whole reason a hundred members polling a 1D chart every minute is
two or three upstream requests rather than a hundred.

`intraday.test.ts` pins the part with the silent failure modes: a chart that
quietly draws Friday on a Tuesday looks exactly like one that draws Tuesday, and
so does one anchored on this morning's open instead of last night's close.

### The nightly snapshot writes closes, not quotes

`worker/analytics/snapshot.ts` runs at 22:15 UTC on weekdays and writes one
`portfolio_snapshots` row per portfolio plus the day's SPY and QQQ closes. Given
that the curve already replays, the reason to store anything is threefold: a
replay decays (a delisted ticker eventually has no bars left), a snapshot reads
the *positions table* rather than deriving the book from fills, and
`club_equity_curve()` has nothing to average until these rows exist.

**It prices the club at daily bar closes, never at the quote cache.** The job
runs after the bell, when `latestTrade` is a thin after-hours IEX print. More
decisively, `history.ts` *merges* snapshots into a replay that is valued at bar
closes — so a snapshot priced any other way would put a visible step in the
curve on exactly the days it was supposed to improve. `snapshot.test.ts` pins
the two against each other on the same session.

**A missed night is not backfilled.** Reconstructing Tuesday on Wednesday means
replaying Tuesday, and `mergeSnapshots()` prefers a snapshot to a replay
precisely because it was computed at the close against marks that were real. A
replay wearing a snapshot's clothes would quietly retire that guarantee, and the
replay already covers the gap. The job writes today or it writes nothing.

**The trading-day gate is a SPY bar dated today** — the same fact the chart's
x-axis is built from. Holidays and weekends fail it without a holiday list
existing anywhere. Everything is upserted on `(portfolio_id, as_of)` and
`(symbol, as_of)`, so `POST /api/portfolio/snapshot` is safe for an officer to
press twice, which is how the deploy is verified.

`benchmark_snapshots` is the one durable copy of the ruler. It is backfilled to
the season start when a season is created — a season may begin in the past — and
`history.ts` falls back to it for SPY and QQQ when Alpaca's bars are
unreachable, which also restores the x-axis. A chart with the benchmark on it
and a short account line beats an empty panel.

The cron expressions live in two files that must agree, and a mismatch is
silent: the trigger still fires, the handler matches no branch, and the job
simply stops. `worker/schedule.test.ts` fails the build when `wrangler.jsonc`
and `worker/index.ts` disagree in either direction.

### Expiry runs before the snapshot, and a failure cancels it

`worker/orders/expiry.ts` settles every contract expiring today, and
`worker/index.ts` chains it *ahead of* `snapshotSeason()` inside one
`waitUntil` rather than dispatching the two independently. That ordering is the
one load-bearing thing in the scheduler: `mergeSnapshots()` prefers a stored
snapshot to a replay forever, so a snapshot taken over a half-settled book is a
wrong number that never washes out — and two independent promises would race, the
snapshot winning about half the time.

If anything failed to settle — an underlying with no close today, or an RPC that
refused — the night is skipped entirely and the replay covers it, which is the
same rule `snapshot.ts` already applies to a bar failure. `expiry.test.ts` reads
`index.ts` and fails the build if the two are dispatched independently again.

The money is moved by `settle_option_expiry()`, which takes the same
`SELECT ... FOR UPDATE` on the portfolio that `place_order()` does, writes the
`EXPIRE` trade, deletes the position, and rejects any resting order left on that
symbol — a leaked reservation on a contract that no longer exists is invisible
money the member can never spend again.

### Sector exposure is gross, not net

`src/lib/sectors.ts` folds positions, quotes and the `securities` table into
buckets in the browser — three things the dashboard already holds, so no
endpoint exists and none should. It ticks with the prices.

Exposure is measured **gross**: a short counts by its absolute value rather than
against the longs. A member $10k long energy and $10k short energy is not
un-exposed to energy — they have two positions that can both go wrong, and a
netted bar of zero would say the opposite. The net is shown in its own column,
uncoloured, because net-short is a direction and not a loss.

The bar is drawn against the whole portfolio rather than rescaled to the largest
sector, so a diversified book draws short bars, which is the correct picture. It
is split amber/red for long/short, and the 40% concentration line is a hairline
on the track itself so crossing it is something the eye catches rather than
something you compute. Nothing is blocked at 40% and nothing should be —
watching a concentrated bet play out is most of what a paper season teaches.

### The map is the screen, and the grid is the authority

The bars were the whole screen once, and a screen that draws five rows in a
viewport built for twenty is not finished. F4 now asks its question at four
resolutions: the **exposure map** (shape), the **concentration rail** (seven
figures), the **sector grid** (the numeric authority), and the **holdings
drill-down** (one level finer than a sector). Everything is still folded in the
browser from positions, quotes and `securities`, so there is still no endpoint
behind this screen and none should appear.

**The map is sized by exposure and coloured by the day.** Nobody reads
"42 / 18 / 11 / 10 / 8" and *sees* a concentrated book; area is read without
arithmetic, which is the only reason this is a map and not a fourth table.
`src/lib/treemap.ts` is a squarified treemap (Bruls/Huizing/van Wijk) — pure
geometry, callers pass pixels, because laying out on a unit square and
positioning in percentages stretches every tile by the panel's aspect ratio.
Slice-and-dice through nested flexbox needs no measurement and no arithmetic,
and on a realistic long tail its worst aspect ratio is 150 against squarify's
2.3: a barcode, not a map.

**Colour is `dayPnl / |marketValue|`, never the price's day change.** A short is
a negative `qty`, so `dayPnl` already flips when the price falls and one formula
stays right in both directions. Colouring by the price's own move would paint a
winning short red, on the one screen a member visits to understand risk.
`positionDayReturn()` in `src/lib/sectors.ts` is the single definition, shared
by the tiles and by the drill-down's Day % column, because the two are on screen
together. It returns `null` — a neutral tile and a `—` — when there is no
previous close, which is a different thing from a flat day.

**Cash is a tile.** It is not exposure and is deliberately absent from
`sectorBreakdown`, but a member who is 60% cash and sees a full map concludes
they are fully invested. It sits in neutral panel grey, so it reads as the
absence of a bet rather than a flat one.

**A contract is named the same way on all four panels.** The map's tiles, the
concentration rail and the drill-down all print `formatContract` — the same
"AAPL 16JAN26 150C" F1's grid and the blotter print — and keep the stored OCC
symbol in the tooltip, because that is what the API takes and what settles the
money. F4 used to print the raw `AAPL260116C00150000` on all three, next to an
F1 the member had just come from, and two screens disagreeing about what one
holding is called is the same failure as two screens disagreeing about a
number.

The map is the one place the name may not fit, and it does not truncate.
"AAPL 16JAN26 150C" is four times the width of "AAPL", so a fixed 38px gate
tuned for a ticker draws "AAPL 1…" — not a shorter name but a *different and
wrong* one, since the strike is what got cut. The gate is measured from the
label that will actually be painted, and a tile too narrow for it falls back to
what the map already does with every small tile: colour, area and a tooltip,
with the drill-down below as the authority. The day figure was implicitly
gated on the symbol fitting — 52px of figure is wider than 38px of ticker — so
that is now stated, or a tile could draw a bare percentage belonging to nothing.

`loadPortfolio` already sets a contract's `name` to its formatted symbol, since
"Apple Inc." is the underlying's name and not the contract's, so the
concentration rail appends the name only when it says something the symbol did
not.

**Effective bets** is the inverse Herfindahl over the sector weights,
`1 / Σ(wᵢ²)`. Six sectors with one of them at 80% is not six bets, and this is
the figure that says so. The panel prints what an even split would read, because
the number means nothing without its own baseline.

**Clicking a sector selects it; it no longer opens the ticket.** It filters the
drill-down and dims the rest of the map. The old behaviour jumped to the ticket
on the sector's *largest* holding, which was a guess about which symbol the
member meant — the drill-down lets them pick it, and its `industry` column
(free from `securities`, and rendered nowhere else in the app) is what tells six
semiconductor names apart from a diversified technology sleeve.

**The layout has two height regimes and needs both.** At `xl` the page height is
definite, because a column flex container with `height: auto` sizes a `flex-1`
child to its *max-content* — so the concentration rail's metrics would otherwise
set the height of every other panel and the page would run to twice the
viewport. `min-h-0` does not help; that is a minimum, and this is max-content
sizing. Below `xl` the columns stack into four full-width panels, holding those
to the viewport would crush them, so the height goes back to a floor and
`<main>` scrolls.

---

## Leaderboard

### Ranked by return, and priced on the server

Everyone starts a season with the same cash, so NAV and return give the same
order - right up until an officer changes the starting cash or someone joins
mid-season. What the screen is asking is "who is trading well", so it ranks the
return, against each member's own baseline. A tie shares a rank and the next one
skips; inventing an order between two identical returns would be a number the
data does not contain.

`/api/leaderboard` is the one read that is priced server-side, and it is the
opposite call to `/api/portfolio` for the opposite reason. Valuing the club in
the browser would mean every member polling quotes for the *union* of everyone's
holdings - a couple of hundred symbols each - and computing equity a second time
outside `marketValues()`, which is how the leaderboard ends up disagreeing with
the positions grid. Server-side it is one batch off the warm quote cache and one
definition of equity. The payload does not depend on who asked, so it is
memoised per season for one quote interval: a hundred members refreshing
together share one database read, and the "you" highlight is applied in the
browser from the row's user id.

Clicking a member opens their book, which *is* unpriced - the browser already
values positions against quotes for the member's own grid, so the detail panel
reuses that rather than growing a second copy. Their resting orders are not in
it and must not be.

### The bar is the screen

Every member's return on one shared axis, with SPY drawn through it as a
hairline. A sorted column of percentages tells you your number and makes you
work out the rest; one axis shows the spread of the club and which side of the
market all of it is on at a glance. The colour rule holds: the bar is green or
red because it is a result, the benchmark is grey because it is the ruler, and
amber stays the interface.

## Admin console

Officer-only, and the role is read from the database on every request rather
than from the session token - a token minted before a demotion would keep
asserting `admin` for the rest of its hour. F6 is hidden from members rather
than shown and refused, which is presentation; `requireAdmin` is the permission.

Nothing in `worker/routes/admin.ts` does arithmetic on money. Every mutation is
one RPC into migration 0005, which takes the locks and knows what the change
implies.

### A correction is a replay, not a patch

Voiding a fill from the middle of a season is not a matter of handing the cash
back. Every later fill in that symbol was priced against an average cost the
voided one helped set, and every later realised P/L was booked against that
average. So `rebuild_portfolio()` deletes the positions, starts from the
portfolio's starting cash, and applies the surviving fills in order, rewriting
`realized_pnl` and `notional` as it goes. `void_trade()` and `amend_trade()` are
both that, with one row changed first.

It opens on the same `SELECT ... FOR UPDATE` on the portfolio that
`place_order()` takes, so a member's order cannot land halfway through their own
season being replayed. The arithmetic is deliberately duplicated rather than
shared - the live path must not depend on the correction path - and
`migrations.test.ts` fails the build if the two disagree about which way a side
moves cash.

**A replay can be impossible, and then nothing happens.** Voiding the BUY that a
later SELL sold out of would leave that SELL selling shares nobody owned, so it
raises `FC013` naming the fill to deal with first and the whole transaction
rolls back. Inventing a book that could not have happened would be worse.

### Arming, and what is not armed

A control that cannot be undone takes two deliberate presses and turns red in
between; a reset also demands the season's name typed out, because the only
confirmation worth anything is one the officer produces themselves. Everything
reversible - locking trading, promoting a member, renaming a season - is a
single click. Spending that signal on the safe controls would train an officer
to click through it.

Admin SQLSTATEs continue the order codes: `FC010` would leave the club with no
officer, `FC011` no such row, `FC012` malformed, `FC013` the replay cannot
produce a possible portfolio.

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
- Function-key top nav: `F1 POSITIONS / F2 TRADE / F3 LEADERBOARD / F4 RESEARCH /
  F5 SECTORS / F6 ADMIN`, with `LEGAL` at the far end of the same row, keyless.
  **A key means the same screen for everyone**; officers simply have one more.
  Numbering a screen differently per audience would make a printed keycap lie,
  and `SCREENS` keys are static literals matched against `event.key`, so the
  command bar's key lookup would answer differently per member too.
- Slash key focuses the command bar. Keyboard-first order entry.

**Order entry is two presses, not one.** Review Order, then Place Order, with
the order frozen on a panel in between — the way a real brokerage ticket works.
This reverses the original decision, which was that the readback *was* the
confirmation. That held while the ticket had two order types and one price
field; with five types, a stop price, a trail and a limit it no longer does, and
the readback label was still changing under the cursor at the moment of the
press. Any edit clears the review, so the panel can never describe an order
other than the one that will be placed.

**Keycaps are actions; underlines are modes.** BUY, MKT, GTC, SHRS are things
you do, and they are filled keycaps. The instrument selector on F2 and the
expiration rail on the chain are things you are *in*, and they are underlined
text. Phase 8 added two controls to one screen and they read as one new
vocabulary rather than two — spending a second visual idiom on the second
control would have been the expensive way to say the same thing.

**And plain dim text is a reference.** `LEGAL` rides the far end of the
function-key row with no keycap and no key, because it is neither an action nor
a mode — it is somewhere you look something up. There is deliberately **no
function key** for it — no F6 before Phase 10 and no F7 after: a function key
would rank the terms of use alongside the trade ticket, and the member who wants
them is never in a hurry. It costs no height, since the row was already there.

**The legal screen is the one screen that is a document.** `/legal/terms` and
`/legal/privacy` are two tabs of one panel and two real addresses — the one
thing here anybody pastes into a chat, so the link has to land on the document
it names. It renders signed *out* as well as in, because the terms have to be
readable before there is an account to agree to them with, and the sign-up
button links to both directly above it. That makes it the single path where
`App` does not fall through to `Login`, which is why `docs/SITEMAP.md` no longer
claims the app is auth-gated at every address.

Density loses one argument there and only there: a clause set at the grid's 1.35
leading across a full-width panel runs past two hundred characters and nobody
reads it, so the panel hugs a 68-character measure and the body is 13px on 1.7.
The privacy document answers in two grids — what is held about you and who else
touches it — because those are the only two questions anyone opens a privacy
policy with, and this app answers everything else in a grid already. Keep them
true: they name `profiles`, `pending_orders`, and the service providers by hand,
so a new table or service means editing that screen too.

**F2 gains exactly one control and no height.** `EQUITY · OPTION · CRYPTO` rides
the existing Ticker label row, so a member who never touches it sees the screen
they had. Everything else is the same ticket showing less: the field is TICKER,
UNDERLYING or PAIR, the sides that do not apply are disabled with the reason on
hover rather than removed (removing them would move the row under the cursor),
the unit keycap is SHRS, CTRS or UNIT, and crypto drops the DAY/GTC row
entirely because there is nothing to choose.

**The chain is a ladder, not a grid.** Calls left, puts right, strikes down the
middle, the two halves mirrored so bid and ask sit against the axis on both
sides. That is the vernacular every chain uses, and it exists because the
question is "at this strike, what do the two sides cost" — which a flat table
makes you scan for. The strike is amber because it is the axis and amber is
interface. In-the-money contracts are tinted `panel-hi` and **never** green or
red, which mean gain and loss on every other screen. A hairline labelled with the
underlying's price is drawn between the two strikes that bracket it, and the
ladder opens scrolled to it.

Load the `frontend-design` skill before building UI, and the `dataviz` skill
before writing any chart code. (`dataviz` is not installed on this machine —
`frontend-design` is. Charts follow the colour rule below in its place.)

**Colour on a chart.** The same rule as everywhere else, which is what stops a
chart looking like a different application. Amber is the interface and never a
number, so on the equity curve it marks the line that is *you* — identity, not
performance. Benchmarks are greys, because they are the ruler. Green and red
mean gain and loss and nothing else, which on that screen is the change figure
in the panel header, the excess-return strip, and the sector bars' short side —
never the account line itself, however the day went. No gradients, no fills, no
animated line draws: the tick flash is still the only motion in the app.

---

## The phone

Half the club reads this on a phone, and the terminal was drawn for a desktop.
The rule is that **the phone gets the same instrument showing less**, never a
second app: the density, the amber, the tabular figures, the panels and the
grid all survive, and what changes is the four things a 390px touch screen
genuinely cannot do the desktop way.

`md` (768px) is the line. Below it every screen is one column, the grids drop
their secondary columns, and the option chain loses a field per side.
`src/hooks/useMediaQuery.ts` holds that number once, so the CSS breakpoints and
the JS ones cannot drift into a width that is neither layout.

### A grid drops columns and then scrolls, in that order

`Column.hideOnMobile` removes a column from the render below `md` — removes,
not `display: none`, which still lays the column out and still renders every
row's value. What is left scrolls sideways inside its panel if it has to.

Both halves are needed. Scrolling alone leaves a member swiping past four
columns of context to reach the P/L they opened the screen for. Dropping alone
still overflows on a long ticker, and a page that scrolls horizontally takes
the status rail and the command bar off the screen with it.

**What gets marked is context, never the answer.** The name beside a ticker,
the sector beside a name, the average cost beside a live price — all of those
are restatements of something the row already carries or another screen asks
properly. F3 keeps `#`, the member, the bar and the return, because the bar
*is* the screen; F1 keeps the last price, the market value, the day and the
P/L. Sorting still reads the full column list, so a grid ordered by a column
the phone does not draw stays ordered by it.

There is no `minWidth` on the table and none is wanted: an auto-layout table
already refuses to render narrower than its own min-content, so the floor is
computed per grid from the headers and figures actually in it.

### The bug that is invisible on the machine it breaks on

A bare Tailwind `grid` has one implicit `auto` track, and an `auto` track is at
least its content's min-content width. So a panel holding an eleven-column
table made its track 511px wide inside a 360px screen, and the whole page
scrolled sideways under its own chrome. Every stacking layout grid therefore
carries an unprefixed **`grid-cols-1`** — `repeat(1, minmax(0, 1fr))`, where
the `0` is the entire point — and `Panel` carries **`min-w-0`** beside its
`min-h-0`, for the same reason and against the same trap in the other axis.

None of that is visible at 1440px, which is why `scripts/mobile-layout.test.ts`
asserts it as text rather than leaving it to a reviewer's eye.

### Four rules in `terminal.css`

- **The shell is sized in `dvh`.** `height: 100%` on a phone resolves against
  the *large* viewport — the one that assumes the address bar has already
  scrolled away — so a shell sized to it puts the command bar a bar's height
  below the fold, on a page that does not scroll.
- **Form fields are 16px below 768px.** iOS Safari zooms whenever a focused
  input's text is smaller than that, and it does not zoom back: tap a quantity
  field, and the buying-power line you were about to read is off-screen. This
  is the one place the app spends height on legibility rather than density.
  The rule sits outside Tailwind's cascade layers so a `text-lede` utility
  cannot silently lower a field back to 15px.
- **`--spacing-row` steps 28px → 36px under a coarse pointer.** One variable,
  so every grid, keycap and nav tab in the app grows together. A 28px row is a
  comfortable line of data and a poor target for a thumb.
- **`env()` insets on the two rails that touch the frame.** Zero on every
  device without a notch, exact on the ones that need them.

### What each screen gives up

- **The status rail** keeps the session dot and its label at every width, and
  sheds the ET clock, the display name and the app name in that order. A member
  about to be told "market closed" has to see it before they type, and that is
  as true at 390px as at 1440.
- **The function-key nav** drops the keycaps below `sm` and scrolls sideways. A
  function key is a promise about a keyboard, and a phone has none — `F1`
  printed on a tab there is decoration standing where the label should be.
  `LEGAL` only floats right from `sm` up, because `ml-auto` in a scroller
  either does nothing or strands the link past the last tab.
  Opening a screen from another link or resizing the phone brings its active
  tab into view by scrolling the rail, without moving the page underneath.
- **Research** keeps each article's source, age and tier under its title on a
  phone; filings keep their date under the document, and discussion keeps its
  age and comment link. Header metadata wraps, filters and report tabs have
  44px touch targets, and article links have a 36px minimum height. The symbol
  label stays accessible while giving the input more width. Research omits
  trading restrictions from autocomplete; a swipe scrolls suggestions and a
  completed tap selects one. Desktop columns and terminal styling stay intact.
- **The stat strip** becomes a two-column grid whose hairlines are a 1px gap
  over a line-coloured ground, since borders on a wrapping row leave the seams
  between rows unpainted and the ends of them doubled. NAV steps to 22px, and
  the two cells that restate something else — long/short, the position count —
  drop out.
- **The order ticket** stacks the quote under the ticker, shares the side rail
  equally between its four keys, and puts the review panel in one column. It
  also **prints the reason a side is disabled**, which on a desktop is a
  `title`: a greyed-out SHORT that explains itself is the whole argument for
  disabling it rather than rejecting later, and on a touch screen a tooltip
  never fires.
- **The option chain** shows bid, ask and the strike. Open interest goes first
  because it is the only figure there that is not a price; the last print goes
  next because on the indicative feed it lags OPRA by fifteen minutes and is
  the worst of the three. What survives answers "what does this cost".
- **`Panel`'s header clips.** It is one grid row tall and its meta slot is free
  text; F4's sector panel names its gross, its legend and SPY's day, which is
  three lines of content in 28px of room. Unclipped it wraps *over* the grid
  below it. Callers keep their meta on one line so that stays a truncation.

---

## Layout

```
worker/index.ts                 Hono app, SPA fallback, scheduled() handler
worker/market/provider.ts       swappable data-provider interfaces + shared types
worker/market/alpaca.ts         snapshots, bars, clock, assets
worker/market/finnhub.ts        profile2 -> sector
worker/market/sectors.ts        finnhubIndustry -> GICS-11 map, ETF bucket
worker/market/quotes.ts         three-tier quote cache + symbol validation
worker/market/clock.ts          cached market clock + calendar, falls back to session.ts
worker/market/session.ts        wall-clock session estimate (fallback only)
worker/market/universe.ts       nightly asset list in KV, sharded for autocomplete
worker/market/securities.ts     sector enrichment, persisted to `securities`
worker/market/bars.ts           cached daily bars, two tiers, for the curve
worker/market/intraday.ts       cached 5-minute bars, two tiers, for the 1D chart
worker/orders/engine.ts         order rules in TypeScript: pre-flight + tests
worker/orders/sweep.ts          fills resting orders; cron-driven, calendar-gated
worker/analytics/curve.ts       curve arithmetic: replay a season, replay a day, scale
worker/analytics/history.ts     assembles the curve from trades, bars, snapshots
worker/analytics/snapshot.ts    nightly portfolio + benchmark rows; cron-driven
worker/lib/portfolio.ts         active season + portfolio + positions, read side
worker/lib/leaderboard.ts       club ranking arithmetic: value, rank, summarise
worker/lib/club.ts              the invite code: read, rotate, generate, compare
worker/market/symbols.ts        the classifier: OCC parse/format, class, multiplier
worker/market/crypto.ts         Alpaca v1beta3 crypto: snapshots, bars, assets
worker/market/options.ts        Alpaca v1beta1 options: chain, contracts, bars
worker/market/router.ts         one PriceProvider over three classes, merged
worker/market/chain.ts          cached chain + contract lookup, two TTLs
worker/orders/expiry.ts         settles expiring contracts for cash; cron-driven
worker/orders/stops.test.ts     the eight stop directions, and the SQL ratchet
worker/market/research.ts       Phase 10: fan-out, merge, dedupe, two-tier cache
worker/market/gdelt.ts          Phase 10: global press. No credential
worker/market/edgar.ts          Phase 10: SEC filings + XBRL. No credential
worker/market/hackernews.ts     Phase 10: tech discussion. No credential
worker/routes/                  auth, quotes, market, orders, portfolio, leaderboard, admin,
                                research
supabase/migrations/*.sql       schema, RLS policies, place_order() RPC
scripts/check-client-env.ts     build-time guard on the two VITE_ values
scripts/mobile-layout.test.ts   the phone rules that are invisible on a desktop
src/lib/                        supabase client, API client, formatters, valuation
src/lib/sectors.ts              positions -> gross sector exposure, client-side
src/lib/symbols.ts              the classifier, mirrored for the browser
src/hooks/useChain.ts           one underlying's chain, 20s poll, debounced
src/hooks/useQuotes.ts          TanStack Query, 20s refetchInterval
src/hooks/usePortfolio.ts       holdings + blotter + the place-order mutation
src/hooks/useHistory.ts         the equity curve, 5-minute poll (60s on 1D), range in state
src/hooks/useLeaderboard.ts     the standings, 30s poll, plus one member's book
src/hooks/useAdmin.ts           the console's one read and every officer mutation
src/hooks/useMediaQuery.ts      one breakpoint, for the grids that drop columns
src/components/terminal/        Panel, DataGrid, StatStrip, OrderTicket, Blotter,
                                WorkingOrders, SymbolSearch, SectorBars, ReturnBar,
                                OptionChain, MemberBook, MemberRoster, Corrections,
                                AdminControls
src/components/charts/          EquityCurve panel + lazy-loaded CurvePlot
src/routes/                     Login, Positions, Trade, Leaderboard, Research, Sectors, Admin,
                                Legal
```

Recharts is the only heavy dependency in the bundle, so it is behind a
`React.lazy` boundary: `EquityCurve.tsx` (panel, toggles, legend) ships in the
main chunk and `CurvePlot.tsx` (everything that imports Recharts) does not. The
login screen and the order ticket never pay for a chart they do not draw —
worth about 110KB gzipped.

Worker modules import each other with an explicit `.ts` extension
(`allowImportingTsExtensions`), which is what lets `node --test` load them
directly with no build step or loader.

That no-build-step rule has one sharp edge: Node strips types, it does not
compile them, so a **constructor parameter property** anywhere in the import
graph makes every test that reaches it fail to load with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — including tests that only wanted a pure
function three files away. Declare the field and assign it in the body.
`PortfolioError` in `worker/lib/portfolio.ts` carries the note where someone
would otherwise tidy it back.

## API

```
GET  /api/health                      liveness + market session (no auth)
GET  /api/quotes?symbols=A,B          batched, cached prices
GET  /api/market/clock                open/closed, next open, next close
GET  /api/market/symbols?q=           ticker autocomplete
GET  /api/market/securities?symbols=  names and sectors
GET  /api/market/chain?underlying=&expiration=
                                      one underlying's expirations, and one of
                                      them priced. Front month by default
GET  /api/market/universe             asset-list size and last sync
POST /api/market/universe/sync        force a resync (admin only)
GET  /api/portfolio                   cash, positions, season. Deliberately unpriced
GET  /api/portfolio/history?range=    equity curve vs SPY, QQQ, club, in dollars.
                                      1D is one session at 5-minute resolution
POST /api/portfolio/snapshot          run tonight's snapshot now (admin only)
POST /api/orders                      place an order. No price field — see rule 3.
                                      orderType MARKET | LIMIT | STOP |
                                      STOP_LIMIT | TRAILING_STOP; a stop carries
                                      stopPrice, a trail carries trailAmount or
                                      trailPercent. Every stop is queued
GET  /api/orders                      trade blotter, newest first
GET  /api/orders/working              resting orders (owner-only)
DELETE /api/orders/working/:id        cancel, releasing the reservation
POST /api/orders/sweep                force a sweep (admin only)
GET  /api/research?symbol=            Phase 10. News, earnings, filings and
                                      discussion for one symbol. Five upstreams,
                                      one answer; `sources` and `missing` name
                                      who replied, so a thin feed says why
GET  /api/leaderboard                 the standings. Priced, and memoised per season
GET  /api/leaderboard/:portfolioId    one member's book, read-only and unpriced
```

Officers only, every one behind `requireAdmin`:

```
GET    /api/admin                     seasons, members, invite code, universe
POST   /api/admin/seasons             start a season, funding every member
PATCH  /api/admin/seasons/:id         rename, re-fund new joiners, lock trading
POST   /api/admin/seasons/:id/reset   wipe it back to the starting line
POST   /api/admin/invite              rotate the code. Old one dies immediately
POST   /api/admin/members/:id/role    promote or demote
GET    /api/admin/trades              the club's fills, filterable
DELETE /api/admin/trades/:id          void a fill, then replay the portfolio
PATCH  /api/admin/trades/:id          correct qty or price, then replay
```

## Commands

```
npm run dev        vite dev; the Cloudflare plugin runs the Worker inside
                   workerd, so the SPA and the API share one port
npm run build      typecheck + bundle -> dist/client and dist/<worker-name>
npm run deploy     build + wrangler deploy
npm run typecheck  tsc across the app, worker, and node configs
npm test           node --test over worker/**/*.test.ts and scripts/**/*.test.ts
```

**Windows prerequisite:** `workerd` is a native binary that needs the Microsoft
Visual C++ Redistributable. Without it `npm run dev` dies with a bare
`write EOF`, which reads like a config error and is not one. See `SETUP.md`
step 6. Build and deploy are unaffected.

## Phase status

- [x] **Phase 0** - repo hygiene, env scaffolding, credential checklist (`SETUP.md`)
- [x] **Phase 1** - scaffold + terminal design system
- [x] **Phase 2** - auth (invite-code signup, protected routes)
- [x] **Phase 3** - market data layer (Alpaca proxy, quote cache, sector enrichment)
- [x] **Phase 4** - trading engine (`place_order()` RPC, order ticket, blotter)
- [x] **Phase 5** - analytics (positions grid, sectors, equity curve vs benchmarks)
- [x] **Phase 6** - leaderboard + admin console (migration 0005 applied and verified)
- [x] **Phase 7 (code)** - nightly snapshot cron, benchmark backfill, forced-run
      endpoint. Adds **no migration**: `portfolio_snapshots` and
      `benchmark_snapshots` have existed since 0001 with the unique constraints
      the upserts land on.
- [ ] **Phase 7 (deploy)** - create the KV namespace, set the secrets,
      `npm run deploy`, then walk the checklist at the end of `DEPLOYMENT.md`.
- [x] **Phase 8a (code)** - crypto, and the plumbing both new classes share: the
      symbol classifier, the `multiplier` column, the routing provider, the
      24/7 sweep, and F2's instrument selector.
- [x] **Phase 8b (code)** - options: the chain endpoint and panel, OCC
      validation on the orders route, and cash settlement at expiry chained
      ahead of the nightly snapshot.
- [x] **Phase 9 (code)** - the order ticket a real brokerage has: stop,
      stop-limit and trailing-stop types, a Review/Place confirmation step, and
      the crypto minimum-order-size floor surfaced before the press rather than
      at the fill. Adds migration `0007_stop_orders.sql`.
- [x] **Phase 9 (deploy)** - `0007_stop_orders.sql` applied and verified
      2026-09-02.
- [x] **Phase 8 (deploy)** - `0006_derivatives.sql` applied and verified
      2026-09-02.
- [x] **Phase 10 (code)** - Research on F4: news, earnings, filings and
      discussion for any ticker, across six sources. **Adds no migration and no
      credential** - nothing is persisted, so there is no `0008_*.sql` to look
      for, and every source is either a key already in use or an open endpoint.
      The only setup is `SEC_CONTACT` in `wrangler.jsonc`, which is a var and
      not a secret. Build, 335 tests and Research render smoke checks pass.
- [ ] **Phase 10 (deploy)** - set a reachable `SEC_CONTACT`, verify SEC access
      with it, deploy, and walk `docs/PLAN.md` verification items 15–23.
      Finnhub earnings passed the live-key probe; GDELT returned 429 from local
      workerd. Browser visual verification and deployed egress remain unchecked.

## Reference docs

This file is the architecture document. `CLAUDE.md` and `AGENTS.md` in the repo
root are four-line pointers to it, kept so that it is still picked up
automatically; they are deliberately the only copy of nothing.

- `docs/PLAN.md` - full build plan, phase by phase
- `SETUP.md` - account + API key checklist
- `DEPLOYMENT.md` - Cloudflare connection. Build vars and runtime secrets live in
  two different dashboard stores; `VITE_*` must be build vars or the bundle ships
  with an undefined Supabase client.
- `PLANNING/PHASE-10-RESEARCH.md` - the Phase 10 build sheet: order of work, the
  two probes to run first, file-by-file breakdown, and the test list
