import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Render the actual ticket with cached data: arithmetic tests alone missed blocked stop controls.
 * Run with: npm test
 */
const compiled = await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  stdin: {
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { OrderTicket } from './src/components/terminal/OrderTicket';
      import { valuePortfolio, estimateReservation } from './src/lib/portfolio';
      export { estimateReservation };
      export function render(initial, cash = 100000) {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const symbol = initial.symbol;
        client.setQueryData(['quotes', [symbol]], { quotes: { [symbol]: { symbol, price: 3, source: 'quote', prevClose: 3 } }, unknown: [] });
        client.setQueryData(['securities', [symbol]], { securities: {}, pending: [] });
        client.setQueryData(['clock'], { isOpen: false, authoritative: true, label: 'Closed' });
        const { totals } = valuePortfolio({ positions: [], quotes: {}, securities: {}, cash, startingCash: cash });
        const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
          React.createElement(OrderTicket, { initial, positions: [], totals, tradingLocked: false, reservedCash: 0 })));
        client.clear();
        return html;
      }
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx",
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  external: ["react", "react/*", "react-dom/*", "@tanstack/*", "@supabase/*"],
  jsx: "automatic", define: { "import.meta.env": "{}" },
  tsconfig: fileURLToPath(new URL("../tsconfig.app.json", import.meta.url)),
});
const module = { exports: {} as { render: (initial: object, cash?: number) => string; estimateReservation: (input: object) => { cash: number } } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
const { render, estimateReservation } = module.exports;

test("plain stops and trailing stops ask for their trigger rather than an invisible limit field", () => {
  for (const orderType of ["STOP", "TRAILING_STOP"]) {
    const html = render({ symbol: "AAPL", qty: 1, orderType });
    assert.doesNotMatch(html, /Enter a limit price\./);
    assert.match(html, orderType === "STOP" ? /Enter a stop price\./ : /Enter how far the stop should trail\./);
  }
  for (const orderType of ["LIMIT", "STOP_LIMIT"]) {
    assert.match(render({ symbol: "AAPL", qty: 1, orderType }), /Enter a limit price\./);
  }
});

test("the rendered adjusted-option ticket refuses a reservation larger than available buying power", () => {
  const html = render({ symbol: "AAPL300118C00150000", multiplier: 1000, qty: 2, orderType: "LIMIT", limitPrice: 3 }, 1000);
  assert.match(html, /Queueing this holds/);
  assert.match(html, /6,000\.00/);
});

test("option reservation previews include the multiplier and dollar orders remain capped", () => {
  const common = { side: "BUY", orderType: "LIMIT", limitPrice: 3, referencePrice: 3, multiplier: 1000 };
  assert.equal(estimateReservation({ ...common, qty: 2 }).cash, 6000);
  assert.equal(estimateReservation({ ...common, notional: 6500 }).cash, 6500);
});
