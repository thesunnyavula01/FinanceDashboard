import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { checkClientEnv, formatClientEnvError } from "./scripts/check-client-env.ts";

/**
 * Fails the build when the two client-side variables are missing, templated, or
 * carry a credential that must never reach the browser.
 *
 * `apply: "build"` so `vite dev` still starts without them — the login screen
 * already names what is unset via `missingConfig` in src/lib/supabase.ts, which
 * is the right behaviour while someone is setting the project up. A *deploy*
 * is a different matter: a bundle built without them is broken for the whole
 * club and says nothing about why, so the build stops instead.
 */
function requireClientEnv(env: Record<string, string>): Plugin {
  return {
    name: "finance-club:require-client-env",
    apply: "build",
    buildStart() {
      const problems = checkClientEnv(env);
      if (problems.length > 0) {
        this.error(formatClientEnvError(problems));
      }
    },
  };
}

// The Cloudflare plugin runs the Worker inside Vite's dev server using the real
// workerd runtime, so `vite dev` serves the SPA and the Hono API together and
// local behaviour matches production. It reads wrangler.jsonc for bindings.
export default defineConfig(({ mode }) => {
  // Exactly the set Vite will inline: VITE_-prefixed values from the .env files
  // for this mode, plus any from the real environment. `vite build` runs in
  // production mode, which is what loads the committed .env.production.
  const clientEnv = loadEnv(mode, process.cwd(), "VITE_");

  return {
    plugins: [react(), tailwindcss(), cloudflare(), requireClientEnv(clientEnv)],
    resolve: {
      // Mirrors the `@/*` path mapping in tsconfig.app.json.
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      // Keep the bundle debuggable in production; this is a teaching tool and the
      // club should be able to read its own stack traces.
      sourcemap: true,
    },
  };
});
