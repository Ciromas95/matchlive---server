import axios from "axios";
import { getCache, setCache } from "./cache";
import { markApiCall, markCacheHit, markCacheMiss } from "./stats";

type BrainLiveTag =
  | "hot"
  | "homeDom"
  | "awayDom"
  | "interesting";

type BrainLivePick = {
  fixtureId: number;
  statusShort: string | null;
  elapsed: number | null;
  phase: "firstHalf" | "secondHalf";
  phaseElapsed: number;
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
  tagType: BrainLiveTag;
  badgeText: string;
  finalScore: number;
  stats: {
    xgHome: number;
    xgAway: number;
    possessionHome: number;
    possessionAway: number;
    shotsHome: number;
    shotsAway: number;
    shotsOnGoalHome: number;
    shotsOnGoalAway: number;
    cornersHome: number;
    cornersAway: number;
  };
};

type StatsMap = Record<string, number>;

type BrainStatsPair = {
  home: StatsMap;
  away: StatsMap;
};

type PhaseScope = {
  phase: "firstHalf" | "secondHalf";
  phaseElapsed: number;
  scopedStats: BrainStatsPair;
  hasSecondHalfBaseline: boolean;
};

const BASE_URL = "https://v3.football.api-sports.io";

const LIVE_STATUSES = new Set(["1H", "2H", "HT", "ET", "LIVE", "INT"]);

const ALLOWED_LEAGUE_IDS = new Set<number>([
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
]);

const HOT_MIN = 56;
const DOM_MIN = 52;
const INTERESTING_MIN = 30;

function apiKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new Error("Missing API_FOOTBALL_KEY in .env");
  }
  return key;
}

