import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFixtureDayPayload,
  mergeProviderFixturePayloads,
  shiftFixtureDay,
} from "../src/fixtureDay";
import {
  getLiveRawFixtures,
  getLiveStateSnapshot,
  publishLiveDiscoveries,
  publishLiveState,
  resetLiveStateForTests,
} from "../src/liveState";

const fixtureId = 304;

function fixture(status: string, elapsed: number | null = null) {
  return {
    fixture: {
      id: fixtureId,
      date: "2026-10-03T18:30:00+02:00",
      status: { short: status, long: status, elapsed },
    },
    league: {
      id: 135,
      name: "Serie A",
      country: "Italy",
      season: 2026,
    },
    teams: {
      home: { id: 1, name: "Casa", logo: "home.png" },
      away: { id: 2, name: "Ospite", logo: "away.png" },
    },
    goals: { home: 0, away: 0 },
    events: [],
  };
}

function providerDay(rows: any[]) {
  return {
    get: "fixtures",
    parameters: {},
    errors: [],
    results: rows.length,
    paging: { current: 1, total: 1 },
    response: rows,
  };
}

test("Tutte e Live condividono subito una fixture appena iniziata", async () => {
  resetLiveStateForTests();
  const justStarted = fixture("1H", 2);
  justStarted.fixture.date = "2026-10-10T20:45:00+02:00";

  await publishLiveDiscoveries(
    providerDay([justStarted]),
    { observedAt: new Date("2026-10-10T20:47:00+02:00") },
  );
  const snapshot = getLiveStateSnapshot();
  const day = buildFixtureDayPayload(
    "2026-10-10",
    providerDay([justStarted]),
    snapshot,
    getLiveRawFixtures(),
  );

  assert.equal(snapshot.fixtures.length, 1);
  assert.equal(snapshot.fixtures[0].fixtureId, fixtureId);
  assert.equal(day.response.length, 1);
  assert.equal(day.response[0].fixture.id, fixtureId);
  assert.equal(day.brainlive.liveRevision, snapshot.revision);
});

test("E2E logico: fixture 3 ottobre live il 4 viene spostata senza duplicati", async () => {
  resetLiveStateForTests();

  const initialDay3 = buildFixtureDayPayload(
    "2026-10-03",
    providerDay([fixture("PST")]),
    getLiveStateSnapshot(),
    getLiveRawFixtures(),
  );
  assert.deepEqual(initialDay3.response.map((row: any) => row.fixture.id), [fixtureId]);

  for (const [status, elapsed] of [
    ["1H", 4],
    ["1H", 5],
    ["1H", 6],
    ["HT", 45],
    ["2H", 49],
  ] as const) {
    await publishLiveState(
      { response: [fixture(status, elapsed)] },
      { observedAt: new Date(`2026-10-04T18:${elapsed === 4 ? "34" : "35"}:00+02:00`) },
    );

    const day3 = buildFixtureDayPayload(
      "2026-10-03",
      providerDay([fixture("PST")]),
      getLiveStateSnapshot(),
      getLiveRawFixtures(),
    );
    const day4 = buildFixtureDayPayload(
      "2026-10-04",
      providerDay([]),
      getLiveStateSnapshot(),
      getLiveRawFixtures(),
    );
    assert.equal(day3.response.some((row: any) => row.fixture.id === fixtureId), false);
    assert.equal(day4.response.filter((row: any) => row.fixture.id === fixtureId).length, 1);
    const moved = day4.response[0];
    assert.equal(moved.fixture.date, "2026-10-03T18:30:00+02:00");
    assert.equal(moved.fixture.schedule.providerKickoffAt, moved.fixture.date);
    assert.equal(moved.fixture.schedule.originalScheduledAt, moved.fixture.date);
    assert.equal(moved.fixture.schedule.displayDay, "2026-10-04");
    assert.equal(
      moved.fixture.schedule.observedLiveAt,
      "2026-10-04T16:34:00.000Z",
    );
  }
});

test("merge per fixtureId mantiene una sola riga quando calendario e live coincidono", async () => {
  resetLiveStateForTests();
  const normal = fixture("1H", 8);
  normal.fixture.date = "2026-10-04T20:45:00+02:00";
  await publishLiveState(
    { response: [normal] },
    { observedAt: new Date("2026-10-04T20:53:00+02:00") },
  );
  const day4 = buildFixtureDayPayload(
    "2026-10-04",
    providerDay([normal]),
    getLiveStateSnapshot(),
    getLiveRawFixtures(),
  );
  assert.equal(day4.response.length, 1);
  assert.equal(day4.response[0].fixture.schedule.displayDay, "2026-10-04");
  assert.equal(day4.response[0].fixture.schedule.scheduleRevision, 0);
});

