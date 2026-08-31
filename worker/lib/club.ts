import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types.ts";

/**
 * The invite code.
 *
 * It started life as a Worker secret, which made it un-rotatable: changing it
 * meant a deploy, and "an officer read the code out at a meeting and it ended
 * up in a group chat" is a Tuesday, not an incident. So the live code lives in
 * `club_settings` (migration 0005) and the secret becomes the seed — what
 * signup uses until a code has ever been set, which is what lets the very first
 * officer create the account that can then set one.
 *
 * Once a row exists it is the ONLY code that works. Falling back to the
 * environment after a rotation would leave the old code valid, which is not a
 * rotation at all; it is two doors.
 *
 * Nothing here is cached, deliberately. Signup happens a few dozen times a
 * season and a rotation has to bite immediately — a thirty-second window in
 * which the code an officer just revoked still opens the door is exactly the
 * window they rotated it to close.
 */

export interface InviteCode {
  /** Null when neither the database nor the environment has one. */
  code: string | null;
  source: "database" | "environment" | "none";
  /** When it was last rotated. Null while the environment seed is in use. */
  updatedAt: string | null;
}

export async function inviteCode(env: Env, supabase: SupabaseClient): Promise<InviteCode> {
  const { data, error } = await supabase
    .from("club_settings")
    .select("invite_code, updated_at")
    .maybeSingle();

  if (error) {
    // The table arrives in migration 0005. Until that is applied the secret is
    // still the code, and signup keeps working rather than locking the club out
    // of its own app over an unapplied migration.
    console.warn("club_settings unavailable, falling back to the environment:", error.message);
    return fromEnv(env);
  }

  const stored = typeof data?.invite_code === "string" ? data.invite_code.trim() : "";
  if (!stored) return fromEnv(env);

  return { code: stored, source: "database", updatedAt: (data?.updated_at as string) ?? null };
}

function fromEnv(env: Env): InviteCode {
  const seed = env.CLUB_INVITE_CODE?.trim();
  return seed
    ? { code: seed, source: "environment", updatedAt: null }
    : { code: null, source: "none", updatedAt: null };
}

/** Store a new code. Replaces whatever was there; there is only ever one row. */
export async function setInviteCode(
  supabase: SupabaseClient,
  code: string,
  updatedBy: string,
): Promise<void> {
  const { error } = await supabase
    .from("club_settings")
    .upsert(
      { id: true, invite_code: code, updated_at: new Date().toISOString(), updated_by: updatedBy },
      { onConflict: "id" },
    );

  if (error) throw error;
}

/**
 * Characters that survive being read aloud in a classroom and written down
 * wrong. No O/0, no I/1/l, no 5/S — the code is going on a whiteboard, and a
 * member who mistypes it is told only that it is wrong.
 */
const ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";

/** A fresh code: two groups of four, hyphenated, e.g. `K7QM-3XBD`. */
export function generateInviteCode(): string {
  // 256 does not divide by 29, so the bytes in the remainder are dropped rather
  // than folded back onto the first few letters of the alphabet.
  const ceiling = 256 - (256 % ALPHABET.length);
  const letters: string[] = [];

  while (letters.length < 8) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= ceiling) continue;
      letters.push(ALPHABET[byte % ALPHABET.length]!);
      if (letters.length === 8) break;
    }
  }

  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

/** Comparison that does not reveal how much of the code was correct. */
export function secretEquals(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
