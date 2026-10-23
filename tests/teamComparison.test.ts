import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTeamPeriod,
  comparisonCacheKey,
  comparisonSeasonLabel,
  createTeamComparisonService,
  selectOfficialFixtures,
} from "../src/teamComparison";

function row(input: {
  id: number;
  date: string;
  status?: string;
  league?: string;
  season?: number;
  home?: number;
  away?: number;
  homeGoals?: number | null;
  awayGoals?: number | null;
  extraHome?: number | null;
  extraAway?: number | null;
}) {
  return {
    fixture: {
      id: input.id,
      date: input.date,
      status: { short: input.status ?? "FT" },
    },
    league: { name: input.league ?? "Serie A", season: input.season ?? 2026 },
    teams: {
      home: { id: input.home ?? 10 },
      away: { id: input.away ?? 20 },
    },
    goals: { home: input.homeGoals ?? 2, away: input.awayGoals ?? 1 },
    score: {
      extratime: { home: input.extraHome, away: input.extraAway },
    },
  };
}

test("seleziona soltanto gare ufficiali concluse, deduplicate e precedenti", () => {
  const valid = row({ id: 1, date: "2026-10-01T18:00:00Z" });
  const selected = selectOfficialFixtures(
    [
      {
        response: [
          valid,
          valid,
          row({ id: 2, date: "2026-10-02T18:00:00Z", league: "Friendlies" }),
          row({ id: 3, date: "2026-10-03T18:00:00Z", status: "NS" }),
          row({ id: 99, date: "2026-10-04T18:00:00Z" }),
          row({ id: 4, date: "2026-10-11T18:00:00Z" }),
          row({ id: 6, date: "2026-10-10T18:00:00Z" }),
          row({ id: 5, date: "2026-09-01T18:00:00Z", home: 30, away: 40 }),
        ],
      },
    ],
    10,
    "2026-10-10T18:00:00Z",
    99,
    2026,
  );
  assert.deepEqual(selected.map((value) => value.fixture.id), [1]);
});

test("le medie ignorano i valori mancanti senza convertirli in zero", () => {
  const rows = [
    row({ id: 1, date: "2026-10-01T18:00:00Z", homeGoals: 2, awayGoals: 1 }),
    row({ id: 2, date: "2026-10-04T18:00:00Z", homeGoals: 0, awayGoals: 0 }),
  ];
  const stats = new Map<number, any>([
    [
      1,
      {
        response: [
          {
            team: { id: 10 },
            statistics: [
              { type: "Total Shots", value: 12 },
              { type: "Ball Possession", value: "55%" },
            ],
          },
        ],
      },
    ],
    [2, { response: [{ team: { id: 10 }, statistics: [] }] }],
  ]);
  const result = aggregateTeamPeriod(rows, 10, stats);
  assert.equal(result.matches, 2);
  assert.deepEqual(result.metrics.goalsFor, { average: 1, samples: 2 });
  assert.deepEqual(result.metrics.totalShots, { average: 12, samples: 1 });
  assert.equal(result.metrics.shotsOnTarget, undefined);
  assert.deepEqual(result.metrics.possession, { average: 55, samples: 1 });
});

test("l'etichetta stagione indica correttamente un'annata a cavallo", () => {
  assert.equal(
    comparisonSeasonLabel(2026, [
      { response: [row({ id: 1, date: "2027-02-01T18:00:00Z" })] },
    ]),
    "2026/27",
  );
  assert.equal(
    comparisonSeasonLabel(2026, [
      { response: [row({ id: 1, date: "2026-05-01T18:00:00Z" })] },
    ]),
    "2026",
  );
});

