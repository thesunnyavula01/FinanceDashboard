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
  SUPABASE_URL: string;
  ALPACA_DATA_FEED: string;
  QUOTE_CACHE_TTL: string;
  /**
   * Who to contact about our EDGAR traffic, sent as the `User-Agent` on every
   * SEC request. A var rather than a secret on purpose: the SEC requires a real,
   * reachable address and publishing it is the point. A request without one is
   * refused with 403 rather than throttled.
   */
  SEC_CONTACT: string;

  // Secrets (never exposed to the client)
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_JWT_SECRET?: string;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  FINNHUB_API_KEY?: string;
  CLUB_INVITE_CODE?: string;
  /**
   * Reddit's Data API, for F4's discussion panel. The only credential Phase 10
   * adds: GDELT, SEC EDGAR and Hacker News need no key at all, and news for
   * both asset classes comes off the Alpaca and Finnhub keys already above.
   */
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
}

export type AppBindings = { Bindings: Env };
