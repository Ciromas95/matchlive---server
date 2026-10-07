import { FixtureLifecycle, normalizeFixtureStatus } from "./fixtureLifecycle";

export const FIXTURE_DISPLAY_TIME_ZONE = "Europe/Rome";

// Una gara osservata per la prima volta pochi minuti dopo mezzanotte potrebbe
// essere semplicemente iniziata il giorno precedente. La correzione del giorno
// operativo interviene solo quando il kickoff provider e l'osservazione live
// sono abbastanza distanti da rappresentare una programmazione ormai stantia.
export const STALE_LIVE_KICKOFF_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export type FixtureSchedule = {
  providerKickoffAt: string | null;
  originalScheduledAt: string | null;
  effectiveKickoffAt: string | null;
  observedLiveAt: string | null;
  displayDay: string | null;
  scheduleRevision: number;
};

type ScheduleOptions = {
  previous?: FixtureSchedule | null;
  lifecycle?: FixtureLifecycle;
  observedAt?: Date | string;
};

function reliableProviderDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function sameFixtureInstant(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs === rightMs;
  }
  return false;
}

type DisplayDayOptions = {
  providerKickoffAt: string | null;
  originalScheduledAt: string | null;
  effectiveKickoffAt: string | null;
  observedLiveAt: string | null;
  lifecycle: FixtureLifecycle;
};

/**
 * Unica regola autoritativa per l'appartenenza della fixture a una giornata.
 * Non modifica mai il kickoff: decide esclusivamente il giorno operativo.
 */
export function resolveFixtureDisplayDay({
  providerKickoffAt,
  originalScheduledAt,
  effectiveKickoffAt,
  observedLiveAt,
  lifecycle,
}: DisplayDayOptions): string | null {
  const effectiveDay = displayDayInRome(effectiveKickoffAt);
  if (effectiveDay == null || !lifecycle.isLive || observedLiveAt == null) {
    return effectiveDay;
  }

  const observedDay = displayDayInRome(observedLiveAt);
  if (observedDay == null || observedDay <= effectiveDay) return effectiveDay;

  // Se il provider ha realmente cambiato la programmazione rispetto alla
  // prima osservata, quel nuovo kickoff rimane la fonte principale.
  const providerWasRescheduled = originalScheduledAt != null &&
    providerKickoffAt != null &&
    !sameFixtureInstant(originalScheduledAt, providerKickoffAt);
  if (providerWasRescheduled) return effectiveDay;

  const effectiveMs = Date.parse(effectiveKickoffAt!);
  const observedMs = Date.parse(observedLiveAt);
  if (!Number.isFinite(effectiveMs) || !Number.isFinite(observedMs)) {
    return effectiveDay;
  }
  if (observedMs - effectiveMs < STALE_LIVE_KICKOFF_THRESHOLD_MS) {
    return effectiveDay;
  }

  return observedDay;
}

export function displayDayInRome(value: string | null): string | null {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIXTURE_DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/**
 * Costruisce la programmazione canonica senza modificare fixture.date.
 *
 * In assenza di uno storico osservato, originalScheduledAt coincide in modo
 * conservativo con la prima data provider affidabile. Nessuna data originaria
 * viene ricostruita tramite euristiche.
 */
export function fixtureScheduleOf(
  fixture: any,
  options: ScheduleOptions = {},
): FixtureSchedule {
  const providerKickoffAt = reliableProviderDate(fixture?.fixture?.date);
  const previous = options.previous ?? null;
  const lifecycle = options.lifecycle ??
    normalizeFixtureStatus(fixture?.fixture?.status);
  const effectiveKickoffAt = providerKickoffAt ??
    previous?.effectiveKickoffAt ?? null;
  const originalScheduledAt = previous?.originalScheduledAt ??
    providerKickoffAt;
  const effectiveChanged = previous != null &&
    !sameFixtureInstant(previous.effectiveKickoffAt, effectiveKickoffAt);
  const observedAt = options.observedAt instanceof Date
    ? options.observedAt
    : options.observedAt == null
    ? null
    : new Date(options.observedAt);
  const observedLiveAt = previous?.observedLiveAt ??
    (lifecycle.isLive && observedAt != null && Number.isFinite(observedAt.getTime())
      ? observedAt.toISOString()
      : null);
  const displayDay = resolveFixtureDisplayDay({
    providerKickoffAt,
    originalScheduledAt,
    effectiveKickoffAt,
    observedLiveAt,
    lifecycle,
  });
  const displayDayChanged = previous != null &&
    previous.displayDay !== displayDay;
  const scheduleRevision = previous == null
    ? 0
    : previous.scheduleRevision +
      (effectiveChanged || displayDayChanged ? 1 : 0);

  return {
    providerKickoffAt,
    originalScheduledAt,
    effectiveKickoffAt,
    observedLiveAt,
    displayDay,
    scheduleRevision,
  };
}

export function fixtureScheduleFrom(value: unknown): FixtureSchedule | null {
  if (value == null || typeof value !== "object") return null;
  const row = value as any;
  const revision = Number(row.scheduleRevision ?? 0);
  return {
    providerKickoffAt: reliableProviderDate(row.providerKickoffAt),
    originalScheduledAt: reliableProviderDate(row.originalScheduledAt),
    effectiveKickoffAt: reliableProviderDate(row.effectiveKickoffAt),
    observedLiveAt: reliableProviderDate(row.observedLiveAt),
    displayDay: typeof row.displayDay === "string" && row.displayDay.trim()
      ? row.displayDay
      : null,
    scheduleRevision: Number.isFinite(revision) ? revision : 0,
  };
}
