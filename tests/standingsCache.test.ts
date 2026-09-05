import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

test("classifiche: richieste concorrenti condividono una chiamata API-Football ogni ora", async () => {
  const previousKey = process.env.API_FOOTBALL_KEY;
  const originalGet = axios.get;
  process.env.API_FOOTBALL_KEY = "test-key";
  let providerCalls = 0;
  (axios as any).get = async (url: string, options: any) => {
    providerCalls++;
    assert.match(url, /\/standings$/);
    assert.equal(options.params.league, 987654);
    assert.equal(options.params.season, 2026);
    return {
      headers: {},
      data: { response: [{ league: { id: 987654, standings: [] } }], errors: [] },
    };
  };
  try {
    const { getStandingsCached } = await import("../src/apiFootball");
    const results = await Promise.all([
      getStandingsCached(987654, 2026),
      getStandingsCached(987654, 2026),
      getStandingsCached(987654, 2026),
    ]);
    assert.equal(results.length, 3);
    assert.equal(providerCalls, 1);
    await getStandingsCached(987654, 2026);
    assert.equal(providerCalls, 1);
  } finally {
    (axios as any).get = originalGet;
    if (previousKey == null) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = previousKey;
  }
});

test("referti finali: tutti gli utenti condividono una sola chiamata", async () => {
  const previousKey = process.env.API_FOOTBALL_KEY;
  const originalGet = axios.get;
  process.env.API_FOOTBALL_KEY = "test-key";
  let providerCalls = 0;
  (axios as any).get = async (url: string, options: any) => {
    providerCalls++;
    assert.match(url, /\/fixtures$/);
    assert.equal(options.params.id, 7654321);
    return {
      headers: {},
      data: { response: [{ fixture: { id: 7654321 }, players: [] }], errors: [] },
    };
  };
  try {
    const { getFinishedFixtureDetailsCached } = await import("../src/apiFootball");
    await Promise.all([
      getFinishedFixtureDetailsCached(7654321),
      getFinishedFixtureDetailsCached(7654321),
      getFinishedFixtureDetailsCached(7654321),
    ]);
    assert.equal(providerCalls, 1);
    await getFinishedFixtureDetailsCached(7654321);
    assert.equal(providerCalls, 1);
  } finally {
    (axios as any).get = originalGet;
    if (previousKey == null) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = previousKey;
  }
});
