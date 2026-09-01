# Deploying to Cloudflare

## Migrations: all five are applied

`0001` through `0005` are in the FinanceClub project (ref `vtlqkgpcfdhslqahivzf`)
and were verified against the catalogue on 2026-08-30. Phase 7 added none. **You
do not owe the database anything before deploying.**

There is no migration runner in this project — migrations are pasted into the
Supabase SQL editor by hand — so if you ever need to confirm the state rather
than trust this file, run the check below. Do that rather than trusting
"Success. No rows returned", which is also what a script you did not mean to run
says:

```sql
select 'starting_cash'    as item, count(*)::text as found from information_schema.columns
  where table_schema='public' and table_name='portfolios' and column_name='starting_cash'
union all
select 'club_settings', count(*)::text from information_schema.tables
  where table_schema='public' and table_name='club_settings'
union all
select 'admin fns (of 7)', count(distinct proname)::text from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and proname in ('create_season','update_season','reset_season',
        'set_member_role','rebuild_portfolio','void_trade','amend_trade')
union all
select 'anon/authenticated can execute them (want 0)', count(*)::text from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname in ('create_season','update_season','reset_season',
        'set_member_role','rebuild_portfolio','void_trade','amend_trade')
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
```

Expect `1, 1, 7, 0`. The last row is non-negotiable rule 2 holding at the
database level: only `service_role` may call the functions that move money.

> Two things that bite in the SQL editor. It runs **whichever tab has focus**,
> not the one you were last looking at, so read the editor before pressing Run —
> the editor restores previous sessions' tabs and one of them may hold something
> else entirely. And a migration whose *function bodies* contain `delete from`
> trips the "destructive operations" warning even though creating a function
> that contains a DELETE does not run it; `0003` and `0005` both do this.

## The KV namespace — created

Namespace `financedashboard-QUOTES`, id `6d645b694a1b4555b0ea3ed17d1880ce`,
already wired into `wrangler.jsonc`. It holds the nightly copy of Alpaca's
tradable asset list, which is what makes ticker autocomplete a local read
instead of a multi-megabyte download per keystroke.

Until that id was real, every deploy died at the deploy step — after a
completely successful build — with:

```
✘ [ERROR] KV namespace 'PLACEHOLDER_...' is not valid. [code: 10042]
```

If the namespace is ever deleted, recreate it and paste the new id in:

```
npx wrangler kv namespace create QUOTES
```

The id is not a secret. It names a namespace; reaching it still needs the
account's credentials, so it belongs in the config rather than the secret store.

## The Worker is named `financedashboard`

Workers Builds derives the service name from the repository, so the dashboard
created `financedashboard` while `wrangler.jsonc` said `finance-club-terminal`.
The config now matches the dashboard.

Do not let them drift again:

```
▲ [WARNING] Failed to match Worker name. Your config file is using
  "finance-club-terminal", but the CI system expected "financedashboard".
```

CI overrides and carries on, so this is only a warning — but **`wrangler secret
put` run locally reads the name from the config**, so under a mismatch your
secrets go to a Worker that is not the one serving traffic, and nothing tells
you. Pass `--name financedashboard` whenever you are unsure.

> The binding is still named `QUOTES` for historical reasons; quotes themselves
> are **not** cached in KV. A 20-second quote cache would be roughly 234,000
> writes a day against a 1,000/day free-tier ceiling, and KV cannot express a
> TTL below 60 seconds anyway. Prices are cached in isolate memory and the Cache
> API instead — see the comment at the top of `worker/market/quotes.ts`.

The app builds and the SPA renders without the namespace; only the Worker needs
it, from Phase 3 onward.

After the first deploy, populate the asset list without waiting for the cron:

```
curl -X POST https://<your-worker>/api/market/universe/sync \
  -H "Authorization: Bearer <an admin's session token>"
```

Or just use the app — the first ticker search kicks off a sync behind the
response, and the one after it returns results.

---

## The one thing that breaks this app

Cloudflare has **two completely separate variable stores**, and they are not
interchangeable:

| Store | Dashboard path | Available when | What goes here |
|---|---|---|---|
| **Build variables** | Settings → **Build** | Only while `npm run build` runs | Nothing — the two `VITE_*` values are committed in `.env.production` |
| **Runtime secrets** | Settings → **Variables & Secrets** | Only while the Worker serves a request | Alpaca keys, Finnhub key, service-role key, JWT secret, invite code |

Cloudflare's docs are explicit: **build variables are not accessible at runtime.**
The reverse is also true — runtime secrets are not visible during the build.

### Why this matters here

`.dev.vars` is gitignored, so it does not exist on Cloudflare's build machine —
and neither did `.env`, which is what broke this app on push after push. Vite
bakes `VITE_*` values into the JavaScript bundle at build time by reading the
environment. With nothing to read, the bundle shipped with `undefined` for the
Supabase URL and key, and every member saw a login page that silently failed to
connect.

