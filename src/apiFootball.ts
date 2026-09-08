import axios from "axios";
import { getCache, getCacheState, setCache } from "./cache";
import { getInflight, runOnce } from "./inflight";
import {
  CounterKey,
  markApiCall,
  markCacheHit,
  markCacheMiss,
  markProviderResult,
  syncProviderQuota,
} from "./stats";
import { liveTtlMs } from "./ttl";
import { waitForProviderSlot } from "./providerRateLimiter";
import { getRedisCache, setRedisCache, withRedisSingleFlight } from "./redisInfrastructure";
import { markHealthActivity } from "./health";
import { markProviderTelemetryCall } from "./telemetry";
import { executeProviderRequest } from "./providerResilience";

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
function apiKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new Error("Missing API_FOOTBALL_KEY in .env");
  }
  return key;
}

function hasProviderErrors(errors: any): boolean {
  if (!errors) return false;
  if (Array.isArray(errors)) return errors.length > 0;
  if (typeof errors === "object") return Object.keys(errors).length > 0;
  return Boolean(errors);
}

async function apiGet(
  path: string,
  type: CounterKey = "other",
  params?: Record<string, any>
): Promise<any> {
  return executeProviderRequest(async () => {
    await waitForProviderSlot(type === "live" || type === "brainLive" ? "critical" : "normal");
    markApiCall(type);
    markProviderTelemetryCall();
    const quotaRequestedAt = Date.now();
    const providerStartedAt = Date.now();
    let res;
    try {
      res = await axios.get(`${BASE_URL}${path}`, {
        headers: { "x-apisports-key": apiKey(), Accept: "application/json" },
        params,
        timeout: Math.max(1_000, Number(process.env.PROVIDER_TIMEOUT_MS ?? "10000")),
      });
      syncProviderQuota(res.headers, quotaRequestedAt);
    } catch (error: any) {
      markProviderResult(Date.now() - providerStartedAt, false);
      syncProviderQuota(error?.response?.headers, quotaRequestedAt);
      throw error;
    }
    if (hasProviderErrors(res.data?.errors)) {
      markProviderResult(Date.now() - providerStartedAt, false);
      const err: any = new Error("API-Football returned an application error");
      err.response = { status: 502 };
      throw err;
    }
    markProviderResult(Date.now() - providerStartedAt, true);
    markHealthActivity("provider");
    return res.data;
  });
}

async function distributedFetch<T>(cacheKey: string, ttlSeconds: number, staleSeconds: number, fetcher: () => Promise<T>) {
  return withRedisSingleFlight(cacheKey, async () => {
    const shared = await getRedisCache<T>(cacheKey);
    if (shared.state !== "miss" && shared.value != null) {
      setCache(cacheKey, shared.value, ttlSeconds, staleSeconds);
      return shared.value;
    }
    return null;
  }, async () => {
    const secondLook = await getRedisCache<T>(cacheKey);
    if (secondLook.state !== "miss" && secondLook.value != null) return secondLook.value;
    const fresh = await fetcher();
    setCache(cacheKey, fresh, ttlSeconds, staleSeconds);
    await setRedisCache(cacheKey, fresh, ttlSeconds, staleSeconds);
    return fresh;
  }, Math.max(5_000, Math.min(30_000, ttlSeconds * 1_000)));
}

const PROVIDER_PROXY_PATHS = new Set([
  "/fixtures",
  "/fixtures/statistics",
  "/fixtures/events",
  "/fixtures/lineups",
  "/fixtures/players",
  "/fixtures/headtohead",
  "/odds",
  "/injuries",
  "/leagues",
  "/players",
  "/players/profiles",
  "/players/squads",
  "/teams",
  "/teams/statistics",
]);

const PROVIDER_PROXY_PARAMS: Record<string, Set<string>> = {
  "/fixtures": new Set(["date", "id", "league", "season", "round", "team", "last", "next"]),
  "/fixtures/statistics": new Set(["fixture", "half"]),
  "/fixtures/events": new Set(["fixture"]),
  "/fixtures/lineups": new Set(["fixture"]),
  "/fixtures/players": new Set(["fixture"]),
  "/fixtures/headtohead": new Set(["h2h", "last"]),
  "/odds": new Set(["fixture"]),
  "/injuries": new Set(["fixture"]),
  "/leagues": new Set(["team", "current"]),
  "/players": new Set(["id", "team", "season", "page"]),
  "/players/profiles": new Set(["id", "player"]),
  "/players/squads": new Set(["team"]),
  "/teams": new Set(["search"]),
  "/teams/statistics": new Set(["team", "league", "season"]),
};

