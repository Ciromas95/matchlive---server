import test from "node:test";
import assert from "node:assert/strict";
import { primeLiveStandingsBaselines, projectLiveStandings, rememberCompletedStandingsFixture, resetLiveStandingsForTests } from "../src/liveStandings";

function row(id: number, rank: number, points: number, gf: number, ga: number) {
  const block = { played: 10, win: 0, draw: 0, lose: 0, goals: { for: gf, against: ga } };
  return { rank, team: { id, name: `Team ${id}` }, points, goalsDiff: gf - ga, all: structuredClone(block), home: structuredClone(block), away: structuredClone(block) };
}

function fixture(id: number, home: number, away: number, hg: number, ag: number, status = "2H") {
  return { fixture: { id, status: { short: status } }, league: { id: 135, season: 2026 }, teams: { home: { id: home }, away: { id: away } }, goals: { home: hg, away: ag } };
}

test("ricalcola atomicamente punti, reti e posizioni di più match live", () => {
  resetLiveStandingsForTests();
  const official = { response: [{ league: { standings: [[row(1, 1, 20, 15, 8), row(2, 2, 19, 14, 8), row(3, 3, 18, 13, 8), row(4, 4, 17, 12, 8)]] } }] };
  const projected = projectLiveStandings(official, [fixture(101, 1, 2, 0, 1), fixture(102, 3, 4, 2, 0)], 135, 2026);
  const rows = projected.response[0].league.standings[0];
  assert.deepEqual(rows.map((value: any) => value.team.id), [2, 3, 1, 4]);
  assert.equal(rows.find((value: any) => value.team.id === 2).points, 22);
  assert.equal(rows.find((value: any) => value.team.id === 3).all.goals.for, 15);
  assert.equal(projected._brainLive.provisional, true);
});

test("una partita sospesa non modifica la classifica", () => {
  resetLiveStandingsForTests();
  const official = { response: [{ league: { standings: [[row(1, 1, 20, 15, 8), row(2, 2, 19, 14, 8)]] } }] };
  projectLiveStandings(official, [fixture(103, 1, 2, 2, 0)], 135, 2026);
  const projected = projectLiveStandings(official, [fixture(103, 1, 2, 2, 0, "SUSP")], 135, 2026);
  assert.equal(projected.response[0].league.standings[0][0].points, 20);
  assert.equal(projected._brainLive.provisional, false);
});

test("mantiene il finale già proiettato finché il provider non lo assorbe", () => {
  resetLiveStandingsForTests();
  const official = { response: [{ league: { standings: [[row(1, 1, 20, 15, 8), row(2, 2, 19, 14, 8)]] } }] };
  projectLiveStandings(official, [fixture(104, 1, 2, 1, 0)], 135, 2026);
  rememberCompletedStandingsFixture(fixture(104, 1, 2, 1, 0, "FT"));
  const pending = projectLiveStandings(official, [], 135, 2026);
  assert.equal(pending.response[0].league.standings[0].find((value: any) => value.team.id === 1).points, 23);

  const absorbedOfficial = { response: [{ league: { standings: [[row(1, 1, 23, 16, 8), row(2, 2, 19, 14, 9)]] } }] };
  for (const value of absorbedOfficial.response[0].league.standings[0]) value.all.played = 11;
  const absorbed = projectLiveStandings(absorbedOfficial, [], 135, 2026);
  assert.equal(absorbed.response[0].league.standings[0].find((value: any) => value.team.id === 1).points, 23);
  assert.equal(absorbed._brainLive.provisional, false);
});

test("conserva il finale anche se nessuno ha aperto la classifica durante il live", async () => {
  resetLiveStandingsForTests();
  const official = { response: [{ league: { standings: [[row(1, 1, 20, 15, 8), row(2, 2, 19, 14, 8)]] } }] };
  await primeLiveStandingsBaselines(
    [fixture(105, 1, 2, 2, 1)],
    async () => official,
  );
  rememberCompletedStandingsFixture(fixture(105, 1, 2, 2, 1, "FT"));
  const projected = projectLiveStandings(official, [], 135, 2026);
  assert.equal(projected.response[0].league.standings[0].find((value: any) => value.team.id === 1).points, 23);
  assert.equal(projected._brainLive.provisional, true);
});
