import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLiveV3, LiveObservationV3, parseLiveStatsV3 } from "../src/liveStrategyV3";

function observation(): LiveObservationV3 {
  return {
    elapsed: 30, homeGoals: 0, awayGoals: 0,
    stats: {
      shotsHome: 10, shotsAway: 2, shotsOnGoalHome: 5, shotsOnGoalAway: 0,
      cornersHome: 5, cornersAway: 0, possessionHome: 66, possessionAway: 34,
      xgHome: 1.3, xgAway: 0.1, redsHome: 0, redsAway: 0,
    },
  };
}

test("live: expected_goals viene letto e le squadre sono abbinate per ID", () => {
  const stats = parseLiveStatsV3({ response: [
    { team: { id: 2 }, statistics: [{ type: "expected_goals", value: "0.20" }] },
    { team: { id: 1 }, statistics: [{ type: "expected_goals", value: "1.40" }] },
  ] }, 1, 2);
  assert.equal(stats?.xgHome, 1.4);
  assert.equal(stats?.xgAway, 0.2);
});

test("live: dominio sostenuto da tiri reali genera una segnalazione", () => {
  const result = evaluateLiveV3(observation());
  assert.equal(result?.tagType, "homeDom");
  assert.ok((result?.finalScore ?? 0) >= 62);
});

test("live: solo possesso palla o dati incompleti non generano una card", () => {
  const current = observation();
  current.stats.shotsOnGoalHome = null;
  assert.equal(evaluateLiveV3(current), null);
});

test("live: una pressione ferma da cinque minuti non viene riproposta", () => {
  const current = observation();
  const previous = { ...observation(), elapsed: 25 };
  assert.equal(evaluateLiveV3(current, previous), null);
});

test("live: espulsione della squadra dominante impedisce la segnalazione automatica", () => {
  const current = observation();
  current.stats.redsHome = 1;
  assert.equal(evaluateLiveV3(current), null);
});
