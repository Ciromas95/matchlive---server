import assert from "node:assert/strict";
import test from "node:test";
import {
  displayDayInRome,
  fixtureScheduleOf,
} from "../src/fixtureSchedule";
import { toLiveCompact } from "../src/compact";

function fixture(date: string | null, status = "NS") {
  return {
    fixture: {
      id: 71,
      date,
      status: { short: status },
    },
  };
}

test("fixture normale: conserva provider, effective e giorno Europe/Rome", () => {
  const schedule = fixtureScheduleOf(
    fixture("2026-10-05T20:45:00+02:00"),
    { observedAt: "2026-10-05T10:00:00Z" },
  );
  assert.equal(schedule.providerKickoffAt, "2026-10-05T20:45:00+02:00");
  assert.equal(schedule.originalScheduledAt, "2026-10-05T20:45:00+02:00");
  assert.equal(schedule.effectiveKickoffAt, "2026-10-05T20:45:00+02:00");
  assert.equal(schedule.displayDay, "2026-10-05");
  assert.equal(schedule.scheduleRevision, 0);
  assert.equal(schedule.observedLiveAt, null);
});

test("displayDay converte esplicitamente la mezzanotte in Europe/Rome", () => {
  assert.equal(displayDayInRome("2026-10-04T22:30:00Z"), "2026-10-05");
  assert.equal(displayDayInRome("2026-12-31T23:30:00Z"), "2027-01-01");
});

test("displayDay usa Europe/Rome anche sui cambi di ora legale", () => {
  assert.equal(displayDayInRome("2026-03-28T23:30:00Z"), "2026-03-29");
  assert.equal(displayDayInRome("2026-10-25T23:30:00Z"), "2026-10-26");
});

test("una riprogrammazione conserva l'originale e incrementa la revisione", () => {
  const original = fixtureScheduleOf(fixture("2026-10-03T18:00:00Z"));
  const revised = fixtureScheduleOf(fixture("2026-10-04T18:00:00Z"), {
    previous: original,
  });
  assert.equal(revised.originalScheduledAt, "2026-10-03T18:00:00Z");
  assert.equal(revised.effectiveKickoffAt, "2026-10-04T18:00:00Z");
  assert.equal(revised.scheduleRevision, 1);
});

test("NS → 1H valorizza observedLiveAt una volta sola", () => {
  const scheduled = fixtureScheduleOf(fixture("2026-10-05T18:00:00Z", "NS"));
  const live = fixtureScheduleOf(fixture("2026-10-05T18:00:00Z", "1H"), {
    previous: scheduled,
    observedAt: "2026-10-05T18:04:00Z",
  });
  const nextPoll = fixtureScheduleOf(fixture("2026-10-05T18:00:00Z", "1H"), {
    previous: live,
    observedAt: "2026-10-05T18:05:00Z",
  });
  assert.equal(live.observedLiveAt, "2026-10-05T18:04:00.000Z");
  assert.equal(nextPoll.observedLiveAt, live.observedLiveAt);
});

test("fixture già live al primo avvistamento valorizza observedLiveAt", () => {
  const schedule = fixtureScheduleOf(fixture("2026-10-05T18:00:00Z", "HT"), {
    observedAt: "2026-10-05T18:51:00Z",
  });
  assert.equal(schedule.observedLiveAt, "2026-10-05T18:51:00.000Z");
});

test("live con data provider vecchia usa il giorno operativo osservato", () => {
  const postponed = fixtureScheduleOf(
    fixture("2026-10-03T18:30:00+02:00", "PST"),
  );
  const live = fixtureScheduleOf(
    fixture("2026-10-03T18:30:00+02:00", "1H"),
    {
      previous: postponed,
      observedAt: "2026-10-04T18:34:00+02:00",
    },
  );
  assert.equal(live.providerKickoffAt, postponed.providerKickoffAt);
  assert.equal(live.originalScheduledAt, postponed.originalScheduledAt);
  assert.equal(live.observedLiveAt, "2026-10-04T16:34:00.000Z");
  assert.equal(live.displayDay, "2026-10-04");
  assert.equal(live.scheduleRevision, 1);
});

test("una gara a cavallo della mezzanotte resta nel giorno di avvio", () => {
  const firstLive = fixtureScheduleOf(
    fixture("2026-10-04T23:50:00+02:00", "1H"),
    { observedAt: "2026-10-04T23:55:00+02:00" },
  );
  const afterMidnight = fixtureScheduleOf(
    fixture("2026-10-04T23:50:00+02:00", "2H"),
    {
      previous: firstLive,
      observedAt: "2026-10-05T00:20:00+02:00",
    },
  );
  assert.equal(afterMidnight.observedLiveAt, firstLive.observedLiveAt);
  assert.equal(afterMidnight.displayDay, "2026-10-04");
  assert.equal(afterMidnight.scheduleRevision, 0);
});

test("prima osservazione poco dopo mezzanotte non crea un falso rebucketing", () => {
  const live = fixtureScheduleOf(
    fixture("2026-10-04T23:50:00+02:00", "1H"),
    { observedAt: "2026-10-05T00:10:00+02:00" },
  );
  assert.equal(live.displayDay, "2026-10-04");
});

test("gli stati non live non valorizzano observedLiveAt e non cambiano giorno", () => {
  for (const status of ["NS", "TBD", "PST", "SUSP", "ABD", "CANC"]) {
    const schedule = fixtureScheduleOf(
      fixture("2026-10-03T18:30:00+02:00", status),
      { observedAt: "2026-10-04T18:34:00+02:00" },
    );
    assert.equal(schedule.observedLiveAt, null, status);
    assert.equal(schedule.displayDay, "2026-10-03", status);
  }
});

test("senza una data affidabile non inventa kickoff o giorno", () => {
  const schedule = fixtureScheduleOf(fixture(null));
  assert.equal(schedule.providerKickoffAt, null);
  assert.equal(schedule.originalScheduledAt, null);
  assert.equal(schedule.effectiveKickoffAt, null);
  assert.equal(schedule.displayDay, null);
});

test("compact trasmette data provider, lifecycle e blocco schedule", async () => {
  const row = fixture("2026-10-05T20:45:00+02:00", "1H") as any;
  row.league = { id: 2, name: "Champions" };
  row.teams = {
    home: { id: 1, name: "Casa" },
    away: { id: 2, name: "Ospite" },
  };
  row.goals = { home: 0, away: 0 };
  const compact = await toLiveCompact(
    { response: [row] },
    { observedAt: new Date("2026-10-05T18:49:00Z") },
  );
  assert.equal(compact[0].date, "2026-10-05T20:45:00+02:00");
  assert.equal(compact[0].lifecycle.lifecycleState, "live");
  assert.equal(compact[0].schedule.providerKickoffAt, compact[0].date);
  assert.equal(compact[0].schedule.displayDay, "2026-10-05");
  assert.equal(compact[0].schedule.observedLiveAt, "2026-10-05T18:49:00.000Z");
});
