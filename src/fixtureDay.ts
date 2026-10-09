import { normalizeFixtureStatus } from "./fixtureLifecycle";
import {
  FIXTURE_DISPLAY_TIME_ZONE,
  FixtureSchedule,
  fixtureScheduleFrom,
  fixtureScheduleOf,
  resolveFixtureDisplayDay,
} from "./fixtureSchedule";
import { LiveStateSnapshot } from "./liveState";

function fixtureIdOf(row: any): number {
  return Number(row?.fixture?.id ?? row?.fixtureId ?? 0);
}

function validDisplayDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

export function isValidFixtureDay(value: unknown): value is string {
  return validDisplayDay(value);
}

/**
 * Restituisce un giorno civile adiacente senza dipendere dal timezone del
 * processo Node. I parametri `date` di API-Football sono giorni UTC, mentre
 * la giornata BrainLive e Europe/Rome: per ricostruire le ore subito dopo
 * mezzanotte italiana serve quindi anche il giorno provider precedente.
 */
export function shiftFixtureDay(value: string, days: number): string {
  if (!validDisplayDay(value)) throw new Error("invalid_fixture_day");
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    shifted.getUTCFullYear().toString().padStart(4, "0"),
    (shifted.getUTCMonth() + 1).toString().padStart(2, "0"),
    shifted.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

/**
 * Combina piu finestre calendario API-Football conservando il contratto del
 * payload principale. La deduplicazione e sempre per fixtureId; in caso di
 * sovrapposizione prevale la riga della giornata richiesta.
 */
export function mergeProviderFixturePayloads(
  primaryPayload: any,
  additionalPayloads: any[] = [],
): any {
  const byId = new Map<number, any>();
  for (const payload of [...additionalPayloads, primaryPayload]) {
    const rows = Array.isArray(payload?.response) ? payload.response : [];
    for (const row of rows) {
      const id = fixtureIdOf(row);
      if (id > 0) byId.set(id, row);
    }
  }
  const response = [...byId.values()];
  return {
    ...(primaryPayload ?? {}),
    results: response.length,
    response,
  };
}

function canonicalizeSchedule(
  schedule: FixtureSchedule,
  lifecycle: ReturnType<typeof normalizeFixtureStatus>,
): FixtureSchedule {
  const displayDay = resolveFixtureDisplayDay({
    providerKickoffAt: schedule.providerKickoffAt,
    originalScheduledAt: schedule.originalScheduledAt,
    effectiveKickoffAt: schedule.effectiveKickoffAt,
    observedLiveAt: schedule.observedLiveAt,
    lifecycle,
  });
  if (displayDay === schedule.displayDay) return schedule;
  return {
    ...schedule,
    displayDay,
    scheduleRevision: schedule.scheduleRevision + 1,
  };
}

function mergeLiveIntoCalendar(calendar: any, liveRaw: any): any {
  if (liveRaw == null) return calendar;
  return {
    ...calendar,
    ...liveRaw,
    fixture: {
      ...(calendar?.fixture ?? {}),
      ...(liveRaw?.fixture ?? {}),
      // La risposta giornaliera del provider è più recente per la
      // programmazione; lo snapshot live aggiorna stato e punteggio, non deve
      // rimettere una vecchia fixture.date sopra una riprogrammazione nota.
      date: calendar?.fixture?.date ?? liveRaw?.fixture?.date ?? null,
    },
    league: { ...(calendar?.league ?? {}), ...(liveRaw?.league ?? {}) },
    teams: {
      home: {
        ...(calendar?.teams?.home ?? {}),
        ...(liveRaw?.teams?.home ?? {}),
      },
      away: {
        ...(calendar?.teams?.away ?? {}),
        ...(liveRaw?.teams?.away ?? {}),
      },
    },
    goals: { ...(calendar?.goals ?? {}), ...(liveRaw?.goals ?? {}) },
    score: { ...(calendar?.score ?? {}), ...(liveRaw?.score ?? {}) },
  };
}

function providerRowFromCompact(row: any): any {
  return {
    fixture: {
      id: row?.fixtureId ?? null,
      date: row?.date ?? null,
      status: {
        short: row?.statusShort ?? null,
        long: row?.statusLong ?? null,
        elapsed: row?.elapsed ?? null,
      },
    },
    league: { ...(row?.league ?? {}) },
    teams: {
      home: { ...(row?.home ?? {}) },
      away: { ...(row?.away ?? {}) },
    },
    goals: { ...(row?.goals ?? {}) },
    events: Array.isArray(row?.events) ? row.events : [],
  };
}

function attachCanonicalMetadata(
  row: any,
  schedule: FixtureSchedule,
  lifecycle: ReturnType<typeof normalizeFixtureStatus>,
): any {
  return {
    ...row,
    fixture: {
      ...(row?.fixture ?? {}),
      // Compatibilità API-Football: date resta sempre il valore raw.
      date: row?.fixture?.date ?? schedule.providerKickoffAt,
      lifecycle,
      schedule,
    },
  };
}

function kickoffClockInRome(row: any): number | null {
  const schedule = fixtureScheduleFrom(row?.fixture?.schedule);
  const value = schedule?.effectiveKickoffAt ?? row?.fixture?.date ?? null;
  const parsed = value == null ? null : new Date(String(value));
  if (parsed == null || !Number.isFinite(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: FIXTURE_DISPLAY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return number("hour") * 3600 + number("minute") * 60 + number("second");
}

/**
 * Unisce calendario provider e fotografia live in una sola collezione keyed
 * per fixtureId. Il filtro finale usa esclusivamente displayDay.
 */
export function buildFixtureDayPayload(
  requestedDay: string,
  providerPayload: any,
  liveSnapshot: LiveStateSnapshot,
  liveRawFixtures: any[],
): any {
  if (!validDisplayDay(requestedDay)) {
    throw new Error("invalid_fixture_day");
  }

  const calendarRows = Array.isArray(providerPayload?.response)
    ? providerPayload.response
    : [];
  const compactById = new Map<number, any>();
  for (const row of liveSnapshot.fixtures ?? []) {
    const id = fixtureIdOf(row);
    if (id > 0) compactById.set(id, row);
  }
  const rawById = new Map<number, any>();
  for (const row of liveRawFixtures ?? []) {
    const id = fixtureIdOf(row);
    if (id > 0) rawById.set(id, row);
  }

  const byId = new Map<number, any>();
  for (const calendar of calendarRows) {
    const id = fixtureIdOf(calendar);
    if (id <= 0) continue;
    const compact = compactById.get(id);
    const merged = mergeLiveIntoCalendar(calendar, rawById.get(id));
    const lifecycle = compact?.lifecycle ??
      normalizeFixtureStatus(merged?.fixture?.status);
    const previousSchedule = fixtureScheduleFrom(compact?.schedule);
    const schedule = canonicalizeSchedule(
      fixtureScheduleOf(merged, { previous: previousSchedule, lifecycle }),
      lifecycle,
    );
    if (schedule.displayDay !== requestedDay) continue;
    byId.set(id, attachCanonicalMetadata(merged, schedule, lifecycle));
  }

  // Le fixture spostate operativamente nel giorno richiesto possono non
  // comparire nella query provider di quel giorno. Lo snapshot le aggiunge una
  // sola volta, mantenendo fixtureId e data raw.
  for (const [id, compact] of compactById) {
    if (byId.has(id)) continue;
    const parsed = fixtureScheduleFrom(compact?.schedule);
    const lifecycle = compact?.lifecycle ??
      normalizeFixtureStatus(compact?.statusShort);
    if (parsed == null) continue;
    const schedule = canonicalizeSchedule(parsed, lifecycle);
    if (schedule.displayDay !== requestedDay) continue;
    const raw = rawById.get(id) ?? providerRowFromCompact(compact);
    byId.set(id, attachCanonicalMetadata(raw, schedule, lifecycle));
  }

  const response = [...byId.values()];
  response.sort((left, right) => {
    const leftClock = kickoffClockInRome(left);
    const rightClock = kickoffClockInRome(right);
    if (leftClock == null && rightClock != null) return 1;
    if (leftClock != null && rightClock == null) return -1;
    if (leftClock != null && rightClock != null && leftClock !== rightClock) {
      return leftClock - rightClock;
    }
    return fixtureIdOf(left) - fixtureIdOf(right);
  });

  return {
    ...(providerPayload ?? {}),
    get: "fixtures/day",
    parameters: {
      ...(providerPayload?.parameters ?? {}),
      date: requestedDay,
    },
    results: response.length,
    response,
    brainlive: {
      displayDay: requestedDay,
      liveRevision: liveSnapshot.revision,
      mergedBy: "fixtureId",
    },
  };
}