The failure was quiet — no build error, no red text. The site deployed
"successfully" and simply didn't work.

**Both halves of that are fixed now, and neither needs a dashboard setting.**

1. The two public values live in **`.env.production`, which is committed.** Vite
   loads it during `vite build`, so the build has them whether it runs on a
   laptop or in CI, and there is nothing left for a deploy to wipe. They are
   safe to commit and *only* they are: the project URL is already in
   `wrangler.jsonc`, and the anon key is public by design — it ships in the
   bundle every visitor downloads, and RLS is enabled on all ten tables, so it
   grants the read policies and nothing more.

2. The build **refuses to run** if either value is missing, still holds an
   `.env.example` placeholder, or is a service-role credential — and it refuses
   any `VITE_`-prefixed variable naming a Worker secret, which is rule 1
   enforced by the build rather than by memory. `scripts/check-client-env.ts`,
   pinned by `scripts/check-client-env.test.ts`.

**The trap worth naming, because it looks exactly like the fix:** setting
`VITE_SUPABASE_ANON_KEY` in the Worker's **runtime** store does nothing. Vite
cannot read it — a runtime binding exists only while a request is being served,
long after the bundle was built — *and* the next deploy deletes it, because
`wrangler deploy` reconciles runtime vars against `wrangler.jsonc` and that name
is not in there. Putting a build-time value in the runtime store is what
produced the "my variables got wiped again" loop. The deploy history still shows
it: `Updated secret: VITE_SUPABASE_ANON_KEY`, then `Updated variable:
VITE_SUPABASE_ANON_KEY`, then gone.

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

4. Build variables: **nothing to set.** `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` are committed in `.env.production`, so the build
   machine reads them straight from the repository. Do not add them to the
   Worker's runtime store either — see "The one thing that breaks this app".

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

## The Cron Triggers

`wrangler.jsonc` declares two schedules, and `wrangler deploy` registers them.
They appear under **Settings → Trigger Events** in the dashboard; if that list
is empty after a deploy, nothing scheduled is running.

| Schedule (UTC) | Job |
|---|---|
| `* 13-21 * * 1-5` | Fill resting orders, expire DAY orders. Gates itself on the exchange calendar, so holidays cost one cached clock lookup |
| `15 22 * * 1-5` | Refresh the tradable universe, then snapshot every portfolio and the two benchmarks |

22:15 UTC is 18:15 ET in summer and 17:15 ET in winter — past the close in both,
with enough margin that the daily bars the snapshot prices the club at have
certainly been published, and still the same exchange date the rows are stamped
with.

The cron expressions are duplicated in `worker/index.ts`, which dispatches on
them. `worker/schedule.test.ts` fails the build if the two files drift, because
the failure is otherwise silent: the trigger fires, no branch matches, and the
job quietly stops running.

### Verifying the snapshot without waiting for 22:15

Both jobs have a forced-run endpoint behind `requireAdmin`, and both are
idempotent, so pressing them is safe:

```
curl -X POST https://<your-worker>/api/portfolio/snapshot \
  -H "Authorization: Bearer <an admin's session token>"
```

It answers with what it did:

```json
{ "ran": true, "asOf": "2026-08-31", "portfolios": 12, "benchmarks": 20, "unpriced": 0 }
```

`"ran": false` with a `reason` is the ordinary answer on a weekend or a holiday
— the job gates on whether SPY has a bar dated today, so there is nothing to
record. Run it again and confirm `portfolios` reports the same count and the
row count in the table has not moved: the writes upsert on
`(portfolio_id, as_of)`, so a second run overwrites rather than duplicates.

```sql
select as_of, count(*) from portfolio_snapshots group by as_of order by as_of desc;
```

To exercise the handler locally, `wrangler dev --test-scheduled` exposes
`http://localhost:8787/__scheduled?cron=15+22+*+*+1-5`.

---

## Post-deploy checklist

- [ ] Sign up with the invite code; confirm a wrong code is rejected
- [ ] Buy a position; confirm cash decreases and the sector resolves
- [ ] Short a position; confirm buying power drops by ~50% of notional
- [ ] Open DevTools → Network and confirm **no** Alpaca, Finnhub, or
      service-role key appears in any request or in the JS bundle
- [ ] Place an order while the market is closed; confirm it is *queued*, not
      refused, and appears under working orders
- [ ] Fire two orders at once from two tabs; confirm the cash math is right
- [ ] Settings → Trigger Events lists both cron schedules
- [ ] `POST /api/portfolio/snapshot` writes rows; run it twice and confirm the
      row count does not move
- [ ] Rotate the invite code from the admin console and confirm the old one
      stops working immediately
