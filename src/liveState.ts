import { toLiveCompact } from "./compact";
import { broadcast } from "./stream";
import fs from "node:fs";
import path from "node:path";
import { features } from "./featureFlags";
import { setRedisJson } from "./redisInfrastructure";
import { readShadowDocument, shadowWriteDocument } from "./shadowStorage";
import { recordLiveRedis } from "./livePipelineTelemetry";
import { FixtureSchedule, fixtureScheduleFrom } from "./fixtureSchedule";
import { normalizeFixtureStatus } from "./fixtureLifecycle";

export type LiveStateDelta = {
  type: "live_delta";
  revision: number;
  updatedAt: string;
  providerAgeMs: number;
  upsert: any[];
  remove: number[];
};

export type LiveStateSnapshot = {
  revision: number;
  updatedAt: string | null;
  fixtures: any[];
};

const g = globalThis as any;
const compactByFixture: Map<number, any> =
  g.__BRAINLIVE_COMPACT_STATE__ ??
  (g.__BRAINLIVE_COMPACT_STATE__ = new Map<number, any>());

let revision: number = g.__BRAINLIVE_LIVE_REVISION__ ?? 0;
let updatedAt: string | null = g.__BRAINLIVE_LIVE_UPDATED_AT__ ?? null;
let rawFixtures: any[] = g.__BRAINLIVE_RAW_FIXTURES__ ?? [];
let publishQueue: Promise<void> = Promise.resolve();
type MissingLiveObservation = {
  firstObservedAtMs: number;
  observations: number;
};

const missingLiveObservations: Map<number, MissingLiveObservation> =
  g.__BRAINLIVE_MISSING_LIVE_OBSERVATIONS__ ??
  (g.__BRAINLIVE_MISSING_LIVE_OBSERVATIONS__ =
    new Map<number, MissingLiveObservation>());

// Il feed live del provider puo risultare incompleto per un singolo ciclo.
// Aspettiamo almeno tre fotografie autorevoli e venti secondi prima di
// considerare davvero uscita una fixture. Le letture HTTP non contribuiscono
// mai a questa conferma: il poller globale e l'unico responsabile delle
// rimozioni.
const LIVE_MISSING_GRACE_MS = 20_000;
const LIVE_MISSING_MIN_OBSERVATIONS = 3;
const LIVE_STATE_STORE_PATH = process.env.LIVE_STATE_STORE_PATH ??
  "/data/brainlive-live-state.json";
let persistTimer: NodeJS.Timeout | null = null;

function restoreFromDisk() {
  if (compactByFixture.size > 0 || updatedAt != null) return;
  try {
    if (!fs.existsSync(LIVE_STATE_STORE_PATH)) return;
    const saved = JSON.parse(fs.readFileSync(LIVE_STATE_STORE_PATH, "utf8"));
    const savedAt = Date.parse(String(saved?.updatedAt ?? ""));
    // Dopo uno stop lungo non mostriamo come live una fotografia ormai vecchia.
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > 2 * 60_000) return;
    for (const row of Array.isArray(saved?.fixtures) ? saved.fixtures : []) {
      const id = Number(row?.fixtureId ?? 0);
      if (id > 0) compactByFixture.set(id, row);
    }
    rawFixtures = Array.isArray(saved?.rawFixtures) ? saved.rawFixtures : [];
    revision = Number(saved?.revision ?? 0);
    updatedAt = new Date(savedAt).toISOString();
  } catch (error: any) {
    console.warn("[liveState] ripristino ignorato:", error?.message ?? error);
  }
}

