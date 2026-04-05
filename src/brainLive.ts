import { getCache, setCache } from "./cache";
import { markCacheHit, markCacheMiss } from "./stats";
import { getTopLiveFixtures } from "./apiFootball";

type BrainLiveCandidate = {
  fixtureId: number;
  statusShort: string | null;
  elapsed: number | null;
  league: {
    id: number | null;
    name: string | null;
    country: string | null;
    logo: string | null;
    flag: string | null;
  };
  home: {
    id: number | null;
    name: string | null;
    logo: string | null;
    goals: number;
  };
  away: {
    id: number | null;
    name: string | null;
    logo: string | null;
    goals: number;
  };
  lightScore: number;
  scoreHint: string;
};

type BrainLiveResult = {
  candidates: BrainLiveCandidate[];
};

const DEBUG_BRAIN_LIVE = false;

const LIVE_STATUSES = new Set(["1H", "2H", "HT", "ET", "LIVE", "INT"]);

const ALLOWED_LEAGUE_IDS = new Set<number>([
  61,
  140,
  78,
  135,
  94,
  88,
  39,
  218,
  119,
  144,
  2,
  3,
  137,
  207,
]);

const FINAL_RESULT_TTL_SEC = 25;
const PRECOMPUTED_CACHE_TTL_SEC = 50;

/**
 * Più rilassato: il cervello live non è una livescore page.
 */
const BRAIN_LIVE_POLL_INTERVAL_MS = 45_000;

function logDebug(...args: any[]) {
  if (DEBUG_BRAIN_LIVE) {
    console.log(...args);
  }
}

function isAllowedLeague(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  if (ALLOWED_LEAGUE_IDS.has(leagueId)) return true;

  const name = String(f?.league?.name ?? "").toLowerCase();
  const country = String(f?.league?.country ?? "").toLowerCase();

  if (country === "france" && name === "ligue 1") return true;
  if (country === "spain" && name === "la liga") return true;
  if (country === "germany" && name === "bundesliga" && !name.includes("2.")) return true;
  if (country === "italy" && name === "serie a") return true;
  if (country === "portugal" && (name.includes("primeira liga") || name.includes("liga portugal"))) return true;
  if (country === "netherlands" && name.includes("eredivisie")) return true;
  if (country === "england" && name === "premier league") return true;
  if (country.includes("austria") && name.includes("bundesliga")) return true;
  if ((country.includes("denmark") || country.includes("danish")) && name.includes("superliga")) return true;
  if (country.includes("belgium") && (name.includes("jupiler") || name.includes("pro league"))) return true;
  if (name.includes("champions league")) return true;
  if (name.includes("europa league")) return true;
  if (country === "italy" && name.includes("coppa italia")) return true;
  if ((country.includes("switzerland") || country.includes("swiss")) && name.includes("super league")) return true;

  return false;
}

function isYouthOrReserveFixture(f: any): boolean {
  const leagueName = String(f?.league?.name ?? "").toLowerCase();
  const homeName = String(f?.teams?.home?.name ?? "").toLowerCase();
  const awayName = String(f?.teams?.away?.name ?? "").toLowerCase();

  const text = `${leagueName} ${homeName} ${awayName}`;

  return (
    text.includes("u17") ||
    text.includes("u18") ||
    text.includes("u19") ||
    text.includes("u20") ||
    text.includes("u21") ||
    text.includes("u23") ||
    text.includes("youth") ||
    text.includes("reserve") ||
    text.includes("reserves") ||
    text.includes("women")
  );
}

function isUsefulLiveFixture(f: any): boolean {
  const status = String(f?.fixture?.status?.short ?? "").toUpperCase();
  const elapsed = Number(f?.fixture?.status?.elapsed ?? 0);

  if (!LIVE_STATUSES.has(status)) return false;
  if (elapsed < 18) return false;
  if (elapsed > 75) return false;
  if (!isAllowedLeague(f)) return false;
  if (isYouthOrReserveFixture(f)) return false;

  return true;
}

