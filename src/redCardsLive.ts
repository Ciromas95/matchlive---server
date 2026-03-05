// src/redCardsLive.ts

export type RedCards = { home: number; away: number };

const redCardsLive = new Map<number, { home: number; away: number; exp: number }>();

function isRedCardEvent(ev: any) {
  const type = String(ev?.type ?? "").toLowerCase();
  if (type !== "card") return false;
  const detail = String(ev?.detail ?? "").toLowerCase();
  return detail.includes("red card") || detail.includes("second yellow");
}

function countRedsFromEvents(events: any[], homeTeamId?: number, awayTeamId?: number) {
  let home = 0;
  let away = 0;

  for (const ev of events) {
    if (!isRedCardEvent(ev)) continue;
    const teamId = ev?.team?.id;
    if (homeTeamId && teamId === homeTeamId) home++;
    else if (awayTeamId && teamId === awayTeamId) away++;
  }

  return { home, away };
}

// ✅ EXPORT (così il file diventa “module”)
export function updateRedCardsFromFixture(
  fixtureId: number,
  fixtureObj: any,
  ttlMs: number = 90_000
): void {
  const homeTeamId = fixtureObj?.teams?.home?.id;
  const awayTeamId = fixtureObj?.teams?.away?.id;

  const events = Array.isArray(fixtureObj?.events) ? fixtureObj.events : [];
  const reds = countRedsFromEvents(events, homeTeamId, awayTeamId);

  redCardsLive.set(fixtureId, { home: reds.home, away: reds.away, exp: Date.now() + ttlMs });
}

export function getRedCardsForFixtureFromLiveCache(fixtureId: number): RedCards {
  const now = Date.now();
  const v = redCardsLive.get(fixtureId);
  if (!v || v.exp < now) return { home: 0, away: 0 };
  return { home: v.home, away: v.away };
}

export function pruneRedCardsLive(liveFixtureIds: Set<number>): void {
  for (const id of redCardsLive.keys()) {
    if (!liveFixtureIds.has(id)) redCardsLive.delete(id);
  }
}