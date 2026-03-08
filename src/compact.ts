import { getFixtureEventsCached } from "./apiFootball";
import { getRedCardsForFixtureFromLiveCache } from "./redCardsLive";

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

function isCardEvent(ev: any): boolean {
  return String(ev?.type ?? "").toLowerCase().trim() === "card";
}

function isRedCardEvent(ev: any): boolean {
  if (!isCardEvent(ev)) return false;

  const detail = String(ev?.detail ?? "").toLowerCase().trim();
  return detail.includes("red card") || detail.includes("second yellow");
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
    if (!isRedCardEvent(ev)) continue;

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

function hasAnyCard(events: any[]): boolean {
  return (events ?? []).some((ev: any) => isCardEvent(ev));
}

function isLiveStatus(statusShort?: string | null): boolean {
  const s = String(statusShort ?? "").toUpperCase();
  return ["1H", "2H", "HT", "ET", "BT", "P", "INT"].includes(s);
}

function hasStartedStatus(statusShort?: string | null): boolean {
  const s = String(statusShort ?? "").toUpperCase();

  if (!s) return false;
  if (["NS", "TBD", "PST", "CANC", "ABD", "AWD", "WO"].includes(s)) return false;

  return true;
}

/**
 * Strategia:
 * - se ci sono già eventi nel fixture e contengono card, li usiamo subito
 * - se è live, prima proviamo la cache redCardsLive alimentata dal poller
 * - se serve ancora, facciamo /fixtures/events con cache
 */
async function resolveEventsAndReds(f: any): Promise<{
  events: any[];
  reds: { home: number; away: number; total: number };
}> {
  const fixtureId = f?.fixture?.id ?? null;
  const statusShort = f?.fixture?.status?.short ?? null;
  const homeId: number | null = f?.teams?.home?.id ?? null;
  const awayId: number | null = f?.teams?.away?.id ?? null;

  let events = Array.isArray(f?.events) ? f.events : [];

  // 1) Se abbiamo già card negli eventi inclusi, basta questo
  if (events.length > 0 && hasAnyCard(events)) {
    const reds = countRedCards(events, homeId, awayId);
    return { events, reds };
  }

  // 2) Se è live, prova prima la cache redCardsLive del poller
  if (fixtureId && isLiveStatus(statusShort)) {
    const cachedLiveReds = getRedCardsForFixtureFromLiveCache(fixtureId);
    const total = cachedLiveReds.home + cachedLiveReds.away;

    if (total > 0) {
      return {
        events,
        reds: {
          home: cachedLiveReds.home,
          away: cachedLiveReds.away,
          total,
        },
      };
    }
  }

  // 3) Se la partita è iniziata, recupera eventi completi da endpoint dedicato
  if (fixtureId && hasStartedStatus(statusShort)) {
    try {
      const evData = await getFixtureEventsCached(fixtureId, "events");
      const full = Array.isArray(evData?.response) ? evData.response : [];

      if (full.length > 0) {
        events = full;
      }
    } catch {
      // non blocchiamo tutta la risposta se gli events falliscono
    }
  }

  const reds = countRedCards(events, homeId, awayId);
  return { events, reds };
}

async function fixtureToCompact(f: any): Promise<any> {
  const fixtureId = f?.fixture?.id ?? null;

  const homeId: number | null = f?.teams?.home?.id ?? null;
  const awayId: number | null = f?.teams?.away?.id ?? null;

  const { events, reds } = await resolveEventsAndReds(f);

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