function getScoreHint(f: any): string {
  const homeGoals = Number(f?.goals?.home ?? 0);
  const awayGoals = Number(f?.goals?.away ?? 0);
  const totalGoals = homeGoals + awayGoals;
  const goalDiff = Math.abs(homeGoals - awayGoals);

  if (
    (homeGoals === 0 && awayGoals === 0) ||
    (homeGoals === 1 && awayGoals === 0) ||
    (homeGoals === 0 && awayGoals === 1) ||
    (homeGoals === 1 && awayGoals === 1)
  ) {
    return "open-score";
  }

  if (totalGoals <= 3 && goalDiff <= 1) {
    return "balanced";
  }

  if (goalDiff >= 2) {
    return "one-sided";
  }

  return "generic";
}

function getLightCandidateScore(f: any): number {
  const elapsed = Number(f?.fixture?.status?.elapsed ?? 0);
  const homeGoals = Number(f?.goals?.home ?? 0);
  const awayGoals = Number(f?.goals?.away ?? 0);
  const totalGoals = homeGoals + awayGoals;
  const goalDiff = Math.abs(homeGoals - awayGoals);
  const leagueId = Number(f?.league?.id ?? 0);

  let score = 0;

  if (elapsed >= 18 && elapsed <= 40) score += 16;
  if (elapsed >= 46 && elapsed <= 70) score += 20;
  if (elapsed > 70 && elapsed <= 75) score += 4;

  if (
    (homeGoals === 0 && awayGoals === 0) ||
    (homeGoals === 1 && awayGoals === 0) ||
    (homeGoals === 0 && awayGoals === 1) ||
    (homeGoals === 1 && awayGoals === 1)
  ) {
    score += 24;
  } else if (totalGoals <= 3 && goalDiff <= 1) {
    score += 12;
  } else if (goalDiff >= 2) {
    score -= 12;
  }

  if ([39, 140, 135, 78, 61, 2, 3].includes(leagueId)) {
    score += 8;
  }

  if (goalDiff === 0) score += 6;

  return score;
}

function dedupeByFixture(fixtures: any[]): any[] {
  const seen = new Set<number>();
  const result: any[] = [];

  for (const f of fixtures) {
    const fixtureId = Number(f?.fixture?.id ?? 0);
    if (!fixtureId) continue;
    if (seen.has(fixtureId)) continue;
    seen.add(fixtureId);
    result.push(f);
  }

  return result;
}

function toCandidate(f: any): BrainLiveCandidate | null {
  const fixtureId = Number(f?.fixture?.id ?? 0);
  if (!fixtureId) return null;

  const elapsedRaw = Number(f?.fixture?.status?.elapsed ?? 0);
  const elapsed = Number.isFinite(elapsedRaw) ? elapsedRaw : null;

  return {
    fixtureId,
    statusShort: f?.fixture?.status?.short ?? null,
    elapsed,
    league: {
      id: f?.league?.id ?? null,
      name: f?.league?.name ?? null,
      country: f?.league?.country ?? null,
      logo: f?.league?.logo ?? null,
      flag: f?.league?.flag ?? null,
    },
    home: {
      id: f?.teams?.home?.id ?? null,
      name: f?.teams?.home?.name ?? null,
      logo: f?.teams?.home?.logo ?? null,
      goals: Number(f?.goals?.home ?? 0),
    },
    away: {
      id: f?.teams?.away?.id ?? null,
      name: f?.teams?.away?.name ?? null,
      logo: f?.teams?.away?.logo ?? null,
      goals: Number(f?.goals?.away ?? 0),
    },
    lightScore: getLightCandidateScore(f),
    scoreHint: getScoreHint(f),
  };
}

function getLightResultCacheKey(maxResults: number): string {
  return `brainLive_light_candidates_${maxResults}`;
}

function getPrecomputedCacheKey(maxResults: number): string {
  return `brainLive_precomputed_${maxResults}`;
}

