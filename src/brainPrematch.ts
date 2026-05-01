import axios from "axios";
import { getCache, setCache } from "./cache";
import { markApiCall, markCacheHit, markCacheMiss } from "./stats";

const PREMATCH_DEBUG = true;

function prematchDebug(label: string, payload?: Record<string, unknown>) {
  if (!PREMATCH_DEBUG) return;
  console.log(`[brainPrematch] ${label}`, payload ?? {});
}

type DiscardReason =
  | "league_not_allowed"
  | "odds_below_minimum"
  | "missing_odds"
  | "missing_form_data"
  | "insufficient_scoring_data"
  | "final_score_below_threshold"
  | "candidate_limit_exceeded"
  | "unknown";

function logDiscard(
  reason: DiscardReason,
  payload: {
    fixtureId?: number;
    home?: string;
    away?: string;
    league?: string;
    goalOdd?: number | null;
    over25Odd?: number | null;
    extra?: Record<string, unknown>;
  }
) {
  prematchDebug(`discard:${reason}`, payload);
}

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
  overallHome: TeamSplitStats;
  overallAway: TeamSplitStats;
  splitHome: TeamSplitStats;
  splitAway: TeamSplitStats;
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
  homeGoalProjection: number;
  awayGoalProjection: number;
  homeGoalSupport: number;
  awayGoalSupport: number;
  volumeSupport: number;
  
};

const BASE_URL = "https://v3.football.api-sports.io";
const NOT_STARTED = new Set(["NS", "TBD"]);
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN"]);

const MAX_PICKS_PER_LEAGUE = 2;
const MIN_PICK_SCORE = 68;
const MIN_CONFIDENCE = 0.60;
const MIN_ODD = 1.45;
const RECENT_MATCHES = 5;

function isAllowedPrematchCompetition(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();
  const country = String(f?.league?.country ?? "").toLowerCase().trim();

  const allowedLeagueIds = new Set<number>([
    135, // Serie A
    78, // Bundesliga
    39, // Premier League
    88, // Eredivisie
    140, // La Liga
    61, // Ligue 1
    94, // Primeira Liga
    119, // Superliga Denmark
    2, // UEFA Champions League
    3, // UEFA Europa League
    848, // UEFA Europa Conference League
    1, // World Cup
    4, // Euro Championship
    5, // Nations League
    32, // WC Qual Europe
    960, // Euro Qual
    15, // Club World Cup
  ]);

  if (allowedLeagueIds.has(leagueId)) return true;

  if (country === "italy" && leagueName === "serie a") return true;
  if (country === "germany" && leagueName === "bundesliga") return true;
  if (country === "england" && leagueName === "premier league") return true;
  if (country === "netherlands" && leagueName === "eredivisie") return true;
  if (country === "spain" && leagueName === "la liga") return true;
  if (country === "france" && leagueName === "ligue 1") return true;
  if (country === "portugal" && leagueName.includes("primeira")) return true;
  if (country === "portugal" && leagueName.includes("liga portugal")) return true;
  if (country === "denmark" && leagueName.includes("superliga")) return true;

  if (leagueName === "uefa champions league") return true;
  if (leagueName === "uefa europa league") return true;
  if (leagueName === "uefa europa conference league") return true;

  if (leagueName === "world cup") return true;
  if (leagueName === "uefa euro championship") return true;
  if (leagueName === "uefa nations league") return true;
  if (leagueName === "world cup - qualification europe") return true;
  if (leagueName === "uefa euro qualification") return true;
  if (leagueName === "fifa club world cup") return true;

  return false;
}

function isCupCompetition(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();

  const cupIds = new Set<number>([
    2,
    3,
    848,
    1,
    4,
    5,
    32,
    960,
    15,
  ]);

  if (cupIds.has(leagueId)) return true;

  if (leagueName === "uefa champions league") return true;
  if (leagueName === "uefa europa league") return true;
  if (leagueName === "uefa europa conference league") return true;
  if (leagueName === "world cup") return true;
  if (leagueName === "uefa euro championship") return true;
  if (leagueName === "uefa nations league") return true;
  if (leagueName === "world cup - qualification europe") return true;
  if (leagueName === "uefa euro qualification") return true;
  if (leagueName === "fifa club world cup") return true;

  return false;
}