function schedulePersist() {
  if (persistTimer || !fs.existsSync(path.dirname(LIVE_STATE_STORE_PATH))) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const temp = `${LIVE_STATE_STORE_PATH}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({
        revision,
        updatedAt,
        fixtures: [...compactByFixture.values()],
        rawFixtures,
      }));
      fs.renameSync(temp, LIVE_STATE_STORE_PATH);
      const snapshot = { revision, updatedAt, fixtures: [...compactByFixture.values()], rawFixtures };
      void shadowWriteDocument("live_state", "current", snapshot, 1, updatedAt ?? new Date().toISOString());
      if (features.redisLiveState) void setRedisJson("live:snapshot", snapshot, 180);
    } catch (error: any) {
      console.warn("[liveState] salvataggio ignorato:", error?.message ?? error);
    }
  }, 15_000);
  persistTimer.unref?.();
}

restoreFromDisk();

export async function hydrateLiveStateFromPostgres() {
  if (!features.postgresReadLive) return false;
  const saved = await readShadowDocument<any>("live_state", "current", 1);
  const savedAt = Date.parse(String(saved?.updatedAt ?? ""));
  if (!saved || !Number.isFinite(savedAt) || Date.now() - savedAt > 2 * 60_000) return false;
  compactByFixture.clear();
  for (const row of Array.isArray(saved.fixtures) ? saved.fixtures : []) {
    const id = Number(row?.fixtureId ?? 0);
    if (id > 0) compactByFixture.set(id, row);
  }
  rawFixtures = Array.isArray(saved.rawFixtures) ? saved.rawFixtures : [];
  revision = Number(saved.revision ?? 0);
  updatedAt = new Date(savedAt).toISOString();
  rememberGlobals();
  return true;
}

function fixtureId(row: any): number {
  return Number(row?.fixtureId ?? 0);
}

function visibleSignature(row: any): string {
  return JSON.stringify({
    fixtureId: row?.fixtureId ?? null,
    statusShort: row?.statusShort ?? null,
    elapsed: row?.elapsed ?? null,
    goals: row?.goals ?? null,
    redCards: row?.redCards ?? null,
    homeRedCards: row?.home?.redCards ?? null,
    awayRedCards: row?.away?.redCards ?? null,
    events: row?.events ?? null,
    effectiveKickoffAt: row?.schedule?.effectiveKickoffAt ?? null,
    displayDay: row?.schedule?.displayDay ?? null,
    scheduleRevision: row?.schedule?.scheduleRevision ?? 0,
  });
}

function rememberGlobals() {
  g.__BRAINLIVE_LIVE_REVISION__ = revision;
  g.__BRAINLIVE_LIVE_UPDATED_AT__ = updatedAt;
  g.__BRAINLIVE_RAW_FIXTURES__ = rawFixtures;
  schedulePersist();
}

/**
 * Unica fotografia condivisa del live. Il poller pubblica fotografie globali
 * autorevoli anche per le assenze; le letture HTTP fresche possono invece
 * aggiungere o aggiornare dati senza rimuovere. App, liste, preferiti e
 * Cervello leggono tutti questo stesso stato.
 */
async function publishLiveStateNow(
  providerPayload: any,
  options: { observedAt?: Date; authoritativeAbsence?: boolean } = {},
): Promise<LiveStateDelta | null> {
  const observedAt = options.observedAt ?? new Date();
  const authoritativeAbsence = options.authoritativeAbsence ?? true;
  const nextRaw = Array.isArray(providerPayload?.response)
    ? providerPayload.response
    : [];
  const previousRawById = new Map<number, any>();
  for (const fixture of rawFixtures) {
    const id = Number(fixture?.fixture?.id ?? 0);
    if (id > 0) previousRawById.set(id, fixture);
  }
  const previousSchedules = new Map<number, FixtureSchedule>();
  for (const [id, row] of compactByFixture) {
    const schedule = fixtureScheduleFrom(row?.schedule);
    if (schedule) previousSchedules.set(id, schedule);
  }
  const nextCompact = await toLiveCompact(
    { response: nextRaw },
    { previousSchedules, observedAt },
  );
  const nextById = new Map<number, any>();
  for (const row of nextCompact) {
    const id = fixtureId(row);
    if (id > 0) nextById.set(id, row);
  }

  // Una risposta momentaneamente incompleta del provider non deve far
  // lampeggiare o sparire una partita da tutte le schermate.
  for (const [id, previous] of compactByFixture) {
    if (nextById.has(id)) {
      missingLiveObservations.delete(id);
      continue;
    }

    // Endpoint HTTP e viste parziali possono scoprire/aggiornare fixture, ma
    // non rappresentano una fotografia globale affidabile per le assenze.
    if (!authoritativeAbsence) {
      nextById.set(id, previous);
      continue;
    }

    const previousMissing = missingLiveObservations.get(id);
    const missing = previousMissing == null
      ? { firstObservedAtMs: observedAt.getTime(), observations: 1 }
      : {
        firstObservedAtMs: previousMissing.firstObservedAtMs,
        observations: previousMissing.observations + 1,
      };
    missingLiveObservations.set(id, missing);
    const missingForMs = Math.max(0, observedAt.getTime() - missing.firstObservedAtMs);
    const confirmedMissing =
      missing.observations >= LIVE_MISSING_MIN_OBSERVATIONS &&
      missingForMs >= LIVE_MISSING_GRACE_MS;
    if (!confirmedMissing) nextById.set(id, previous);
  }

  const upsert: any[] = [];
  const remove: number[] = [];
  for (const [id, row] of nextById) {
    const previous = compactByFixture.get(id);
    if (!previous || visibleSignature(previous) !== visibleSignature(row)) {
      upsert.push(row);
    }
  }
  for (const id of compactByFixture.keys()) {
    if (!nextById.has(id)) remove.push(id);
  }

  const retainedRaw = [...nextRaw];
  const receivedRawIds = new Set(
    nextRaw.map((fixture: any) => Number(fixture?.fixture?.id ?? 0)),
  );
  for (const [id, previous] of previousRawById) {
    if (!receivedRawIds.has(id) && nextById.has(id)) retainedRaw.push(previous);
  }
  rawFixtures = retainedRaw;
  updatedAt = new Date().toISOString();
  compactByFixture.clear();
  for (const [id, row] of nextById) compactByFixture.set(id, row);
  for (const id of missingLiveObservations.keys()) {
    if (!compactByFixture.has(id)) missingLiveObservations.delete(id);
  }

  if (upsert.length === 0 && remove.length === 0) {
    rememberGlobals();
    return null;
  }

  revision += 1;
  rememberGlobals();
  if (features.redisLiveState) {
    const redisStarted = performance.now();
    await setRedisJson("live:snapshot", { revision, updatedAt, fixtures:[...compactByFixture.values()], rawFixtures }, 180);
    recordLiveRedis(performance.now() - redisStarted);
  }
  const delta: LiveStateDelta = {
    type: "live_delta",
    revision,
    updatedAt,
    providerAgeMs: 0,
    upsert,
    remove,
  };
  broadcast(delta);
  return delta;
}

/**
 * Serializza tutti gli aggiornamenti della fotografia Live. Il poller e
 * l'unica autorita per le rimozioni, ma anche una lettura HTTP fresca puo
 * scoprire una gara appena iniziata: senza coda due conversioni asincrone
 * concorrenti potrebbero applicarsi in ordine inverso e perdere una fixture.
 */
export function publishLiveState(
  providerPayload: any,
  options: { observedAt?: Date; authoritativeAbsence?: boolean } = {},
): Promise<LiveStateDelta | null> {
  const task = publishQueue.then(() =>
    publishLiveStateNow(providerPayload, options)
  );
  publishQueue = task.then(() => undefined, () => undefined);
  return task;
}

/**
 * Inserisce nello snapshot autorevole le sole nuove fixture realmente LIVE
 * scoperte da una vista parziale (per esempio il calendario giornaliero).
 *
 * A differenza di publishLiveState, questa operazione non interpreta
 * l'assenza dalla risposta come una rimozione: una giornata non rappresenta
 * infatti l'intero feed live mondiale. Le fixture gia presenti restano
 * affidate al poller globale, cosi una risposta calendario eventualmente
 * meno fresca non puo far arretrare punteggio o cronometro.
 */
async function publishLiveDiscoveriesNow(
  providerPayload: any,
  options: { observedAt?: Date } = {},
): Promise<LiveStateDelta | null> {
  const candidates = Array.isArray(providerPayload?.response)
    ? providerPayload.response.filter((row: any) => {
      const id = Number(row?.fixture?.id ?? 0);
      return id > 0 &&
        !compactByFixture.has(id) &&
        normalizeFixtureStatus(row?.fixture?.status).isLive;
    })
    : [];
  if (candidates.length === 0) return null;

  const discovered = await toLiveCompact(
    { response: candidates },
    { observedAt: options.observedAt ?? new Date() },
  );
  const upsert = discovered.filter((row) => {
    const id = fixtureId(row);
    return id > 0 && !compactByFixture.has(id);
  });
  if (upsert.length === 0) return null;

  const rawById = new Map<number, any>();
  for (const row of rawFixtures) {
    const id = Number(row?.fixture?.id ?? 0);
    if (id > 0) rawById.set(id, row);
  }
  for (const row of candidates) {
    const id = Number(row?.fixture?.id ?? 0);
    if (id > 0 && !rawById.has(id)) rawById.set(id, row);
  }
  rawFixtures = [...rawById.values()];

  for (const row of upsert) {
    const id = fixtureId(row);
    compactByFixture.set(id, row);
    missingLiveObservations.delete(id);
  }
  updatedAt = new Date().toISOString();
  revision += 1;
  rememberGlobals();
  if (features.redisLiveState) {
    const redisStarted = performance.now();
    await setRedisJson(
      "live:snapshot",
      {
        revision,
        updatedAt,
        fixtures: [...compactByFixture.values()],
        rawFixtures,
      },
      180,
    );
    recordLiveRedis(performance.now() - redisStarted);
  }
  const delta: LiveStateDelta = {
    type: "live_delta",
    revision,
    updatedAt,
    providerAgeMs: 0,
    upsert,
    remove: [],
  };
  broadcast(delta);
  return delta;
}

export function publishLiveDiscoveries(
  providerPayload: any,
  options: { observedAt?: Date } = {},
): Promise<LiveStateDelta | null> {
  const task = publishQueue.then(() =>
    publishLiveDiscoveriesNow(providerPayload, options)
  );
  publishQueue = task.then(() => undefined, () => undefined);
  return task;
}

export function getLiveStateSnapshot(): LiveStateSnapshot {
  return {
    revision,
    updatedAt,
    fixtures: [...compactByFixture.values()],
  };
}

export function getLiveRawFixtures(): any[] {
  return rawFixtures;
}

export function hasLiveState(): boolean {
  return updatedAt != null;
}

export function resetLiveStateForTests() {
  compactByFixture.clear();
  rawFixtures = [];
  revision = 0;
  updatedAt = null;
  missingLiveObservations.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  publishQueue = Promise.resolve();
  rememberGlobals();
}