function getBrainLiveFromCache(maxResults: number): BrainLiveResult | null {
  const raw = getCache<any>(getPrecomputedCacheKey(maxResults));

  if (!raw || !Array.isArray(raw?.candidates)) {
    return null;
  }

  return raw as BrainLiveResult;
}

/**
 * Ora BrainLive legge SOLO live top leagues.
 */
async function loadSharedLiveFixtures(): Promise<any[]> {
  const raw = await getTopLiveFixtures("brainLive");
  return Array.isArray(raw?.response) ? raw.response : [];
}

async function buildBrainLive(maxResults: number = 8): Promise<BrainLiveResult> {
  const cacheKey = getLightResultCacheKey(maxResults);
  const cached = getCache<BrainLiveResult>(cacheKey);

  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const startedAt = Date.now();

  const fixtures = await loadSharedLiveFixtures();
  const filtered = fixtures.filter(isUsefulLiveFixture);

  const candidates = dedupeByFixture(filtered)
    .map((f) => ({
      fixture: f,
      lightScore: getLightCandidateScore(f),
    }))
    .filter((x) => x.lightScore > 0)
    .sort((a, b) => {
      if (b.lightScore !== a.lightScore) return b.lightScore - a.lightScore;

      const aElapsed = Number(a.fixture?.fixture?.status?.elapsed ?? 0);
      const bElapsed = Number(b.fixture?.fixture?.status?.elapsed ?? 0);
      return aElapsed - bElapsed;
    })
    .slice(0, maxResults)
    .map((x) => toCandidate(x.fixture))
    .filter((x): x is BrainLiveCandidate => x != null);

  const result: BrainLiveResult = { candidates };

  setCache(cacheKey, result, FINAL_RESULT_TTL_SEC);

  const totalMs = Date.now() - startedAt;
  console.log(
    `[brainLive] light done in ${totalMs}ms | topLiveTotal=${fixtures.length} | filtered=${filtered.length} | candidates=${candidates.length}`
  );

  logDebug(
    "[brainLive] candidates",
    candidates.map((c) => ({
      fixtureId: c.fixtureId,
      match: `${c.home.name} vs ${c.away.name}`,
      minute: c.elapsed,
      lightScore: c.lightScore,
      scoreHint: c.scoreHint,
    }))
  );

  return result;
}

async function refreshBrainLiveCache(maxResults: number = 8): Promise<BrainLiveResult> {
  const result = await buildBrainLive(maxResults);
  setCache(getPrecomputedCacheKey(maxResults), result, PRECOMPUTED_CACHE_TTL_SEC);
  return result;
}

function getDefaultBrainLivePayload(_maxResults: number = 8): BrainLiveResult {
  return {
    candidates: [],
  };
}

let brainLivePollerStarted = false;
let brainLivePollerBusy = false;
let brainLiveInterval: NodeJS.Timeout | null = null;

function startBrainLivePoller(maxResults: number = 8): void {
  if (brainLivePollerStarted) {
    console.log("[brainLive] poller already started");
    return;
  }

  brainLivePollerStarted = true;

  const run = async () => {
    if (brainLivePollerBusy) {
      console.log("[brainLive] poller skipped: previous run still in progress");
      return;
    }

    brainLivePollerBusy = true;

    try {
      await refreshBrainLiveCache(maxResults);
    } catch (e: any) {
      console.error(
        "[brainLive] poller refresh error:",
        e?.response?.data ?? e?.message ?? e
      );
    } finally {
      brainLivePollerBusy = false;
    }
  };

  run();
  brainLiveInterval = setInterval(run, BRAIN_LIVE_POLL_INTERVAL_MS);

  console.log(
    `[brainLive] top-live poller started | intervalMs=${BRAIN_LIVE_POLL_INTERVAL_MS} | maxResults=${maxResults}`
  );
}

console.log("[brainLive.ts] top-live shared module loaded");

export {
  buildBrainLive,
  refreshBrainLiveCache,
  getBrainLiveFromCache,
  getDefaultBrainLivePayload,
  startBrainLivePoller,
};

export type {
  BrainLiveCandidate,
  BrainLiveResult,
};

export default buildBrainLive;
