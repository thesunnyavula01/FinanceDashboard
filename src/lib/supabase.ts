import { createClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client.
 *
 * This holds the anon key, which is public by design — it can only do what the
 * row-level security policies allow, and those grant reads and nothing else.
 * Every write in this app goes through the Worker. Never put the service-role
 * key here; it bypasses RLS entirely.
 */

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Which required variables are missing, if any.
 *
 * Vite inlines these at build time, so an unset variable produces a client that
 * fails at runtime with an opaque network error. Detecting it here lets the UI
 * say exactly which variable is missing and where to set it — this is the most
 * common way a Cloudflare deploy of this app breaks.
 */
export const missingConfig: string[] = [
  !url && "VITE_SUPABASE_URL",
  !anonKey && "VITE_SUPABASE_ANON_KEY",
].filter(Boolean) as string[];

export const isConfigured = missingConfig.length === 0;

export const supabase = createClient(url ?? "http://unconfigured.invalid", anonKey ?? "missing", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

/** The current access token, for Authorization headers on Worker calls. */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
