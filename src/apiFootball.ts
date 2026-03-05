import axios from "axios";
import { getCache, setCache } from "./cache";
import { CounterKey, markApiCall, markCacheHit, markCacheMiss } from "./stats";
import { liveTtlMs } from "./ttl";

const BASE_URL = "https://v3.football.api-sports.io";

function apiKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new Error("Missing API_FOOTBALL_KEY in .env");
  }
  return key;
}

/**
 * Wrapper unico per chiamate API-Football con stats e params.
 * NOTA: qui facciamo markApiCall(type), quindi NON duplicarlo nei caller.
 */
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

/**
 * Fixtures live (cache TTL dinamico in base al numero live)
 */
export async function getLiveFixtures(type: CounterKey = "live"): Promise<any> {
  const cacheKey = "liveFixtures";

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  // usa apiGet (che fa già markApiCall)
  const data = await apiGet("/fixtures", type, { live: "all" });

  const liveCount = Array.isArray(data?.response) ? data.response.length : 0;
  const ttlSeconds = Math.max(1, Math.round(liveTtlMs(liveCount) / 1000));

  setCache(cacheKey, data, ttlSeconds);
  return data;
}

/**
 * Events di una fixture (cache breve 60s)
 * Serve per calcolare redCards quando i fixtures live non includono gli eventi Card.
 */
export async function getFixtureEventsCached(
  fixtureId: number,
  type: CounterKey = "other"
): Promise<any> {
  const cacheKey = `fixtureEvents_${fixtureId}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const data = await apiGet("/fixtures/events", type, { fixture: fixtureId });

  // cache breve: 60s (solo per live)
  setCache(cacheKey, data, 60);
  return data;
}

/**
 * Players by team (paginato) - cache 12h
 */
export async function getPlayersByTeam(teamId: number, season: number): Promise<any> {
  const cacheKey = `players_team_${teamId}_season_${season}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const all: any[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await apiGet("/players", "other", { team: teamId, season, page });

    const resp = Array.isArray(data?.response) ? data.response : [];
    all.push(...resp);

    // API-Football: paging.total = numero totale pagine
    const pagingTotal = data?.paging?.total;
    if (pagingTotal != null) {
      const t = Number(pagingTotal);
      totalPages = Number.isFinite(t) && t > 0 ? t : 1;
    } else {
      totalPages = 1;
    }

    page += 1;
  } while (page <= totalPages);

  const merged = {
    response: all,
    paging: { current: totalPages, total: totalPages },
  };

  // cache 12 ore
  setCache(cacheKey, merged, 12 * 60 * 60);
  return merged;
}