import axios from "axios";
import { getCache, setCache } from "./cache";
import { markApiCall, markCacheHit, markCacheMiss } from "./stats";

type TeamSplitStats = {
  matches: number;
  goalsFor: number;
  goalsAgainst: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  avgTotalGoals: number;
  bttsRate: number;
  over25Rate: number;
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
  recommendedBet: string;
  insightLine: string;
  reason: string;
  confidence: number;
  score: number;
};

type PrematchMetrics = {
  homeHome: TeamSplitStats;
  awayAway: TeamSplitStats;
  homeRecent: TeamSplitStats;
  awayRecent: TeamSplitStats;
  h2h: H2HStats;
};

type PrematchCandidate = {
  fixtureId: number | null;
  date: string | null;
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
  metrics: PrematchMetrics;
  serverPreAnalysis: {
    preScore: number;
    candidateBet: string | null;
  };
};

const BASE_URL = "https://v3.football.api-sports.io";
const NOT_STARTED = new Set(["NS", "TBD"]);

const MAX_PICKS_PER_LEAGUE = 2;
const MIN_PICK_SCORE = 68;
const MIN_CONFIDENCE = 0.58;

/**
 * Solo top campionati europei richiesti:
 * - Serie A
 * - Bundesliga
 * - Premier League
 * - Eredivisie
 * - La Liga
 * - Ligue 1
 * - Liga Portugal
 * - Superliga (Danimarca)
 */
function isAllowedPrematchCompetition(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();
  const country = String(f?.league?.country ?? "").toLowerCase().trim();

  const allowedLeagueIds = new Set<number>([
    // Top campionati
    135, // Serie A
    78,  // Bundesliga
    39,  // Premier League
    88,  // Eredivisie
    140, // La Liga
    61,  // Ligue 1
    94,  // Liga Portugal
    119, // Superliga Denmark

    // Coppe europee
    2,   // UEFA Champions League
    3,   // UEFA Europa League
    848, // UEFA Europa Conference League (verifica provider se diverso)

    // Competizioni internazionali / mondiali
    1,   // FIFA World Cup
    4,   // Euro Championship
    5,   // UEFA Nations League
    32,  // World Cup - Qualification Europe
    960, // Euro Championship - Qualification (verifica provider se diverso)
    15,  // FIFA Club World Cup
  ]);

  if (allowedLeagueIds.has(leagueId)) return true;

  // Fallback per nome/country
  if (country === "italy" && leagueName === "serie a") return true;
  if (country === "germany" && leagueName === "bundesliga") return true;
  if (country === "england" && leagueName === "premier league") return true;
  if (country === "netherlands" && leagueName === "eredivisie") return true;
  if (country === "spain" && leagueName === "la liga") return true;
  if (country === "france" && leagueName === "ligue 1") return true;
  if (country === "portugal" && leagueName.includes("liga portugal")) return true;
  if (country === "denmark" && leagueName.includes("superliga")) return true;

  // Coppe europee
  if (leagueName.includes("champions league")) return true;
  if (leagueName.includes("europa league")) return true;
  if (leagueName.includes("conference league")) return true;

  // Nazionali / mondiali
  if (leagueName.includes("world cup")) return true;
  if (leagueName.includes("euro championship")) return true;
  if (leagueName.includes("nations league")) return true;
  if (leagueName.includes("qualification europe")) return true;
  if (leagueName.includes("euro qualification")) return true;
  if (leagueName.includes("club world cup")) return true;

  return false;
}

function getCompetitionWeight(f: any): number {
  const leagueName = String(f?.league?.name ?? "").toLowerCase().trim();
  const country = String(f?.league?.country ?? "").toLowerCase().trim();

  // Coppe europee
  if (
    leagueName.includes("champions league") ||
    leagueName.includes("europa league") ||
    leagueName.includes("conference league")
  ) {
    return 0.95;
  }

  // Competizioni internazionali / nazionali
  if (
    leagueName.includes("world cup") ||
    leagueName.includes("euro championship") ||
    leagueName.includes("nations league") ||
    leagueName.includes("qualification europe") ||
    leagueName.includes("euro qualification") ||
    leagueName.includes("club world cup")
  ) {
    return 0.90;
  }

  // Top campionati domestici
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
    return 1.00;
  }

  return 0.94;
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

