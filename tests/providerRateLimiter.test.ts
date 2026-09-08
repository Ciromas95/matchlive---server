import assert from "node:assert/strict";
import test from "node:test";
import { waitForProviderSlot } from "../src/providerRateLimiter";

test("la corsia live supera le richieste normali già in attesa", async () => {
  const order: string[] = [];
  const first = waitForProviderSlot("normal").then(() => order.push("normal-1"));
  const second = waitForProviderSlot("normal").then(() => order.push("normal-2"));
  const live = waitForProviderSlot("critical").then(() => order.push("live"));
  await Promise.all([first, second, live]);
  assert.deepEqual(order, ["normal-1", "live", "normal-2"]);
});
