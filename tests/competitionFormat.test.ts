import test from "node:test";
import assert from "node:assert/strict";
import { inferCompetitionFormat, resolveCompetitionChampion } from "../src/competitionFormat";

test("detects grouped competitions", () => {
  const standings = { response: [{ league: { standings: [
    [{ group: "Group A" }, { group: "Group A" }],
    [{ group: "Group B" }, { group: "Group B" }],
  ] } }] };
  const result = inferCompetitionFormat(1, 2026, standings, { response: [] });
  assert.equal(result.competitionFormat, "groups_then_knockout");
  assert.deepEqual(result.phases.map((value) => value.label), [
    "Gironi", "Sedicesimi", "Ottavi", "Quarti", "Semifinali", "Finale",
  ]);
});

test("detects hybrid and current knockout view", () => {
  const standings = { response: [{ league: { standings: [[{ group: "League" }, { group: "League" }]] } }] };
  const fixtures = { response: [{ fixture: { date: new Date(Date.now() + 1000).toISOString(), status: { short: "NS" } }, league: { round: "Quarter-finals" } }] };
  const result = inferCompetitionFormat(2, 2026, standings, fixtures);
  assert.equal(result.competitionFormat, "single_table_then_knockout");
  assert.equal(result.activeView, "knockout");
});

test("the modern UEFA format exposes qualifying and knockout play-offs", () => {
  const result = inferCompetitionFormat(2, 2026, { response: [] }, {
    response: [{
      fixture: { date: new Date(Date.now() + 1000).toISOString(), status: { short: "NS" } },
      league: { round: "Playoff Round" },
    }],
  });
  assert.equal(result.activeView, "qualification");
  assert.deepEqual(result.phases.map((value) => value.label), [
    "Qualificazione", "Play-off", "Fase campionato", "Spareggi",
    "Ottavi", "Quarti", "Semifinali", "Finale",
  ]);
});

test("keeps the historical Champions League group format", () => {
  const result = inferCompetitionFormat(2, 2023, { response: [] }, { response: [] });
  assert.equal(result.competitionFormat, "groups_then_knockout");
  assert.equal(result.source, "catalog");
});

test("a cup champion comes from the completed final, never the table", () => {
  const standings = { response: [{ league: { standings: [[
    { rank: 1, team: { id: 42, name: "Arsenal" } },
  ]] } }] };
  const fixtures = { response: [{
    fixture: { date: "2026-05-30T20:00:00Z", status: { short: "PEN" } },
    league: { round: "Final" },
    teams: {
      home: { id: 85, name: "PSG", winner: true },
      away: { id: 42, name: "Arsenal", winner: false },
    },
    goals: { home: 1, away: 1 },
  }] };
  assert.equal(resolveCompetitionChampion("single_table_then_knockout", standings, fixtures)?.name, "PSG");
});

test("a league champion still comes from the final table", () => {
  const standings = { response: [{ league: { standings: [[
    { rank: 1, team: { id: 1, name: "Napoli" } },
  ]] } }] };
  assert.equal(resolveCompetitionChampion("round_robin", standings, { response: [] })?.name, "Napoli");
});
