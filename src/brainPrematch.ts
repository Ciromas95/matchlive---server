import axios from "axios";
import { getCache, setCache } from "./cache";
import { markApiCall, markCacheHit, markCacheMiss } from "./stats";

type OddsSnapshot = {
  goal: number | null;
  over25: number | null;
  under25: number | null;
};

type TeamSplitStats = {
  matches: number;
  goalsFor: number;
  goalsAgainst: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  avgTotalGoals: number;
  bttsRate: number;
  over25Rate: number;
  scoredRate: number;
  concededRate: number;
  failedToScoreRate: number;
  cleanSheetRate: number;
};

type H2HStats = {
  matches: number;
  goalsForHomeTeam: number;
  goalsForAwayTeam: number;
  avgTotalGoals: number;
  bttsRate: number;
  over25Rate: number;
};

type PrematchPick = {
  fixtureId: number | null;
  date: string | null;
  contextType?: "league" | "cup";
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
  };
  away: {
    id: number | null;
    name: string | null;
    logo: string | null;
  };
  odds: {
    goal: number | null;
    over25: number | null;
    under25: number | null;
  };
  recommendedBet: string;
  insightLine: string;
  reason: string;
  confidence: number;
  score: number;
};

type PrematchMetrics = {
  seasonHome: TeamSplitStats;
  seasonAway: TeamSplitStats;
  recentHome: TeamSplitStats;
  recentAway: TeamSplitStats;
  h2h: H2HStats;
};

type PrematchCandidate = {
  fixtureId: number | null;
  date: string | null;
  contextType?: "league" | "cup";
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
  };
  away: {
    id: number | null;
    name: string | null;
    logo: string | null;
  };
  odds: {
    goal: number | null;
    over25: number | null;
    under25: number | null;
  };
  metrics: PrematchMetrics;
  serverPreAnalysis: {
    preScore: number;
    candidateBet: string | null;
  };
};

type MatchContextType = "league" | "cup";

type EvaluatedPrematch = {
  contextType: MatchContextType;
  goalScore: number;
  overScore: number;
  bestBet: "GOAL" | "OVER 2.5" | null;
  rawScore: number;
  normalizedScore: number;
  confidence: number;
  expectedGoals: number;
  goalSupportRate: number;
  overSupportRate: number;
  homeAttackIndex: number;
  awayAttackIndex: number;
  dualScoringSupport: number;
};

const BASE_URL = "https://v3.football.api-sports.io";
const NOT_STARTED = new Set(["NS", "TBD"]);

const MAX_PICKS_PER_LEAGUE = 2;
const MIN_PICK_SCORE = 65;
const MIN_CONFIDENCE = 0.56;
const MIN_ODD = 1.45;
const RECENT_MATCHES = 5;

function isAllowedPrematchCompetition(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();
  const country = String(f?.league?.country ?? "").toLowerCase().trim();

  const allowedLeagueIds = new Set<number>([
    135, // Serie A
    78,  // Bundesliga
    39,  // Premier League
    88,  // Eredivisie
    140, // La Liga
    61,  // Ligue 1
    94,  // Liga Portugal
    119, // Superliga Denmark
    2,   // UCL
    3,   // UEL
    848, // UECL
    1,   // World Cup
    4,   // Euro Championship
    5,   // Nations League
    32,  // WC Qual Europe
    960, // Euro Qual
    15,  // Club World Cup
  ]);

  if (allowedLeagueIds.has(leagueId)) return true;

  if (country === "italy" && leagueName === "serie a") return true;
  if (country === "germany" && leagueName === "bundesliga") return true;
  if (country === "england" && leagueName === "premier league") return true;
  if (country === "netherlands" && leagueName === "eredivisie") return true;
  if (country === "spain" && leagueName === "la liga") return true;
  if (country === "france" && leagueName === "ligue 1") return true;
  if (country === "portugal" && leagueName.includes("liga portugal")) return true;
  if (country === "denmark" && leagueName.includes("superliga")) return true;

  if (leagueName.includes("champions league")) return true;
  if (leagueName.includes("europa league")) return true;
  if (leagueName.includes("conference league")) return true;

  if (leagueName.includes("world cup")) return true;
  if (leagueName.includes("euro championship")) return true;
  if (leagueName.includes("nations league")) return true;
  if (leagueName.includes("qualification europe")) return true;
  if (leagueName.includes("euro qualification")) return true;
  if (leagueName.includes("club world cup")) return true;

  return false;
}

function isCupCompetition(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();

  const cupIds = new Set<number>([
    2,   // UCL
    3,   // UEL
    848, // UECL
    1,   // World Cup
    4,   // Euro Championship
    5,   // Nations League
    32,  // WC Qual Europe
    960, // Euro Qual
    15,  // Club World Cup
  ]);

  if (cupIds.has(leagueId)) return true;

  if (leagueName.includes("champions league")) return true;
  if (leagueName.includes("europa league")) return true;
  if (leagueName.includes("conference league")) return true;
  if (leagueName.includes("world cup")) return true;
  if (leagueName.includes("euro championship")) return true;
  if (leagueName.includes("nations league")) return true;
  if (leagueName.includes("qualification")) return true;
  if (leagueName.includes("club world cup")) return true;

  return false;
}