test("include campionato e coppa ma ignora gare rinviate, sospese e abbandonate", () => {
  const selected = selectOfficialFixtures(
    [
      {
        response: [
          row({ id: 1, date: "2026-10-01T18:00:00Z", league: "Serie A" }),
          row({ id: 2, date: "2026-10-02T18:00:00Z", league: "Coppa Italia" }),
          row({ id: 6, date: "2026-10-02T20:00:00Z", league: "Champions League" }),
          row({ id: 3, date: "2026-10-03T18:00:00Z", status: "PST" }),
          row({ id: 4, date: "2026-10-04T18:00:00Z", status: "SUSP" }),
          row({ id: 5, date: "2026-10-05T18:00:00Z", status: "ABD" }),
        ],
      },
    ],
    10,
    "2026-10-10T18:00:00Z",
    99,
    2026,
  );
  assert.deepEqual(
    selected.map((value) => value.fixture.id),
    [6, 2, 1],
  );
});

test("ordina le gare ufficiali e conserva soltanto le cinque più recenti", () => {
  const selected = selectOfficialFixtures(
    [{ response: teamRows(10, 7) }],
    10,
    "2026-12-01T20:00:00Z",
    99,
    2026,
    5,
  );
  assert.deepEqual(
    selected.map((value) => value.fixture.id),
    [1006, 1005, 1004, 1003, 1002],
  );
});

test("usa il risultato dopo i supplementari senza contare i rigori", () => {
  const rows = [
    row({
      id: 1,
      date: "2026-10-01T18:00:00Z",
      status: "AET",
      homeGoals: 2,
      awayGoals: 2,
      extraHome: 3,
      extraAway: 2,
    }),
    row({
      id: 2,
      date: "2026-10-02T18:00:00Z",
      status: "PEN",
      homeGoals: 1,
      awayGoals: 1,
      extraHome: 1,
      extraAway: 1,
    }),
  ];
  const result = aggregateTeamPeriod(rows, 10, new Map());
  assert.deepEqual(result.metrics.goalsFor, { average: 2, samples: 2 });
  assert.deepEqual(result.metrics.goalsAgainst, { average: 1.5, samples: 2 });
});

function statsPayload(id: number, home = 10, away = 20) {
  return {
    response: [
      {
        team: { id: home },
        statistics: [
          { type: "Total Shots", value: 8 + (id % 4) },
          { type: "Shots on Goal", value: 3 },
          { type: "Ball Possession", value: "51%" },
          { type: "Corner Kicks", value: 4 },
        ],
      },
      {
        team: { id: away },
        statistics: [
          { type: "Total Shots", value: 7 },
          { type: "Shots on Goal", value: 2 },
          { type: "Ball Possession", value: "49%" },
          { type: "Corner Kicks", value: 3 },
        ],
      },
    ],
  };
}

let serviceFixtureId = 20_000;

function fakeComparison(input: {
  homeRows: any[];
  awayRows: any[];
  failFirstStats?: boolean;
}) {
  const fixtureId = serviceFixtureId++;
  const calls = {
    details: 0,
    seasons: [] as Array<{ teamId: number; season: number }>,
    stats: [] as number[],
  };
  let shouldFail = input.failFirstStats ?? false;
  const service = createTeamComparisonService({
    async getFixtureById() {
      calls.details += 1;
      return {
        response: [
          row({
            id: fixtureId,
            date: "2026-12-01T20:00:00Z",
            home: 10,
            away: 20,
            season: 2026,
          }),
        ],
      };
    },
    async getTeamSeasonFixtures(teamId, season) {
      calls.seasons.push({ teamId, season });
      return { response: teamId === 10 ? input.homeRows : input.awayRows };
    },
    async getFixtureStatistics(id) {
      calls.stats.push(id);
      if (shouldFail) {
        shouldFail = false;
        throw Object.assign(new Error("temporary provider error"), {
          source: "provider",
        });
      }
      return statsPayload(id);
    },
  });
  const request = () =>
    service({ fixtureId, homeTeamId: 10, awayTeamId: 20 });
  return { calls, fixtureId, request };
}

