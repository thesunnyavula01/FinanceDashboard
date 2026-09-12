import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { invalidatePortfolioViews, resetSessionCache, workingOrdersChanged, workingOrdersInterval } from "../src/lib/refresh.ts";

/** A cron fill must update the whole book, and a new login must start with its own data.
 * Run with: npm test
 */
test("crypto fills and DAY expirations keep polling after the stock exchange closes", () => {
  const pending = { orders: [{ id: "order", status: "PENDING" }] };
  assert.equal(workingOrdersInterval(pending, false), 20_000);
  assert.equal(workingOrdersInterval({ orders: [] }, false), 60_000);
  for (const status of ["FILLED", "CANCELLED", "EXPIRED", "REJECTED"]) {
    assert.equal(workingOrdersChanged(pending, { orders: [{ id: "order", status }] }), true);
  }
  assert.equal(workingOrdersChanged(pending, pending), false);
  assert.equal(workingOrdersChanged(undefined, pending), false);
  assert.equal(workingOrdersChanged(pending, { orders: [] }), true);
});

test("a fill invalidates the portfolio, blotter, history, ranking and member details together", () => {
  const client = new QueryClient();
  const keys = [["portfolio"], ["blotter", 100], ["history", "1D"], ["standings"], ["member-book", "p"], ["me", "u"]];
  for (const key of [...keys, ["working-orders"], ["quotes"]]) client.setQueryData(key, { value: 1 });
  invalidatePortfolioViews(client);
  for (const key of keys) assert.equal(client.getQueryState(key)?.isInvalidated, true, String(key));
  assert.equal(client.getQueryState(["working-orders"])?.isInvalidated, false, "no self-triggered polling loop");
  assert.equal(client.getQueryState(["quotes"])?.isInvalidated, false, "no extra provider requests");
  client.clear();
});

test("sign-out and account switching erase private caches but token refresh keeps them", async () => {
  const client = new QueryClient();
  client.setQueryData(["portfolio"], { owner: "alice" });
  resetSessionCache(client, "alice", "alice");
  assert.deepEqual(client.getQueryData(["portfolio"]), { owner: "alice" });
  let finish!: (value: string) => void;
  const pending = client.fetchQuery({ queryKey: ["admin"], queryFn: () => new Promise<string>((resolve) => { finish = resolve; }) }).catch(() => undefined);
  resetSessionCache(client, "alice", "bob");
  finish("alice's private response");
  await pending;
  assert.equal(client.getQueryData(["portfolio"]), undefined);
  assert.equal(client.getQueryData(["admin"]), undefined, "an old in-flight response cannot restore a previous owner's data");
  client.setQueryData(["working-orders"], { owner: "bob" });
  resetSessionCache(client, "bob", null);
  assert.equal(client.getQueryCache().getAll().length, 0);
});