function proxyTtl(path: string, params: Record<string, string>) {
  if (path === "/fixtures/statistics" || path === "/fixtures/events" || path === "/fixtures/players") return 8;
  if (path === "/fixtures" && (params.live || params.id)) return 8;
  if (path === "/fixtures" && params.date) return 10;
  if (path === "/fixtures/lineups" || path === "/odds") return 60;
  if (path === "/injuries") return 5 * 60;
  if (path === "/fixtures/headtohead" || path === "/teams/statistics") return 60 * 60;
  if (path.startsWith("/players")) return 60 * 60;
  if (path === "/leagues") return 6 * 60 * 60;
  if (path === "/teams") return 10 * 60;
  return 5 * 60;
}

/**
 * Proxy ristretto usato dall'app per i dettagli non ancora compattati.
 * La chiave del fornitore non lascia mai il server e richieste identiche di
 * utenti diversi condividono cache e chiamata in corso.
 */
export async function getProviderResource(
  path: string,
  rawParams: Record<string, unknown>,
) {
  if (!PROVIDER_PROXY_PATHS.has(path)) {
    const error: any = new Error("Provider endpoint not allowed");
    error.status = 400;
    throw error;
  }

  const params = Object.fromEntries(
    Object.entries(rawParams)
      .filter(([key, value]) =>
        PROVIDER_PROXY_PARAMS[path].has(key) &&
        typeof value === "string" &&
        value.length <= 180
      )
      .map(([key, value]) => [key, String(value)]),
  );
  const signature = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const ttl = proxyTtl(path, params);

  return fetchStaleWhileRevalidate(
    `provider-proxy:${path}?${signature}`,
    ttl,
    Math.max(ttl * 3, 30),
    () => apiGet(path, "other", params),
  );
}

async function fetchWithCache<T>(
  cacheKey: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  staleSeconds: number = 10 * 60
): Promise<T> {
  const cached = getCache<T>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  const shared = await getRedisCache<T>(cacheKey);
  if (shared.state !== "miss" && shared.value != null) {
    markCacheHit();
    setCache(cacheKey, shared.value, Math.max(1, ttlSeconds), staleSeconds);
    return shared.value;
  }

  const running = getInflight<T>(cacheKey);
  if (running) {
    markCacheHit();
    return running;
  }

  markCacheMiss();

  return runOnce(cacheKey, async () => {
    return distributedFetch(cacheKey, ttlSeconds, staleSeconds, fetcher);
  });
}

async function fetchStaleWhileRevalidate<T>(
  cacheKey: string,
  ttlSeconds: number,
  staleSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = getCacheState<T>(cacheKey);

  if (cached.state === "fresh" && cached.value != null) {
    markCacheHit();
    return cached.value;
  }

  const shared = await getRedisCache<T>(cacheKey);
  if (shared.state === "fresh" && shared.value != null) {
    markCacheHit(); setCache(cacheKey, shared.value, ttlSeconds, staleSeconds); return shared.value;
  }

  const running = getInflight<T>(cacheKey);
  if (running) {
    if (cached.state === "stale" && cached.value != null) {
      markCacheHit();
      return cached.value;
    }
    markCacheHit();
    return running;
  }

  if (cached.state === "stale" && cached.value != null) {
    markCacheHit();
    void runOnce(cacheKey, async () => {
      return distributedFetch(cacheKey, ttlSeconds, staleSeconds, fetcher);
    }).catch((e) => {
      console.error("[cache] background refresh failed:", e?.message ?? e);
    });
    return cached.value;
  }

  markCacheMiss();
  return runOnce(cacheKey, async () => {
    return distributedFetch(cacheKey, ttlSeconds, staleSeconds, fetcher);
  });
}

/**
 * Live globale condiviso.
 * Usalo per la sezione Live classica o quando ti serve davvero tutto il live.
 */
