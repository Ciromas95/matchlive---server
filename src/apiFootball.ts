import axios from "axios";
import { getCache, setCache } from "./cache";
import { CounterKey, markApiCall, markCacheHit, markCacheMiss } from "./stats";
import { liveTtlMs } from "./ttl";

const BASE_URL = "https://v3.football.api-sports.io";

/**
 * Top leagues usate dal BrainLive.
 * La stringa viene passata al provider come live=39-140-135-...
 */
const BRAIN_LIVE_LEAGUE_IDS = [
  61,  // Ligue 1
  140, // La Liga
  78,  // Bundesliga
  135, // Serie A
  94,  // Primeira Liga
  88,  // Eredivisie
  39,  // Premier League
  218, // Austria Bundesliga
  119, // Denmark Superliga
  144, // Jupiler Pro League
  2,   // Champions League
  3,   // Europa League
  137, // Coppa Italia
  207, // Switzerland Super League
];

const BRAIN_LIVE_LIVE_PARAM = BRAIN_LIVE_LEAGUE_IDS.join("-");

/**
 * Deduplica richieste concorrenti verso la stessa risorsa.
 * Se più endpoint chiedono la stessa chiave cache mentre è scaduta,
 * parte una sola chiamata esterna e gli altri aspettano la stessa Promise.
 */
const inflight = new Map<string, Promise<any>>();

function apiKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new Error("Missing API_FOOTBALL_KEY in .env");
  }
  return key;
}

async function apiGet(
  path: string,
  type: CounterKey = "other",
  params?: Record<string, any>
): Promise<any> {
  markApiCall(type);

  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: {
      "x-apisports-key": apiKey(),
      Accept: "application/json",
    },
    params,
    timeout: 10000,
  });

  return res.data;
}

async function fetchWithCache<T>(
  cacheKey: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = getCache<T>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  const running = inflight.get(cacheKey);
  if (running) {
    markCacheHit();
    return running;
  }

  markCacheMiss();

  const p = (async () => {
    try {
      const fresh = await fetcher();
      setCache(cacheKey, fresh, ttlSeconds);
      return fresh;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, p);
  return p;
}

/**
 * Live globale condiviso.
 * Usalo per la sezione Live classica o quando ti serve davvero tutto il live.
 */
export async function getLiveFixtures(type: CounterKey = "live"): Promise<any> {
  const cacheKey = "liveFixtures_all";

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  const running = inflight.get(cacheKey);
  if (running) {
    markCacheHit();
    return running;
  }

  markCacheMiss();

  const p = (async () => {
    try {
      const data = await apiGet("/fixtures", type, { live: "all" });

      const liveCount = Array.isArray(data?.response) ? data.response.length : 0;

      /**
       * Manteniamo un minimo reale per evitare raffiche inutili.
       */
      const ttlSeconds = Math.max(
        12,
        Math.round(liveTtlMs(liveCount) / 1000)
      );

      setCache(cacheKey, data, ttlSeconds);
      return data;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, p);
  return p;
}

/**
 * Live ristretto ai top campionati per BrainLive.
 * Questo evita di scaricare tutto il live mondiale.
 */
export async function getTopLiveFixtures(type: CounterKey = "brainLive"): Promise<any> {
  const cacheKey = `liveFixtures_top_${BRAIN_LIVE_LIVE_PARAM}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  const running = inflight.get(cacheKey);
  if (running) {
    markCacheHit();
    return running;
  }

  markCacheMiss();

  const p = (async () => {
    try {
      const data = await apiGet("/fixtures", type, {
        live: BRAIN_LIVE_LIVE_PARAM,
      });

      const liveCount = Array.isArray(data?.response) ? data.response.length : 0;

      /**
       * Per BrainLive siamo più conservativi:
       * meno traffico, meno stress, più stabilità.
       */
      const ttlSeconds = Math.max(
        20,
        Math.round(liveTtlMs(liveCount) / 1000)
      );

      setCache(cacheKey, data, ttlSeconds);
      return data;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, p);
  return p;
}

export async function getLeagueFixturesByDate(
  leagueId: number,
  date: string,
  season?: number,
  type: CounterKey = "compact"
): Promise<any> {
  const cacheKey = `leagueFixtures_${leagueId}_${date}_${season ?? "na"}`;

  return fetchWithCache<any>(cacheKey, 120, async () => {
    const params: Record<string, any> = {
      league: leagueId,
      date,
    };

    if (season) {
      params.season = season;
    }

    return apiGet("/fixtures", type, params);
  });
}

export async function getFixtureEventsCached(
  fixtureId: number,
  type: CounterKey = "events"
): Promise<any> {
  const cacheKey = `fixtureEvents_${fixtureId}`;

  return fetchWithCache<any>(cacheKey, 600, async () => {
    return apiGet("/fixtures/events", type, { fixture: fixtureId });
  });
}

export async function getFixturesByDate(
  date: string,
  type: CounterKey = "brainPrematch"
): Promise<any> {
  const cacheKey = `fixturesByDate_${date}`;

  return fetchWithCache<any>(cacheKey, 600, async () => {
    return apiGet("/fixtures", type, { date });
  });
}

export async function getTeamLastFixtures(
  teamId: number,
  last: number = 10,
  type: CounterKey = "brainPrematch"
): Promise<any> {
  const safeLast = Math.max(1, Math.min(last, 10));
  const cacheKey = `teamLastFixtures_${teamId}_${safeLast}`;

  return fetchWithCache<any>(cacheKey, 6 * 60 * 60, async () => {
    return apiGet("/fixtures", type, {
      team: teamId,
      last: safeLast,
    });
  });
}

export async function getPlayersByTeam(teamId: number, season: number): Promise<any> {
  const cacheKey = `players_team_${teamId}_season_${season}`;

  return fetchWithCache<any>(cacheKey, 12 * 60 * 60, async () => {
    const all: any[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await apiGet("/players", "other", {
        team: teamId,
        season,
        page,
      });

      const resp = Array.isArray(data?.response) ? data.response : [];
      all.push(...resp);

      const pagingTotal = data?.paging?.total;
      if (pagingTotal != null) {
        const t = Number(pagingTotal);
        totalPages = Number.isFinite(t) && t > 0 ? t : 1;
      } else {
        totalPages = 1;
      }

      page += 1;
    } while (page <= totalPages);

    return {
      response: all,
      paging: { current: totalPages, total: totalPages },
    };
  });
}

const apiFootball = {
  getLiveFixtures,
  getTopLiveFixtures,
  getLeagueFixturesByDate,
  getFixtureEventsCached,
  getFixturesByDate,
  getTeamLastFixtures,
  getPlayersByTeam,
};

export default apiFootball;
