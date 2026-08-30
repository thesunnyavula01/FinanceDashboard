# Deploying to Cloudflare

## Before you deploy: create the KV namespace

`wrangler.jsonc` ships with a placeholder KV id, and **`wrangler deploy` will
fail until it is replaced.** Create the namespace once:

```
npx wrangler kv namespace create QUOTES
```

Paste the returned `id` over `PLACEHOLDER_RUN_WRANGLER_KV_NAMESPACE_CREATE_QUOTES`
in `wrangler.jsonc`. That namespace is the shared quote cache — it is what keeps
100 members refreshing every 20 seconds inside the free API rate limit.

The app builds and the SPA renders without it; only the Worker needs it, from
Phase 3 onward.

---

## The one thing that breaks this app

Cloudflare has **two completely separate variable stores**, and they are not
interchangeable:

| Store | Dashboard path | Available when | What goes here |
|---|---|---|---|
| **Build variables** | Settings → **Build** | Only while `npm run build` runs | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| **Runtime secrets** | Settings → **Variables & Secrets** | Only while the Worker serves a request | Alpaca keys, Finnhub key, service-role key, JWT secret, invite code |

Cloudflare's docs are explicit: **build variables are not accessible at runtime.**
The reverse is also true — runtime secrets are not visible during the build.

### Why this matters here

`.env` and `.dev.vars` are gitignored, so **neither file exists on Cloudflare's
build machine.** Vite bakes `VITE_*` values into the JavaScript bundle at build
time by reading the environment. If those two variables are not registered as
**build** variables, the bundle ships with `undefined` for the Supabase URL and
key, and every member sees a login page that silently fails to connect.

The failure is quiet — no build error, no red text. The site deploys "successfully"
and simply doesn't work. If you ever see that, this is the cause.

Equally: if you put the Alpaca or service-role keys into **Build** variables,
the Worker cannot read them at request time and every quote and order returns a
500.

> **Never** put a secret in the Build store hoping Vite will pick it up. Anything
> Vite can read ends up in the JavaScript bundle that every visitor downloads.
> Only the two `VITE_SUPABASE_*` values are safe there — they are protected by
> row-level security. The service-role key is not, and would hand any visitor
> full control of the club's database.

---

## Connecting the repository

Phase 1 is complete, so the repo now has everything Workers Builds needs: a
`package.json`, a `wrangler.jsonc`, and a build that produces `dist/client`.
Connecting now will succeed — the deployed site will render the terminal with
sample data until Phase 3 wires up live prices.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**
2. Authorize GitHub, pick `thesunnyavula01/FinanceDashboard`
3. Build settings:

   | Field | Value |
   |---|---|
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | *(leave blank)* |
   | Production branch | `main` |

   The Worker name in the dashboard must match the `name` field in
   `wrangler.jsonc`, or the deploy step will not find its target.

4. **Settings → Build → Add variable** (build-time):

   ```
   VITE_SUPABASE_URL
   VITE_SUPABASE_ANON_KEY
   ```

5. **Settings → Variables & Secrets → Add** as type *Secret* (runtime):

   ```
   SUPABASE_SERVICE_ROLE_KEY
   SUPABASE_JWT_SECRET
   ALPACA_API_KEY_ID
   ALPACA_API_SECRET_KEY
   FINNHUB_API_KEY
   CLUB_INVITE_CODE
   ```

   Or set them from the CLI instead, which is less error-prone:

   ```
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put SUPABASE_JWT_SECRET
   npx wrangler secret put ALPACA_API_KEY_ID
   npx wrangler secret put ALPACA_API_SECRET_KEY
   npx wrangler secret put FINNHUB_API_KEY
   npx wrangler secret put CLUB_INVITE_CODE
   ```

6. Push to `main` to trigger a build. Pushes to other branches create preview
   versions via `wrangler versions upload` without touching production.

---

## Known Cloudflare quirk

There is an open issue where deploying through the GitHub integration can clear
plaintext variables that were added by hand in the dashboard, when those
variables are not also declared in `wrangler.jsonc`.

Two habits avoid it entirely:

- Set **secrets** with `wrangler secret put`, not by hand in the dashboard.
  Secrets set this way persist across deploys.
- Declare non-sensitive config in `wrangler.jsonc` under `vars` so the config
  file is the single source of truth.

If a variable ever "disappears" after a deploy, this is why — re-add it and move
it into one of the two patterns above.

---

## Deploying manually instead

You do not have to use the GitHub integration at all. From your machine:

```
npx wrangler login
npm run deploy
```

This is simpler for a club project and skips every issue above. The GitHub
integration is worth it only once other officers start contributing and you want
pushes to deploy automatically.

---

## Post-deploy checklist

- [ ] Sign up with the invite code; confirm a wrong code is rejected
- [ ] Buy a position; confirm cash decreases and the sector resolves
- [ ] Short a position; confirm buying power drops by ~50% of notional
- [ ] Open DevTools → Network and confirm **no** Alpaca, Finnhub, or
      service-role key appears in any request or in the JS bundle
- [ ] Place an order while the market is closed; confirm rejection with the
      next-open time
- [ ] Confirm the nightly Cron Trigger writes snapshot rows