export async function getLiveFixtures(
  type: CounterKey = "live",
  waitForFreshWhenStale = false,
): Promise<any> {
  const cacheKey = "liveFixtures_all";
  const cached = getCacheState<any>(cacheKey);

  if (cached.state === "fresh" && cached.value != null) {
    markCacheHit();
    return cached.value;
  }

  const shared = await getRedisCache<any>(cacheKey);
  if (shared.state === "fresh" && shared.value != null) {
    markCacheHit(); setCache(cacheKey, shared.value, 4, 20); return shared.value;
  }

  const running = getInflight<any>(cacheKey);
  if (running) {
    if (cached.state === "stale" && cached.value != null) {
      markCacheHit();
      return cached.value;
    }
    markCacheHit();
    return running;
  }

  if (cached.state === "stale" && cached.value != null) {
    markCacheHit();
    const refresh = runOnce(cacheKey, async () => {
      const fresh = await apiGet("/fixtures", type, { live: "all" });
      const liveCount = Array.isArray(fresh?.response) ? fresh.response.length : 0;
      const ttlSeconds = Math.max(4, Math.round(liveTtlMs(liveCount) / 1000));
      setCache(cacheKey, fresh, ttlSeconds, 20);
      void setRedisCache(cacheKey, fresh, ttlSeconds, 20);
      return fresh;
    });
    if (waitForFreshWhenStale) return refresh;
    void refresh.catch((e) => {
      console.error("[live] background refresh failed:", e?.message ?? e);
    });
    return cached.value;
  }

  markCacheMiss();
  return runOnce(cacheKey, async () => {
    const data = await apiGet("/fixtures", type, { live: "all" });

    const liveCount = Array.isArray(data?.response) ? data.response.length : 0;

    /**
     * Manteniamo un minimo reale per evitare raffiche inutili.
     */
    const ttlSeconds = Math.max(
      4,
      Math.round(liveTtlMs(liveCount) / 1000)
    );

    setCache(cacheKey, data, ttlSeconds, 20);
    void setRedisCache(cacheKey, data, ttlSeconds, 20);
    return data;
  });
}

export async function getFixtureById(fixtureId: number): Promise<any> {
  return apiGet("/fixtures", "live", { id: fixtureId });
}

export async function getFixtureByIdCached(
  fixtureId: number,
  ttlSeconds = 60,
): Promise<any> {
  return fetchStaleWhileRevalidate(
    `lineupFixture:${fixtureId}`,
    ttlSeconds,
    Math.max(30, ttlSeconds * 3),
    () => apiGet("/fixtures", "lineups", { id: fixtureId }),
  );
}

export async function getFixtureLineupsCached(
  fixtureId: number,
  ttlSeconds = 60,
): Promise<any> {
  return fetchStaleWhileRevalidate(
    `fixtureLineups:${fixtureId}`,
    ttlSeconds,
    Math.max(30, ttlSeconds * 3),
    () => apiGet("/fixtures/lineups", "lineups", { fixture: fixtureId }),
  );
}

export async function getFixturePlayersCached(
  fixtureId: number,
  ttlSeconds = 15,
): Promise<any> {
  return fetchStaleWhileRevalidate(
    `fixturePlayers:${fixtureId}`,
    ttlSeconds,
    Math.max(30, ttlSeconds * 3),
    () => apiGet("/fixtures/players", "lineups", { fixture: fixtureId }),
  );
}

export async function getFixtureInjuriesCached(
  fixtureId: number,
  ttlSeconds = 15 * 60,
): Promise<any> {
  return fetchStaleWhileRevalidate(
    `fixtureInjuries:${fixtureId}`,
    ttlSeconds,
    Math.max(30 * 60, ttlSeconds * 3),
    () => apiGet("/injuries", "lineups", { fixture: fixtureId }),
  );
}

export async function getFixtureStatisticsCached(
  fixtureId: number,
  type: CounterKey = "other",
): Promise<any> {
  return fetchWithCache(
    `fixtureStatistics:${fixtureId}`,
    24 * 3600,
    () => apiGet("/fixtures/statistics", type, { fixture: fixtureId }),
    7 * 24 * 3600,
  );
}

export async function getLiveFixtureStatisticsCached(
  fixtureId: number,
  ttlSeconds = 8,
): Promise<any> {
  return fetchStaleWhileRevalidate(
    `liveFixtureStatistics:${fixtureId}`,
    Math.max(4, ttlSeconds),
    Math.max(16, ttlSeconds * 3),
    () => apiGet("/fixtures/statistics", "brainLive", { fixture: fixtureId }),
  );
}

/**
 * Live ristretto ai top campionati per BrainLive.
 * Questo evita di scaricare tutto il live mondiale.
 */
