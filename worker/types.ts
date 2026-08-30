/**
 * Worker bindings and environment.
 *
 * Plain `vars` come from wrangler.jsonc and are safe to read anywhere. Secrets
 * come from .dev.vars locally and `wrangler secret put` in production; they are
 * typed optional because they are genuinely absent until SETUP.md is complete,
 * and a route that needs one should say so rather than crash.
 */
export interface Env {
  // Bindings
  ASSETS: Fetcher;
  QUOTES: KVNamespace;

  // Vars (public, declared in wrangler.jsonc)
  APP_NAME: string;
  ALPACA_DATA_FEED: string;
  QUOTE_CACHE_TTL: string;

  // Secrets (never exposed to the client)
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_JWT_SECRET?: string;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  FINNHUB_API_KEY?: string;
  CLUB_INVITE_CODE?: string;
}

export type AppBindings = { Bindings: Env };
