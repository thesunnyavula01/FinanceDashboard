/**
 * Build-time validation of the two variables Vite inlines into the browser
 * bundle.
 *
 * Why this exists: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are read at
 * BUILD time, not at request time. If they are absent when `vite build` runs,
 * the build still succeeds and ships a bundle whose Supabase client is
 * configured with `undefined` — the site deploys green and every member sees a
 * login page that cannot connect. That failure has cost this project several
 * deploys, and the only reliable cure is to make the build itself fail.
 *
 * The trap that produced it: Cloudflare has two separate variable stores, and
 * only the *Build* one is readable while `vite build` runs. Putting these two
 * values in the Worker's runtime store does nothing for Vite AND gets wiped by
 * the next deploy, because `wrangler deploy` reconciles runtime vars against
 * wrangler.jsonc. They now live in `.env.production`, which is committed for
 * exactly this reason.
 *
 * This module is pure and takes the environment as an argument so it can be
 * exercised directly — see `scripts/check-client-env.test.ts`.
 */

export interface ClientEnvProblem {
  variable: string;
  problem: string;
}

/** The variables the browser bundle cannot work without. */
const REQUIRED = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"] as const;

/**
 * Fragments that name a Worker-only credential. A `VITE_`-prefixed variable
 * containing any of them is non-negotiable rule 1 being broken: anything Vite
 * can read is inlined into JavaScript that every visitor downloads.
 */
const SECRET_MARKERS = [
  "SERVICE_ROLE",
  "JWT_SECRET",
  "ALPACA",
  "FINNHUB",
  "INVITE_CODE",
  "SECRET",
];

/** An unfilled template uploads cleanly and then fails far from its cause. */
const PLACEHOLDER = /^(your[_-]|changeme|placeholder|xxx+|<)/i;

/**
 * True if `value` is a Supabase credential that bypasses row-level security.
 *
 * Covers both key formats: the new `sb_secret_...` style, and a legacy JWT
 * whose payload claims `role: service_role`. Shipping either to the browser
 * would hand every visitor full control of the club's database, so it is worth
 * decoding the token rather than pattern-matching the prefix.
 */
function isServiceRoleCredential(value: string): boolean {
  if (value.startsWith("sb_secret_")) return true;

  const segments = value.split(".");
  if (segments.length !== 3) return false;

  try {
    const payload = Buffer.from(segments[1], "base64url").toString("utf8");
    return JSON.parse(payload).role === "service_role";
  } catch {
    // Not a JWT we can read. Fall through — the other checks still apply.
    return false;
  }
}

/**
 * Everything wrong with the client-side environment, as a list. Empty means the
 * bundle will be built against real, correctly-scoped values.
 */
export function checkClientEnv(
  env: Record<string, string | undefined>,
): ClientEnvProblem[] {
  const problems: ClientEnvProblem[] = [];

  for (const variable of REQUIRED) {
    const value = (env[variable] ?? "").trim();

    if (value === "") {
      problems.push({ variable, problem: "is missing or empty" });
      continue;
    }

    if (PLACEHOLDER.test(value)) {
      problems.push({ variable, problem: "still holds the .env.example placeholder" });
      continue;
    }

    if (variable === "VITE_SUPABASE_URL" && !value.startsWith("https://")) {
      problems.push({ variable, problem: `is not an https URL (got "${value}")` });
    }

    if (variable === "VITE_SUPABASE_ANON_KEY" && isServiceRoleCredential(value)) {
      problems.push({
        variable,
        problem:
          "is a SERVICE-ROLE key, which bypasses row-level security. " +
          "Use the anon / publishable key — the service-role key is Worker-only",
      });
    }
  }

  // Any VITE_ variable naming a Worker-only credential, not just the two above.
  for (const name of Object.keys(env)) {
    if (!name.startsWith("VITE_")) continue;
    if ((REQUIRED as readonly string[]).includes(name)) continue;

    const marker = SECRET_MARKERS.find((m) => name.toUpperCase().includes(m));
    if (marker) {
      problems.push({
        variable: name,
        problem:
          `names a Worker-only secret (${marker}). Anything VITE_-prefixed is ` +
          "inlined into the public JavaScript bundle — drop the prefix and set " +
          "it with `wrangler secret put` instead",
      });
    }
  }

  return problems;
}

/** The build-failure message, kept here so the plugin stays a one-liner. */
export function formatClientEnvError(problems: ClientEnvProblem[]): string {
  const lines = problems.map((p) => `    ${p.variable} ${p.problem}`).join("\n");

  return [
    "",
    "  Refusing to build: the browser bundle would ship broken.",
    "",
    lines,
    "",
    "  These values are inlined into the JavaScript at BUILD time, so a build",
    "  that cannot read them produces a login page that silently fails to",
    "  connect — with no error at deploy time to tell you why.",
    "",
    "  They belong in .env.production, which is committed precisely so that",
    "  Cloudflare's build machine has them (.env is gitignored and does not",
    "  exist there). Setting them in the Worker's runtime store does NOT work:",
    "  Vite cannot read it, and the next deploy wipes it.",
    "",
  ].join("\n");
}
