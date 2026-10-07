import assert from "node:assert/strict";
import test from "node:test";
import {
  getLiveStateSnapshot,
  publishLiveState,
  resetLiveStateForTests,
} from "../src/liveState";

function fixture(
  elapsed = 12,
  homeGoals = 0,
  date = "2026-09-08T18:00:00+00:00",
) {
  return {
    fixture: {
      id: 9001,
      date,
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

test("stato live: la sola riprogrammazione produce delta e revisione", async () => {
  resetLiveStateForTests();
  const first = await publishLiveState({ response: [fixture()] });
  const original = first?.upsert[0].schedule;
  assert.equal(original.scheduleRevision, 0);

  const changed = await publishLiveState({
    response: [fixture(12, 0, "2026-09-09T18:00:00+00:00")],
  });
  assert.equal(changed?.revision, 2);
  assert.equal(changed?.upsert.length, 1);
  assert.equal(changed?.upsert[0].schedule.originalScheduledAt, original.originalScheduledAt);
  assert.equal(changed?.upsert[0].schedule.effectiveKickoffAt, "2026-09-09T18:00:00+00:00");
  assert.equal(changed?.upsert[0].schedule.scheduleRevision, 1);
});

test("stato live: observedLiveAt resta stabile tra polling", async () => {
  resetLiveStateForTests();
  await publishLiveState({ response: [fixture()] });
  const firstObserved = getLiveStateSnapshot().fixtures[0].schedule.observedLiveAt;
  assert.ok(firstObserved);
  await publishLiveState({ response: [fixture()] });
  assert.equal(
    getLiveStateSnapshot().fixtures[0].schedule.observedLiveAt,
    firstObserved,
  );
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
