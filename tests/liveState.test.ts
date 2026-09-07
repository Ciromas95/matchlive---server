import assert from "node:assert/strict";
import test from "node:test";
import {
  getLiveStateSnapshot,
  publishLiveState,
  resetLiveStateForTests,
} from "../src/liveState";

function fixture(elapsed = 12, homeGoals = 0) {
  return {
    fixture: {
      id: 9001,
      date: "2026-09-08T18:00:00+00:00",
      status: { short: "1H", elapsed },
    },
    league: { id: 135, name: "Serie A", country: "Italy" },
    teams: {
      home: { id: 1, name: "Casa", logo: "home.png" },
      away: { id: 2, name: "Ospite", logo: "away.png" },
    },
    goals: { home: homeGoals, away: 0 },
    events: [],
  };
}

test("stato live: pubblica solo variazioni e mantiene la revisione coerente", async () => {
  resetLiveStateForTests();
  const first = await publishLiveState({ response: [fixture()] });
  assert.equal(first?.revision, 1);
  assert.equal(first?.upsert.length, 1);
  assert.equal(getLiveStateSnapshot().fixtures.length, 1);

  const unchanged = await publishLiveState({ response: [fixture()] });
  assert.equal(unchanged, null);
  assert.equal(getLiveStateSnapshot().revision, 1);

  const goal = await publishLiveState({ response: [fixture(13, 1)] });
  assert.equal(goal?.revision, 2);
  assert.equal(goal?.upsert[0].goals.home, 1);
});

test("stato live: una singola risposta vuota non fa sparire la partita", async () => {
  resetLiveStateForTests();
  await publishLiveState({ response: [fixture()] });

  const transient = await publishLiveState({ response: [] });
  assert.equal(transient, null);
  assert.equal(getLiveStateSnapshot().fixtures.length, 1);

  const confirmed = await publishLiveState({ response: [] });
  assert.deepEqual(confirmed?.remove, [9001]);
  assert.equal(getLiveStateSnapshot().fixtures.length, 0);
});
