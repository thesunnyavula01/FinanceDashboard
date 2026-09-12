import test from "node:test";
import assert from "node:assert/strict";
import { AlpacaProvider } from "./alpaca.ts";
import { AlpacaCryptoProvider } from "./crypto.ts";
import { AlpacaOptionsProvider } from "./options.ts";
import { RoutingProvider } from "./router.ts";

/** A hung provider must release shared requests, and an incomplete sync must not delete assets.
 * Run with: npm test
 */
const config = { keyId: "test", secretKey: "test", feed: "iex" };

test("every price provider bounds a hung request and can recover on the next call", async (t) => {
  const saved = globalThis.fetch;
  try {
    for (const [provider, symbol] of [
      [new AlpacaProvider(config), "AAPL"],
      [new AlpacaCryptoProvider(config), "BTC/USD"],
      [new AlpacaOptionsProvider(config), "AAPL300118C00150000"],
    ] as const) {
      const controller = new AbortController();
      const timeout = t.mock.method(AbortSignal, "timeout", (ms: number) => {
        assert.equal(ms, 8000);
        return controller.signal;
      });
      globalThis.fetch = (async (_url, init) => new Promise((_resolve, reject) => {
        assert.equal(init?.signal, controller.signal);
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      })) as typeof fetch;
      const pending = provider.quotes([symbol]);
      controller.abort();
      await assert.rejects(pending, /Could not reach Alpaca/);
      timeout.mock.restore();
      globalThis.fetch = (async () => new Response(JSON.stringify({ snapshots: {} }))) as typeof fetch;
      assert.equal((await provider.quotes([symbol])).size, 0);
    }
  } finally { globalThis.fetch = saved; }
});

test("a failed crypto universe prevents an equity-only list from replacing the complete universe", async () => {
  const equity = new AlpacaProvider(config);
  const crypto = new AlpacaCryptoProvider(config);
  equity.assets = async () => [];
  crypto.assets = async () => { throw new Error("crypto unavailable"); };
  const provider = new RoutingProvider({ equity, crypto, options: new AlpacaOptionsProvider(config) });
  await assert.rejects(provider.assets(), /crypto unavailable/);
});
