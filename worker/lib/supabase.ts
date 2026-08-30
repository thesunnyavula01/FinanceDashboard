import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types";

/**
 * Service-role Supabase client.
 *
 * This key bypasses every row-level security policy, so it exists only inside
 * the Worker and every call made with it must already have established who the
 * caller is and what they are allowed to do. It is never sent to the browser.
 */
export function serviceClient(env: Env): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new ConfigError(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Thrown when a required secret is missing, so routes can answer 503 not 500. */
export class ConfigError extends Error {}