function teamRows(
  teamId: number,
  count: number,
  options?: { startId?: number; season?: number; league?: string },
) {
  const startId = options?.startId ?? teamId * 100;
  return Array.from({ length: count }, (_, index) =>
    row({
      id: startId + index,
      date: `2026-${String(index + 1).padStart(2, "0")}-01T18:00:00Z`,
      home: teamId,
      away: teamId === 10 ? 100 + index : 200 + index,
      season: options?.season ?? 2026,
      league: options?.league ?? (index % 2 === 0 ? "Serie A" : "Coppa Italia"),
    }),
  );
}

test("Ultime 5 usa al massimo cinque gare per squadra della sola stagione corrente", async () => {
  const homeCurrent = teamRows(10, 7);
  const awayCurrent = teamRows(20, 5);
  const previous = row({
    id: 9_999,
    date: "2025-11-01T18:00:00Z",
    home: 10,
    away: 30,
    season: 2025,
  });
  const fake = fakeComparison({
    homeRows: [...homeCurrent, previous],
    awayRows: awayCurrent,
  });
  const result = await fake.request();

  assert.equal(result.period, "lastFive");
  assert.equal(result.data.home.matches, 5);
  assert.equal(result.data.away.matches, 5);
  assert.equal(fake.calls.stats.includes(9_999), false);
  assert.deepEqual(
    [...new Set(fake.calls.seasons.map((value) => value.season))],
    [2026],
  );
});

test("Ultime 5 conserva un campione reale di tre gare senza completarlo", async () => {
  const fake = fakeComparison({
    homeRows: teamRows(10, 3),
    awayRows: teamRows(20, 5),
  });
  const result = await fake.request();
  assert.equal(result.data.home.matches, 3);
  assert.equal(result.data.away.matches, 5);
});

test("un'assenza reale di gare produce campioni vuoti senza statistiche inventate", async () => {
  const fake = fakeComparison({ homeRows: [], awayRows: [] });
  const result = await fake.request();
  assert.equal(result.data.home.matches, 0);
  assert.equal(result.data.away.matches, 0);
  assert.deepEqual(result.data.home.metrics, {});
  assert.equal(fake.calls.stats.length, 0);
});

test("la cache aggregata identifica fixture, squadre, stagione e istante limite", async () => {
  const fake = fakeComparison({
    homeRows: teamRows(10, 7),
    awayRows: teamRows(20, 7),
  });
  const lastFive = await fake.request();
  assert.equal(lastFive.period, "lastFive");
  assert.equal(lastFive.data.home.matches, 5);
  assert.equal(lastFive.data.away.matches, 5);
  assert.equal(fake.calls.stats.length, 10);

  const base = {
    fixtureId: fake.fixtureId,
    homeTeamId: 10,
    awayTeamId: 20,
    season: 2026,
    cutoffIso: "2026-12-01T20:00:00Z",
  };
  const key = comparisonCacheKey(base);
  assert.match(key, /lastFive/);
  assert.match(key, new RegExp(String(fake.fixtureId)));
  assert.match(key, /10:20:season-2026:before-/);
});

test("cache calda e richieste concorrenti non duplicano l'aggregazione", async () => {
  const fake = fakeComparison({
    homeRows: teamRows(10, 5),
    awayRows: teamRows(20, 4),
  });
  const [first, concurrent] = await Promise.all([
    fake.request(),
    fake.request(),
  ]);
  assert.deepEqual(first.data, concurrent.data);
  assert.equal(fake.calls.seasons.length, 2);
  assert.equal(fake.calls.stats.length, 9);

  await fake.request();
  assert.equal(fake.calls.seasons.length, 2);
  assert.equal(fake.calls.stats.length, 9);
});

test("un errore API-Football non memorizza un aggregato incompleto", async () => {
  const fake = fakeComparison({
    homeRows: teamRows(10, 2),
    awayRows: teamRows(20, 2),
    failFirstStats: true,
  });
  await assert.rejects(fake.request(), /temporary provider error/);
  const recovered = await fake.request();
  assert.equal(recovered.data.home.matches, 2);
  assert.equal(recovered.data.away.matches, 2);
  assert.equal(fake.calls.seasons.length, 4);
});
