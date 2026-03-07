import { getFixtureEventsCached } from "./apiFootball";

type LiteEvent = {
  type: string | null;
  detail: string | null;
  elapsed: number | null;
  teamId: number | null;
  player: string | null;
};

function mapEventsLite(events: any[]): LiteEvent[] {
  return (events ?? []).map((ev: any) => ({
    type: ev?.type ?? null,
    detail: ev?.detail ?? null,
    elapsed: ev?.time?.elapsed ?? null,
    teamId: ev?.team?.id ?? null,
    player: ev?.player?.name ?? null,
  }));
}

function hasAnyCard(events: any[]): boolean {
  return (events ?? []).some(
    (ev: any) => String(ev?.type ?? "").toLowerCase() === "card"
  );
}

function countRedCards(
  events: any[],
  homeTeamId?: number | null,
  awayTeamId?: number | null
): { home: number; away: number; total: number } {
  let home = 0;
  let away = 0;

  if (!homeTeamId || !awayTeamId) {
    return { home: 0, away: 0, total: 0 };
  }

  for (const ev of events ?? []) {
    const type = String(ev?.type ?? "").toLowerCase().trim();
    if (type !== "card") continue;

    const detail = String(ev?.detail ?? "").toLowerCase().trim();
    const isRed =
      detail.includes("red card") || detail.includes("second yellow");

    if (!isRed) continue;

    const teamId = ev?.team?.id ?? null;
    if (teamId === homeTeamId) {
      home++;
    } else if (teamId === awayTeamId) {
      away++;
    }
  }

  return {
    home,
    away,
    total: home + away,
  };
}

function shouldFetchFullEvents(events: any[]): boolean {
  if (!Array.isArray(events) || events.length === 0) return true;
  if (!hasAnyCard(events)) return true;
  return false;
}

function isLiveStatus(statusShort?: string | null): boolean {
  const s = String(statusShort ?? "").toUpperCase();
  return ["1H", "2H", "HT", "ET", "BT", "P", "INT"].includes(s);
}

async function resolveFixtureEvents(f: any): Promise<any[]> {
  const fixtureId = f?.fixture?.id;
  const statusShort = f?.fixture?.status?.short ?? null;

  let events = Array.isArray(f?.events) ? f.events : [];

  if (!fixtureId) return events;

  const canFetchMore = isLiveStatus(statusShort);

  if (canFetchMore && shouldFetchFullEvents(events)) {
    try {
      const evData = await getFixtureEventsCached(fixtureId, "other");
      const full = Array.isArray(evData?.response) ? evData.response : [];
      if (full.length > 0) {
        events = full;
      }
    } catch {
      // ignore
    }
  }

  return events;
}

async function fixtureToCompact(f: any): Promise<any> {
  const fixtureId = f?.fixture?.id ?? null;

  const homeId: number | null = f?.teams?.home?.id ?? null;
  const awayId: number | null = f?.teams?.away?.id ?? null;

  const events = await resolveFixtureEvents(f);
  const reds = countRedCards(events, homeId, awayId);

  return {
    fixtureId,
    date: f?.fixture?.date ?? null,
    statusShort: f?.fixture?.status?.short ?? null,
    elapsed: f?.fixture?.status?.elapsed ?? null,

    league: {
      id: f?.league?.id ?? null,
      name: f?.league?.name ?? null,
      country: f?.league?.country ?? null,
      flag: f?.league?.flag ?? null,
      logo: f?.league?.logo ?? null,
    },

    home: {
      id: homeId,
      name: f?.teams?.home?.name ?? null,
      logo: f?.teams?.home?.logo ?? null,
      redCards: reds.home,
    },

    away: {
      id: awayId,
      name: f?.teams?.away?.name ?? null,
      logo: f?.teams?.away?.logo ?? null,
      redCards: reds.away,
    },

    redCards: {
      home: reds.home,
      away: reds.away,
      total: reds.total,
    },

    goals: {
      home: f?.goals?.home ?? 0,
      away: f?.goals?.away ?? 0,
    },

    events: mapEventsLite(events),
  };
}

export async function toLiveCompact(apiData: any): Promise<any[]> {
  const list = Array.isArray(apiData?.response) ? apiData.response : [];
  const out: any[] = [];

  for (const f of list) {
    out.push(await fixtureToCompact(f));
  }

  return out;
}

export async function toLeagueFixturesCompact(apiData: any): Promise<any[]> {
  const list = Array.isArray(apiData?.response) ? apiData.response : [];
  const out: any[] = [];

  for (const f of list) {
    out.push(await fixtureToCompact(f));
  }

  return out;
}