function getCompetitionWeight(f: any): number {
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();
  const country = String(f?.league?.country ?? "").toLowerCase().trim();

  if (
    leagueName === "uefa champions league" ||
    leagueName === "uefa europa league" ||
    leagueName === "uefa europa conference league"
  ) {
    return 0.97;
  }

  if (
    leagueName === "world cup" ||
    leagueName === "uefa euro championship" ||
    leagueName === "uefa nations league" ||
    leagueName === "world cup - qualification europe" ||
    leagueName === "uefa euro qualification" ||
    leagueName === "fifa club world cup"
  ) {
    return 0.95;
  }

  if (
    (country === "italy" && leagueName === "serie a") ||
    (country === "germany" && leagueName === "bundesliga") ||
    (country === "england" && leagueName === "premier league") ||
    (country === "netherlands" && leagueName === "eredivisie") ||
    (country === "spain" && leagueName === "la liga") ||
    (country === "france" && leagueName === "ligue 1") ||
    (country === "portugal" && (leagueName.includes("primeira") || leagueName.includes("liga portugal"))) ||
    (country === "denmark" && leagueName.includes("superliga"))
  ) {
    return 1.0;
  }

  return 0.96;
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

function weightedAvg(pairs: Array<[number, number]>): number {
  const valid = pairs.filter(([value, weight]) => Number.isFinite(value) && weight > 0);
  if (!valid.length) return 0;

  let num = 0;
  let den = 0;

  for (const [value, weight] of valid) {
    num += value * weight;
    den += weight;
  }

  return den > 0 ? num / den : 0;
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

function sortFixturesDescByDate(fixtures: any[]): any[] {
  return [...fixtures].sort((a, b) => {
    const da = new Date(a?.fixture?.date ?? 0).getTime();
    const db = new Date(b?.fixture?.date ?? 0).getTime();
    return db - da;
  });
}

function getFinishedFixtures(raw: any): any[] {
  const response = Array.isArray(raw?.response) ? raw.response : [];
  return response.filter((e: any) => {
    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    return FINISHED_STATUSES.has(status);
  });
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

async function getTeamCompetitionFixturesLocal(
  teamId: number,
  season: number,
  leagueId: number
): Promise<any> {
  const cacheKey = `brainPrematch_teamCompetitionFixtures_${teamId}_${season}_${leagueId}`;

  const cached = getCache<any>(cacheKey);
  if (cached) {
    markCacheHit();
    return cached;
  }

  markCacheMiss();

  const data = await apiGet("/fixtures", {
    team: teamId,
    season,
    league: leagueId,
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

        if (
          betName === "both teams score" ||
          betName === "both teams to score" ||
          betName === "btts"
        ) {
          for (const v of values) {
            const valueLabel = normalizeLabel(v?.value);
            const odd = parseOdd(v?.odd);
            if (!odd) continue;

            if (valueLabel === "yes" || valueLabel === "si" || valueLabel === "sì") {
              goal = goal == null ? odd : Math.min(goal, odd);
            }
          }
        }

        if (
          betName === "over/under" ||
          betName === "goals over/under" ||
          betName === "total goals"
        ) {
          for (const v of values) {
            const valueLabel = normalizeLabel(v?.value);
            const odd = parseOdd(v?.odd);
            if (!odd) continue;

            if (valueLabel === "over 2.5" || valueLabel === "over 2.5 goals") {
              over25 = over25 == null ? odd : Math.min(over25, odd);
            }

            if (valueLabel === "under 2.5" || valueLabel === "under 2.5 goals") {
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

function buildOverallStats(raw: any, teamId: number): TeamSplitStats {
  const fixtures = getFinishedFixtures(raw);
  if (!fixtures.length) return emptySplitStats();

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failedToScore = 0;
  let cleanSheet = 0;

  for (const e of fixtures) {
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

function buildHomeOnlyStats(raw: any, teamId: number): TeamSplitStats {
  const fixtures = getFinishedFixtures(raw);
  if (!fixtures.length) return emptySplitStats();

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failedToScore = 0;
  let cleanSheet = 0;

  for (const e of fixtures) {
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
  const fixtures = getFinishedFixtures(raw);
  if (!fixtures.length) return emptySplitStats();

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failedToScore = 0;
  let cleanSheet = 0;

  for (const e of fixtures) {
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

function buildRecentCompetitionStats(
  raw: any,
  teamId: number,
  last: number = RECENT_MATCHES
): TeamSplitStats {
  const fixtures = sortFixturesDescByDate(getFinishedFixtures(raw));
  if (!fixtures.length) return emptySplitStats();

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failedToScore = 0;
  let cleanSheet = 0;

  for (const e of fixtures) {
    if (count >= last) break;

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

function buildH2HStats(
  raw: any,
  homeTeamId: number,
  awayTeamId: number,
  last: number = 5
): H2HStats {
  const fixtures = sortFixturesDescByDate(getFinishedFixtures(raw));
  if (!fixtures.length) return emptyH2HStats();

  let count = 0;
  let homeGoalsSum = 0;
  let awayGoalsSum = 0;
  let btts = 0;
  let over25 = 0;

  for (const e of fixtures) {
    if (count >= last) break;

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

function evaluatePrematch(
  f: any,
  overallHome: TeamSplitStats,
  overallAway: TeamSplitStats,
  splitHome: TeamSplitStats,
  splitAway: TeamSplitStats,
  recentHome: TeamSplitStats,
  recentAway: TeamSplitStats,
  h2h: H2HStats,
  odds: OddsSnapshot
): EvaluatedPrematch {
  const contextType: MatchContextType = isCupCompetition(f) ? "cup" : "league";

  // PROIEZIONE GOL CASA:
  // prima dato totale competizione, poi split casa, poi forma recente, poi quanto concede l'avversario
  const homeGoalProjection = weightedAvg([
    [overallHome.avgGoalsFor, 0.22],
    [splitHome.avgGoalsFor, 0.30],
    [recentHome.avgGoalsFor, 0.14],
    [overallAway.avgGoalsAgainst, 0.12],
    [splitAway.avgGoalsAgainst, 0.17],
    [recentAway.avgGoalsAgainst, 0.05],
  ]);

  // PROIEZIONE GOL OSPITE:
  const awayGoalProjection = weightedAvg([
    [overallAway.avgGoalsFor, 0.22],
    [splitAway.avgGoalsFor, 0.30],
    [recentAway.avgGoalsFor, 0.14],
    [overallHome.avgGoalsAgainst, 0.12],
    [splitHome.avgGoalsAgainst, 0.17],
    [recentHome.avgGoalsAgainst, 0.05],
  ]);

  // SUPPORTO GOAL CASA: quanto è credibile che segni almeno un gol
  const homeGoalSupport = weightedAvg([
    [overallHome.scoredRate, 0.20],
    [splitHome.scoredRate, 0.28],
    [recentHome.scoredRate, 0.16],
    [overallAway.concededRate, 0.12],
    [splitAway.concededRate, 0.18],
    [recentAway.concededRate, 0.06],
  ]);

  // SUPPORTO GOAL OSPITE
  const awayGoalSupport = weightedAvg([
    [overallAway.scoredRate, 0.20],
    [splitAway.scoredRate, 0.28],
    [recentAway.scoredRate, 0.16],
    [overallHome.concededRate, 0.12],
    [splitHome.concededRate, 0.18],
    [recentHome.concededRate, 0.06],
  ]);

  // GOAL = reciprocità
  const goalSupportRate = weightedAvg([
    [Math.min(homeGoalSupport, awayGoalSupport), 0.55],
    [avg([overallHome.bttsRate, overallAway.bttsRate]), 0.20],
    [avg([splitHome.bttsRate, splitAway.bttsRate]), 0.17],
    [avg([recentHome.bttsRate, recentAway.bttsRate]), 0.08],
  ]);

  // OVER = volume totale del match
  const volumeSupport = weightedAvg([
    [avg([overallHome.avgTotalGoals, overallAway.avgTotalGoals]), 0.25],
    [avg([splitHome.avgTotalGoals, splitAway.avgTotalGoals]), 0.35],
    [avg([recentHome.avgTotalGoals, recentAway.avgTotalGoals]), 0.25],
    [homeGoalProjection + awayGoalProjection, 0.15],
  ]);

  const overSupportRate = weightedAvg([
    [avg([overallHome.over25Rate, overallAway.over25Rate]), 0.24],
    [avg([splitHome.over25Rate, splitAway.over25Rate]), 0.34],
    [avg([recentHome.over25Rate, recentAway.over25Rate]), 0.28],
    [clamp((homeGoalProjection + awayGoalProjection) / 3.2, 0, 1), 0.14],
  ]);

  let expectedGoals = weightedAvg([
    [homeGoalProjection + awayGoalProjection, 0.62],
    [avg([overallHome.avgTotalGoals, overallAway.avgTotalGoals]), 0.14],
    [avg([splitHome.avgTotalGoals, splitAway.avgTotalGoals]), 0.16],
    [avg([recentHome.avgTotalGoals, recentAway.avgTotalGoals]), 0.08],
  ]);

  const homeFailRisk = weightedAvg([
    [overallHome.failedToScoreRate, 0.22],
    [splitHome.failedToScoreRate, 0.42],
    [recentHome.failedToScoreRate, 0.36],
  ]);

  const awayFailRisk = weightedAvg([
    [overallAway.failedToScoreRate, 0.22],
    [splitAway.failedToScoreRate, 0.42],
    [recentAway.failedToScoreRate, 0.36],
  ]);

  const homeCleanResistance = weightedAvg([
    [overallHome.cleanSheetRate, 0.18],
    [splitHome.cleanSheetRate, 0.34],
    [recentHome.cleanSheetRate, 0.18],
    [overallAway.cleanSheetRate, 0.08],
    [splitAway.cleanSheetRate, 0.14],
    [recentAway.cleanSheetRate, 0.08],
  ]);

  const awayCleanResistance = weightedAvg([
    [overallAway.cleanSheetRate, 0.18],
    [splitAway.cleanSheetRate, 0.34],
    [recentAway.cleanSheetRate, 0.18],
    [overallHome.cleanSheetRate, 0.08],
    [splitHome.cleanSheetRate, 0.14],
    [recentHome.cleanSheetRate, 0.08],
  ]);

  // H2H leggero: solo surplus
  let h2hGoalBonus = 0;
  let h2hOverBonus = 0;

  if (h2h.matches >= 3) {
    h2hGoalBonus =
      h2h.bttsRate * 3.5 +
      clamp((h2h.avgTotalGoals - 2.1) * 1.1, -1.5, 2.8);

    h2hOverBonus =
      h2h.over25Rate * 3.8 +
      clamp((h2h.avgTotalGoals - 2.3) * 1.3, -1.5, 3.2);
  }

  let goalScore = 0;
  goalScore += clamp(homeGoalProjection, 0, 2.6) * 18;
  goalScore += clamp(awayGoalProjection, 0, 2.6) * 18;
  goalScore += goalSupportRate * 28;
  goalScore += Math.min(homeGoalSupport, awayGoalSupport) * 14;
  goalScore += h2hGoalBonus;

  goalScore -= homeFailRisk * 13;
  goalScore -= awayFailRisk * 13;
  goalScore -= homeCleanResistance * 8;
  goalScore -= awayCleanResistance * 8;

  // GOAL vuole reciprocità vera
  if (Math.min(homeGoalProjection, awayGoalProjection) < 0.9) {
    goalScore -= 10;
  }
  if (Math.min(homeGoalSupport, awayGoalSupport) < 0.58) {
    goalScore -= 9;
  }

  // Se una squadra domina troppo nella proiezione, il GOAL è meno pulito:
// meglio lasciar emergere OVER 2.5 quando il volume è alto.
if (Math.abs(homeGoalProjection - awayGoalProjection) >= 1.6) {
  goalScore -= 8;
}

  if (odds.goal != null) {
    if (odds.goal >= 1.55 && odds.goal <= 2.15) goalScore += 4;
    else if (odds.goal > 2.15 && odds.goal <= 2.65) goalScore += 2;
    else if (odds.goal < MIN_ODD) goalScore -= 8;
  }

let overScore = 0;
overScore += clamp(expectedGoals, 0, 4.0) * 14;
overScore += overSupportRate * 34;
overScore += clamp(volumeSupport, 0, 4.2) * 4;
overScore += Math.max(homeGoalProjection, awayGoalProjection) * 5;
overScore += h2hOverBonus;

  // penalità se volume non basta
  if (Math.min(homeGoalProjection, awayGoalProjection) < 0.8) {
    overScore -= 8;
  }
  if (expectedGoals < 2.35 && overSupportRate < 0.56) {
    overScore -= 11;
  }
  if (
    splitHome.avgGoalsFor < 0.95 &&
    splitAway.avgGoalsFor < 0.95
  ) {
    overScore -= 10;
  }

  overScore -= avg([homeFailRisk, awayFailRisk]) * 8;

  if (odds.over25 != null) {
    if (odds.over25 >= 1.60 && odds.over25 <= 2.20) overScore += 4;
    else if (odds.over25 > 2.20 && odds.over25 <= 2.70) overScore += 2;
    else if (odds.over25 < MIN_ODD) overScore -= 8;
  }

  // Se gli H2H sono molto chiusi e una squadra produce poco nello split,
// l'OVER resta possibile ma non deve diventare un pick forte.
if (
  h2h.matches >= 4 &&
  h2h.avgTotalGoals < 1.8 &&
  Math.min(splitHome.avgGoalsFor, splitAway.avgGoalsFor) < 1.0
) {
  overScore = Math.min(overScore, 64);
}

  // Cap anti-OVER gonfiato: evita score 100 con supporto reale medio/basso
if (overSupportRate < 0.56 || expectedGoals < 2.60) {
  overScore = Math.min(overScore, 68);
}

if (overSupportRate < 0.60 || expectedGoals < 2.70) {
  overScore = Math.min(overScore, 76);
}

if (overSupportRate < 0.64 || expectedGoals < 2.85) {
  overScore = Math.min(overScore, 84);
}

// Se una squadra ha poca produzione offensiva, l'OVER non deve esplodere solo perché subisce tanto
if (
  Math.min(homeGoalProjection, awayGoalProjection) < 0.95 ||
  Math.min(splitHome.avgGoalsFor, splitAway.avgGoalsFor) < 0.90
) {
  overScore = Math.min(overScore, 78);
}

// H2H contrari: non guidano il pick, ma devono frenare gli OVER troppo alti
if (h2h.matches >= 4 && h2h.avgTotalGoals < 2.2 && h2h.over25Rate < 0.35) {
  overScore = Math.min(overScore, 76);
}

  // In coppa riduco leggermente affidabilità strutturale
  if (contextType === "cup") {
    goalScore -= 2;
    overScore -= 2;
    expectedGoals *= 0.98;
  }

  const goalQuoteOk = odds.goal != null && odds.goal >= MIN_ODD;
  const overQuoteOk = odds.over25 != null && odds.over25 >= MIN_ODD;

const goalCandidate =
  goalQuoteOk &&
  homeGoalProjection >= 0.92 &&
  awayGoalProjection >= 0.92 &&
  homeGoalSupport >= 0.57 &&
  awayGoalSupport >= 0.57 &&
  goalSupportRate >= 0.55 &&
  homeFailRisk <= 0.45 &&
  awayFailRisk <= 0.45 &&
  goalScore >= 58;

const overCandidate =
  overQuoteOk &&
  expectedGoals >= 2.55 &&
  overSupportRate >= 0.56 &&
  Math.max(homeGoalProjection, awayGoalProjection) >= 1.20 &&
  avg([recentHome.avgTotalGoals, recentAway.avgTotalGoals]) >= 2.35 &&
  overScore >= 64;

  prematchDebug("evaluate_prematch", {
    fixtureId: f?.fixture?.id ?? null,
    home: f?.teams?.home?.name ?? null,
    away: f?.teams?.away?.name ?? null,
    contextType,
    overallHomeAvgGF: round2(overallHome.avgGoalsFor),
    overallHomeAvgGA: round2(overallHome.avgGoalsAgainst),
    overallAwayAvgGF: round2(overallAway.avgGoalsFor),
    overallAwayAvgGA: round2(overallAway.avgGoalsAgainst),
    splitHomeAvgGF: round2(splitHome.avgGoalsFor),
    splitHomeAvgGA: round2(splitHome.avgGoalsAgainst),
    splitAwayAvgGF: round2(splitAway.avgGoalsFor),
    splitAwayAvgGA: round2(splitAway.avgGoalsAgainst),
    recentHomeAvgGF: round2(recentHome.avgGoalsFor),
    recentHomeAvgGA: round2(recentHome.avgGoalsAgainst),
    recentAwayAvgGF: round2(recentAway.avgGoalsFor),
    recentAwayAvgGA: round2(recentAway.avgGoalsAgainst),
    homeGoalProjection: round2(homeGoalProjection),
    awayGoalProjection: round2(awayGoalProjection),
    homeGoalSupport: round2(homeGoalSupport),
    awayGoalSupport: round2(awayGoalSupport),
    goalSupportRate: round2(goalSupportRate),
    overSupportRate: round2(overSupportRate),
    volumeSupport: round2(volumeSupport),
    expectedGoals: round2(expectedGoals),
    homeFailRisk: round2(homeFailRisk),
    awayFailRisk: round2(awayFailRisk),
    h2hMatches: h2h.matches,
    h2hAvgTotalGoals: round2(h2h.avgTotalGoals),
    h2hBttsRate: round2(h2h.bttsRate),
    h2hOver25Rate: round2(h2h.over25Rate),
    goalScore: round1(goalScore),
    overScore: round1(overScore),
    goalCandidate,
    overCandidate,
  });

  let bestBet: "GOAL" | "OVER 2.5" | null = null;
  let rawScore = 0;

  if (goalCandidate && overCandidate) {
    // Distinzione più intelligente:
    // GOAL se il match è più simmetrico,
    // OVER se il volume totale spinge di più del reciproco.
    const symmetryEdge =
      Math.min(homeGoalSupport, awayGoalSupport) -
      Math.abs(homeGoalProjection - awayGoalProjection) * 0.18;

    const overEdge =
      overSupportRate +
      clamp((expectedGoals - 2.5) / 1.2, 0, 0.3);

    if (symmetryEdge >= overEdge - 0.04) {
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
  const overIsFragile =
    h2h.matches >= 4 &&
    h2h.avgTotalGoals < 1.8 &&
    Math.min(splitHome.avgGoalsFor, splitAway.avgGoalsFor) < 1.0;

  if (
    overIsFragile &&
    goalQuoteOk &&
    homeGoalProjection >= 1.05 &&
    awayGoalProjection >= 0.95 &&
    goalSupportRate >= 0.56 &&
    Math.min(homeGoalSupport, awayGoalSupport) >= 0.58 &&
    goalScore >= 58
  ) {
    bestBet = "GOAL";
    rawScore = Math.min(goalScore, 72);
  } else {
    bestBet = "OVER 2.5";
    rawScore = overScore;
  }
}

  const competitionWeight = getCompetitionWeight(f);
  const normalizedScore = clamp(rawScore * competitionWeight, 0, 100);
  const scoreGap = Math.abs(goalScore - overScore);

  let confidence = 0.42;
  confidence += clamp(normalizedScore / 100, 0, 1) * 0.22;
  confidence += clamp(scoreGap / 24, 0, 1) * 0.05;
  confidence += overallHome.matches >= 8 && overallAway.matches >= 8 ? 0.04 : 0;
  confidence += splitHome.matches >= 4 && splitAway.matches >= 4 ? 0.04 : 0;
  confidence += recentHome.matches >= 4 && recentAway.matches >= 4 ? 0.04 : 0;
  confidence += h2h.matches >= 3 ? 0.01 : 0;

  if (bestBet === "GOAL" && goalSupportRate >= 0.65) confidence += 0.03;
if (bestBet === "OVER 2.5") {
  if (overSupportRate >= 0.68 && expectedGoals >= 2.90) confidence += 0.03;
  else if (overSupportRate < 0.60 || expectedGoals < 2.70) confidence -= 0.04;
  else if (overSupportRate < 0.64 || expectedGoals < 2.85) confidence -= 0.02;
}

  if (contextType === "cup") confidence -= 0.03;

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
    homeGoalProjection: round2(homeGoalProjection),
    awayGoalProjection: round2(awayGoalProjection),
    homeGoalSupport: round2(homeGoalSupport),
    awayGoalSupport: round2(awayGoalSupport),
    volumeSupport: round2(volumeSupport),
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

function buildPrematchPickFromEvaluation(
  f: any,
  overallHome: TeamSplitStats,
  overallAway: TeamSplitStats,
  splitHome: TeamSplitStats,
  splitAway: TeamSplitStats,
  recentHome: TeamSplitStats,
  recentAway: TeamSplitStats,
  h2h: H2HStats,
  odds: OddsSnapshot,
  evaluated: EvaluatedPrematch
): PrematchPick | null {
  if (!evaluated.bestBet) return null;
  const minScoreForBet = evaluated.bestBet === "GOAL" ? 62 : MIN_PICK_SCORE;
  if (evaluated.normalizedScore < minScoreForBet) return null;
  if (evaluated.confidence < MIN_CONFIDENCE) return null;

  const selectedOdd = evaluated.bestBet === "GOAL" ? odds.goal : odds.over25;
  if (selectedOdd == null || selectedOdd < MIN_ODD) return null;

  const homeName = f?.teams?.home?.name ?? "Casa";
  const awayName = f?.teams?.away?.name ?? "Ospite";

  const insightParts: string[] = [];

  insightParts.push(
    `${homeName} totale ${overallHome.matches}: ${round2(overallHome.avgGoalsFor)} fatti / ${round2(
      overallHome.avgGoalsAgainst
    )} subiti`
  );
  insightParts.push(
    `${awayName} totale ${overallAway.matches}: ${round2(overallAway.avgGoalsFor)} fatti / ${round2(
      overallAway.avgGoalsAgainst
    )} subiti`
  );
  insightParts.push(
    `${homeName} casa ${splitHome.matches}: ${round2(splitHome.avgGoalsFor)} fatti / ${round2(
      splitHome.avgGoalsAgainst
    )} subiti`
  );
  insightParts.push(
    `${awayName} fuori ${splitAway.matches}: ${round2(splitAway.avgGoalsFor)} fatti / ${round2(
      splitAway.avgGoalsAgainst
    )} subiti`
  );
  insightParts.push(
    `forma ${RECENT_MATCHES}: ${round2(recentHome.avgTotalGoals)} + ${round2(
      recentAway.avgTotalGoals
    )}`
  );

  if (h2h.matches >= 3) {
    insightParts.push(`H2H ${h2h.matches}: ${round2(h2h.avgTotalGoals)} gol medi`);
  }

  if (evaluated.bestBet === "GOAL") {
    insightParts.push(
      `proiezioni gol ${round2(evaluated.homeGoalProjection)} / ${round2(
        evaluated.awayGoalProjection
      )}`
    );
    insightParts.push(`supporto goal ${pct(evaluated.goalSupportRate)}`);
  } else {
    insightParts.push(`stima match ${round2(evaluated.expectedGoals)} gol`);
    insightParts.push(`supporto over ${pct(evaluated.overSupportRate)}`);
  }

  const insightLine = insightParts.join(" | ");

  let reason = "";

  if (evaluated.bestBet === "GOAL") {
    reason =
      `Profilo da GOAL: la lettura parte dai dati complessivi nella stessa competizione e viene confermata dagli split casa/trasferta. ` +
      `${homeName} ha proiezione gol ${round2(evaluated.homeGoalProjection)}, ` +
      `${awayName} ${round2(evaluated.awayGoalProjection)}. ` +
      `Il supporto combinato alla rete di entrambe è ${pct(evaluated.goalSupportRate)}.`;

    if (h2h.matches >= 3 && h2h.bttsRate >= 0.5) {
      reason += ` I testa a testa aggiungono solo una conferma leggera e non guidano da soli il pick.`;
    }
  } else {
    reason =
      `Profilo da OVER 2.5: il dato principale è il volume stimato del match nella stessa competizione, corretto da split casa/trasferta e forma recente. ` +
      `La stima è di circa ${round2(evaluated.expectedGoals)} gol con supporto over del ${pct(
        evaluated.overSupportRate
      )}.`;

    if (h2h.matches >= 3 && h2h.over25Rate >= 0.5) {
      reason += ` I testa a testa aggiungono un surplus, ma il pick nasce soprattutto dal volume atteso del match.`;
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
  const cacheKey = `brainPrematch_v20_quality_filter_${date}_${maxMatches}`;

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
    const homeId = Number(f?.teams?.home?.id ?? 0);
    const awayId = Number(f?.teams?.away?.id ?? 0);
    const season = getFixtureSeason(f);
    const leagueId = Number(f?.league?.id ?? 0);
    const contextType: MatchContextType = isCupCompetition(f) ? "cup" : "league";
    const leagueName = String(f?.league?.name ?? "");
    const homeName = String(f?.teams?.home?.name ?? "");
    const awayName = String(f?.teams?.away?.name ?? "");

    if (!fixtureId || !homeId || !awayId || !leagueId) continue;

    try {
      const oddsRaw = await getFixtureOddsLocal(fixtureId).catch(() => null);
      const odds = extractOddsSnapshot(oddsRaw);

      prematchDebug("odds_snapshot", {
        fixtureId,
        home: homeName,
        away: awayName,
        leagueId,
        league: leagueName,
        goalOdd: odds.goal,
        over25Odd: odds.over25,
        under25Odd: odds.under25,
        minOdd: MIN_ODD,
      });

      const hasUsableGoal = odds.goal != null && odds.goal >= MIN_ODD;
      const hasUsableOver = odds.over25 != null && odds.over25 >= MIN_ODD;

      if (!hasUsableGoal && !hasUsableOver) {
        logDiscard("odds_below_minimum", {
          fixtureId,
          home: homeName,
          away: awayName,
          league: leagueName,
          goalOdd: odds.goal,
          over25Odd: odds.over25,
          extra: {
            minOdd: MIN_ODD,
            under25Odd: odds.under25,
          },
        });
        continue;
      }

      const [homeCompetitionRaw, awayCompetitionRaw] = await Promise.all([
        getTeamCompetitionFixturesLocal(homeId, season, leagueId).catch(() => null),
        getTeamCompetitionFixturesLocal(awayId, season, leagueId).catch(() => null),
      ]);

      const overallHome = buildOverallStats(homeCompetitionRaw, homeId);
      const overallAway = buildOverallStats(awayCompetitionRaw, awayId);
      const splitHome = buildHomeOnlyStats(homeCompetitionRaw, homeId);
      const splitAway = buildAwayOnlyStats(awayCompetitionRaw, awayId);
      const recentHome = buildRecentCompetitionStats(homeCompetitionRaw, homeId, RECENT_MATCHES);
      const recentAway = buildRecentCompetitionStats(awayCompetitionRaw, awayId, RECENT_MATCHES);

      if (overallHome.matches < 6 || overallAway.matches < 6) {
        logDiscard("insufficient_scoring_data", {
          fixtureId,
          home: homeName,
          away: awayName,
          league: leagueName,
          goalOdd: odds.goal,
          over25Odd: odds.over25,
          extra: {
            overallHomeMatches: overallHome.matches,
            overallAwayMatches: overallAway.matches,
            requiredOverallMatches: 6,
          },
        });
        continue;
      }

      if (splitHome.matches < 4 || splitAway.matches < 4) {
        logDiscard("insufficient_scoring_data", {
          fixtureId,
          home: homeName,
          away: awayName,
          league: leagueName,
          goalOdd: odds.goal,
          over25Odd: odds.over25,
          extra: {
            splitHomeMatches: splitHome.matches,
            splitAwayMatches: splitAway.matches,
            requiredSplitMatches: 4,
          },
        });
        continue;
      }

      if (recentHome.matches < 3 || recentAway.matches < 3) {
        logDiscard("missing_form_data", {
          fixtureId,
          home: homeName,
          away: awayName,
          league: leagueName,
          goalOdd: odds.goal,
          over25Odd: odds.over25,
          extra: {
            recentHomeMatches: recentHome.matches,
            recentAwayMatches: recentAway.matches,
            requiredRecentMatches: 3,
          },
        });
        continue;
      }

      const h2hRaw = await getHeadToHeadLocal(homeId, awayId).catch(() => null);
      const h2h = buildH2HStats(h2hRaw, homeId, awayId, 5);

      const evaluated = evaluatePrematch(
        f,
        overallHome,
        overallAway,
        splitHome,
        splitAway,
        recentHome,
        recentAway,
        h2h,
        odds
      );

      const preAnalysis = {
        preScore: evaluated.normalizedScore,
        candidateBet: evaluated.bestBet,
      };

      prematchDebug("pre_analysis", {
        fixtureId,
        home: homeName,
        away: awayName,
        leagueId,
        league: leagueName,
        contextType,
        candidateBet: preAnalysis.candidateBet,
        preScore: preAnalysis.preScore,
      });

      if (!preAnalysis.candidateBet || preAnalysis.preScore < 58) {
        logDiscard("final_score_below_threshold", {
          fixtureId,
          home: homeName,
          away: awayName,
          league: leagueName,
          goalOdd: odds.goal,
          over25Odd: odds.over25,
          extra: {
            candidateBet: preAnalysis.candidateBet,
            preScore: preAnalysis.preScore,
            requiredPreScore: 58,
            contextType,
          },
        });
        continue;
      }

      const candidate = buildPrematchCandidate(
        f,
        {
          overallHome,
          overallAway,
          splitHome,
          splitAway,
          recentHome,
          recentAway,
          h2h,
        },
        preAnalysis,
        odds,
        contextType
      );

      candidates.push(candidate);

      const pick = buildPrematchPickFromEvaluation(
        f,
        overallHome,
        overallAway,
        splitHome,
        splitAway,
        recentHome,
        recentAway,
        h2h,
        odds,
        evaluated
      );

      if (!pick) {
        logDiscard("final_score_below_threshold", {
          fixtureId,
          home: homeName,
          away: awayName,
          league: leagueName,
          goalOdd: odds.goal,
          over25Odd: odds.over25,
          extra: {
            stage: "buildPrematchPick_returned_null",
          },
        });
      } else {
        prematchDebug("final_pick", {
          fixtureId,
          home: homeName,
          away: awayName,
          leagueId,
          league: leagueName,
          recommendedBet: pick.recommendedBet,
          score: pick.score,
          confidence: pick.confidence,
          contextType,
          expectedGoals: evaluated.expectedGoals,
          goalSupportRate: evaluated.goalSupportRate,
          overSupportRate: evaluated.overSupportRate,
          homeGoalProjection: evaluated.homeGoalProjection,
          awayGoalProjection: evaluated.awayGoalProjection,
          goalOdd: pick.odds.goal,
          over25Odd: pick.odds.over25,
        });

        picks.push(pick);
      }
    } catch {
      continue;
    }
  }

  picks.sort((a, b) => {
    const aRank = a.score * 0.76 + a.confidence * 100 * 0.24;
    const bRank = b.score * 0.76 + b.confidence * 100 * 0.24;
    return bRank - aRank;
  });

  candidates.sort((a, b) => {
    const aRecentAvg = avg([
      a.metrics.recentHome.avgTotalGoals,
      a.metrics.recentAway.avgTotalGoals,
    ]);
    const bRecentAvg = avg([
      b.metrics.recentHome.avgTotalGoals,
      b.metrics.recentAway.avgTotalGoals,
    ]);

    const aRank = a.serverPreAnalysis.preScore + aRecentAvg * 2.2;
    const bRank = b.serverPreAnalysis.preScore + bRecentAvg * 2.2;

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