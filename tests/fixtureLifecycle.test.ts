import assert from "node:assert/strict";
import test from "node:test";
import {
  FixtureLifecycle,
  isFixtureKickoffTransition,
  normalizeFixtureStatus,
  withFixtureLifecycles,
} from "../src/fixtureLifecycle";

function lifecycle(short: string): FixtureLifecycle {
  return normalizeFixtureStatus({ short, long: `Provider ${short}` });
}

test("copre esplicitamente tutti gli status API-Football supportati", () => {
  const expected: Record<string, string> = {
    TBD: "scheduled",
    NS: "scheduled",
    "1H": "live",
    HT: "live_break",
    "2H": "live",
    ET: "live",
    BT: "live_break",
    P: "live",
    PEN_LIVE: "live",
    LIVE: "live",
    INT: "interrupted",
    SUSP: "suspended",
    FT: "finished",
    AET: "finished",
    PEN: "finished",
    PEN_FT: "finished",
    PST: "postponed",
    CANC: "cancelled",
    ABD: "abandoned",
    AWD: "finished",
    WO: "finished",
  };
  for (const [short, state] of Object.entries(expected)) {
    assert.equal(lifecycle(short).lifecycleState, state, short);
  }
});

test("normalizza il ciclo regolamentare NS → 1H → HT → 2H → FT", () => {
  const states = ["NS", "1H", "HT", "2H", "FT"].map(lifecycle);
  assert.equal(states[0].isScheduled, true);
  assert.equal(states[1].isActivelyPlaying, true);
  assert.deepEqual(
    {
      state: states[2].lifecycleState,
      live: states[2].isLive,
      active: states[2].isActivelyPlaying,
      paused: states[2].isPaused,
    },
    { state: "live_break", live: true, active: false, paused: true },
  );
  assert.equal(states[3].isActivelyPlaying, true);
  assert.equal(states[4].isFinished, true);
  assert.equal(states[4].resultType, "regular");
  assert.equal(isFixtureKickoffTransition(states[0], states[1]), true);
  assert.equal(isFixtureKickoffTransition(null, lifecycle("1H")), true);
  assert.equal(isFixtureKickoffTransition(null, lifecycle("INT")), false);
  assert.equal(isFixtureKickoffTransition(null, lifecycle("2H")), false);
});

test("normalizza supplementari e termine AET", () => {
  assert.equal(lifecycle("2H").isLive, true);
  assert.equal(lifecycle("ET").isActivelyPlaying, true);
  assert.equal(lifecycle("AET").isFinished, true);
  assert.equal(lifecycle("AET").resultType, "after_extra_time");
});

test("distingue rigori live e rigori conclusi", () => {
  for (const short of ["P", "PEN_LIVE"]) {
    const value = lifecycle(short);
    assert.equal(value.isLive, true);
    assert.equal(value.isActivelyPlaying, true);
    assert.equal(value.isFinished, false);
  }
  for (const short of ["PEN", "PEN_FT"]) {
    const value = lifecycle(short);
    assert.equal(value.isLive, false);
    assert.equal(value.isFinished, true);
    assert.equal(value.resultType, "penalties");
  }
});

test("LIVE → INT → LIVE non genera kickoff e INT non e realmente live", () => {
  const playing = lifecycle("LIVE");
  const interrupted = lifecycle("INT");
  const resumed = lifecycle("LIVE");
  assert.deepEqual(
    {
      state: interrupted.lifecycleState,
      live: interrupted.isLive,
      active: interrupted.isActivelyPlaying,
      paused: interrupted.isPaused,
      finished: interrupted.isFinished,
    },
    {
      state: "interrupted",
      live: false,
      active: false,
      paused: true,
      finished: false,
    },
  );
  assert.equal(isFixtureKickoffTransition(playing, interrupted), false);
  assert.equal(isFixtureKickoffTransition(interrupted, resumed), false);
});

test("LIVE → SUSP → LIVE non produce un secondo kickoff", () => {
  const suspended = lifecycle("SUSP");
  assert.equal(suspended.lifecycleState, "suspended");
  assert.equal(suspended.isPaused, true);
  assert.equal(suspended.isLive, false);
  assert.equal(isFixtureKickoffTransition(lifecycle("LIVE"), suspended), false);
  assert.equal(isFixtureKickoffTransition(suspended, lifecycle("LIVE")), false);
});

test("normalizza abbandono, assegnazione, walkover e rinvio", () => {
  const abandoned = lifecycle("ABD");
  assert.equal(abandoned.lifecycleState, "abandoned");
  assert.equal(abandoned.isFinished, false);

  const awarded = lifecycle("AWD");
  assert.equal(awarded.lifecycleState, "finished");
  assert.equal(awarded.isFinished, true);
  assert.equal(awarded.resultType, "awarded");

  const walkover = lifecycle("WO");
  assert.equal(walkover.lifecycleState, "finished");
  assert.equal(walkover.isFinished, true);
  assert.equal(walkover.resultType, "walkover");

  const postponed = lifecycle("PST");
  assert.equal(postponed.lifecycleState, "postponed");
  assert.equal(postponed.isPostponed, true);
});

test("uno status sconosciuto usa unknown e conserva i valori provider", () => {
  const value = normalizeFixtureStatus({ short: "xyz", long: "Provider state" });
  assert.equal(value.providerStatusShort, "XYZ");
  assert.equal(value.providerStatusLong, "Provider state");
  assert.equal(value.lifecycleState, "unknown");
  assert.equal(value.displayStatus, "Provider state");
  assert.equal(value.isLive, false);
});

test("arricchisce il payload senza alterare status.short/status.long", () => {
  const source = {
    response: [{ fixture: { id: 7, status: { short: "HT", long: "Halftime" } } }],
  };
  const enriched = withFixtureLifecycles(source);
  assert.equal(enriched.response[0].fixture.status.short, "HT");
  assert.equal(enriched.response[0].fixture.status.long, "Halftime");
  assert.equal(enriched.response[0].fixture.lifecycle.lifecycleState, "live_break");
  assert.equal(enriched.response[0].fixture.lifecycle.isPaused, true);
  assert.equal((source.response[0].fixture as any).lifecycle, undefined);
});
