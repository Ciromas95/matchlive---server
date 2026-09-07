import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import {
  calculatePlayerProbability,
  eventMap,
  predictionAccuracy,
  slotsForFormation,
  type LineupResult,
} from "../src/lineupPrediction";

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: "Titolare",
  photo: null,
  number: 8,
  role: "C" as const,
  score: 5,
  starts: 6,
  bench: 1,
  positionSamples: 6,
  seasonStarts: 15,
  seasonAppearances: 18,
  seasonMinutes: 1300,
  ...overrides,
});

test("probabilità: continuità e ruolo stabile aumentano davvero lo score", () => {
  const stable = calculatePlayerProbability(candidate(), 5, 7, false);
  const uncertain = calculatePlayerProbability(
    candidate({ score: 2.2, starts: 2, positionSamples: 1, seasonStarts: 4 }),
    5,
    7,
    true,
  );
  assert.ok(stable >= 85);
  assert.ok(uncertain < stable);
  assert.ok(uncertain >= 28);
});

test("moduli: assegna sempre undici posti e usa un fallback sicuro", () => {
  assert.deepEqual(slotsForFormation("3-4-2-1"), { P: 1, D: 3, C: 6, A: 1 });
  assert.deepEqual(slotsForFormation("dato-rotto"), { P: 1, D: 4, C: 3, A: 3 });
});

test("eventi live: aggrega gol, assist, cartellini e sostituzioni per giocatore", () => {
  const map = eventMap({ response: [
    { type: "Goal", detail: "Normal Goal", player: { id: 10 }, assist: { id: 8 } },
    { type: "Goal", detail: "Normal Goal", player: { id: 10 } },
    { type: "Goal", detail: "Goal Disallowed", player: { id: 11 } },
    { type: "Card", detail: "Red Card", player: { id: 4 } },
    { type: "Card", detail: "Second Yellow card", player: { id: 5 } },
    { type: "subst", time: { elapsed: 67 }, player: { id: 10, name: "Mario Rossi" }, assist: { id: 19, name: "Luca Bianchi" } },
  ] });
  assert.equal(map.get(10)?.goals, 2);
  assert.equal(map.get(11)?.goals, undefined);
  assert.equal(map.get(8)?.assists, 1);
  assert.equal(map.get(4)?.red, 1);
  assert.equal(map.get(5)?.red, 1);
  assert.equal(map.get(10)?.out, 67);
  assert.equal(map.get(19)?.in, 67);
  assert.deepEqual(map.get(10)?.substitution, { direction: "out", minute: 67, withId: 19, withName: "Luca Bianchi" });
  assert.deepEqual(map.get(19)?.substitution, { direction: "in", minute: 67, withId: 10, withName: "Mario Rossi" });
});

test("accuratezza: confronta la previsione salvata con gli undici ufficiali", () => {
  const team = (ids: number[]) => ({ id: 1, name: "Team", logo: null, formation: "4-3-3", coach: null,
    starters: ids.map((id) => ({ id, name: `${id}`, photo: null, number: null, role: "C" as const, probability: 80, confirmed: false })), bench: [] });
  const base = { fixtureId: 7, generatedAt: new Date().toISOString(), confidence: null, sample: { home: 5, away: 5 } };
  const predicted: LineupResult = { ...base, status: "predicted", source: "brainlive", teams: { home: team([1, 2, 3]), away: team([4, 5, 6]) } };
  const official: LineupResult = { ...base, status: "official", source: "api-football", teams: { home: team([1, 2, 9]), away: team([4, 5, 8]) } };
  const accuracy = predictionAccuracy(predicted, official);
  assert.equal(accuracy.correct, 4);
  assert.equal(accuracy.total, 6);
  assert.equal(accuracy.percent, 66.7);
  assert.equal(accuracy.home.correct, 2);
  assert.equal(accuracy.away.correct, 2);
});

test("cache lineup: richieste concorrenti condividono una sola chiamata provider", async () => {
  const previousKey = process.env.API_FOOTBALL_KEY;
  const originalGet = axios.get;
  process.env.API_FOOTBALL_KEY = "test-key";
  let calls = 0;
  (axios as any).get = async () => {
    calls += 1;
    return { headers: {}, data: { errors: [], response: [{ team: { id: 1 }, startXI: Array(11).fill({ player: { id: 1 } }) }] } };
  };
  try {
    const { getFixtureLineupsCached } = await import("../src/apiFootball");
    await Promise.all([getFixtureLineupsCached(998877), getFixtureLineupsCached(998877), getFixtureLineupsCached(998877)]);
    assert.equal(calls, 1);
  } finally {
    (axios as any).get = originalGet;
    if (previousKey == null) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = previousKey;
  }
});
