import assert from "node:assert/strict";
import test from "node:test";
import {
  isConfirmedScoringGoalEvent,
  reconcileFixtureEvents,
} from "../src/fixtureEvents";

function goal(teamId: number, minute: number, player: string | null) {
  return {
    time: { elapsed: minute },
    team: { id: teamId },
    player: { name: player },
    type: "Goal",
    detail: "Normal Goal",
  };
}

function fixture(home: number, away: number, events: any[]) {
  return {
    teams: { home: { id: 1 }, away: { id: 2 } },
    goals: { home, away },
    events,
  };
}

test("rimuove il Goal fantasma quando il punteggio ufficiale resta 0-0", () => {
  const phantom = goal(1, 7, null);
  assert.deepEqual(reconcileFixtureEvents(fixture(0, 0, [phantom])), []);
});

test("conferma soltanto il numero di reti presente nel punteggio ufficiale", () => {
  const phantom = goal(1, 7, null);
  const confirmed = goal(1, 18, "Mario Rossi");
  const card = { type: "Card", detail: "Yellow Card", team: { id: 2 } };
  assert.deepEqual(
    reconcileFixtureEvents(fixture(1, 0, [phantom, confirmed, card])),
    [confirmed, card],
  );
});

test("rigore sbagliato e goal annullato non vengono trattati come reti", () => {
  const missed = {
    ...goal(1, 20, "Mario Rossi"),
    detail: "Missed Penalty",
  };
  const cancelled = {
    ...goal(1, 21, "Mario Rossi"),
    detail: "Goal cancelled",
  };
  assert.equal(isConfirmedScoringGoalEvent(missed), false);
  assert.equal(isConfirmedScoringGoalEvent(cancelled), false);
  assert.deepEqual(
    reconcileFixtureEvents(fixture(0, 0, [missed, cancelled])),
    [missed, cancelled],
  );
});
