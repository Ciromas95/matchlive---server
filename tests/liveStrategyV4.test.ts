import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLiveV4, LiveObservationV4, LiveStatsV4 } from "../src/liveStrategyV4";
import { isLiveSignalDiscoveryMinute, shouldRetainLiveSignal } from "../src/brainLive";

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

test("live V4: segnala entro il 30' la squadra sotto di un gol che domina", () => {
  const result = evaluateLiveV4(observation(28, 1, 0, stats({
    shotsHome: 3, shotsAway: 13,
    shotsOnGoalHome: 1, shotsOnGoalAway: 6,
    cornersAway: 6, possessionHome: 34, possessionAway: 66,
    shotsInsideBoxAway: 8,
  })));
  assert.equal(result?.tagType, "awayDom");
  assert.equal(result?.signalKind, "equalizer");
  assert.equal(result?.goalTarget, "away");
});

test("live V4: non pubblica nuove analisi dal 35' all'intervallo", () => {
  const result = evaluateLiveV4(observation(35, 1, 0, stats({
    shotsHome: 3, shotsAway: 13,
    shotsOnGoalHome: 1, shotsOnGoalAway: 6,
    cornersAway: 6, possessionHome: 34, possessionAway: 66,
    shotsInsideBoxAway: 8,
  })));
  assert.equal(result, null);
});

test("live V4: non pubblica nuove analisi dopo l'80'", () => {
  const result = evaluateLiveV4({
    ...observation(81, 1, 1, stats({
      shotsHome: 9, shotsAway: 10,
      shotsOnGoalHome: 4, shotsOnGoalAway: 5,
      cornersHome: 4, cornersAway: 5,
    })),
    phaseElapsed: 36,
  });
  assert.equal(result, null);
});

test("live: separa la finestra di scoperta dalla permanenza della card", () => {
  assert.equal(isLiveSignalDiscoveryMinute(34), true);
  assert.equal(isLiveSignalDiscoveryMinute(35), false);
  assert.equal(isLiveSignalDiscoveryMinute(80), true);
  assert.equal(isLiveSignalDiscoveryMinute(81), false);
  assert.equal(shouldRetainLiveSignal(30, 44, "1H"), true);
  assert.equal(shouldRetainLiveSignal(30, 45, "HT"), true);
  assert.equal(shouldRetainLiveSignal(30, 46, "2H"), false);
  assert.equal(shouldRetainLiveSignal(80, 88, "2H"), true);
  assert.equal(shouldRetainLiveSignal(80, 89, "2H"), false);
});

test("live V4: scarta un incontro con due gol di distacco", () => {
  const result = evaluateLiveV4(observation(40, 0, 2, stats({
    shotsHome: 16, shotsAway: 3,
    shotsOnGoalHome: 7, shotsOnGoalAway: 1,
    cornersHome: 7,
  })));
  assert.equal(result, null);
});
