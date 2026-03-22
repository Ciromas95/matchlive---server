import axios from "axios";
import { getCache, setCache } from "./cache";
import { markApiCall, markCacheHit, markCacheMiss } from "./stats";

type TeamFormStats = {
  matches: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
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
function isMainEuropeanLeague(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  const leagueName = String(f?.league?.name ?? "").toLowerCase();
  const country = String(f?.league?.country ?? "").toLowerCase();

  // Se conosci già gli ID reali del tuo provider puoi lasciarli qui.
  // Ho comunque tenuto anche il fallback per nome, più sicuro.
  const allowedLeagueIds = new Set<number>([
    135, // Serie A
    78,  // Bundesliga
    39,  // Premier League
    88,  // Eredivisie
    140, // La Liga
    61,  // Ligue 1
    94,  // Liga Portugal
    119, // Superliga Denmark
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

  return false;
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

function emptyForm(): TeamFormStats {
  return {
    matches: 0,
    avgGoalsFor: 0,
    avgGoalsAgainst: 0,
    bttsRate: 0,
    over25Rate: 0,
  };
}

function buildTeamFormStats(raw: any, teamId: number): TeamFormStats {
  if (!raw || !Array.isArray(raw.response) || raw.response.length === 0) {
    return emptyForm();
  }

  let count = 0;
  let gf = 0;
  let ga = 0;
  let btts = 0;
  let over25 = 0;

  for (const e of raw.response) {
    const homeId = e?.teams?.home?.id ?? null;
    const awayId = e?.teams?.away?.id ?? null;

    if (!homeId || !awayId) continue;

    const status = String(e?.fixture?.status?.short ?? "").toUpperCase();
    if (!["FT", "AET", "PEN"].includes(status)) continue;

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

  if (count === 0) return emptyForm();

  return {
    matches: count,
    avgGoalsFor: gf / count,
    avgGoalsAgainst: ga / count,
    bttsRate: btts / count,
    over25Rate: over25 / count,
  };
}

function buildPrematchPick(
  f: any,
  homeForm: TeamFormStats,
  awayForm: TeamFormStats
): PrematchPick | null {
  const fixtureId = f?.fixture?.id ?? null;

  const combinedBtts = (homeForm.bttsRate + awayForm.bttsRate) / 2;
  const combinedOver25 = (homeForm.over25Rate + awayForm.over25Rate) / 2;

  const avgTotalGoals =
    (
      homeForm.avgGoalsFor +
      homeForm.avgGoalsAgainst +
      awayForm.avgGoalsFor +
      awayForm.avgGoalsAgainst
    ) / 2;

  const attackingSignal = (homeForm.avgGoalsFor + awayForm.avgGoalsFor) / 2;
  const concedingSignal =
    (homeForm.avgGoalsAgainst + awayForm.avgGoalsAgainst) / 2;

  let recommendedBet: string | null = null;
  let score = 0;

  // PRIORITÀ 1: GOAL
  if (
    combinedBtts >= 0.62 &&
    avgTotalGoals >= 2.45 &&
    homeForm.avgGoalsFor >= 1.1 &&
    awayForm.avgGoalsFor >= 1.0 &&
    homeForm.avgGoalsAgainst >= 0.85 &&
    awayForm.avgGoalsAgainst >= 0.85
  ) {
    recommendedBet = "GOAL";
    score =
      combinedBtts * 60 +
      combinedOver25 * 18 +
      avgTotalGoals * 9 +
      attackingSignal * 4 +
      concedingSignal * 4;
  }
  // PRIORITÀ 2: OVER 2.5
  else if (
    combinedOver25 >= 0.60 &&
    avgTotalGoals >= 2.7 &&
    attackingSignal >= 1.2 &&
    concedingSignal >= 0.95
  ) {
    recommendedBet = "OVER 2.5";
    score =
      combinedOver25 * 62 +
      combinedBtts * 14 +
      avgTotalGoals * 10 +
      attackingSignal * 4 +
      concedingSignal * 4;
  } else {
    return null;
  }

  let confidence = Math.max(0.35, Math.min(score / 100, 0.9));

  const strongBtts = combinedBtts >= 0.66;
  const strongOver25 = combinedOver25 >= 0.62;
  const strongGoals = avgTotalGoals >= 2.75;
  const strongAttack = attackingSignal >= 1.35;

  const alignedSignals = [
    strongBtts,
    strongOver25,
    strongGoals,
    strongAttack,
  ].filter(Boolean).length;

  if (alignedSignals >= 3) {
    confidence = Math.min(confidence + 0.06, 0.93);
  } else if (alignedSignals === 2) {
    confidence = Math.min(confidence + 0.03, 0.91);
  }

  const normalizedScore = 58 + (score - 58) * 0.5;
  const clampedScore = Math.max(0, Math.min(normalizedScore, 100));

  if (clampedScore < MIN_PICK_SCORE || confidence < MIN_CONFIDENCE) {
    return null;
  }

  const homeName = f?.teams?.home?.name ?? null;
  const awayName = f?.teams?.away?.name ?? null;

  const insightLine = `Ultime ${homeForm.matches} ${homeName ?? "casa"} e ${awayForm.matches} ${
    awayName ?? "ospite"
  }: circa ${avgTotalGoals.toFixed(1)} gol totali di media.`;

  const bttsPct = Math.round(combinedBtts * 100);
  const over25Pct = Math.round(combinedOver25 * 100);

  const parts: string[] = [];

  if (recommendedBet === "GOAL") {
    parts.push(`BTTS intorno al ${bttsPct}%`);
    if (avgTotalGoals >= 2.4) {
      parts.push(`media gol complessiva ${avgTotalGoals.toFixed(1)}`);
    }
    if (homeForm.avgGoalsFor >= 1.1 && awayForm.avgGoalsFor >= 1.0) {
      parts.push(`entrambe le squadre mostrano produzione offensiva costante`);
    }
  }

  if (recommendedBet === "OVER 2.5") {
    parts.push(`oltre il ${over25Pct}% di gare sopra i 2.5 gol`);
    parts.push(`media gol complessiva ${avgTotalGoals.toFixed(1)}`);
    if (attackingSignal >= 1.2) {
      parts.push(`indice offensivo medio alto`);
    }
  }

  let reason =
    "Statistiche recenti suggeriscono una partita da gol.";

  if (parts.length === 1) {
    reason = `${parts[0]}.`;
  } else if (parts.length >= 2) {
    reason = `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}.`;
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
    score: Number(clampedScore.toFixed(1)),
  };
}

async function buildBrainPrematch(
  date: string,
  maxMatches: number = 5
): Promise<PrematchPick[]> {
  const cacheKey = `brainPrematch_v6_top_eu_only_${date}_${maxMatches}`;

  const cached = getCache<PrematchPick[]>(cacheKey);
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
    if (!isMainEuropeanLeague(f)) return false;

    return true;
  })
  .sort((a: any, b: any) => {
    const da = new Date(a?.fixture?.date ?? 0).getTime();
    const db = new Date(b?.fixture?.date ?? 0).getTime();
    return da - db;
  })
  .slice(0, MAX_PREMATCH_ANALYSIS);

  const picks: PrematchPick[] = [];

  for (const f of upcoming) {
    const homeId = f?.teams?.home?.id ?? null;
    const awayId = f?.teams?.away?.id ?? null;

    if (!homeId || !awayId) continue;

    try {
      const [homeRaw, awayRaw] = await Promise.all([
        getTeamLastFixturesLocal(homeId, 10).catch(() => null),
        getTeamLastFixturesLocal(awayId, 10).catch(() => null),
      ]);

      const homeForm = buildTeamFormStats(homeRaw, homeId);
      const awayForm = buildTeamFormStats(awayRaw, awayId);

      if (homeForm.matches < 4 || awayForm.matches < 4) continue;

      const pick = buildPrematchPick(f, homeForm, awayForm);
      if (pick) {
        picks.push(pick);
      }
    } catch {
      continue;
    }
  }

  picks.sort((a, b) => b.score - a.score);

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

  setCache(cacheKey, finalPicks, 1200);
  return finalPicks;
}

export { buildBrainPrematch };
export default buildBrainPrematch;