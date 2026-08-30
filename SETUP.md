# Setup — one-time account & key checklist

Everything below is **free**. Budget ~15 minutes. Work top to bottom; paste each
value into `.env` or `.dev.vars` as you go (both files already exist with empty
slots waiting).

> Rule of thumb: if a key goes in `.env` it is **public** and will be visible in
> the browser. If it goes in `.dev.vars` it is **secret** and must never be
> renamed to `VITE_*`.

---

## 1. Supabase — database + auth

1. Go to <https://supabase.com> → sign in with GitHub → **New project**.
2. Name it `finance-club`, pick the region closest to your school, and set a
   database password. **Save that password somewhere** — you cannot view it again.
3. Wait ~2 min for provisioning.
4. **Turn off email confirmation** (this is the whole reason signup stays simple):
   - **Authentication** → **Sign In / Providers** → **Email**
   - Toggle **Confirm email** → **OFF** → Save.
   - Members can now sign in the instant they register. No inbox, no magic link.
5. Collect three values:

   | Where | Value | Goes in |
   |---|---|---|
   | Project Settings → Data API → **Project URL** | `https://xxxx.supabase.co` | `.env` → `VITE_SUPABASE_URL` |
   | Project Settings → API Keys → **anon / public**<br>(newer projects call this **publishable**, `sb_publishable_…`) | long token | `.env` → `VITE_SUPABASE_ANON_KEY` |
   | Project Settings → API Keys → **service_role**<br>(newer projects call this **secret**, `sb_secret_…`) | long token | `.dev.vars` → `SUPABASE_SERVICE_ROLE_KEY` |
   | Project Settings → Data API → JWT Settings → **JWT Secret** | long string | `.dev.vars` → `SUPABASE_JWT_SECRET` |

   ⚠️ The **service_role** key bypasses every security rule in the database.
   It belongs only in `.dev.vars` and in `wrangler secret`. If it ever lands in
   the `src/` folder or in a `VITE_` variable, anyone can read and wipe the
   entire club's data. Treat it like a root password.

---

## 2. Alpaca — live prices, history, market clock

This is our main price feed. **You do not need a real brokerage account, any
identity verification, or any money** — a paper account is enough and takes two
minutes.

1. Go to <https://alpaca.markets> → **Sign up**.
2. After signing in, make sure the dashboard is toggled to **Paper Trading**
   (not Live). There is a switch in the sidebar.
3. Find **API Keys** → **Generate New Key**.
4. Copy both halves into `.dev.vars`:
   - `ALPACA_API_KEY_ID` — starts with `PK…`
   - `ALPACA_API_SECRET_KEY` — **shown exactly once**; if you lose it, regenerate.

**What the free plan gives us:** 200 requests/minute, batched quotes for 100+
tickers in a single call, free historical daily bars, and a market-open/closed
clock that already knows every holiday.

**The one limitation:** the live intraday tick comes from the IEX exchange only
(~2–3% of US volume), so on thinly traded stocks the last price can trail the
real tape slightly. Daily change, previous close, and all historical bars are
full consolidated market data even on the free plan, so the dashboard's headline
numbers are accurate. This is fine for a club simulation.

---

## 3. Finnhub — sector classification

Used for exactly one thing: turning a ticker into a sector so the breakdown chart
works. Called once per ticker, ever, then cached in the database forever.

1. Go to <https://finnhub.io/register> → sign up free.
2. Copy the API key from the dashboard into `.dev.vars` → `FINNHUB_API_KEY`.

Free tier is licensed for personal / non-commercial use. A school club qualifies —
just don't put ads on this or charge for it.

---

## 4. Cloudflare — hosting

1. Create an account at <https://dash.cloudflare.com/sign-up> (free plan is fine).
2. When you're ready to deploy, run `npx wrangler login` in this folder and
   approve in the browser.

Nothing to paste — Wrangler stores the credential itself.

---

## 5. Pick your invite code

Open `.dev.vars` and change `CLUB_INVITE_CODE` from `CHANGE-ME-BEFORE-LAUNCH` to
whatever you'll hand out at the first meeting, e.g. `BULLS-2026`. Anyone with the
site URL **and** this code can create an account; anyone without it cannot.

---

## 6. Windows: install the Visual C++ runtime

**Required on this machine — `npm run dev` cannot start without it.**

Cloudflare's local runtime is a native Windows binary called `workerd`, and it
needs Microsoft's C++ runtime libraries. That runtime is currently not installed
here, so `workerd.exe` fails to load with `STATUS_DLL_NOT_FOUND` and both
`vite dev` and `wrangler dev` stop with a bare `write EOF`.

Install it once, from an ordinary terminal:

```
winget install --id Microsoft.VCRedist.2015+.x64
```

Or download "Visual C++ Redistributable for Visual Studio 2015-2022 (x64)" from
<https://aka.ms/vs/17/release/vc_redist.x64.exe> and run it. Reboot if prompted.

Verify it worked:

```
node_modules\@cloudflare\workerd-windows-64\bin\workerd.exe --version
```

That should print a version string. If it prints nothing and exits, the runtime
still is not installed.

**This affects local development only.** `npm run build` works without it, and
so does the deployed site — Cloudflare runs the Worker on its own machines.

---

## Done?

`.env` should have 2 filled values, `.dev.vars` should have 6 filled values plus
the invite code. Then say the word and we'll start Phase 1 (scaffold + the
black/amber terminal design system).

Before deploying, each secret gets pushed separately:

```
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_JWT_SECRET
npx wrangler secret put ALPACA_API_KEY_ID
npx wrangler secret put ALPACA_API_SECRET_KEY
npx wrangler secret put FINNHUB_API_KEY
npx wrangler secret put CLUB_INVITE_CODE
```
