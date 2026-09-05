import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("quota dashboard: il fornitore decide il conteggio e il rinnovo", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-quota-"));
  const oldStore = process.env.METRICS_STORE_PATH;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-31T23:59:00Z") });
  let serial = 0;
  const load = (fresh = true): typeof import("../src/stats") => {
    if (fresh) process.env.METRICS_STORE_PATH = path.join(dir, `${serial++}.json`);
    delete require.cache[require.resolve("../src/stats")];
    return require("../src/stats");
  };
  const quota = (used: number, date = "Mon, 31 Aug 2026 23:59:00 GMT", limit = 7500) => ({
    date,
    "x-ratelimit-requests-limit": String(limit),
    "x-ratelimit-requests-remaining": String(limit - used),
  });
  try {
    await t.test("errori senza header, parziali o invalidi non azzerano la soglia raggiunta", () => {
      const stats = load();
      stats.syncProviderQuota(quota(7500));
      for (const headers of [undefined, null, {},
        { "x-ratelimit-limit": 300, "x-ratelimit-remaining": 0 },
        { "x-ratelimit-requests-limit": 7500 },
        { "x-ratelimit-requests-remaining": 0 },
        { "x-ratelimit-requests-limit": "", "x-ratelimit-requests-remaining": "" },
        { "x-ratelimit-requests-limit": 0, "x-ratelimit-requests-remaining": 0 },
        { "x-ratelimit-requests-limit": false, "x-ratelimit-requests-remaining": null },
      ]) {
        stats.syncProviderQuota(headers);
        stats.markApiCall("live");
        const { readable } = stats.getApiStats();
        assert.equal(readable.externalCallsToday, 7500);
        assert.equal(readable.externalCallsRemainingEstimate, 0);
        assert.equal(readable.status.label, "Quota esaurita");
      }
    });

    await t.test("soglia superata, risposte fuori ordine e cambio piano", () => {
      const stats = load();
      stats.syncProviderQuota(quota(7512));
      stats.syncProviderQuota(quota(7400));
      assert.equal(stats.getApiStats().provider.callsToday, 7512);
      assert.ok(stats.getApiStats().readable.externalBudgetUsedPct > 1);
      stats.syncProviderQuota(quota(7512, undefined, 75000));
      assert.equal(stats.getApiStats().readable.dailyBudget, 75000);
      assert.equal(stats.getApiStats().provider.callsToday, 7512);
    });

    await t.test("mezzanotte e riavvio non cancellano il dato; rinnovo solo con risposta ufficiale", () => {
      let stats = load();
      stats.syncProviderQuota(quota(7500));
      t.mock.timers.setTime(Date.parse("2026-09-01T00:01:00Z"));
      stats.markApiCall("live");
      stats.syncProviderQuota(undefined);
      assert.equal(stats.getApiStats().provider.callsToday, 7500);
      assert.equal(stats.getApiStats().readable.providerAwaitingRenewal, true);
      stats = load(false);
      assert.equal(stats.getApiStats().provider.callsToday, 7500);
      stats.syncProviderQuota(quota(0, "Tue, 01 Sep 2026 00:01:00 GMT"));
      assert.equal(stats.getApiStats().provider.callsToday, 0);
      assert.equal(stats.getApiStats().readable.providerAwaitingRenewal, false);
      stats.syncProviderQuota(quota(7500)); // delayed response from yesterday
      assert.equal(stats.getApiStats().provider.callsToday, 0);
      stats = load(false);
      assert.equal(stats.getApiStats().provider.callsToday, 0);
    });

    await t.test("HTTP Headers e ora di avvio proteggono le richieste a cavallo del rinnovo", () => {
      const stats = load();
      stats.syncProviderQuota(new Headers(quota(3, "Tue, 01 Sep 2026 00:01:00 GMT")));
      stats.syncProviderQuota({
        "X-RateLimit-Requests-Limit": 7500,
        "X-RateLimit-Requests-Remaining": 0,
      }, Date.parse("2026-08-31T23:59:59Z"));
      assert.equal(stats.getApiStats().provider.callsToday, 3);
    });

    await t.test("status condiviso: una verifica al minuto, nessun azzeramento su errore", async () => {
      const stats = load();
      const { createProviderQuotaSync } = require("../src/providerQuotaSync") as typeof import("../src/providerQuotaSync");
      let calls = 0;
      let invalid = false;
      let offline = false;
      let resolve!: (value: any) => void;
      const refresh = createProviderQuotaSync(async () => {
        calls++;
        if (offline) throw new Error("network unavailable");
        if (invalid) return { headers: {}, data: { response: { requests: { current: null, limit_day: 7500 } } } };
        return new Promise(r => { resolve = r; });
      }, stats.syncProviderQuota);
      const first = refresh();
      const second = refresh();
      assert.equal(first, second);
      resolve({ headers: {}, data: { errors: [], response: {
        account: { email: "private@example.test" },
        requests: { current: 7500, limit_day: 7500 },
      } } });
      await first;
      await refresh();
      assert.equal(calls, 1);
      assert.equal(stats.getApiStats().provider.callsToday, 7500);
      assert.equal(JSON.stringify(stats.getApiStats()).includes("private@example.test"), false);
      invalid = true;
      t.mock.timers.setTime(Date.now() + 60_000);
      await refresh();
      assert.equal(stats.getApiStats().provider.callsToday, 7500);
      offline = true;
      t.mock.timers.setTime(Date.now() + 60_000);
      await refresh();
      assert.equal(calls, 3);
      assert.equal(stats.getApiStats().provider.callsToday, 7500);
    });
  } finally {
    if (oldStore == null) delete process.env.METRICS_STORE_PATH;
    else process.env.METRICS_STORE_PATH = oldStore;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
