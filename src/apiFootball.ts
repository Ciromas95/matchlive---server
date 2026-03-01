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

export async function getLiveFixtures(type: CounterKey = "live"): Promise<any> {
  const cacheKey = "liveFixtures";

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();
  markApiCall(type);

  const res = await axios.get(`${BASE_URL}/fixtures?live=all`, {
    headers: { "x-apisports-key": apiKey() },
    timeout: 10000
  });

  const data = res.data;

  const liveCount = Array.isArray(data?.response)
    ? data.response.length
    : 0;

const ttlSeconds = Math.max(1, Math.round(liveTtlMs(liveCount) / 1000));

setCache(cacheKey, data, ttlSeconds);

  return data;
}
export async function getPlayersByTeam(
  teamId: number,
  season: number
): Promise<any> {
  const cacheKey = `players_team_${teamId}_season_${season}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();
  markApiCall("other");

  const all: any[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const res = await axios.get(`${BASE_URL}/players`, {
      headers: { "x-apisports-key": apiKey(), Accept: "application/json" },
      params: { team: teamId, season, page },
      timeout: 10000,
    });

    const data = res.data;

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

  // Ricostruiamo lo stesso shape che usi nel resto del codice:
  const merged = { response: all, paging: { current: totalPages, total: totalPages } };

  // cache 12 ore
  setCache(cacheKey, merged, 12 * 60 * 60);

  return merged;
}