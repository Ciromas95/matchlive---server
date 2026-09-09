import { toLiveCompact } from "./compact";
import { broadcast } from "./stream";
import fs from "node:fs";
import path from "node:path";
import { features } from "./featureFlags";
import { setRedisJson } from "./redisInfrastructure";
import { readShadowDocument, shadowWriteDocument } from "./shadowStorage";
import { recordLiveRedis } from "./livePipelineTelemetry";

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
const missingPolls: Map<number, number> =
  g.__BRAINLIVE_MISSING_POLLS__ ??
  (g.__BRAINLIVE_MISSING_POLLS__ = new Map<number, number>());
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
  });
}

function rememberGlobals() {
  g.__BRAINLIVE_LIVE_REVISION__ = revision;
  g.__BRAINLIVE_LIVE_UPDATED_AT__ = updatedAt;
  g.__BRAINLIVE_RAW_FIXTURES__ = rawFixtures;
  schedulePersist();
}

/**
 * Unica fotografia autorevole del live. Il poller del server è l'unico writer;
 * app, liste, preferiti e Cervello leggono tutti questo stesso stato.
 */
export async function publishLiveState(providerPayload: any): Promise<LiveStateDelta | null> {
  const nextRaw = Array.isArray(providerPayload?.response)
    ? providerPayload.response
    : [];
  const previousRawById = new Map<number, any>();
  for (const fixture of rawFixtures) {
    const id = Number(fixture?.fixture?.id ?? 0);
    if (id > 0) previousRawById.set(id, fixture);
  }
  const nextCompact = await toLiveCompact({ response: nextRaw });
  const nextById = new Map<number, any>();
  for (const row of nextCompact) {
    const id = fixtureId(row);
    if (id > 0) nextById.set(id, row);
  }

  // Una risposta momentaneamente incompleta del provider non deve far
  // lampeggiare o sparire una partita da tutte le schermate.
  for (const [id, previous] of compactByFixture) {
    if (nextById.has(id)) {
      missingPolls.delete(id);
      continue;
    }
    const misses = (missingPolls.get(id) ?? 0) + 1;
    missingPolls.set(id, misses);
    if (misses < 2) nextById.set(id, previous);
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
  for (const id of missingPolls.keys()) {
    if (!compactByFixture.has(id)) missingPolls.delete(id);
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
  missingPolls.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  rememberGlobals();
}
