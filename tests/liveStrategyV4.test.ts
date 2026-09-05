import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLiveV4, LiveObservationV4, LiveStatsV4 } from "../src/liveStrategyV4";

function stats(overrides: Partial<LiveStatsV4> = {}): LiveStatsV4 {
  return {
    shotsHome: 0, shotsAway: 0,
    shotsOnGoalHome: 0, shotsOnGoalAway: 0,
    cornersHome: 0, cornersAway: 0,
    possessionHome: 50, possessionAway: 50,
    xgHome: null, xgAway: null,
    redsHome: 0, redsAway: 0,
    shotsInsideBoxHome: 0, shotsInsideBoxAway: 0,
    goalkeeperSavesHome: 0, goalkeeperSavesAway: 0,
    ...overrides,
  };
}

function observation(elapsed: number, homeGoals: number, awayGoals: number, value: LiveStatsV4): LiveObservationV4 {
  return { elapsed, homeGoals, awayGoals, stats: value };
}

test("live V4: rileva una pressione eccezionale già al quinto minuto", () => {
  const result = evaluateLiveV4(observation(5, 0, 0, stats({
    shotsHome: 7, shotsAway: 1,
    shotsOnGoalHome: 3, shotsOnGoalAway: 0,
    cornersHome: 3, possessionHome: 72, possessionAway: 28,
    shotsInsideBoxHome: 5,
  })));
  assert.equal(result?.tagType, "homeDom");
  assert.equal(result?.signalKind, "pressure");
});

test("live V4: non insegue una squadra dominante già in vantaggio", () => {
  const result = evaluateLiveV4(observation(18, 1, 0, stats({
    shotsHome: 12, shotsAway: 2,
    shotsOnGoalHome: 6, shotsOnGoalAway: 0,
    cornersHome: 5, possessionHome: 70, possessionAway: 30,
  })));
  assert.equal(result, null);
});

test("live V4: segnala la squadra sotto di un gol che domina", () => {
  const result = evaluateLiveV4(observation(32, 1, 0, stats({
    shotsHome: 3, shotsAway: 13,
    shotsOnGoalHome: 1, shotsOnGoalAway: 6,
    cornersAway: 6, possessionHome: 34, possessionAway: 66,
    shotsInsideBoxAway: 8,
  })));
  assert.equal(result?.tagType, "awayDom");
  assert.equal(result?.signalKind, "equalizer");
  assert.equal(result?.goalTarget, "away");
});

test("live V4: scarta un incontro con due gol di distacco", () => {
  const result = evaluateLiveV4(observation(40, 0, 2, stats({
    shotsHome: 16, shotsAway: 3,
    shotsOnGoalHome: 7, shotsOnGoalAway: 1,
    cornersHome: 7,
  })));
  assert.equal(result, null);
});