function getCompetitionWeight(f: any): number {
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();
  const country = String(f?.league?.country ?? "").toLowerCase().trim();

  if (
    leagueName.includes("champions league") ||
    leagueName.includes("europa league") ||
    leagueName.includes("conference league")
  ) {
    return 0.96;
  }

  if (
    leagueName.includes("world cup") ||
    leagueName.includes("euro championship") ||
    leagueName.includes("nations league") ||
    leagueName.includes("qualification europe") ||
    leagueName.includes("euro qualification") ||
    leagueName.includes("club world cup")
  ) {
    return 0.93;
  }

  if (
    (country === "italy" && leagueName === "serie a") ||
    (country === "germany" && leagueName === "bundesliga") ||
    (country === "england" && leagueName === "premier league") ||
    (country === "netherlands" && leagueName === "eredivisie") ||
    (country === "spain" && leagueName === "la liga") ||
    (country === "france" && leagueName === "ligue 1") ||
    (country === "portugal" && leagueName.includes("liga portugal")) ||
    (country === "denmark" && leagueName.includes("superliga"))
  ) {
    return 1.0;
  }

  return 0.95;
}

function apiKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new Error("Missing API_FOOTBALL_KEY in .env");
  }
  return key;
}

async function apiGet(path: string, params?: Record<string, any>): Promise<any> {
  markApiCall("brainPrematch");

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round1(n: number): number {
  return Number(n.toFixed(1));
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function pct(n: number): string {
  return `${Math.round(clamp(n, 0, 1) * 100)}%`;
}

function parseOdd(value: any): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value > 1 ? value : null;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").trim();
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
  }
  return null;
}

function normalizeLabel(value: any): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function getFixturesByDateLocal(date: string): Promise<any> {
  const cacheKey = `brainPrematch_fixturesByDate_${date}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const data = await apiGet("/fixtures", { date });
  setCache(cacheKey, data, 600);

  return data;
}

async function getTeamLastFixturesLocal(teamId: number, last: number = RECENT_MATCHES): Promise<any> {
  const safeLast = Math.max(1, Math.min(last, 10));
  const cacheKey = `brainPrematch_teamLastFixtures_${teamId}_${safeLast}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const data = await apiGet("/fixtures", {
    team: teamId,
    last: safeLast,
  });

  setCache(cacheKey, data, 6 * 60 * 60);
  return data;
}

async function getTeamSeasonFixturesLocal(teamId: number, season: number): Promise<any> {
  const cacheKey = `brainPrematch_teamSeasonFixtures_${teamId}_${season}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const data = await apiGet("/fixtures", {
    team: teamId,
    season,
  });

  setCache(cacheKey, data, 6 * 60 * 60);
  return data;
}

async function getHeadToHeadLocal(homeId: number, awayId: number): Promise<any> {
  const cacheKey = `brainPrematch_h2h_${homeId}_${awayId}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
    }

  markCacheMiss();

  const data = await apiGet("/fixtures/headtohead", {
    h2h: `${homeId}-${awayId}`,
    last: 5,
  });

  setCache(cacheKey, data, 6 * 60 * 60);
  return data;
}

