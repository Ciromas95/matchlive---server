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

  const res = await axios.get(`${BASE_URL}/players`, {
    headers: { 
      "x-apisports-key": apiKey(),
      "Accept": "application/json"
    },
    params: { team: teamId, season },
    timeout: 10000,
  });

  const data = res.data;

  // cache 12 ore
  setCache(cacheKey, data, 12 * 60 * 60);

  return data;
}