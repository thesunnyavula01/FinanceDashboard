import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * F3, rendered against payloads that are not quite right.
 *
 * The standings are the one read in this app assembled from a database query, a
 * batched quote fetch and two bar series, then memoised per season and served
 * to the whole club — so a field that goes missing goes missing for everybody
 * at once, and it goes missing while the market is live, because that is when
 * the pieces behind it are moving. Every read below used to be unguarded, and
 * React unmounts the entire tree when a render throws: the failure was not a
 * broken panel but a black terminal with no status rail and no function keys.
 *
 * Arithmetic tests cannot catch this. Only rendering the real screen can.
 *
 * Run with: npm test
 */
const compiled = await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  stdin: {
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { MemoryRouter } from 'react-router-dom';
      import { Leaderboard } from './src/routes/Leaderboard';

      export function renderStandings(standings) {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        client.setQueryData(['standings'], standings);
        const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
          React.createElement(MemoryRouter, null, React.createElement(Leaderboard))));
        client.clear();
        return html;
      }
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  plugins: [
    {
      // The screen reads the signed-in member's id to mark its own row. Standing
      // up Supabase for that would be testing Supabase.
      name: "auth-stub",
      setup(builder) {
        builder.onResolve({ filter: /(^@\/lib\/auth$)|(\/lib\/auth$)/ }, () => ({
          path: "auth-stub",
          namespace: "auth-stub",
        }));
        builder.onLoad({ filter: /.*/, namespace: "auth-stub" }, () => ({
          contents:
            "export function useAuth() { return { session: { user: { id: 'u-ada' } }, loading: false, " +
            "signIn() {}, signUp() {}, signOut() {} }; }",
          loader: "ts",
        }));
      },
    },
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  external: ["react", "react/*", "react-dom/*", "@tanstack/*", "@supabase/*"],
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
  tsconfig: fileURLToPath(new URL("../tsconfig.app.json", import.meta.url)),
});

const module = { exports: {} as { renderStandings: (standings: unknown) => string } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { renderStandings } = module.exports;

function row(overrides: Record<string, unknown> = {}) {
  return {
    rank: 1,
    portfolioId: "pf-ada",
    userId: "u-ada",
    displayName: "Ada",
    role: "member",
    equity: 101_000,
    cash: 1_000,
    longMv: 100_000,
    shortMv: 0,
    positions: 2,
    totalPnl: 1_000,
    totalReturn: 1,
    dayPnl: 12.5,
    dayReturn: 0.1,
    excess: 0.4,
    top: { symbol: "AAPL", marketValue: 5_000, weight: 50, isShort: false },
    unpriced: 0,
    ...overrides,
  };
}

const complete = {
  // Midday, so the date this prints does not depend on the machine's timezone.
  season: { id: "s1", name: "2026", startsAt: "2026-01-05T12:00:00Z", tradingLocked: false },
  rows: [row(), row({ rank: 2, portfolioId: "pf-bea", userId: "u-bea", displayName: "Bea", totalReturn: -3, top: null })],
  summary: {
    members: 2,
    averageReturn: -1,
    medianReturn: -1,
    bestReturn: 1,
    worstReturn: -3,
    beatingBenchmark: 1,
    totalEquity: 200_000,
  },
  benchmarks: { spy: 0.6, qqq: 1.2 },
  unpriced: 0,
  asOf: "2026-09-17T15:04:05.000Z",
};

test("the standings draw the member, the bar and the benchmark on a complete payload", () => {
  const html = renderStandings(complete);
  assert.match(html, />Ada</);
  assert.match(html, />YOU</);
  assert.match(html, /\+1\.00%/);
  assert.match(html, /2 members/);
  assert.match(html, /since Jan 5/);
});

/**
 * Each of these took the whole terminal down, not just this panel. They are one
 * test rather than six because what is being pinned is the same claim in every
 * case: a thin payload is a thin screen, never a blank app.
 */
test("a partial standings payload degrades the panel instead of unmounting the terminal", () => {
  const degraded: Record<string, unknown> = {
    "no season": { ...complete, season: undefined },
    "no benchmarks": { ...complete, benchmarks: undefined },
    "no rows": { ...complete, rows: undefined },
    "no summary": { ...complete, summary: undefined },
    // Intl.DateTimeFormat throws on an invalid date rather than printing
    // "Invalid Date" the way toLocaleString does.
    "an unparseable timestamp": { ...complete, asOf: "not-a-date" },
    "a top holding with no weight": {
      ...complete,
      rows: [row({ top: { symbol: "AAPL", marketValue: 5_000, weight: null, isShort: false } })],
    },
    "an empty body": {},
  };

  for (const [name, standings] of Object.entries(degraded)) {
    assert.doesNotThrow(() => renderStandings(standings), `F3 threw on ${name}`);
  }

  // Still a screen, not an empty div: the member is drawn with no season on it.
  assert.match(renderStandings(degraded["no season"]), />Ada</);
});

/**
 * The boundary's placement, read off the shell.
 *
 * It cannot be exercised through `renderToStaticMarkup` — server rendering
 * rethrows rather than falling back to a boundary — and what actually matters
 * here is not the fallback's markup but *where it sits*. Outside the shell it
 * would be no better than the crash: the status rail, the function keys and the
 * command bar would go down with the screen and a member would have no way to
 * navigate off the broken one. So the placement is what gets pinned, the same
 * shape as `expiry.test.ts` reading `index.ts` for the order of two jobs.
 */
test("a failing screen is caught inside the shell, not around it", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");

  const main = app.slice(app.indexOf("<main"), app.indexOf("</main>"));
  assert.ok(main.includes("<ErrorBoundary"), "the boundary must be inside <main>");
  assert.ok(
    main.indexOf("<ErrorBoundary") < main.indexOf("<Routes>"),
    "the boundary must wrap the routed screen",
  );
  // Keyed on the path, or a tripped boundary follows the member to the screen
  // they navigated to in order to get away from it.
  assert.match(main, /<ErrorBoundary key=\{location\.pathname\}>/);

  // The chrome the boundary exists to keep.
  for (const chrome of ["<StatusRail", "<FunctionNav", "<CommandBar"]) {
    assert.ok(
      app.indexOf(chrome) < app.indexOf("<ErrorBoundary") ||
        app.indexOf(chrome) > app.indexOf("</ErrorBoundary>"),
      `${chrome} must sit outside the boundary so it survives a broken screen`,
    );
  }
});
