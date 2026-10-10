import assert from "node:assert/strict";
import test from "node:test";
import {
  getLiveStateSnapshot,
  getLiveRawFixtures,
  publishLiveDiscoveries,
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

test("stato live: assenze ravvicinate non fanno lampeggiare la partita", async () => {
  resetLiveStateForTests();
  const start = new Date("2026-10-10T18:00:00Z");
  await publishLiveState({ response: [fixture()] }, { observedAt: start });

  const transient = await publishLiveState(
    { response: [] },
    { observedAt: new Date("2026-10-10T18:00:04Z") },
  );
  assert.equal(transient, null);
  assert.equal(getLiveStateSnapshot().fixtures.length, 1);

  const repeatedTooSoon = await publishLiveState(
    { response: [] },
    { observedAt: new Date("2026-10-10T18:00:08Z") },
  );
  assert.equal(repeatedTooSoon, null);
  assert.equal(getLiveStateSnapshot().fixtures.length, 1);

  const confirmed = await publishLiveState(
    { response: [] },
    { observedAt: new Date("2026-10-10T18:00:25Z") },
  );
  assert.deepEqual(confirmed?.remove, [9001]);
  assert.equal(getLiveStateSnapshot().fixtures.length, 0);
});

test("stato live: una lettura HTTP non autorevole non puo rimuovere fixture", async () => {
  resetLiveStateForTests();
  await publishLiveState(
    { response: [fixture()] },
    { observedAt: new Date("2026-10-10T18:00:00Z") },
  );

  for (const timestamp of [
    "2026-10-10T18:00:05Z",
    "2026-10-10T18:00:25Z",
    "2026-10-10T18:01:00Z",
  ]) {
    const delta = await publishLiveState(
      { response: [] },
      {
        observedAt: new Date(timestamp),
        authoritativeAbsence: false,
      },
    );
    assert.equal(delta, null);
    assert.equal(getLiveStateSnapshot().fixtures.length, 1);
  }
});

test("stato live: HTTP aggiunge una nuova fixture senza perdere quella esistente", async () => {
  resetLiveStateForTests();
  await publishLiveState({ response: [fixture(15)] });

  const discovered = fixture(2);
  discovered.fixture.id = 9002;
  discovered.teams.home.name = "Braga";
  discovered.teams.away.name = "Sporting";
  const delta = await publishLiveState(
    { response: [discovered] },
    { authoritativeAbsence: false },
  );

  assert.deepEqual(delta?.remove, []);
  assert.deepEqual(
    getLiveStateSnapshot().fixtures.map((row) => row.fixtureId).sort(),
    [9001, 9002],
  );
});

test("stato live: la ricomparsa azzera la conferma di assenza", async () => {
  resetLiveStateForTests();
  await publishLiveState(
    { response: [fixture()] },
    { observedAt: new Date("2026-10-10T18:00:00Z") },
  );
  await publishLiveState(
    { response: [] },
    { observedAt: new Date("2026-10-10T18:00:04Z") },
  );
  await publishLiveState(
    { response: [fixture(18)] },
    { observedAt: new Date("2026-10-10T18:00:12Z") },
  );

  const missingAgain = await publishLiveState(
    { response: [] },
    { observedAt: new Date("2026-10-10T18:00:30Z") },
  );
  assert.equal(missingAgain, null);
  assert.equal(getLiveStateSnapshot().fixtures.length, 1);
});

test("stato live: una fixture scoperta da una lettura fresca entra nello snapshot autorevole", async () => {
  resetLiveStateForTests();
  await publishLiveState({ response: [fixture(9)] });

  const second = fixture(2);
  second.fixture.id = 9002;
  second.teams.home.name = "Braga";
  second.teams.away.name = "Sporting";
  const delta = await publishLiveState({ response: [fixture(10), second] });

  assert.equal(delta?.revision, 2);
  assert.deepEqual(
    getLiveStateSnapshot().fixtures.map((row) => row.fixtureId).sort(),
    [9001, 9002],
  );
  assert.equal(delta?.upsert.some((row) => row.fixtureId === 9002), true);
});

test("la giornata pubblica una nuova live senza rimuovere le altre dirette", async () => {
  resetLiveStateForTests();
  await publishLiveState({ response: [fixture(18, 1)] });

  const discovered = fixture(2);
  discovered.fixture.id = 9002;
  discovered.teams.home.name = "Braga";
  discovered.teams.away.name = "Sporting";
  const scheduled = fixture(0);
  scheduled.fixture.id = 9003;
  scheduled.fixture.status = { short: "NS", elapsed: null };

  const delta = await publishLiveDiscoveries({
    response: [discovered, scheduled],
  });

  assert.equal(delta?.remove.length, 0);
  assert.deepEqual(
    getLiveStateSnapshot().fixtures.map((row) => row.fixtureId).sort(),
    [9001, 9002],
  );
  assert.deepEqual(
    getLiveRawFixtures().map((row) => row.fixture.id).sort(),
    [9001, 9002],
  );
  assert.equal(getLiveStateSnapshot().revision, 2);

  const duplicate = await publishLiveDiscoveries({ response: [discovered] });
  assert.equal(duplicate, null);
  assert.equal(getLiveStateSnapshot().revision, 2);
});