export async function getTopLiveFixtures(type: CounterKey = "brainLive"): Promise<any> {
  const cacheKey = `liveFixtures_top_${BRAIN_LIVE_LIVE_PARAM}`;

  return fetchStaleWhileRevalidate<any>(
    cacheKey,
    8,
    24,
    async () => {
      const data = await apiGet("/fixtures", type, {
        live: BRAIN_LIVE_LIVE_PARAM,
      });

      const liveCount = Array.isArray(data?.response) ? data.response.length : 0;

      /**
       * BrainLive deve restare reattivo: è una sezione premium/live,
       * quindi non può mostrare punteggi troppo vecchi.
       */
      const ttlSeconds = Math.max(
        10,
        Math.round(liveTtlMs(liveCount) / 1000)
      );

      setCache(cacheKey, data, ttlSeconds, 30);
      return data;
    }
  );
}

export async function getLeagueFixturesByDate(
  leagueId: number,
  date: string,
  season?: number,
  type: CounterKey = "compact"
): Promise<any> {
  const cacheKey = `leagueFixtures_${leagueId}_${date}_${season ?? "na"}`;

  const today = new Date().toISOString().slice(0, 10);
  const liveDayTtl = 10;
  const ttl = date === today ? liveDayTtl : 120;
  return fetchWithCache<any>(cacheKey, ttl, async () => {
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

/**
 * API-Football pubblica le classifiche con cadenza oraria. La cache vive sul
 * server, quindi centomila utenti condividono la stessa singola chiamata.
 */
export async function getStandingsCached(
  leagueId: number,
  season: number,
): Promise<any> {
  const cacheKey = `standings_${leagueId}_${season}`;
  return fetchWithCache<any>(cacheKey, 60 * 60, async () => {
    return apiGet("/standings", "standings", {
      league: leagueId,
      season,
    });
  });
}

export async function getFixtureEventsCached(
  fixtureId: number,
  type: CounterKey = "events",
  ttlSeconds = 600,
): Promise<any> {
  const cacheKey = `fixtureEvents_${fixtureId}`;

  return fetchWithCache<any>(cacheKey, ttlSeconds, async () => {
    return apiGet("/fixtures/events", type, { fixture: fixtureId });
  });
}

export async function getFixtureEventsRealtimeCached(
  fixtureId: number,
  ttlSeconds = 10,
): Promise<any> {
  return fetchStaleWhileRevalidate<any>(
    `fixtureEventsRealtime_${fixtureId}`,
    ttlSeconds,
    Math.max(20, ttlSeconds * 3),
    () => apiGet("/fixtures/events", "lineups", { fixture: fixtureId }),
  );
}

/// Referto completo di una gara terminata. I dati definitivi non cambiano e
/// possono essere condivisi tra tutti i profili squadra per un giorno intero.
export async function getFinishedFixtureDetailsCached(
  fixtureId: number,
): Promise<any> {
  return fetchWithCache<any>(`finishedFixture_${fixtureId}`, 24 * 60 * 60, () => {
    return apiGet("/fixtures", "other", { id: fixtureId });
  });
}

export async function getFixturesByDate(
  date: string,
  type: CounterKey = "brainPrematch"
): Promise<any> {
  const cacheKey = `fixturesByDate_${date}`;

  const today = new Date().toISOString().slice(0, 10);
  const isToday = date === today;
  const ttl = isToday ? 10 : 600;
  const stale = isToday ? 24 : 30 * 60;
  return fetchStaleWhileRevalidate<any>(cacheKey, ttl, stale, async () => {
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

export async function getPlayerById(playerId: number, season: number): Promise<any> {
  const cacheKey = `player_${playerId}_season_${season}`;

  return fetchWithCache<any>(cacheKey, 12 * 60 * 60, async () => {
    return apiGet("/players", "other", {
      id: playerId,
      season,
    });
  });
}

const apiFootball = {
  getLiveFixtures,
  getTopLiveFixtures,
  getLeagueFixturesByDate,
  getFixtureEventsCached,
  getFixtureEventsRealtimeCached,
  getFixturesByDate,
  getTeamLastFixtures,
  getPlayersByTeam,
  getPlayerById,
  getFixtureByIdCached,
  getFixtureLineupsCached,
  getFixturePlayersCached,
  getFixtureInjuriesCached,
};

export default apiFootball;
