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

test("a relegation final never replaces the league champion", () => {
  const standings = { response: [{ league: { standings: [[
    { rank: 1, group: "Ligue 1", team: { id: 85, name: "Paris Saint Germain" } },
    { rank: 16, group: "Ligue 1", team: { id: 84, name: "Nice" } },
  ]] } }] };
  const fixtures = { response: [{
    fixture: { date: "2026-05-29T18:45:00Z", status: { short: "FT" } },
    league: { round: "Final" },
    teams: {
      home: { id: 84, name: "Nice", winner: true },
      away: { id: 1063, name: "Saint Etienne", winner: false },
    },
    goals: { home: 4, away: 1 },
  }] };
  assert.equal(resolveCompetitionChampion(
    "groups_then_knockout",
    standings,
    fixtures,
    { competitionType: "League" },
  )?.name, "Paris Saint Germain");
});

test("a championship round is authoritative over qualification finals", () => {
  const standings = { response: [{ league: { standings: [
    [
      { rank: 1, group: "Superliga, Championship Round", team: { id: 1, name: "Aarhus" } },
      { rank: 2, group: "Superliga, Championship Round", team: { id: 2, name: "Midtjylland" } },
    ],
    [
      { rank: 1, group: "Superliga, Relegation Round", team: { id: 3, name: "Copenhagen" } },
    ],
  ] } }] };
  const fixtures = { response: [{
    fixture: { date: "2026-05-29T18:45:00Z", status: { short: "FT" } },
    league: { round: "Final" },
    teams: {
      home: { id: 3, name: "Copenhagen", winner: true },
      away: { id: 4, name: "Brondby", winner: false },
    },
    goals: { home: 2, away: 1 },
  }] };
  assert.equal(resolveCompetitionChampion(
    "groups_then_knockout",
    standings,
    fixtures,
    { competitionType: "League" },
  )?.name, "Aarhus");
});

test("a league explicitly marked Final Series keeps its playoff champion", () => {
  const standings = { response: [{ league: { standings: [[
    {
      rank: 1,
      group: "A-League",
      description: "Final Series",
      team: { id: 1, name: "Premiers" },
    },
    { rank: 2, group: "A-League", team: { id: 2, name: "Champions" } },
  ]] } }] };
  const fixtures = { response: [{
    fixture: { date: "2026-05-29T18:45:00Z", status: { short: "FT" } },
    league: { round: "Grand Final" },
    teams: {
      home: { id: 1, name: "Premiers", winner: false },
      away: { id: 2, name: "Champions", winner: true },
    },
    goals: { home: 1, away: 2 },
  }] };
  assert.equal(resolveCompetitionChampion(
    "groups_then_knockout",
    standings,
    fixtures,
    { competitionType: "League" },
  )?.name, "Champions");
});

test("a two-legged cup final is resolved by aggregate score", () => {
  const fixtures = { response: [
    {
      fixture: { date: "2026-05-20T18:45:00Z", status: { short: "FT" } },
      league: { round: "Final" },
      teams: {
        home: { id: 1, name: "Alpha", winner: true },
        away: { id: 2, name: "Beta", winner: false },
      },
      goals: { home: 3, away: 0 },
    },
    {
      fixture: { date: "2026-05-27T18:45:00Z", status: { short: "FT" } },
      league: { round: "Final" },
      teams: {
        home: { id: 2, name: "Beta", winner: true },
        away: { id: 1, name: "Alpha", winner: false },
      },
      goals: { home: 2, away: 0 },
    },
  ] };
  assert.equal(resolveCompetitionChampion(
    "knockout",
    { response: [] },
    fixtures,
    { competitionType: "Cup" },
  )?.name, "Alpha");
});