async function getFixtureOddsLocal(fixtureId: number): Promise<any> {
  const cacheKey = `brainPrematch_odds_${fixtureId}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const data = await apiGet("/odds", { fixture: fixtureId });
  setCache(cacheKey, data, 15 * 60);

  return data;
}

function extractOddsSnapshot(raw: any): OddsSnapshot {
  const response = Array.isArray(raw?.response) ? raw.response : [];
  let goal: number | null = null;
  let over25: number | null = null;
  let under25: number | null = null;

  for (const item of response) {
    const bookmakers = Array.isArray(item?.bookmakers) ? item.bookmakers : [];

    for (const bookmaker of bookmakers) {
      const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];

      for (const bet of bets) {
        const betName = normalizeLabel(bet?.name);
        const values = Array.isArray(bet?.values) ? bet.values : [];

        if (betName.includes("both teams to score") || betName === "btts") {
          for (const v of values) {
            const valueLabel = normalizeLabel(v?.value);
            const odd = parseOdd(v?.odd);
            if (!odd) continue;

            if (["yes", "si", "sì"].includes(valueLabel)) {
              goal = goal == null ? odd : Math.min(goal, odd);
            }
          }
        }

        if (
          betName.includes("over/under") ||
          betName.includes("goals over/under") ||
          betName.includes("total goals")
        ) {
          for (const v of values) {
            const valueLabel = normalizeLabel(v?.value);
            const odd = parseOdd(v?.odd);
            if (!odd) continue;

            if (valueLabel.includes("over 2.5") || valueLabel === "over 2.5 goals") {
              over25 = over25 == null ? odd : Math.min(over25, odd);
            }

            if (valueLabel.includes("under 2.5") || valueLabel === "under 2.5 goals") {
              under25 = under25 == null ? odd : Math.min(under25, odd);
            }
          }
        }
      }
    }
  }

  return { goal, over25, under25 };
}

function emptySplitStats(): TeamSplitStats {
  return {
    matches: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    avgGoalsFor: 0,
    avgGoalsAgainst: 0,
    avgTotalGoals: 0,
    bttsRate: 0,
    over25Rate: 0,
    scoredRate: 0,
    concededRate: 0,
    failedToScoreRate: 0,
    cleanSheetRate: 0,
  };
}

function emptyH2HStats(): H2HStats {
  return {
    matches: 0,
    goalsForHomeTeam: 0,
    goalsForAwayTeam: 0,
    avgTotalGoals: 0,
    bttsRate: 0,
    over25Rate: 0,
  };
}

function buildHomeOnlyStats(raw: any, teamId: number): TeamSplitStats {
  if (!raw || !Array.isArray(raw.response) || raw.response.length === 0) {
    return emptySplitStats();
  }

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failedToScore = 0;
  let cleanSheet = 0;

  for (const e of raw.response) {
    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    if (!["FT", "AET", "PEN"].includes(status)) continue;

    const homeId = e?.teams?.home?.id ?? null;
    if (homeId !== teamId) continue;

    const homeGoals = Number(e?.goals?.home ?? 0);
    const awayGoals = Number(e?.goals?.away ?? 0);

    gf += homeGoals;
    ga += awayGoals;

    if (homeGoals > 0) scored += 1;
    if (awayGoals > 0) conceded += 1;
    if (homeGoals === 0) failedToScore += 1;
    if (awayGoals === 0) cleanSheet += 1;
    if (homeGoals > 0 && awayGoals > 0) btts += 1;
    if (homeGoals + awayGoals >= 3) over25 += 1;

    count += 1;
  }

  if (count === 0) return emptySplitStats();

  return {
    matches: count,
    goalsFor: gf,
    goalsAgainst: ga,
    avgGoalsFor: gf / count,
    avgGoalsAgainst: ga / count,
    avgTotalGoals: (gf + ga) / count,
    bttsRate: btts / count,
    over25Rate: over25 / count,
    scoredRate: scored / count,
    concededRate: conceded / count,
    failedToScoreRate: failedToScore / count,
    cleanSheetRate: cleanSheet / count,
  };
}

function buildAwayOnlyStats(raw: any, teamId: number): TeamSplitStats {
  if (!raw || !Array.isArray(raw.response) || raw.response.length === 0) {
    return emptySplitStats();
  }

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failedToScore = 0;
  let cleanSheet = 0;

  for (const e of raw.response) {
    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    if (!["FT", "AET", "PEN"].includes(status)) continue;

    const awayId = e?.teams?.away?.id ?? null;
    if (awayId !== teamId) continue;

    const homeGoals = Number(e?.goals?.home ?? 0);
    const awayGoals = Number(e?.goals?.away ?? 0);

    gf += awayGoals;
    ga += homeGoals;

    if (awayGoals > 0) scored += 1;
    if (homeGoals > 0) conceded += 1;
    if (awayGoals === 0) failedToScore += 1;
    if (homeGoals === 0) cleanSheet += 1;
    if (homeGoals > 0 && awayGoals > 0) btts += 1;
    if (homeGoals + awayGoals >= 3) over25 += 1;

    count += 1;
  }

  if (count === 0) return emptySplitStats();

  return {
    matches: count,
    goalsFor: gf,
    goalsAgainst: ga,
    avgGoalsFor: gf / count,
    avgGoalsAgainst: ga / count,
    avgTotalGoals: (gf + ga) / count,
    bttsRate: btts / count,
    over25Rate: over25 / count,
    scoredRate: scored / count,
    concededRate: conceded / count,
    failedToScoreRate: failedToScore / count,
    cleanSheetRate: cleanSheet / count,
  };
}

function buildRecentOverallStats(raw: any, teamId: number, last: number = RECENT_MATCHES): TeamSplitStats {
  if (!raw || !Array.isArray(raw.response) || raw.response.length === 0) {
    return emptySplitStats();
  }

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failedToScore = 0;
  let cleanSheet = 0;

  for (const e of raw.response) {
    if (count >= last) break;

    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    if (!["FT", "AET", "PEN"].includes(status)) continue;

    const homeId = e?.teams?.home?.id ?? null;
    const awayId = e?.teams?.away?.id ?? null;

    const homeGoals = Number(e?.goals?.home ?? 0);
    const awayGoals = Number(e?.goals?.away ?? 0);

    let thisGf = 0;
    let thisGa = 0;

    if (homeId === teamId) {
      thisGf = homeGoals;
      thisGa = awayGoals;
    } else if (awayId === teamId) {
      thisGf = awayGoals;
      thisGa = homeGoals;
    } else {
      continue;
    }

    gf += thisGf;
    ga += thisGa;

    if (thisGf > 0) scored += 1;
    if (thisGa > 0) conceded += 1;
    if (thisGf === 0) failedToScore += 1;
    if (thisGa === 0) cleanSheet += 1;
    if (homeGoals > 0 && awayGoals > 0) btts += 1;
    if (homeGoals + awayGoals >= 3) over25 += 1;

    count += 1;
  }

  if (count === 0) return emptySplitStats();

  return {
    matches: count,
    goalsFor: gf,
    goalsAgainst: ga,
    avgGoalsFor: gf / count,
    avgGoalsAgainst: ga / count,
    avgTotalGoals: (gf + ga) / count,
    bttsRate: btts / count,
    over25Rate: over25 / count,
    scoredRate: scored / count,
    concededRate: conceded / count,
    failedToScoreRate: failedToScore / count,
    cleanSheetRate: cleanSheet / count,
  };
}

function buildH2HStats(raw: any, homeTeamId: number, awayTeamId: number, last: number = 5): H2HStats {
  if (!raw || !Array.isArray(raw.response) || raw.response.length === 0) {
    return emptyH2HStats();
  }

  let count = 0;
  let homeGoalsSum = 0;
  let awayGoalsSum = 0;
  let btts = 0;
  let over25 = 0;

  for (const e of raw.response) {
    if (count >= last) break;

    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    if (!["FT", "AET", "PEN"].includes(status)) continue;

    const rawHomeId = e?.teams?.home?.id ?? null;
    const rawAwayId = e?.teams?.away?.id ?? null;

    const homeGoals = Number(e?.goals?.home ?? 0);
    const awayGoals = Number(e?.goals?.away ?? 0);

    let normalizedHomeGoals = 0;
    let normalizedAwayGoals = 0;

    if (rawHomeId === homeTeamId && rawAwayId === awayTeamId) {
      normalizedHomeGoals = homeGoals;
      normalizedAwayGoals = awayGoals;
    } else if (rawHomeId === awayTeamId && rawAwayId === homeTeamId) {
      normalizedHomeGoals = awayGoals;
      normalizedAwayGoals = homeGoals;
    } else {
      continue;
    }

    homeGoalsSum += normalizedHomeGoals;
    awayGoalsSum += normalizedAwayGoals;

    if (normalizedHomeGoals > 0 && normalizedAwayGoals > 0) btts += 1;
    if (normalizedHomeGoals + normalizedAwayGoals >= 3) over25 += 1;

    count += 1;
  }

  if (count === 0) return emptyH2HStats();

  return {
    matches: count,
    goalsForHomeTeam: homeGoalsSum,
    goalsForAwayTeam: awayGoalsSum,
    avgTotalGoals: (homeGoalsSum + awayGoalsSum) / count,
    bttsRate: btts / count,
    over25Rate: over25 / count,
  };
}

function getFixtureSeason(f: any): number {
  const fixtureDate = String(f?.fixture?.date ?? "");
  const yearFromDate = new Date(fixtureDate).getUTCFullYear();
  const seasonFromLeague = Number(f?.league?.season ?? 0);

  if (seasonFromLeague > 0) return seasonFromLeague;
  if (Number.isFinite(yearFromDate) && yearFromDate > 2000) return yearFromDate;

  return new Date().getUTCFullYear();
}

function buildWeightedMetric(
  contextType: MatchContextType,
  leagueValue: number,
  recentValue: number,
  totalFallbackValue: number = 0
): number {
  if (contextType === "cup") {
    return recentValue * 0.50 + leagueValue * 0.20 + totalFallbackValue * 0.30;
  }
  return leagueValue * 0.55 + recentValue * 0.35 + totalFallbackValue * 0.10;
}

function evaluatePrematch(
  f: any,
  seasonHome: TeamSplitStats,
  seasonAway: TeamSplitStats,
  recentHome: TeamSplitStats,
  recentAway: TeamSplitStats,
  h2h: H2HStats,
  odds: OddsSnapshot
): EvaluatedPrematch {
  const contextType: MatchContextType = isCupCompetition(f) ? "cup" : "league";

  const homeAttackIndex = buildWeightedMetric(
    contextType,
    avg([seasonHome.avgGoalsFor, seasonAway.avgGoalsAgainst]),
    avg([recentHome.avgGoalsFor, recentAway.avgGoalsAgainst]),
    avg([seasonHome.scoredRate * 2.2, recentHome.scoredRate * 2.2])
  );

  const awayAttackIndex = buildWeightedMetric(
    contextType,
    avg([seasonAway.avgGoalsFor, seasonHome.avgGoalsAgainst]),
    avg([recentAway.avgGoalsFor, recentHome.avgGoalsAgainst]),
    avg([seasonAway.scoredRate * 2.2, recentAway.scoredRate * 2.2])
  );

  const dualScoringSupport = avg([
    seasonHome.scoredRate,
    seasonAway.scoredRate,
    recentHome.scoredRate,
    recentAway.scoredRate,
  ]);

  const dualConcedingSupport = avg([
    seasonHome.concededRate,
    seasonAway.concededRate,
    recentHome.concededRate,
    recentAway.concededRate,
  ]);

  const failedToScoreRisk = avg([
    seasonHome.failedToScoreRate,
    seasonAway.failedToScoreRate,
    recentHome.failedToScoreRate,
    recentAway.failedToScoreRate,
  ]);

  const cleanSheetResistance = avg([
    seasonHome.cleanSheetRate,
    seasonAway.cleanSheetRate,
    recentHome.cleanSheetRate,
    recentAway.cleanSheetRate,
  ]);

  const goalSupportRate = avg([
    seasonHome.bttsRate,
    seasonAway.bttsRate,
    recentHome.bttsRate,
    recentAway.bttsRate,
  ]);

  const overSupportRate = avg([
    seasonHome.over25Rate,
    seasonAway.over25Rate,
    recentHome.over25Rate,
    recentAway.over25Rate,
  ]);

  const structuralExpectedGoals = avg([
    seasonHome.avgGoalsFor + seasonAway.avgGoalsAgainst,
    seasonAway.avgGoalsFor + seasonHome.avgGoalsAgainst,
  ]);

  const recentExpectedGoals = avg([
    recentHome.avgGoalsFor + recentAway.avgGoalsAgainst,
    recentAway.avgGoalsFor + recentHome.avgGoalsAgainst,
  ]);

  let expectedGoals =
    contextType === "cup"
      ? structuralExpectedGoals * 0.30 + recentExpectedGoals * 0.55
      : structuralExpectedGoals * 0.50 + recentExpectedGoals * 0.35;

  if (h2h.matches >= 2) {
    expectedGoals += h2h.avgTotalGoals * 0.10;
  }

  const h2hGoalBonus =
    h2h.matches >= 2 ? h2h.bttsRate * 7 + clamp(h2h.avgTotalGoals, 0, 4) * 1.6 : 0;

  const h2hOverBonus =
    h2h.matches >= 2 ? h2h.over25Rate * 7 + clamp(h2h.avgTotalGoals, 0, 4) * 2.0 : 0;

  let goalScore = 0;
  goalScore += clamp(homeAttackIndex, 0, 3.5) * 16;
  goalScore += clamp(awayAttackIndex, 0, 3.5) * 16;
  goalScore += goalSupportRate * 18;
  goalScore += dualScoringSupport * 12;
  goalScore += dualConcedingSupport * 10;
  goalScore += h2hGoalBonus;

  goalScore -= failedToScoreRisk * 18;
  goalScore -= cleanSheetResistance * 14;

  if (odds.goal != null) {
    if (odds.goal >= 1.55 && odds.goal <= 2.10) goalScore += 4;
    else if (odds.goal > 2.10 && odds.goal <= 2.60) goalScore += 2;
    else if (odds.goal < MIN_ODD) goalScore -= 6;
  }

  let overScore = 0;
  overScore += clamp(expectedGoals, 0, 4.2) * 14;
  overScore += overSupportRate * 22;
  overScore += avg([
    seasonHome.avgTotalGoals,
    seasonAway.avgTotalGoals,
    recentHome.avgTotalGoals,
    recentAway.avgTotalGoals,
  ]) * 7;
  overScore += avg([
    seasonHome.avgGoalsFor,
    seasonAway.avgGoalsFor,
    recentHome.avgGoalsFor,
    recentAway.avgGoalsFor,
  ]) * 8;
  overScore += h2hOverBonus;

  overScore -= avg([
    seasonHome.failedToScoreRate,
    seasonAway.failedToScoreRate,
    recentHome.failedToScoreRate,
    recentAway.failedToScoreRate,
  ]) * 10;

  if (odds.over25 != null) {
    if (odds.over25 >= 1.60 && odds.over25 <= 2.20) overScore += 4;
    else if (odds.over25 > 2.20 && odds.over25 <= 2.70) overScore += 2;
    else if (odds.over25 < MIN_ODD) overScore -= 6;
  }

  const goalQuoteOk = odds.goal != null && odds.goal >= MIN_ODD;
  const overQuoteOk = odds.over25 != null && odds.over25 >= MIN_ODD;

  const goalCandidate =
    goalQuoteOk &&
    homeAttackIndex >= 1.15 &&
    awayAttackIndex >= 1.10 &&
    dualScoringSupport >= 0.64 &&
    dualConcedingSupport >= 0.58 &&
    failedToScoreRisk <= 0.34 &&
    cleanSheetResistance <= 0.34 &&
    goalSupportRate >= 0.50 &&
    goalScore >= 61;

  const overCandidate =
    overQuoteOk &&
    expectedGoals >= 2.55 &&
    overSupportRate >= 0.50 &&
    avg([
      seasonHome.avgGoalsFor,
      seasonAway.avgGoalsFor,
      recentHome.avgGoalsFor,
      recentAway.avgGoalsFor,
    ]) >= 1.20 &&
    overScore >= 61;

  let bestBet: "GOAL" | "OVER 2.5" | null = null;
  let rawScore = 0;

  if (goalCandidate && overCandidate) {
    if (goalScore >= overScore) {
      bestBet = "GOAL";
      rawScore = goalScore;
    } else {
      bestBet = "OVER 2.5";
      rawScore = overScore;
    }
  } else if (goalCandidate) {
    bestBet = "GOAL";
    rawScore = goalScore;
  } else if (overCandidate) {
    bestBet = "OVER 2.5";
    rawScore = overScore;
  }

  const competitionWeight = getCompetitionWeight(f);
  const normalizedScore = clamp(rawScore * competitionWeight, 0, 100);
  const scoreGap = Math.abs(goalScore - overScore);

  let confidence = 0.42;
  confidence += clamp(normalizedScore / 100, 0, 1) * 0.22;
  confidence += clamp(scoreGap / 22, 0, 1) * 0.05;
  confidence += (seasonHome.matches >= 6 && seasonAway.matches >= 6) ? 0.04 : 0;
  confidence += (recentHome.matches >= 4 && recentAway.matches >= 4) ? 0.05 : 0;
  confidence += (h2h.matches >= 2) ? 0.02 : 0;
  confidence += bestBet === "GOAL" && dualScoringSupport >= 0.72 ? 0.03 : 0;
  confidence += bestBet === "OVER 2.5" && expectedGoals >= 2.95 ? 0.03 : 0;

  if (contextType === "cup") {
    confidence -= 0.03;
  }

  confidence = clamp(confidence, 0.48, 0.82);

  return {
    contextType,
    goalScore: round1(goalScore),
    overScore: round1(overScore),
    bestBet,
    rawScore: round1(rawScore),
    normalizedScore: round1(normalizedScore),
    confidence: round2(confidence),
    expectedGoals: round2(expectedGoals),
    goalSupportRate: round2(goalSupportRate),
    overSupportRate: round2(overSupportRate),
    homeAttackIndex: round2(homeAttackIndex),
    awayAttackIndex: round2(awayAttackIndex),
    dualScoringSupport: round2(dualScoringSupport),
  };
}

function buildServerPreAnalysis(
  f: any,
  seasonHome: TeamSplitStats,
  seasonAway: TeamSplitStats,
  recentHome: TeamSplitStats,
  recentAway: TeamSplitStats,
  h2h: H2HStats,
  odds: OddsSnapshot
): { preScore: number; candidateBet: string | null } {
  const evaluated = evaluatePrematch(
    f,
    seasonHome,
    seasonAway,
    recentHome,
    recentAway,
    h2h,
    odds
  );

  return {
    preScore: evaluated.normalizedScore,
    candidateBet: evaluated.bestBet,
  };
}

function buildPrematchCandidate(
  f: any,
  metrics: PrematchMetrics,
  preAnalysis: { preScore: number; candidateBet: string | null },
  odds: OddsSnapshot,
  contextType: MatchContextType
): PrematchCandidate {
  return {
    fixtureId: f?.fixture?.id ?? null,
    date: f?.fixture?.date ?? null,
    contextType,
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
    },
    away: {
      id: f?.teams?.away?.id ?? null,
      name: f?.teams?.away?.name ?? null,
      logo: f?.teams?.away?.logo ?? null,
    },
    odds: {
      goal: odds.goal,
      over25: odds.over25,
      under25: odds.under25,
    },
    metrics,
    serverPreAnalysis: preAnalysis,
  };
}

function buildPrematchPick(
  f: any,
  seasonHome: TeamSplitStats,
  seasonAway: TeamSplitStats,
  recentHome: TeamSplitStats,
  recentAway: TeamSplitStats,
  h2h: H2HStats,
  odds: OddsSnapshot
): PrematchPick | null {
  const evaluated = evaluatePrematch(
    f,
    seasonHome,
    seasonAway,
    recentHome,
    recentAway,
    h2h,
    odds
  );

  if (!evaluated.bestBet) return null;
  if (evaluated.normalizedScore < MIN_PICK_SCORE) return null;
  if (evaluated.confidence < MIN_CONFIDENCE) return null;

  const selectedOdd = evaluated.bestBet === "GOAL" ? odds.goal : odds.over25;
  if (selectedOdd == null || selectedOdd < MIN_ODD) return null;

  const homeName = f?.teams?.home?.name ?? "Casa";
  const awayName = f?.teams?.away?.name ?? "Ospite";

  const insightParts: string[] = [];

  if (evaluated.contextType === "league") {
    insightParts.push(
      `${homeName} casa ${round2(seasonHome.avgGoalsFor)} fatti / ${round2(seasonHome.avgGoalsAgainst)} subiti`
    );
    insightParts.push(
      `${awayName} fuori ${round2(seasonAway.avgGoalsFor)} fatti / ${round2(seasonAway.avgGoalsAgainst)} subiti`
    );
  } else {
    insightParts.push(
      `${homeName} ultime ${RECENT_MATCHES}: ${round2(recentHome.avgGoalsFor)} fatti / ${round2(recentHome.avgGoalsAgainst)} subiti`
    );
    insightParts.push(
      `${awayName} ultime ${RECENT_MATCHES}: ${round2(recentAway.avgGoalsFor)} fatti / ${round2(recentAway.avgGoalsAgainst)} subiti`
    );
  }

  insightParts.push(
    `forma ${RECENT_MATCHES}: ${round2(recentHome.avgTotalGoals)} + ${round2(recentAway.avgTotalGoals)}`
  );

  if (h2h.matches >= 2) {
    insightParts.push(`H2H ${h2h.matches}: ${round2(h2h.avgTotalGoals)} gol medi`);
  }

  if (evaluated.bestBet === "GOAL") {
    insightParts.push(
      `indici rete ${round2(evaluated.homeAttackIndex)} / ${round2(evaluated.awayAttackIndex)}`
    );
    insightParts.push(`supporto gol ${pct(evaluated.dualScoringSupport)}`);
  } else {
    insightParts.push(`stima match ${round2(evaluated.expectedGoals)} gol`);
    insightParts.push(`supporto over ${pct(evaluated.overSupportRate)}`);
  }

  const insightLine = insightParts.join(" | ");

  let reason = "";

  if (evaluated.bestBet === "GOAL") {
    reason =
      `Profilo da GOAL: entrambe mostrano continuità realizzativa recente ` +
      `e una buona tendenza a concedere. ` +
      `${homeName} ha indice rete ${round2(evaluated.homeAttackIndex)}, ` +
      `${awayName} ${round2(evaluated.awayAttackIndex)}. ` +
      `Il supporto combinato al gol di entrambe è ${pct(evaluated.dualScoringSupport)}.`;

    if (h2h.matches >= 2 && h2h.bttsRate >= 0.50) {
      reason += ` Anche i testa a testa recenti non contrastano il profilo da GOAL.`;
    }

    if (evaluated.contextType === "cup") {
      reason += ` Trattandosi di coppa, il cervello ha pesato di più la forma recente rispetto ai soli split casa/trasferta di stagione.`;
    }
  } else {
    reason =
      `Profilo da OVER 2.5: il match ha una stima di circa ${round2(evaluated.expectedGoals)} gol ` +
      `e supporto over del ${pct(evaluated.overSupportRate)} tra struttura stagionale e forma recente.`;

    if (h2h.matches >= 2 && h2h.over25Rate >= 0.50) {
      reason += ` I testa a testa recenti sostengono ulteriormente il volume atteso del match.`;
    }

    if (evaluated.contextType === "cup") {
      reason += ` Nelle coppe il peso maggiore è stato dato al momento recente delle due squadre.`;
    }
  }

  return {
    fixtureId: f?.fixture?.id ?? null,
    date: f?.fixture?.date ?? null,
    contextType: evaluated.contextType,
    league: {
      id: f?.league?.id ?? null,
      name: f?.league?.name ?? null,
      country: f?.league?.country ?? null,
      logo: f?.league?.logo ?? null,
      flag: f?.league?.flag ?? null,
    },
    home: {
      id: f?.teams?.home?.id ?? null,
      name: homeName,
      logo: f?.teams?.home?.logo ?? null,
    },
    away: {
      id: f?.teams?.away?.id ?? null,
      name: awayName,
      logo: f?.teams?.away?.logo ?? null,
    },
    odds: {
      goal: odds.goal,
      over25: odds.over25,
      under25: odds.under25,
    },
    recommendedBet: evaluated.bestBet,
    insightLine,
    reason,
    confidence: round2(evaluated.confidence),
    score: round1(evaluated.normalizedScore),
  };
}

async function buildBrainPrematch(
  date: string,
  maxMatches: number = 5
): Promise<{
  picks: PrematchPick[];
  candidates: PrematchCandidate[];
}> {
  const cacheKey = `brainPrematch_v9_context_recent5_${date}_${maxMatches}`;

  const cached = getCache<{
    picks: PrematchPick[];
    candidates: PrematchCandidate[];
  }>(cacheKey);

  if (cached) {
    return cached;
  }

  const raw = await getFixturesByDateLocal(date);
  const fixtures = Array.isArray(raw?.response) ? raw.response : [];

  const MAX_PREMATCH_ANALYSIS = 28;

  const upcoming = fixtures
    .filter((f: any) => {
      const status = String(f?.fixture?.status?.short ?? "").toUpperCase();
      if (!NOT_STARTED.has(status)) return false;
      if (!isAllowedPrematchCompetition(f)) return false;
      return true;
    })
    .sort((a: any, b: any) => {
      const da = new Date(a?.fixture?.date ?? 0).getTime();
      const db = new Date(b?.fixture?.date ?? 0).getTime();
      return da - db;
    })
    .slice(0, MAX_PREMATCH_ANALYSIS);

  const picks: PrematchPick[] = [];
  const candidates: PrematchCandidate[] = [];

  for (const f of upcoming) {
    const fixtureId = Number(f?.fixture?.id ?? 0);
    const homeId = f?.teams?.home?.id ?? null;
    const awayId = f?.teams?.away?.id ?? null;
    const season = getFixtureSeason(f);
    const contextType: MatchContextType = isCupCompetition(f) ? "cup" : "league";

    if (!fixtureId || !homeId || !awayId) continue;

    try {
      const oddsRaw = await getFixtureOddsLocal(fixtureId).catch(() => null);
      const odds = extractOddsSnapshot(oddsRaw);

      const hasUsableGoal = odds.goal != null && odds.goal >= MIN_ODD;
      const hasUsableOver = odds.over25 != null && odds.over25 >= MIN_ODD;

      if (!hasUsableGoal && !hasUsableOver) {
        continue;
      }

      const [homeRecentRaw, awayRecentRaw, homeSeasonRaw, awaySeasonRaw] = await Promise.all([
        getTeamLastFixturesLocal(homeId, RECENT_MATCHES).catch(() => null),
        getTeamLastFixturesLocal(awayId, RECENT_MATCHES).catch(() => null),
        getTeamSeasonFixturesLocal(homeId, season).catch(() => null),
        getTeamSeasonFixturesLocal(awayId, season).catch(() => null),
      ]);

      const seasonHome = buildHomeOnlyStats(homeSeasonRaw, homeId);
      const seasonAway = buildAwayOnlyStats(awaySeasonRaw, awayId);
      const recentHome = buildRecentOverallStats(homeRecentRaw, homeId, RECENT_MATCHES);
      const recentAway = buildRecentOverallStats(awayRecentRaw, awayId, RECENT_MATCHES);

      if (seasonHome.matches < 4 || seasonAway.matches < 4) {
        continue;
      }

      if (recentHome.matches < 3 || recentAway.matches < 3) {
        continue;
      }

      const h2hRaw = await getHeadToHeadLocal(homeId, awayId).catch(() => null);
      const h2h = buildH2HStats(h2hRaw, homeId, awayId, 5);

      const preAnalysis = buildServerPreAnalysis(
        f,
        seasonHome,
        seasonAway,
        recentHome,
        recentAway,
        h2h,
        odds
      );

      if (!preAnalysis.candidateBet || preAnalysis.preScore < 58) {
        continue;
      }

      const candidate = buildPrematchCandidate(
        f,
        {
          seasonHome,
          seasonAway,
          recentHome,
          recentAway,
          h2h,
        },
        preAnalysis,
        odds,
        contextType
      );

      candidates.push(candidate);

      const pick = buildPrematchPick(
        f,
        seasonHome,
        seasonAway,
        recentHome,
        recentAway,
        h2h,
        odds
      );

      if (pick) {
        picks.push(pick);
      }
    } catch {
      continue;
    }
  }

  picks.sort((a, b) => {
    const aRank = a.score * 0.78 + a.confidence * 100 * 0.22;
    const bRank = b.score * 0.78 + b.confidence * 100 * 0.22;
    return bRank - aRank;
  });

  candidates.sort((a, b) => {
    const aRecentAvg =
      (a.metrics.recentHome.avgTotalGoals + a.metrics.recentAway.avgTotalGoals) / 2;
    const bRecentAvg =
      (b.metrics.recentHome.avgTotalGoals + b.metrics.recentAway.avgTotalGoals) / 2;

    const aH2HBonus = a.metrics.h2h.matches > 0 ? a.metrics.h2h.avgTotalGoals * 1.5 : 0;
    const bH2HBonus = b.metrics.h2h.matches > 0 ? b.metrics.h2h.avgTotalGoals * 1.5 : 0;

    const aRank = a.serverPreAnalysis.preScore + aRecentAvg * 3 + aH2HBonus;
    const bRank = b.serverPreAnalysis.preScore + bRecentAvg * 3 + bH2HBonus;

    return bRank - aRank;
  });

  const leagueCounter = new Map<string, number>();
  const finalPicks: PrematchPick[] = [];

  for (const pick of picks) {
    const leagueKey = `${pick.league.id ?? "na"}_${pick.league.name ?? "unknown"}`;
    const used = leagueCounter.get(leagueKey) ?? 0;

    if (used >= MAX_PICKS_PER_LEAGUE) continue;
    if (finalPicks.length >= maxMatches) break;

    leagueCounter.set(leagueKey, used + 1);
    finalPicks.push(pick);
  }

  const candidateLeagueCounter = new Map<string, number>();
  const finalCandidates: PrematchCandidate[] = [];

  for (const candidate of candidates) {
    const leagueKey = `${candidate.league.id ?? "na"}_${candidate.league.name ?? "unknown"}`;
    const used = candidateLeagueCounter.get(leagueKey) ?? 0;

    if (used >= MAX_PICKS_PER_LEAGUE) continue;
    if (finalCandidates.length >= Math.min(Math.max(maxMatches * 2, 6), 12)) break;

    candidateLeagueCounter.set(leagueKey, used + 1);
    finalCandidates.push(candidate);
  }

  const result = {
    picks: finalPicks,
    candidates: finalCandidates,
  };

  setCache(cacheKey, result, 1200);
  return result;
}

export { buildBrainPrematch };
export default buildBrainPrematch;