async function getTeamLastFixturesLocal(
  teamId: number,
  last: number = 10
): Promise<any> {
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

  for (const e of raw.response) {
    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    if (!["FT", "AET", "PEN"].includes(status)) continue;

    const homeId = e?.teams?.home?.id ?? null;
    if (homeId !== teamId) continue;

    const homeGoals = Number(e?.goals?.home ?? 0);
    const awayGoals = Number(e?.goals?.away ?? 0);

    gf += homeGoals;
    ga += awayGoals;

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

  for (const e of raw.response) {
    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    if (!["FT", "AET", "PEN"].includes(status)) continue;

    const awayId = e?.teams?.away?.id ?? null;
    if (awayId !== teamId) continue;

    const homeGoals = Number(e?.goals?.home ?? 0);
    const awayGoals = Number(e?.goals?.away ?? 0);

    gf += awayGoals;
    ga += homeGoals;

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
  };
}

function buildRecentOverallStats(raw: any, teamId: number, last: number = 5): TeamSplitStats {
  if (!raw || !Array.isArray(raw.response) || raw.response.length === 0) {
    return emptySplitStats();
  }

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;

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
function buildServerPreAnalysis(
  homeHome: TeamSplitStats,
  awayAway: TeamSplitStats,
  homeRecent: TeamSplitStats,
  awayRecent: TeamSplitStats
): { preScore: number; candidateBet: string | null } {
  const goalLean =
    homeHome.bttsRate * 22 +
    awayAway.bttsRate * 22 +
    homeRecent.bttsRate * 14 +
    awayRecent.bttsRate * 14 +
    Math.min(homeHome.avgGoalsFor, 2.2) * 7 +
    Math.min(awayAway.avgGoalsFor, 2.2) * 7 +
    Math.min(homeHome.avgGoalsAgainst, 2.0) * 7 +
    Math.min(awayAway.avgGoalsAgainst, 2.0) * 7;

  const overLean =
    homeHome.over25Rate * 20 +
    awayAway.over25Rate * 20 +
    homeRecent.over25Rate * 14 +
    awayRecent.over25Rate * 14 +
    Math.min(homeHome.avgTotalGoals, 4.0) * 8 +
    Math.min(awayAway.avgTotalGoals, 4.0) * 8 +
    Math.min(homeRecent.avgTotalGoals, 4.0) * 8 +
    Math.min(awayRecent.avgTotalGoals, 4.0) * 8;

  if (goalLean >= overLean && goalLean >= 58) {
    return {
      preScore: Number(goalLean.toFixed(1)),
      candidateBet: "GOAL",
    };
  }

  if (overLean > goalLean && overLean >= 58) {
    return {
      preScore: Number(overLean.toFixed(1)),
      candidateBet: "OVER 2.5",
    };
  }

  return {
    preScore: Number(Math.max(goalLean, overLean).toFixed(1)),
    candidateBet: null,
  };
}

function buildPrematchCandidate(
  f: any,
  metrics: PrematchMetrics,
  preAnalysis: { preScore: number; candidateBet: string | null }
): PrematchCandidate {
  return {
    fixtureId: f?.fixture?.id ?? null,
    date: f?.fixture?.date ?? null,
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
    metrics,
    serverPreAnalysis: preAnalysis,
  };
}

function buildPrematchPick(
  f: any,
  homeHome: TeamSplitStats,
  awayAway: TeamSplitStats,
  homeRecent: TeamSplitStats,
  awayRecent: TeamSplitStats,
  h2h: H2HStats,
  candidateBet: string | null
): PrematchPick | null {
  if (!candidateBet) return null;

  const fixtureId = f?.fixture?.id ?? null;
  const homeName = f?.teams?.home?.name ?? null;
  const awayName = f?.teams?.away?.name ?? null;

  // BLOCCO 1: casa/trasferta
  const splitGoalScore =
    homeHome.bttsRate * 22 +
    awayAway.bttsRate * 22 +
    Math.min(homeHome.avgGoalsFor, 2.5) * 8 +
    Math.min(awayAway.avgGoalsFor, 2.5) * 8 +
    Math.min(homeHome.avgGoalsAgainst, 2.2) * 7 +
    Math.min(awayAway.avgGoalsAgainst, 2.2) * 7;

  const splitOverScore =
    homeHome.over25Rate * 24 +
    awayAway.over25Rate * 24 +
    Math.min(homeHome.avgTotalGoals, 4.0) * 9 +
    Math.min(awayAway.avgTotalGoals, 4.0) * 9;

  // BLOCCO 2: forma recente
  const recentGoalScore =
    homeRecent.bttsRate * 16 +
    awayRecent.bttsRate * 16 +
    Math.min(homeRecent.avgGoalsFor, 2.4) * 6 +
    Math.min(awayRecent.avgGoalsFor, 2.4) * 6 +
    Math.min(homeRecent.avgGoalsAgainst, 2.2) * 5 +
    Math.min(awayRecent.avgGoalsAgainst, 2.2) * 5;

  const recentOverScore =
    homeRecent.over25Rate * 18 +
    awayRecent.over25Rate * 18 +
    Math.min(homeRecent.avgTotalGoals, 4.0) * 7 +
    Math.min(awayRecent.avgTotalGoals, 4.0) * 7;

  // BLOCCO 3: H2H
  const h2hGoalScore =
    h2h.matches > 0
      ? h2h.bttsRate * 16 + Math.min(h2h.avgTotalGoals, 4.0) * 5
      : 0;

  const h2hOverScore =
    h2h.matches > 0
      ? h2h.over25Rate * 16 + Math.min(h2h.avgTotalGoals, 4.0) * 6
      : 0;

  const goalScore = splitGoalScore + recentGoalScore + h2hGoalScore;
  const overScore = splitOverScore + recentOverScore + h2hOverScore;

  let recommendedBet: string | null = null;
  let rawScore = 0;

  if (candidateBet === "GOAL") {
    recommendedBet = goalScore >= overScore ? "GOAL" : "OVER 2.5";
    rawScore = Math.max(goalScore, overScore);
  } else if (candidateBet === "OVER 2.5") {
    recommendedBet = overScore >= goalScore ? "OVER 2.5" : "GOAL";
    rawScore = Math.max(goalScore, overScore);
  } else {
    recommendedBet = goalScore >= overScore ? "GOAL" : "OVER 2.5";
    rawScore = Math.max(goalScore, overScore);
  }

  const competitionWeight = getCompetitionWeight(f);

  const normalizedScore = Math.max(
    0,
    Math.min(100, (45 + rawScore * 0.42) * competitionWeight)
  );

  let confidence = 0.50 * competitionWeight;

  const alignedSignals = [
    homeHome.matches >= 4 && awayAway.matches >= 4,
    homeRecent.matches >= 4 && awayRecent.matches >= 4,
    h2h.matches >= 2,
    recommendedBet === "GOAL"
      ? (homeHome.bttsRate + awayAway.bttsRate + homeRecent.bttsRate + awayRecent.bttsRate) / 4 >= 0.55
      : (homeHome.over25Rate + awayAway.over25Rate + homeRecent.over25Rate + awayRecent.over25Rate) / 4 >= 0.55,
  ].filter(Boolean).length;

  confidence += Math.min(normalizedScore / 100, 0.30);

  if (alignedSignals >= 4) confidence += 0.10;
  else if (alignedSignals === 3) confidence += 0.07;
  else if (alignedSignals === 2) confidence += 0.04;

  if (h2h.matches > 0) {
    if (recommendedBet === "GOAL" && h2h.bttsRate >= 0.60) confidence += 0.04;
    if (recommendedBet === "OVER 2.5" && h2h.over25Rate >= 0.60) confidence += 0.04;
  }

    const minConfidenceFloor = competitionWeight >= 0.99 ? 0.45 : 0.42;
    const maxConfidenceCap = competitionWeight >= 0.99 ? 0.92 : 0.88;

  confidence = Math.max(
    minConfidenceFloor,
    Math.min(confidence, maxConfidenceCap)
  );

  const splitAvgGoals = ((homeHome.avgTotalGoals + awayAway.avgTotalGoals) / 2);
  const recentAvgGoals = ((homeRecent.avgTotalGoals + awayRecent.avgTotalGoals) / 2);

  const splitRecentGoalAgreement =
    (
      homeHome.bttsRate +
      awayAway.bttsRate +
      homeRecent.bttsRate +
      awayRecent.bttsRate
    ) / 4;

  const splitRecentOverAgreement =
    (
      homeHome.over25Rate +
      awayAway.over25Rate +
      homeRecent.over25Rate +
      awayRecent.over25Rate
    ) / 4;

  const bothTeamsScoringSignal =
    homeHome.avgGoalsFor >= 1.0 &&
    awayAway.avgGoalsFor >= 0.95;

  const bothTeamsConcedingSignal =
    homeHome.avgGoalsAgainst >= 0.8 &&
    awayAway.avgGoalsAgainst >= 0.8;

  const recentOpenMatchSignal =
    homeRecent.avgTotalGoals >= 2.2 &&
    awayRecent.avgTotalGoals >= 2.2;

  const overVolumeSignal =
    homeHome.avgTotalGoals >= 2.4 &&
    awayAway.avgTotalGoals >= 2.4 &&
    recentAvgGoals >= 2.35;

  const h2hGoalSupport =
    h2h.matches === 0 || h2h.bttsRate >= 0.40 || h2h.avgTotalGoals >= 2.4;

  const h2hOverSupport =
    h2h.matches === 0 || h2h.over25Rate >= 0.40 || h2h.avgTotalGoals >= 2.6;

  if (recommendedBet === "GOAL") {
    if (!bothTeamsScoringSignal) return null;
    if (!bothTeamsConcedingSignal) return null;
    if (splitRecentGoalAgreement < 0.52) return null;
    if (!recentOpenMatchSignal && !h2hGoalSupport) return null;
  }

  if (recommendedBet === "OVER 2.5") {
    if (!overVolumeSignal) return null;
    if (splitRecentOverAgreement < 0.50) return null;
    if (!h2hOverSupport && recentAvgGoals < 2.5) return null;
  }

  if (normalizedScore < MIN_PICK_SCORE || confidence < MIN_CONFIDENCE) {
    return null;
  }

  const insightParts: string[] = [];
  insightParts.push(
    `${homeName ?? "Casa"} in casa: ${homeHome.avgTotalGoals.toFixed(2)} gol medi`
  );
  insightParts.push(
    `${awayName ?? "Ospite"} fuori: ${awayAway.avgTotalGoals.toFixed(2)} gol medi`
  );
  insightParts.push(
    `forma recente combinata: ${recentAvgGoals.toFixed(2)}`
  );

  if (h2h.matches > 0) {
    insightParts.push(`H2H ultimi ${h2h.matches}: ${h2h.avgTotalGoals.toFixed(2)} gol medi`);
  }

  const insightLine = insightParts.join(" | ");

  const reasonParts: string[] = [];

  if (recommendedBet === "GOAL") {
    reasonParts.push(
      `i dati casa/trasferta mostrano propensione al BTTS`
    );

    if (recentAvgGoals >= 2.2) {
      reasonParts.push(`la forma recente conferma partite aperte`);
    }

    if (h2h.matches > 0 && h2h.bttsRate >= 0.50) {
      reasonParts.push(`anche i precedenti tra le due squadre sono favorevoli`);
    }
  } else {
    reasonParts.push(
      `le medie gol casa/trasferta suggeriscono una gara da almeno 3 reti`
    );

    if (recentAvgGoals >= 2.4) {
      reasonParts.push(`lo stato di forma recente sostiene l'OVER 2.5`);
    }

    if (h2h.matches > 0 && h2h.over25Rate >= 0.50) {
      reasonParts.push(`gli H2H recenti rafforzano il pronostico`);
    }
  }

  let reason =
    reasonParts.length > 0
      ? `${reasonParts.join(", ")}.`
      : "Statistiche recenti suggeriscono una partita da gol.";

  if (competitionWeight < 1) {
    reason += " Competizione gestita con valutazione leggermente più prudente.";
  }

  return {
    fixtureId,
    date: f?.fixture?.date ?? null,
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
    recommendedBet,
    insightLine,
    reason,
    confidence: Number(confidence.toFixed(2)),
    score: Number(normalizedScore.toFixed(1)),
  };
}

async function buildBrainPrematch(
  date: string,
  maxMatches: number = 5
): Promise<{
  picks: PrematchPick[];
  candidates: PrematchCandidate[];
}> {
  const cacheKey = `brainPrematch_v6_top_eu_only_${date}_${maxMatches}`;

const cached = getCache<{
  picks: PrematchPick[];
  candidates: PrematchCandidate[];
}>(cacheKey);
  if (cached) {
    return cached;
  }

  const raw = await getFixturesByDateLocal(date);
  const fixtures = Array.isArray(raw?.response) ? raw.response : [];

const MAX_PREMATCH_ANALYSIS = 24;

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
    const homeId = f?.teams?.home?.id ?? null;
    const awayId = f?.teams?.away?.id ?? null;

    if (!homeId || !awayId) continue;

try {
  const [homeRaw, awayRaw] = await Promise.all([
    getTeamLastFixturesLocal(homeId, 10).catch(() => null),
    getTeamLastFixturesLocal(awayId, 10).catch(() => null),
  ]);

  const homeHome = buildHomeOnlyStats(homeRaw, homeId);
  const awayAway = buildAwayOnlyStats(awayRaw, awayId);
  const homeRecent = buildRecentOverallStats(homeRaw, homeId, 5);
  const awayRecent = buildRecentOverallStats(awayRaw, awayId, 5);

  if (
    homeHome.matches < 4 ||
    awayAway.matches < 4 ||
    homeRecent.matches < 3 ||
    awayRecent.matches < 3
  ) {
    continue;
  }

  const preAnalysis = buildServerPreAnalysis(
    homeHome,
    awayAway,
    homeRecent,
    awayRecent
  );

  if (!preAnalysis.candidateBet || preAnalysis.preScore < 58) {
    continue;
  }

  const h2hRaw = await getHeadToHeadLocal(homeId, awayId).catch(() => null);
  const h2h = buildH2HStats(h2hRaw, homeId, awayId, 5);

const candidate = buildPrematchCandidate(
  f,
  {
    homeHome,
    awayAway,
    homeRecent,
    awayRecent,
    h2h,
  },
  preAnalysis
);

candidates.push(candidate);

// Manteniamo ancora il vecchio pick finale per compatibilità temporanea
const pick = buildPrematchPick(
  f,
  homeHome,
  awayAway,
  homeRecent,
  awayRecent,
  h2h,
  preAnalysis.candidateBet
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
      (a.metrics.homeRecent.avgTotalGoals + a.metrics.awayRecent.avgTotalGoals) / 2;
  const bRecentAvg =
      (b.metrics.homeRecent.avgTotalGoals + b.metrics.awayRecent.avgTotalGoals) / 2;

  const aH2HBonus = a.metrics.h2h.matches > 0 ? a.metrics.h2h.avgTotalGoals * 2 : 0;
  const bH2HBonus = b.metrics.h2h.matches > 0 ? b.metrics.h2h.avgTotalGoals * 2 : 0;

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