test("l'ordinamento usa l'orario Europe/Rome senza falsificare la data raw", async () => {
  resetLiveStateForTests();
  await publishLiveState(
    { response: [fixture("1H", 4)] },
    { observedAt: new Date("2026-10-04T18:34:00+02:00") },
  );
  const morning = fixture("NS");
  morning.fixture.id = 305;
  morning.fixture.date = "2026-10-04T10:00:00+02:00";
  const day4 = buildFixtureDayPayload(
    "2026-10-04",
    providerDay([morning]),
    getLiveStateSnapshot(),
    getLiveRawFixtures(),
  );
  assert.deepEqual(
    day4.response.map((row: any) => row.fixture.id),
    [305, fixtureId],
  );
  assert.equal(
    day4.response[1].fixture.date,
    "2026-10-03T18:30:00+02:00",
  );
});

test("fixture senza kickoff non viene assegnata arbitrariamente al giorno richiesto", () => {
  resetLiveStateForTests();
  const unknown = fixture("TBD");
  unknown.fixture.date = null as any;
  const result = buildFixtureDayPayload(
    "2026-10-04",
    providerDay([unknown]),
    getLiveStateSnapshot(),
    getLiveRawFixtures(),
  );
  assert.equal(result.response.length, 0);
});

test("uno snapshot ripristinato conserva il giorno operativo osservato", () => {
  const compact = {
    fixtureId,
    date: "2026-10-03T18:30:00+02:00",
    statusShort: "2H",
    elapsed: 70,
    lifecycle: {
      lifecycleState: "live",
      isLive: true,
      isActivelyPlaying: true,
      isPaused: false,
      isFinished: false,
      isScheduled: false,
      isPostponed: false,
      isCancelled: false,
      displayStatus: "2° TEMPO",
      providerStatusShort: "2H",
      providerStatusLong: null,
      resultType: null,
    },
    schedule: {
      providerKickoffAt: "2026-10-03T18:30:00+02:00",
      originalScheduledAt: "2026-10-03T18:30:00+02:00",
      effectiveKickoffAt: "2026-10-03T18:30:00+02:00",
      observedLiveAt: "2026-10-04T16:34:00.000Z",
      displayDay: "2026-10-04",
      scheduleRevision: 1,
    },
    league: { id: 135, name: "Serie A", country: "Italy" },
    home: { id: 1, name: "Casa" },
    away: { id: 2, name: "Ospite" },
    goals: { home: 1, away: 0 },
  };
  const restored = buildFixtureDayPayload(
    "2026-10-04",
    providerDay([]),
    {
      revision: 9,
      updatedAt: "2026-10-04T17:40:00.000Z",
      fixtures: [compact],
    },
    [],
  );
  assert.equal(restored.response.length, 1);
  assert.equal(restored.response[0].fixture.schedule.displayDay, "2026-10-04");
  assert.equal(restored.response[0].fixture.date, "2026-10-03T18:30:00+02:00");
});

test("la finestra provider precedente conserva una fixture dopo mezzanotte a Roma", () => {
  resetLiveStateForTests();
  const lateBrazil = fixture("FT", 90);
  lateBrazil.fixture.id = 1520912;
  lateBrazil.fixture.date = "2026-10-08T22:30:00+00:00";
  lateBrazil.league = {
    id: 72,
    name: "Serie B",
    country: "Brazil",
    season: 2026,
  };

  const mergedProvider = mergeProviderFixturePayloads(
    providerDay([]),
    [providerDay([lateBrazil])],
  );
  const day9 = buildFixtureDayPayload(
    "2026-10-09",
    mergedProvider,
    getLiveStateSnapshot(),
    getLiveRawFixtures(),
  );

  assert.equal(day9.response.length, 1);
  assert.equal(day9.response[0].fixture.id, 1520912);
  assert.equal(day9.response[0].fixture.date, "2026-10-08T22:30:00+00:00");
  assert.equal(day9.response[0].fixture.schedule.displayDay, "2026-10-09");
  assert.equal(shiftFixtureDay("2026-10-09", -1), "2026-10-08");
});