async function apiGet(path: string, params?: Record<string, any>): Promise<any> {
  markApiCall("brainLive");

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

async function getLiveFixtures(): Promise<any[]> {
  const cacheKey = "brainLive_liveFixtures";
  const cached = getCache<any[]>(cacheKey);

  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const raw = await apiGet("/fixtures", { live: "all" });
  const fixtures = Array.isArray(raw?.response) ? raw.response : [];

  setCache(cacheKey, fixtures, 8);
  return fixtures;
}

async function getMatchStats(fixtureId: number): Promise<BrainStatsPair | null> {
  const cacheKey = `brainLive_matchStats_${fixtureId}`;
  const cached = getCache<BrainStatsPair>(cacheKey);

  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const raw = await apiGet("/fixtures/statistics", { fixture: fixtureId });
  const response = Array.isArray(raw?.response) ? raw.response : [];

  if (response.length < 2) return null;

  const home = response[0];
  const away = response[1];

  const homeMap = toNumericMap(home?.statistics);
  const awayMap = toNumericMap(away?.statistics);

  const pair: BrainStatsPair = {
    home: homeMap,
    away: awayMap,
  };

  setCache(cacheKey, pair, 20);
  return pair;
}

function toNumericMap(list: unknown): StatsMap {
  const map: StatsMap = {};

  if (!Array.isArray(list)) return map;

  for (const e of list) {
    const rawType = String((e as any)?.type ?? "").trim();
    const value = parseValue((e as any)?.value);

    if (!rawType || value == null) continue;

    map[canonicalKey(rawType)] = value;
  }

  return map;
}

function canonicalKey(type: string): string {
  const norm = type.toLowerCase().replace(/[ _']/g, "");

  switch (norm) {
    case "ballpossession":
    case "possession":
      return "Ball Possession";
    case "totalshots":
      return "Total Shots";
    case "shotsongoal":
    case "shotsontarget":
      return "Shots on Goal";
    case "cornerkicks":
    case "corners":
      return "Corner Kicks";
    case "xg":
    case "expectedgoals":
      return "xG";
    default:
      return type;
  }
}

function parseValue(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;

  const s = String(value).trim();

  if (!s || s === "-") return null;

  if (s.endsWith("%")) {
    const inner = s.slice(0, -1).trim().replace(",", ".");
    const num = Number(inner);
    return Number.isFinite(num) ? num : null;
  }

  const num = Number(s.replace(",", "."));
  return Number.isFinite(num) ? num : null;
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
  if (elapsed < 10) return false;
  if (elapsed > 80) return false;
  if (!isAllowedLeague(f)) return false;
  if (isYouthOrReserveFixture(f)) return false;

  return true;
}

function sum(a?: number, b?: number): number {
  return (a ?? 0) + (b ?? 0);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

function scale(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  if (inMax <= inMin) return outMin;

  const t = clamp((value - inMin) / (inMax - inMin), 0, 1);
  return outMin + (outMax - outMin) * t;
}

function nonNegativeDelta(current: number, baseline: number): number {
  return Math.max(0, current - baseline);
}

function subtractStatsMap(current: StatsMap, baseline: StatsMap): StatsMap {
  const keys = new Set<string>([
    ...Object.keys(current),
    ...Object.keys(baseline),
  ]);

  const result: StatsMap = {};

  for (const key of keys) {
    result[key] = nonNegativeDelta(current[key] ?? 0, baseline[key] ?? 0);
  }

  return result;
}

function saveHalfTimeBaseline(fixtureId: number, stats: BrainStatsPair): void {
  const cacheKey = `brainLive_htBaseline_${fixtureId}`;
  const already = getCache<BrainStatsPair>(cacheKey);

  if (already) return;

  setCache(cacheKey, stats, 7200);
  console.log("[brainLive] HT BASELINE SAVED for fixture", fixtureId);
}

function getPhaseScope(
  fixtureId: number,
  statusShort: string,
  elapsed: number,
  cumulativeStats: BrainStatsPair
): PhaseScope {
  const isFirstHalf = statusShort === "1H" || statusShort === "HT";
  const isSecondHalfLike =
    statusShort === "2H" ||
    statusShort === "INT" ||
    (elapsed > 45 && statusShort !== "1H" && statusShort !== "HT");

  if (statusShort === "HT" || statusShort === "INT" || elapsed === 45) {
    saveHalfTimeBaseline(fixtureId, cumulativeStats);
  }

  if (isFirstHalf || elapsed <= 45) {
    return {
      phase: "firstHalf",
      phaseElapsed: clamp(elapsed, 0, 45),
      scopedStats: cumulativeStats,
      hasSecondHalfBaseline: false,
    };
  }

  if (isSecondHalfLike) {
    const baselineKey = `brainLive_htBaseline_${fixtureId}`;
    const baseline = getCache<BrainStatsPair>(baselineKey);

    if (baseline) {
      return {
        phase: "secondHalf",
        phaseElapsed: clamp(elapsed - 45, 0, 45),
        scopedStats: {
          home: subtractStatsMap(cumulativeStats.home, baseline.home),
          away: subtractStatsMap(cumulativeStats.away, baseline.away),
        },
        hasSecondHalfBaseline: true,
      };
    }

    console.log(
      "[brainLive] WARNING no HT baseline for fixture",
      fixtureId,
      "- fallback to cumulative stats"
    );

    return {
      phase: "secondHalf",
      phaseElapsed: clamp(elapsed - 45, 0, 45),
      scopedStats: cumulativeStats,
      hasSecondHalfBaseline: false,
    };
  }

  return {
    phase: "firstHalf",
    phaseElapsed: clamp(elapsed, 0, 45),
    scopedStats: cumulativeStats,
    hasSecondHalfBaseline: false,
  };
}

function buildPick(f: any, cumulativeStats: BrainStatsPair): BrainLivePick | null {
  const fixtureId = Number(f?.fixture?.id ?? 0);
  if (!fixtureId) return null;

  const elapsed = Number(f?.fixture?.status?.elapsed ?? 0);
  const statusShort = String(f?.fixture?.status?.short ?? "").toUpperCase();

  const homeGoals = Number(f?.goals?.home ?? 0);
  const awayGoals = Number(f?.goals?.away ?? 0);
  const goalDiff = Math.abs(homeGoals - awayGoals);

  const interestingScorelineOk =
  homeGoals <= 1 &&
  awayGoals <= 1 &&
  goalDiff <= 1;

  const homeName = String(f?.teams?.home?.name ?? "Unknown Home");
  const awayName = String(f?.teams?.away?.name ?? "Unknown Away");
  const leagueName = String(f?.league?.name ?? "Unknown League");

  const phaseScope = getPhaseScope(fixtureId, statusShort, elapsed, cumulativeStats);
  const { phase, phaseElapsed, scopedStats, hasSecondHalfBaseline } = phaseScope;

  const h = scopedStats.home;
  const a = scopedStats.away;

  const xgHome = h["xG"] ?? 0;
  const xgAway = a["xG"] ?? 0;
  const possessionHome = h["Ball Possession"] ?? 0;
  const possessionAway = a["Ball Possession"] ?? 0;
  const shotsHome = h["Total Shots"] ?? 0;
  const shotsAway = a["Total Shots"] ?? 0;
  const shotsOnGoalHome = h["Shots on Goal"] ?? 0;
  const shotsOnGoalAway = a["Shots on Goal"] ?? 0;
  const cornersHome = h["Corner Kicks"] ?? 0;
  const cornersAway = a["Corner Kicks"] ?? 0;

  const shotsPer10Home = phaseElapsed > 0 ? (shotsHome / phaseElapsed) * 10 : 0;
  const shotsPer10Away = phaseElapsed > 0 ? (shotsAway / phaseElapsed) * 10 : 0;

  const shotsRatioHome =
    shotsAway > 0 ? shotsHome / shotsAway : shotsHome >= 4 ? 4 : 1;
  const shotsRatioAway =
    shotsHome > 0 ? shotsAway / shotsHome : shotsAway >= 4 ? 4 : 1;

  let hotScore = 0;
  const inScoringWindow =
    (phase === "firstHalf" && phaseElapsed >= 15 && phaseElapsed <= 45) ||
    (phase === "secondHalf" && phaseElapsed >= 1 && phaseElapsed <= 35);

  const hotScorelineOk =
    (homeGoals === 0 && awayGoals === 0) ||
    (homeGoals === 1 && awayGoals === 0) ||
    (homeGoals === 0 && awayGoals === 1) ||
    (homeGoals === 1 && awayGoals === 1);

  if (inScoringWindow && hotScorelineOk) {
    const bilateralXg = Math.min(xgHome, xgAway);
    const bilateralShots = Math.min(shotsHome, shotsAway);
    const bilateralSot = Math.min(shotsOnGoalHome, shotsOnGoalAway);
    const possDiffAbs = Math.abs(possessionHome - possessionAway);

    hotScore += scale(sum(xgHome, xgAway), 0.5, 2.2, 0, 35);
    hotScore += scale(sum(shotsHome, shotsAway), 6, 20, 0, 20);
    hotScore += scale(sum(shotsOnGoalHome, shotsOnGoalAway), 2, 8, 0, 20);
    hotScore += scale(sum(cornersHome, cornersAway), 2, 8, 0, 10);
    hotScore += scale(bilateralXg, 0.12, 0.8, 0, 8);
    hotScore += scale(bilateralShots, 2, 7, 0, 4);
    hotScore += scale(bilateralSot, 1, 3, 0, 3);

    if (possDiffAbs <= 18) hotScore += 5;
    if (goalDiff > 1) hotScore -= 20;
  }

  let homeDomScore = 0;
  const homeNotAlreadyAhead = homeGoals <= awayGoals;

  if (inScoringWindow && homeNotAlreadyAhead) {
    homeDomScore += scale(xgHome - xgAway, 0.15, 1.0, 0, 30);
    homeDomScore += scale(shotsOnGoalHome - shotsOnGoalAway, 1, 4, 0, 25);
    homeDomScore += scale(shotsHome - shotsAway, 2, 8, 0, 18);
    homeDomScore += scale(cornersHome - cornersAway, 1, 5, 0, 12);
    homeDomScore += scale(possessionHome - possessionAway, 6, 25, 0, 10);

    if (homeGoals === awayGoals) homeDomScore += 6;
    if (homeGoals < awayGoals && goalDiff === 1) homeDomScore += 10;
    if (goalDiff >= 2) homeDomScore -= 10;
  }

  let awayDomScore = 0;
  const awayNotAlreadyAhead = awayGoals <= homeGoals;

  if (inScoringWindow && awayNotAlreadyAhead) {
    awayDomScore += scale(xgAway - xgHome, 0.15, 1.0, 0, 30);
    awayDomScore += scale(shotsOnGoalAway - shotsOnGoalHome, 1, 4, 0, 25);
    awayDomScore += scale(shotsAway - shotsHome, 2, 8, 0, 18);
    awayDomScore += scale(cornersAway - cornersHome, 1, 5, 0, 12);
    awayDomScore += scale(possessionAway - possessionHome, 6, 25, 0, 10);

    if (homeGoals === awayGoals) awayDomScore += 6;
    if (awayGoals < homeGoals && goalDiff === 1) awayDomScore += 10;
    if (goalDiff >= 2) awayDomScore -= 10;
  }

  let homeInterestingScore = 0;
const homeInterestingAllowed =
  inScoringWindow &&
  interestingScorelineOk &&
  phaseElapsed >= (phase === "firstHalf" ? 20 : 5) &&
  homeDomScore < DOM_MIN;

  if (homeInterestingAllowed) {
    homeInterestingScore += scale(shotsHome, 5, 12, 0, 26);
    homeInterestingScore += scale(shotsPer10Home, 1.2, 2.8, 0, 22);
    homeInterestingScore += scale(shotsHome - shotsAway, 2, 8, 0, 18);
    homeInterestingScore += scale(shotsRatioHome, 1.6, 3.5, 0, 14);
    homeInterestingScore += scale(xgHome - xgAway, 0.08, 0.70, 0, 10);
    homeInterestingScore += scale(shotsOnGoalHome - shotsOnGoalAway, 1, 3, 0, 8);

    if (shotsHome >= 5 && shotsHome >= shotsAway * 2) homeInterestingScore += 8;
    if (homeGoals === awayGoals) homeInterestingScore += 4;
    if (homeGoals < awayGoals && goalDiff === 1) homeInterestingScore += 5;
    if (goalDiff >= 2) homeInterestingScore -= 10;

    if (phase === "secondHalf" && phaseElapsed <= 20 && shotsHome >= 4) homeInterestingScore += 4;
    if (phase === "secondHalf" && xgHome >= 0.45) homeInterestingScore += 3;
    if (shotsHome < 5) homeInterestingScore -= 10;
  }

  let awayInterestingScore = 0;
const awayInterestingAllowed =
  inScoringWindow &&
  interestingScorelineOk &&
  phaseElapsed >= (phase === "firstHalf" ? 20 : 5) &&
  awayDomScore < DOM_MIN;

  if (awayInterestingAllowed) {
    awayInterestingScore += scale(shotsAway, 5, 12, 0, 26);
    awayInterestingScore += scale(shotsPer10Away, 1.2, 2.8, 0, 22);
    awayInterestingScore += scale(shotsAway - shotsHome, 2, 8, 0, 18);
    awayInterestingScore += scale(shotsRatioAway, 1.6, 3.5, 0, 14);
    awayInterestingScore += scale(xgAway - xgHome, 0.08, 0.70, 0, 10);
    awayInterestingScore += scale(shotsOnGoalAway - shotsOnGoalHome, 1, 3, 0, 8);

    if (shotsAway >= 5 && shotsAway >= shotsHome * 2) awayInterestingScore += 8;
    if (homeGoals === awayGoals) awayInterestingScore += 4;
    if (awayGoals < homeGoals && goalDiff === 1) awayInterestingScore += 5;
    if (goalDiff >= 2) awayInterestingScore -= 10;

    if (phase === "secondHalf" && phaseElapsed <= 20 && shotsAway >= 4) awayInterestingScore += 4;
    if (phase === "secondHalf" && xgAway >= 0.45) awayInterestingScore += 3;
    if (shotsAway < 5) awayInterestingScore -= 10;
  }

  hotScore = clamp(hotScore, 0, 100);
  homeDomScore = clamp(homeDomScore, 0, 100);
  awayDomScore = clamp(awayDomScore, 0, 100);
  homeInterestingScore = clamp(homeInterestingScore, 0, 100);
  awayInterestingScore = clamp(awayInterestingScore, 0, 100);

  console.log(
    "[brainLive][scores]",
    homeName,
    "vs",
    awayName,
    "|",
    leagueName,
    "| phase:",
    phase,
    "| phaseMinute:",
    phaseElapsed,
    "| baseline2T:",
    hasSecondHalfBaseline ? "yes" : "no",
    "| realMinute:",
    elapsed,
    "| score:",
    `${homeGoals}-${awayGoals}`,
    "| xG:",
    `${xgHome}-${xgAway}`,
    "| poss:",
    `${possessionHome}-${possessionAway}`,
    "| shots:",
    `${shotsHome}-${shotsAway}`,
    "| sot:",
    `${shotsOnGoalHome}-${shotsOnGoalAway}`,
    "| corners:",
    `${cornersHome}-${cornersAway}`,
    "| hot:",
    hotScore.toFixed(1),
    "| homeDom:",
    homeDomScore.toFixed(1),
    "| awayDom:",
    awayDomScore.toFixed(1),
    "| interestingHome:",
    homeInterestingScore.toFixed(1),
    "| interestingAway:",
    awayInterestingScore.toFixed(1)
  );

  const candidates: Array<{ tagType: BrainLiveTag; score: number }> = [];

  if (hotScore >= HOT_MIN) {
    candidates.push({ tagType: "hot", score: hotScore });
  }

  if (homeDomScore >= DOM_MIN) {
    candidates.push({ tagType: "homeDom", score: homeDomScore });
  }

  if (awayDomScore >= DOM_MIN) {
    candidates.push({ tagType: "awayDom", score: awayDomScore });
  }

  const bestInterestingScore = Math.max(homeInterestingScore, awayInterestingScore);
  const hasInteresting =
    bestInterestingScore >= INTERESTING_MIN &&
    hotScore < HOT_MIN &&
    homeDomScore < DOM_MIN &&
    awayDomScore < DOM_MIN;

  if (hasInteresting) {
    candidates.push({
      tagType: "interesting",
      score: bestInterestingScore,
    });
  }

  if (candidates.length === 0) return null;

  const priority: Record<BrainLiveTag, number> = {
    hot: 4,
    homeDom: 3,
    awayDom: 3,
    interesting: 2,
  };

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return priority[b.tagType] - priority[a.tagType];
  });

  const best = candidates[0];

  const badgeText =
    best.tagType === "hot"
      ? "HOT MATCH"
      : best.tagType === "homeDom"
      ? "DOMINIO CASA"
      : best.tagType === "awayDom"
      ? "DOMINIO OSPITE"
      : "MATCH INTERESSANTE";

  return {
    fixtureId,
    statusShort,
    elapsed: Number.isFinite(elapsed) ? elapsed : null,
    phase,
    phaseElapsed,
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
      goals: homeGoals,
    },
    away: {
      id: f?.teams?.away?.id ?? null,
      name: f?.teams?.away?.name ?? null,
      logo: f?.teams?.away?.logo ?? null,
      goals: awayGoals,
    },
    tagType: best.tagType,
    badgeText,
    finalScore: Number(best.score.toFixed(1)),
    stats: {
      xgHome,
      xgAway,
      possessionHome,
      possessionAway,
      shotsHome,
      shotsAway,
      shotsOnGoalHome,
      shotsOnGoalAway,
      cornersHome,
      cornersAway,
    },
  };
}

async function buildBrainLive(
  maxResults: number = 8
): Promise<{ hot: BrainLivePick | null; others: BrainLivePick[] }> {
  const cacheKey = `brainLive_v2_${maxResults}`;
  const cached = getCache<{ hot: BrainLivePick | null; others: BrainLivePick[] }>(cacheKey);

  if (cached) {
    console.log("[brainLive] CACHE HIT");
    return cached;
  }

  console.log("[brainLive] START");

  const fixtures = await getLiveFixtures();
  console.log("[brainLive] live fixtures total =", fixtures.length);

  const candidates = fixtures.filter(isUsefulLiveFixture);
  console.log("[brainLive] candidates after filters =", candidates.length);

  for (const f of candidates) {
    console.log(
      "[brainLive] CANDIDATE",
      f?.league?.country,
      "|",
      f?.league?.name,
      "|",
      f?.teams?.home?.name,
      "vs",
      f?.teams?.away?.name,
      "| minute:",
      f?.fixture?.status?.elapsed,
      "| score:",
      `${Number(f?.goals?.home ?? 0)}-${Number(f?.goals?.away ?? 0)}`
    );
  }

  const picks: BrainLivePick[] = [];

  for (const f of candidates) {
    const fixtureId = Number(f?.fixture?.id ?? 0);
    if (!fixtureId) continue;

    const homeName = String(f?.teams?.home?.name ?? "Unknown Home");
    const awayName = String(f?.teams?.away?.name ?? "Unknown Away");
    const leagueName = String(f?.league?.name ?? "Unknown League");
    const elapsed = Number(f?.fixture?.status?.elapsed ?? 0);
    const score = `${Number(f?.goals?.home ?? 0)}-${Number(f?.goals?.away ?? 0)}`;

    try {
      const stats = await getMatchStats(fixtureId);

      if (!stats) {
        console.log("[brainLive] NO STATS", homeName, "vs", awayName);
        continue;
      }

      const pick = buildPick(f, stats);

      if (!pick) {
        console.log(
          "[brainLive] SKIPPED",
          homeName,
          "vs",
          awayName,
          "|",
          leagueName,
          "| minute:",
          elapsed,
          "| score:",
          score
        );
        continue;
      }

      console.log(
        "[brainLive] PICK",
        homeName,
        "vs",
        awayName,
        "|",
        pick.tagType,
        "| score:",
        pick.finalScore,
        "| phase:",
        pick.phase,
        "| phaseMinute:",
        pick.phaseElapsed
      );

      picks.push(pick);
    } catch (err) {
      console.log("[brainLive] ERROR", homeName, "vs", awayName, err);
      continue;
    }
  }

  console.log("[brainLive] TOTAL PICKS =", picks.length);

  picks.sort((a, b) => b.finalScore - a.finalScore);

  let hot: BrainLivePick | null = null;
  for (const p of picks) {
    if (p.tagType === "hot") {
      hot = p;
      break;
    }
  }

  const others: BrainLivePick[] = [];
  for (const p of picks) {
    if (hot && p.fixtureId === hot.fixtureId) continue;
    if (others.length >= (hot ? maxResults - 1 : maxResults)) break;
    others.push(p);
  }

  console.log(
    "[brainLive] RESULT => hot:",
    hot ? `${hot.home.name} vs ${hot.away.name}` : "none",
    "| others:",
    others.length
  );

  const result = { hot, others };
  setCache(cacheKey, result, 8);

  return result;
}

export { buildBrainLive };
