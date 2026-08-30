import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin runs the Worker inside Vite's dev server using the real
// workerd runtime, so `vite dev` serves the SPA and the Hono API together and
// local behaviour matches production. It reads wrangler.jsonc for bindings.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
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
});
