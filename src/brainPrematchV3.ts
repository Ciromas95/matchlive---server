import axios from "axios";
import { getCache, getCacheState, setCache } from "./cache";
import { runOnce } from "./inflight";
import { markApiCall, markCacheHit, markCacheMiss, syncProviderQuota } from "./stats";
import {
  emptyTeamStatsV2,
  TeamStatsV2,
} from "./prematchStrategyV2";
import {
  CoreMarketV3,
  CornerMarketV3,
  CornerProfileV3,
  emptyCornerProfileV3,
  emptyResultProfileV3,
  H2HStatsV2,
  LeagueBaselineV2,
  MarketOfferV3,
  MarketPriceV3,
  MIN_ODDS_V3,
  PrematchMarketV3,
  ResultProfileV3,
  ScheduleContextV3,
  StrategyInputV3,
} from "./prematchStrategyV3";
import { evaluateStrategyV4 } from "./prematchStrategyV4";
import { sendBrainPrematchPush } from "./push";
import { claimPrematchNotification } from "./prematchNotificationState";
import { loadPublishedPrematchDay, savePublishedPrematchDay } from "./prematchPublishedState";
import { PrematchScanReport, savePrematchScanReport } from "./prematchScanReport";

const BASE_URL = "https://v3.football.api-sports.io";
const FINISHED = new Set(["FT", "AET", "PEN"]);
const NOT_STARTED = new Set(["NS", "TBD"]);
const CORE_MARKETS: CoreMarketV3[] = [
  "GOAL",
  "OVER 2.5",
  "CASA OVER 1.5",
  "OSPITE OVER 1.5",
  "1",
  "2",
  "1X",
  "X2",
];
const CORNER_MARKETS: CornerMarketV3[] = [
  "CORNER CASA",
  "CORNER OSPITE",
  "CORNER TOTALI",
];
const EXACT_MARKET_BY_BET_ID: Record<number, CoreMarketV3 | CornerMarketV3> = {
  5: "OVER 2.5",
  8: "GOAL",
  12: "1X",
  16: "CASA OVER 1.5",
  17: "OSPITE OVER 1.5",
  45: "CORNER TOTALI",
  57: "CORNER CASA",
  58: "CORNER OSPITE",
};

type Venue = "all" | "home" | "away";
type BookmakerMarket = {
  selectionOdd?: number;
  oppositeOdd?: number;
  bookmakerId?: number | null;
};
type OddsSnapshotV3 = {
  fetchedAt: string;
  providerUpdatedAt: string | null;
  markets: Record<CoreMarketV3, MarketPriceV3>;
  cornerMarkets: Record<CornerMarketV3, MarketPriceV3[]>;
};

type PrematchPickV3 = {
  fixtureId: number;
  date: string | null;
  contextType: "league" | "cup";
  algorithmVersion: "brainlive-strategy-v5-complete";
  league: Record<string, unknown>;
  home: Record<string, unknown>;
  away: Record<string, unknown>;
  recommendedBet: string;
  confidence: number;
  score: number;
  insightLine: string;
  reason: string;
  odds: Record<string, unknown>;
  analysis: Record<string, unknown>;
};

function apiKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("Missing API_FOOTBALL_KEY in .env");
  return key;
}

async function apiGet(path: string, params: Record<string, unknown>): Promise<any> {
  markApiCall("brainPrematch");
  const quotaRequestedAt = Date.now();
  try {
    const response = await axios.get(`${BASE_URL}${path}`, {
      headers: { "x-apisports-key": apiKey(), Accept: "application/json" },
      params,
      timeout: 12_000,
    });
    syncProviderQuota(response.headers, quotaRequestedAt);
    const errors = response.data?.errors;
    if (errors && (typeof errors === "object" ? Object.keys(errors).length > 0 : Boolean(errors))) {
      throw new Error("API-Football non ha fornito dati validi per questa richiesta");
    }
    return response.data;
  } catch (error: any) {
    syncProviderQuota(error?.response?.headers, quotaRequestedAt);
    throw error;
  }
}

async function cached<T>(
  key: string,
  ttlSeconds: number,
  staleSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = getCache<T>(key);
  if (hit != null) {
    markCacheHit();
    return hit;
  }
  markCacheMiss();
  return runOnce(key, async () => {
    const value = await loader();
    setCache(key, value, ttlSeconds, staleSeconds);
    return value;
  });
}

function dateFixtures(date: string) {
  return cached(
    `brainPrematchV3:date:${date}`,
    10 * 60,
    30 * 60,
    () => apiGet("/fixtures", { date, timezone: "Europe/Rome" }),
  );
}

function leagueSeasonFixtures(leagueId: number, season: number, previous = false) {
  return cached(
    `brainPrematchV3:league:${leagueId}:${season}`,
    previous ? 24 * 3600 : 30 * 60,
    24 * 3600,
    () => apiGet("/fixtures", { league: leagueId, season }),
  );
}

function recentTeamFixtures(teamId: number) {
  return cached(
    `brainPrematchV3:recent:${teamId}:12`,
    60 * 60,
    6 * 3600,
    () => apiGet("/fixtures", { team: teamId, last: 12 }),
  );
}

function nextTeamFixtures(teamId: number) {
  return cached(
    `brainPrematchV3:next:${teamId}:3`,
    45 * 60,
    6 * 3600,
    () => apiGet("/fixtures", { team: teamId, next: 3 }),
  );
}

function fixtureStatistics(fixtureId: number) {
  return cached(
    `brainPrematchV3:fixtureStats:${fixtureId}`,
    7 * 24 * 3600,
    30 * 24 * 3600,
    () => apiGet("/fixtures/statistics", { fixture: fixtureId }),
  );
}

function headToHead(homeId: number, awayId: number) {
  return cached(
    `brainPrematchV3:h2h:${homeId}:${awayId}:10`,
    12 * 3600,
    24 * 3600,
    () => apiGet("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 10 }),
  );
}

function oddsTtlSeconds(kickoff: string | null): number {
  const kickoffMs = kickoff ? new Date(kickoff).getTime() : Number.NaN;
  const hours = Number.isFinite(kickoffMs) ? (kickoffMs - Date.now()) / 3_600_000 : 48;
  if (hours <= 1) return 120;
  if (hours <= 6) return 300;
  if (hours <= 24) return 900;
  return 3600;
}

function fixtureOdds(fixtureId: number, kickoff: string | null) {
  const ttl = oddsTtlSeconds(kickoff);
  return cached(
    `brainPrematchV3:odds:${fixtureId}:exact-v1`,
    ttl,
    Math.max(600, ttl * 2),
    async () => ({
      payload: await apiGet("/odds", { fixture: fixtureId }),
      fetchedAt: new Date().toISOString(),
    }),
  );
}

function normalized(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function odd(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Media robusta: elimina gli estremi quando il campione lo consente. */
export function robustReferenceOdd(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const central = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  return central.reduce((sum, value) => sum + value, 0) / central.length;
}

function emptyPrice(line: number | null = null): MarketPriceV3 {
  return {
    bestOdd: null,
    referenceOdd: null,
    consensusProbability: null,
    bookmakerCount: 0,
    offers: [],
    line,
  };
}

function finalizePrice(rawOffers: MarketOfferV3[], line: number | null = null): MarketPriceV3 {
  const paired = rawOffers.filter((offer) => offer.fairProbability != null);
  const probabilityMedian = median(
    paired.map((offer) => offer.fairProbability!).filter(Number.isFinite),
  );
  const oddMedian = median(paired.map((offer) => offer.odd));
  if (probabilityMedian == null || oddMedian == null) return emptyPrice(line);
  const credible = paired.filter((offer) => {
    const probabilityDistance = Math.abs(offer.fairProbability! - probabilityMedian);
    const oddRatio = Math.max(offer.odd, oddMedian) / Math.min(offer.odd, oddMedian);
    return probabilityDistance <= 0.1 && oddRatio <= 1.22;
  });
  credible.sort((left, right) => right.odd - left.odd);
  return {
    bestOdd: credible[0]?.odd ?? null,
    referenceOdd: robustReferenceOdd(credible.map((offer) => offer.odd)),
    consensusProbability: median(credible.map((offer) => offer.fairProbability!)),
    bookmakerCount: credible.length,
    offers: credible.slice(0, 3),
    line,
  };
}

function parseHalfLine(label: string): { direction: "over" | "under"; line: number } | null {
  const match = label.match(/^(over|under)\s+(\d+(?:\.5))$/);
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isFinite(line)) return null;
  return { direction: match[1] as "over" | "under", line };
}

export function extractOddsSnapshotV3(raw: any): OddsSnapshotV3 {
  const core = new Map<CoreMarketV3, Map<string, BookmakerMarket>>();
  for (const market of CORE_MARKETS) core.set(market, new Map());
  const corner = new Map<CornerMarketV3, Map<number, Map<string, BookmakerMarket>>>();
  for (const market of CORNER_MARKETS) corner.set(market, new Map());
  const oneXTwo = new Map<string, { home?: number; draw?: number; away?: number }>();
  const payload = raw?.payload ?? raw;
  const response = Array.isArray(payload?.response) ? payload.response : [];
  let providerUpdatedAt: string | null = null;

  for (const item of response) {
    const itemUpdate = String(item?.update ?? item?.updatedAt ?? "").trim();
    if (itemUpdate && (!providerUpdatedAt || itemUpdate > providerUpdatedAt)) {
      providerUpdatedAt = itemUpdate;
    }
    for (const bookmaker of Array.isArray(item?.bookmakers) ? item.bookmakers : []) {
      const bookmakerName = String(bookmaker?.name ?? "Bookmaker").trim() || "Bookmaker";
      const bookmakerId = Number(bookmaker?.id ?? 0) || null;
      for (const bet of Array.isArray(bookmaker?.bets) ? bookmaker.bets : []) {
        const betId = Number(bet?.id ?? 0);
        if (betId === 1) {
          const result = oneXTwo.get(bookmakerName) ?? {};
          for (const value of Array.isArray(bet?.values) ? bet.values : []) {
            const parsedOdd = odd(value?.odd);
            const label = normalized(value?.value);
            if (parsedOdd == null) continue;
            if (label === "home") result.home = parsedOdd;
            if (label === "draw") result.draw = parsedOdd;
            if (label === "away") result.away = parsedOdd;
          }
          oneXTwo.set(bookmakerName, result);
          if (result.home != null) core.get("1")!.set(bookmakerName, { selectionOdd: result.home, bookmakerId });
          if (result.away != null) core.get("2")!.set(bookmakerName, { selectionOdd: result.away, bookmakerId });
          continue;
        }
        const market = EXACT_MARKET_BY_BET_ID[betId];
        if (!market) continue;
        if (betId === 12) {
          for (const value of Array.isArray(bet?.values) ? bet.values : []) {
            const parsedOdd = odd(value?.odd);
            const label = normalized(value?.value);
            if (parsedOdd == null) continue;
            const target: CoreMarketV3 | null = label === "home draw" || label === "1x"
              ? "1X"
              : label === "draw away" || label === "away draw" || label === "x2"
                ? "X2"
                : null;
            if (target) core.get(target)!.set(bookmakerName, { selectionOdd: parsedOdd, bookmakerId });
          }
          continue;
        }
        if (CORNER_MARKETS.includes(market as CornerMarketV3)) {
          const cornerMarket = market as CornerMarketV3;
          for (const value of Array.isArray(bet?.values) ? bet.values : []) {
            const parsedOdd = odd(value?.odd);
            const parsedLine = parseHalfLine(normalized(value?.value));
            if (parsedOdd == null || parsedLine == null) continue;
            const lineMap = corner.get(cornerMarket)!;
            const bookmakerMap = lineMap.get(parsedLine.line) ?? new Map();
            const current = bookmakerMap.get(bookmakerName) ?? { bookmakerId };
            if (parsedLine.direction === "over") current.selectionOdd = parsedOdd;
            else current.oppositeOdd = parsedOdd;
            bookmakerMap.set(bookmakerName, current);
            lineMap.set(parsedLine.line, bookmakerMap);
          }
          continue;
        }
        const coreMarket = market as CoreMarketV3;
        const current = core.get(coreMarket)!.get(bookmakerName) ?? { bookmakerId };
        for (const value of Array.isArray(bet?.values) ? bet.values : []) {
          const parsedOdd = odd(value?.odd);
          if (parsedOdd == null) continue;
          const label = normalized(value?.value);
          if (coreMarket === "GOAL") {
            if (["yes", "si", "sì"].includes(label)) current.selectionOdd = parsedOdd;
            if (label === "no") current.oppositeOdd = parsedOdd;
          } else if (coreMarket === "OVER 2.5") {
            if (label === "over 2.5" || label === "over 2.5 goals") current.selectionOdd = parsedOdd;
            if (label === "under 2.5" || label === "under 2.5 goals") current.oppositeOdd = parsedOdd;
          } else if (coreMarket === "CASA OVER 1.5" || coreMarket === "OSPITE OVER 1.5") {
            if (label === "over 1.5" || label === "over 1.5 goals") current.selectionOdd = parsedOdd;
            if (label === "under 1.5" || label === "under 1.5 goals") current.oppositeOdd = parsedOdd;
          } else if (coreMarket === "1X" && label === "home draw") {
            current.selectionOdd = parsedOdd;
          } else if (coreMarket === "X2" && label === "draw away") {
            current.selectionOdd = parsedOdd;
          }
        }
        core.get(coreMarket)!.set(bookmakerName, current);
      }
    }
  }

  const markets = {} as Record<CoreMarketV3, MarketPriceV3>;
  for (const market of CORE_MARKETS) {
    const offers: MarketOfferV3[] = [];
    for (const [bookmaker, values] of core.get(market)!) {
      if (values.selectionOdd == null) continue;
      let oppositeOdd = values.oppositeOdd ?? null;
      let fairProbability: number | null = null;
      if (["1", "2", "1X", "X2"].includes(market)) {
        const result = oneXTwo.get(bookmaker);
        if (result?.home && result.draw && result.away) {
          const total = 1 / result.home + 1 / result.draw + 1 / result.away;
          const homeProbability = (1 / result.home) / total;
          const drawProbability = (1 / result.draw) / total;
          const awayProbability = (1 / result.away) / total;
          fairProbability = market === "1" ? homeProbability
            : market === "2" ? awayProbability
            : market === "1X" ? homeProbability + drawProbability
            : drawProbability + awayProbability;
          oppositeOdd = market === "1" ? null
            : market === "2" ? null
            : market === "1X" ? result.away : result.home;
        }
      } else if (oppositeOdd != null) {
        fairProbability = (1 / values.selectionOdd) /
          (1 / values.selectionOdd + 1 / oppositeOdd);
      }
      offers.push({
        bookmaker,
        bookmakerId: values.bookmakerId ?? null,
        odd: values.selectionOdd,
        oppositeOdd,
        fairProbability,
      });
    }
    markets[market] = finalizePrice(offers);
  }

  const cornerMarkets = {} as Record<CornerMarketV3, MarketPriceV3[]>;
  for (const market of CORNER_MARKETS) {
    cornerMarkets[market] = [...corner.get(market)!.entries()]
      .map(([line, bookmakerMap]) => {
        const offers: MarketOfferV3[] = [];
        for (const [bookmaker, values] of bookmakerMap) {
          if (values.selectionOdd == null || values.oppositeOdd == null) continue;
          const fairProbability = (1 / values.selectionOdd) /
            (1 / values.selectionOdd + 1 / values.oppositeOdd);
          offers.push({
            bookmaker,
            bookmakerId: values.bookmakerId ?? null,
            odd: values.selectionOdd,
            oppositeOdd: values.oppositeOdd,
            fairProbability,
            line,
          });
        }
        return finalizePrice(offers, line);
      })
      .filter((price) => price.bookmakerCount >= 2)
      .sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
  }

  return {
    fetchedAt: String(raw?.fetchedAt ?? new Date().toISOString()),
    providerUpdatedAt,
    markets,
    cornerMarkets,
  };
}

function responseFixtures(raw: any): any[] {
  return Array.isArray(raw?.response) ? raw.response : [];
}

function finishedFixtures(raw: any): any[] {
  return responseFixtures(raw).filter((fixture) =>
    FINISHED.has(String(fixture?.fixture?.status?.short ?? "").toUpperCase()),
  );
}

function fixtureDate(fixture: any): number {
  return new Date(fixture?.fixture?.date ?? 0).getTime();
}

function officialFixture(fixture: any): boolean {
  const name = normalized(fixture?.league?.name);
  return !name.includes("friendl");
}

export function buildTeamStatsV2(
  raw: any,
  teamId: number,
  venue: Venue = "all",
  last?: number,
): TeamStatsV2 {
  const fixtures = finishedFixtures(raw)
    .filter(officialFixture)
    .sort((a, b) => fixtureDate(b) - fixtureDate(a));
  let matches = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let failed = 0;
  let clean = 0;
  let scoredOver15 = 0;
  let concededOver15 = 0;

  for (const fixture of fixtures) {
    if (last != null && matches >= last) break;
    const homeId = Number(fixture?.teams?.home?.id ?? 0);
    const awayId = Number(fixture?.teams?.away?.id ?? 0);
    const isHome = homeId === teamId;
    const isAway = awayId === teamId;
    if (!isHome && !isAway) continue;
    if (venue === "home" && !isHome) continue;
    if (venue === "away" && !isAway) continue;
    const homeGoals = Number(fixture?.goals?.home ?? 0);
    const awayGoals = Number(fixture?.goals?.away ?? 0);
    const gf = isHome ? homeGoals : awayGoals;
    const ga = isHome ? awayGoals : homeGoals;
    goalsFor += gf;
    goalsAgainst += ga;
    if (gf > 0) scored += 1; else failed += 1;
    if (ga > 0) conceded += 1; else clean += 1;
    if (gf >= 2) scoredOver15 += 1;
    if (ga >= 2) concededOver15 += 1;
    if (homeGoals > 0 && awayGoals > 0) btts += 1;
    if (homeGoals + awayGoals >= 3) over25 += 1;
    matches += 1;
  }
  if (!matches) return emptyTeamStatsV2();
  return {
    matches,
    goalsFor,
    goalsAgainst,
    avgGoalsFor: goalsFor / matches,
    avgGoalsAgainst: goalsAgainst / matches,
    avgTotalGoals: (goalsFor + goalsAgainst) / matches,
    bttsRate: btts / matches,
    over25Rate: over25 / matches,
    scoredRate: scored / matches,
    concededRate: conceded / matches,
    failedToScoreRate: failed / matches,
    cleanSheetRate: clean / matches,
    scoredOver15Rate: scoredOver15 / matches,
    concededOver15Rate: concededOver15 / matches,
    effectiveMatches: matches,
  };
}

function fixtureWeightV3(fixture: any, recencyIndex: number): number {
  const leagueName = normalized(fixture?.league?.name);
  const competitionWeight = leagueName.includes("friendl") ? 0.48 : 1;
  const recencyWeight = Math.pow(0.9, recencyIndex);
  return competitionWeight * recencyWeight;
}

export function buildWeightedRecentStatsV3(
  raw: any,
  teamId: number,
  cutoffMs: number,
  venue: Venue = "all",
  last = 5,
): TeamStatsV2 {
  const fixtures = finishedFixtures(raw)
    .filter((fixture) => fixtureDate(fixture) < cutoffMs)
    .sort((left, right) => fixtureDate(right) - fixtureDate(left));
  let rawMatches = 0;
  let weightTotal = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let btts = 0;
  let over25 = 0;
  let scored = 0;
  let conceded = 0;
  let scoredOver15 = 0;
  let concededOver15 = 0;
  for (const fixture of fixtures) {
    if (rawMatches >= last) break;
    const homeId = Number(fixture?.teams?.home?.id ?? 0);
    const awayId = Number(fixture?.teams?.away?.id ?? 0);
    const isHome = homeId === teamId;
    const isAway = awayId === teamId;
    if (!isHome && !isAway) continue;
    if (venue === "home" && !isHome) continue;
    if (venue === "away" && !isAway) continue;
    const hg = Number(fixture?.goals?.home);
    const ag = Number(fixture?.goals?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const weight = fixtureWeightV3(fixture, rawMatches);
    const gf = isHome ? hg : ag;
    const ga = isHome ? ag : hg;
    goalsFor += gf * weight;
    goalsAgainst += ga * weight;
    if (gf > 0) scored += weight;
    if (ga > 0) conceded += weight;
    if (gf >= 2) scoredOver15 += weight;
    if (ga >= 2) concededOver15 += weight;
    if (hg > 0 && ag > 0) btts += weight;
    if (hg + ag >= 3) over25 += weight;
    weightTotal += weight;
    rawMatches += 1;
  }
  if (!rawMatches || weightTotal <= 0) return emptyTeamStatsV2();
  return {
    matches: rawMatches,
    goalsFor,
    goalsAgainst,
    avgGoalsFor: goalsFor / weightTotal,
    avgGoalsAgainst: goalsAgainst / weightTotal,
    avgTotalGoals: (goalsFor + goalsAgainst) / weightTotal,
    bttsRate: btts / weightTotal,
    over25Rate: over25 / weightTotal,
    scoredRate: scored / weightTotal,
    concededRate: conceded / weightTotal,
    failedToScoreRate: 1 - scored / weightTotal,
    cleanSheetRate: 1 - conceded / weightTotal,
    scoredOver15Rate: scoredOver15 / weightTotal,
    concededOver15Rate: concededOver15 / weightTotal,
    effectiveMatches: weightTotal,
  };
}

export function buildResultProfileV3(
  raw: any,
  teamId: number,
  cutoffMs: number,
  venue: Venue = "all",
  last?: number,
  includeFriendlies = false,
): ResultProfileV3 {
  const fixtures = finishedFixtures(raw)
    .filter((fixture) => fixtureDate(fixture) < cutoffMs)
    .filter((fixture) => includeFriendlies || officialFixture(fixture))
    .sort((left, right) => fixtureDate(right) - fixtureDate(left));
  let matches = 0;
  let effectiveMatches = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalDifference = 0;
  for (const fixture of fixtures) {
    if (last != null && matches >= last) break;
    const homeId = Number(fixture?.teams?.home?.id ?? 0);
    const awayId = Number(fixture?.teams?.away?.id ?? 0);
    const isHome = homeId === teamId;
    const isAway = awayId === teamId;
    if (!isHome && !isAway) continue;
    if (venue === "home" && !isHome) continue;
    if (venue === "away" && !isAway) continue;
    const hg = Number(fixture?.goals?.home);
    const ag = Number(fixture?.goals?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const weight = includeFriendlies ? fixtureWeightV3(fixture, matches) : 1;
    const gf = isHome ? hg : ag;
    const ga = isHome ? ag : hg;
    if (gf > ga) wins += weight;
    else if (gf === ga) draws += weight;
    else losses += weight;
    goalDifference += (gf - ga) * weight;
    effectiveMatches += weight;
    matches += 1;
  }
  if (!matches || effectiveMatches <= 0) return emptyResultProfileV3();
  return {
    matches,
    effectiveMatches,
    wins,
    draws,
    losses,
    pointsPerMatch: (wins * 3 + draws) / effectiveMatches,
    winRate: wins / effectiveMatches,
    drawRate: draws / effectiveMatches,
    lossRate: losses / effectiveMatches,
    unbeatenRate: (wins + draws) / effectiveMatches,
    goalDifferencePerMatch: goalDifference / effectiveMatches,
  };
}

function statNumber(list: any, keys: string[]): number | null {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const type = normalized(item?.type).replace(/\s+/g, " ");
    if (!keys.includes(type)) continue;
    if (item?.value == null || item.value === "") continue;
    const value = Number(String(item?.value ?? "").replace("%", "").replace(",", "."));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function buildCornerProfileV3(rawSnapshots: any[], teamId: number): CornerProfileV3 {
  const samplesFor: number[] = [];
  const samplesAgainst: number[] = [];
  for (const raw of rawSnapshots) {
    const response = Array.isArray(raw?.response) ? raw.response : [];
    const own = response.find((entry: any) => Number(entry?.team?.id ?? 0) === teamId);
    const opponent = response.find((entry: any) => Number(entry?.team?.id ?? 0) !== teamId);
    if (!own || !opponent) continue;
    const ownCorners = statNumber(own?.statistics, ["corner kicks", "corners"]);
    const opponentCorners = statNumber(opponent?.statistics, ["corner kicks", "corners"]);
    if (ownCorners == null || opponentCorners == null) continue;
    samplesFor.push(ownCorners);
    samplesAgainst.push(opponentCorners);
  }
  if (!samplesFor.length) return emptyCornerProfileV3();
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = (values: number[], mean: number) =>
    values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  const averageFor = average(samplesFor);
  const averageAgainst = average(samplesAgainst);
  return {
    matches: samplesFor.length,
    effectiveMatches: samplesFor.length,
    averageFor,
    averageAgainst,
    varianceFor: variance(samplesFor, averageFor),
    varianceAgainst: variance(samplesAgainst, averageAgainst),
    samplesFor,
    samplesAgainst,
  };
}

export function buildLeagueBaselineV2(raw: any): LeagueBaselineV2 {
  const fixtures = finishedFixtures(raw).filter(officialFixture);
  if (!fixtures.length) return { matches: 0, homeGoals: 1.45, awayGoals: 1.15, totalGoals: 2.6 };
  let home = 0;
  let away = 0;
  for (const fixture of fixtures) {
    home += Number(fixture?.goals?.home ?? 0);
    away += Number(fixture?.goals?.away ?? 0);
  }
  return {
    matches: fixtures.length,
    homeGoals: home / fixtures.length,
    awayGoals: away / fixtures.length,
    totalGoals: (home + away) / fixtures.length,
  };
}

export function buildH2HStatsV2(raw: any, homeId: number, awayId: number): H2HStatsV2 {
  const fixtures = finishedFixtures(raw)
    .filter(officialFixture)
    .sort((a, b) => fixtureDate(b) - fixtureDate(a))
    .slice(0, 5);
  let matches = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  let btts = 0;
  let over25 = 0;
  for (const fixture of fixtures) {
    const rawHomeId = Number(fixture?.teams?.home?.id ?? 0);
    const rawAwayId = Number(fixture?.teams?.away?.id ?? 0);
    const hg = Number(fixture?.goals?.home ?? 0);
    const ag = Number(fixture?.goals?.away ?? 0);
    if (rawHomeId === homeId && rawAwayId === awayId) {
      homeGoals += hg;
      awayGoals += ag;
    } else if (rawHomeId === awayId && rawAwayId === homeId) {
      homeGoals += ag;
      awayGoals += hg;
    } else continue;
    if (hg > 0 && ag > 0) btts += 1;
    if (hg + ag >= 3) over25 += 1;
    matches += 1;
  }
  return {
    matches,
    homeGoals,
    awayGoals,
    avgTotalGoals: matches ? (homeGoals + awayGoals) / matches : 0,
    bttsRate: matches ? btts / matches : 0,
    over25Rate: matches ? over25 / matches : 0,
  };
}

function seasonOf(fixture: any): number {
  const leagueSeason = Number(fixture?.league?.season ?? 0);
  if (leagueSeason > 2000) return leagueSeason;
  const year = new Date(fixture?.fixture?.date ?? Date.now()).getUTCFullYear();
  return year > 2000 ? year : new Date().getUTCFullYear();
}

export const BRAIN_PREMATCH_LEAGUE_IDS = new Set([
  218, 144, 119, 4, 2, 3, 848, 1, 5, 61, 78, 39, 135, 137, 547,
  88, 94, 140, 141, 207, 203,
]);

function allowed(fixture: any): boolean {
  const id = Number(fixture?.league?.id ?? 0);
  return BRAIN_PREMATCH_LEAGUE_IDS.has(id);
}

function isCup(fixture: any): boolean {
  return new Set([2, 3, 848, 1, 4, 5, 137, 547]).has(Number(fixture?.league?.id ?? 0));
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function insight(pick: PrematchPickV3): string {
  const a: any = pick.analysis;
  const s: any = a.stats;
  if (String(pick.recommendedBet).startsWith("CORNER")) {
    const home = a.corners?.home;
    const away = a.corners?.away;
    return [
      `${String(pick.home.name)}: ${round(Number(home?.averageFor ?? 0))} corner battuti / ${round(Number(home?.averageAgainst ?? 0))} concessi`,
      `${String(pick.away.name)}: ${round(Number(away?.averageFor ?? 0))} corner battuti / ${round(Number(away?.averageAgainst ?? 0))} concessi`,
      `campione ${Number(home?.matches ?? 0)} + ${Number(away?.matches ?? 0)} incontri`,
      `linea ${String(pick.recommendedBet)}`,
    ].join(" | ");
  }
  const lines = [
    `${String(pick.home.name)} totale ${s.homeOverall.matches}: ${round(s.homeOverall.avgGoalsFor)} fatti / ${round(s.homeOverall.avgGoalsAgainst)} subiti`,
    `${String(pick.away.name)} totale ${s.awayOverall.matches}: ${round(s.awayOverall.avgGoalsFor)} fatti / ${round(s.awayOverall.avgGoalsAgainst)} subiti`,
    `${String(pick.home.name)} casa ${s.homeVenue.matches}: ${round(s.homeVenue.avgGoalsFor)} fatti / ${round(s.homeVenue.avgGoalsAgainst)} subiti`,
    `${String(pick.away.name)} trasferta ${s.awayVenue.matches}: ${round(s.awayVenue.avgGoalsFor)} fatti / ${round(s.awayVenue.avgGoalsAgainst)} subiti`,
    `forma 5: ${round(s.homeRecent.avgTotalGoals)} + ${round(s.awayRecent.avgTotalGoals)}`,
    `H2H ${a.h2h.matches}: ${round(a.h2h.avgTotalGoals)} gol medi`,
    `proiezioni gol ${round(a.projection.homeGoals)} / ${round(a.projection.awayGoals)}`,
  ];
  if (a.results) {
    lines.push(
      `casa imbattuta ${Math.round(Number(a.results.homeVenue.unbeatenRate ?? 0) * 100)}% / ` +
      `ospite imbattuta ${Math.round(Number(a.results.awayVenue.unbeatenRate ?? 0) * 100)}%`,
    );
  }
  if (a.corners?.home?.matches > 0) {
    lines.push(
      `corner medi ${round(a.corners.home.averageFor)} casa / ${round(a.corners.away.averageFor)} ospite`,
    );
  }
  return lines.join(" | ");
}

function selectedPrice(snapshot: OddsSnapshotV3, market: PrematchMarketV3, line: number | null) {
  if (CORNER_MARKETS.includes(market as CornerMarketV3)) {
    return snapshot.cornerMarkets[market as CornerMarketV3]
      .find((price) => price.line === line) ?? emptyPrice(line);
  }
  return snapshot.markets[market as CoreMarketV3];
}

function oddsPayload(snapshot: OddsSnapshotV3, selected: PrematchMarketV3, line: number | null) {
  const goal = snapshot.markets.GOAL;
  const over = snapshot.markets["OVER 2.5"];
  const home = snapshot.markets["CASA OVER 1.5"];
  const away = snapshot.markets["OSPITE OVER 1.5"];
  const selectedMarketPrice = selectedPrice(snapshot, selected, line);
  const marketOdds: Record<string, number | null> = {};
  const marketOffers: Record<string, MarketOfferV3[]> = {};
  for (const market of CORE_MARKETS) {
    marketOdds[market] = snapshot.markets[market].bestOdd;
    marketOffers[market] = snapshot.markets[market].offers;
  }
  for (const market of CORNER_MARKETS) {
    for (const price of snapshot.cornerMarkets[market]) {
      const key = `${market} OVER ${price.line?.toFixed(1)}`;
      marketOdds[key] = price.bestOdd;
      marketOffers[key] = price.offers;
    }
  }
  return {
    goal: goal.bestOdd,
    over25: over.bestOdd,
    under25: null,
    homeOver15: home.bestOdd,
    awayOver15: away.bestOdd,
    goalOffers: goal.offers,
    over25Offers: over.offers,
    under25Offers: [],
    homeOver15Offers: home.offers,
    awayOver15Offers: away.offers,
    selectedMarket: selected,
    selectedLine: line,
    selectedOdd: selectedMarketPrice.referenceOdd ?? selectedMarketPrice.bestOdd,
    selectedBestOdd: selectedMarketPrice.bestOdd,
    selectedReferenceOdd: selectedMarketPrice.referenceOdd,
    selectedOffers: selectedMarketPrice.offers,
    marketOdds,
    marketOffers,
    fetchedAt: snapshot.fetchedAt,
    providerUpdatedAt: snapshot.providerUpdatedAt,
  };
}

function blendResultProfiles(current: ResultProfileV3, previous: ResultProfileV3): ResultProfileV3 {
  if (current.effectiveMatches >= 6 || previous.effectiveMatches <= 0) return current;
  const previousWeight = Math.min(4, Math.max(1.5, 6 - current.effectiveMatches)) * 0.55;
  const previousScale = previousWeight / Math.max(1, previous.effectiveMatches);
  const effectiveMatches = current.effectiveMatches + previous.effectiveMatches * previousScale;
  const wins = current.wins + previous.wins * previousScale;
  const draws = current.draws + previous.draws * previousScale;
  const losses = current.losses + previous.losses * previousScale;
  const goalDifference =
    current.goalDifferencePerMatch * current.effectiveMatches +
    previous.goalDifferencePerMatch * previous.effectiveMatches * previousScale;
  return {
    matches: current.matches + Math.round(previous.matches * previousScale),
    effectiveMatches,
    wins,
    draws,
    losses,
    pointsPerMatch: (wins * 3 + draws) / effectiveMatches,
    winRate: wins / effectiveMatches,
    drawRate: draws / effectiveMatches,
    lossRate: losses / effectiveMatches,
    unbeatenRate: (wins + draws) / effectiveMatches,
    goalDifferencePerMatch: goalDifference / effectiveMatches,
  };
}

function daysBetween(fromMs: number, toMs: number): number | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return (toMs - fromMs) / 86_400_000;
}

function previousFinishedDate(raw: any, cutoffMs: number): number | null {
  const dates = finishedFixtures(raw)
    .map(fixtureDate)
    .filter((value) => value < cutoffMs && Number.isFinite(value))
    .sort((left, right) => right - left);
  return dates[0] ?? null;
}

function nextFixtureAfter(raw: any, fixtureId: number, kickoffMs: number): any | null {
  return responseFixtures(raw)
    .filter((item) => Number(item?.fixture?.id ?? 0) !== fixtureId)
    .filter((item) => fixtureDate(item) > kickoffMs)
    .sort((left, right) => fixtureDate(left) - fixtureDate(right))[0] ?? null;
}

function buildScheduleContext(
  fixtureId: number,
  kickoffMs: number,
  homeRecentRaw: any,
  awayRecentRaw: any,
  homeNextRaw: any,
  awayNextRaw: any,
): ScheduleContextV3 {
  const homePrevious = previousFinishedDate(homeRecentRaw, kickoffMs);
  const awayPrevious = previousFinishedDate(awayRecentRaw, kickoffMs);
  const homeNext = nextFixtureAfter(homeNextRaw, fixtureId, kickoffMs);
  const awayNext = nextFixtureAfter(awayNextRaw, fixtureId, kickoffMs);
  return {
    homeRestDays: homePrevious == null ? null : daysBetween(homePrevious, kickoffMs),
    awayRestDays: awayPrevious == null ? null : daysBetween(awayPrevious, kickoffMs),
    homeNextRestDays: homeNext == null ? null : daysBetween(kickoffMs, fixtureDate(homeNext)),
    awayNextRestDays: awayNext == null ? null : daysBetween(kickoffMs, fixtureDate(awayNext)),
    homeHasPriorityCupNext: homeNext != null && isCup(homeNext),
    awayHasPriorityCupNext: awayNext != null && isCup(awayNext),
    lineupsConfirmed: false,
    homeLineupStrength: null,
    awayLineupStrength: null,
  };
}

function recentFixtureIds(raw: any, teamId: number, cutoffMs: number, limit = 10, venue: Venue = "all"): number[] {
  return finishedFixtures(raw)
    .filter(officialFixture)
    .filter((fixture) => fixtureDate(fixture) < cutoffMs && fixtureDate(fixture) > cutoffMs - 365 * 86_400_000)
    .filter((fixture) => {
      const homeId = Number(fixture?.teams?.home?.id ?? 0);
      const awayId = Number(fixture?.teams?.away?.id ?? 0);
      return venue === "home" ? homeId === teamId : venue === "away" ? awayId === teamId : homeId === teamId || awayId === teamId;
    })
    .sort((left, right) => fixtureDate(right) - fixtureDate(left))
    .slice(0, limit)
    .map((fixture) => Number(fixture?.fixture?.id ?? 0))
    .filter(Boolean);
}

async function loadCornerProfiles(
  homeRecentRaw: any,
  awayRecentRaw: any,
  homeId: number,
  awayId: number,
  cutoffMs: number,
  enabled: boolean,
) {
  if (!enabled) {
    return { home: emptyCornerProfileV3(), away: emptyCornerProfileV3() };
  }
  const homeIds = recentFixtureIds(homeRecentRaw, homeId, cutoffMs, 10, "home");
  const awayIds = recentFixtureIds(awayRecentRaw, awayId, cutoffMs, 10, "away");
  const ids = [...new Set([...homeIds, ...awayIds])];
  const snapshots = new Map<number, any>();
  for (let index = 0; index < ids.length; index += 4) {
    const batch = ids.slice(index, index + 4);
    const loaded = await Promise.all(
      batch.map(async (id) => [id, await fixtureStatistics(id).catch(() => null)] as const),
    );
    for (const [id, value] of loaded) if (value) snapshots.set(id, value);
  }
  return {
    home: buildCornerProfileV3(homeIds.map((id) => snapshots.get(id)).filter(Boolean), homeId),
    away: buildCornerProfileV3(awayIds.map((id) => snapshots.get(id)).filter(Boolean), awayId),
  };
}

async function evaluateFixture(fixture: any, allowCorners: boolean): Promise<PrematchPickV3 | null> {
  const fixtureId = Number(fixture?.fixture?.id ?? 0);
  const homeId = Number(fixture?.teams?.home?.id ?? 0);
  const awayId = Number(fixture?.teams?.away?.id ?? 0);
  const leagueId = Number(fixture?.league?.id ?? 0);
  const season = seasonOf(fixture);
  const kickoffMs = fixtureDate(fixture);
  if (!fixtureId || !homeId || !awayId || !leagueId) return null;
  if (!Number.isFinite(kickoffMs) || kickoffMs <= Date.now()) return null;

  // Prima le quote: non scaricare dossier statistici per mercati assenti,
  // quote sotto soglia o prezzi non confrontabili tra almeno due bookmaker.
  const oddsRaw = await fixtureOdds(fixtureId, fixture?.fixture?.date ?? null).catch(() => null);
  const oddsSnapshot = extractOddsSnapshotV3(oddsRaw);
  const hasCorePrices = CORE_MARKETS.some((market) => {
    const price = oddsSnapshot.markets[market];
    const reference = price.referenceOdd ?? price.bestOdd;
    return reference != null && reference >= MIN_ODDS_V3[market] && price.bookmakerCount >= 2;
  });
  const hasCornerPrices = allowCorners && CORNER_MARKETS.some((market) =>
    oddsSnapshot.cornerMarkets[market].some((price) =>
      (price.referenceOdd ?? price.bestOdd) != null &&
      (price.referenceOdd ?? price.bestOdd)! >= MIN_ODDS_V3[market]
    ),
  );
  if (!hasCorePrices && !hasCornerPrices) return null;

  const [currentRaw, previousRaw, h2hRaw, homeRecentRaw, awayRecentRaw, homeNextRaw, awayNextRaw] = await Promise.all([
    leagueSeasonFixtures(leagueId, season),
    leagueSeasonFixtures(leagueId, season - 1, true).catch(() => null),
    headToHead(homeId, awayId).catch(() => null),
    recentTeamFixtures(homeId).catch(() => null),
    recentTeamFixtures(awayId).catch(() => null),
    nextTeamFixtures(homeId).catch(() => null),
    nextTeamFixtures(awayId).catch(() => null),
  ]);
  const homeOverall = buildTeamStatsV2(currentRaw, homeId);
  const awayOverall = buildTeamStatsV2(currentRaw, awayId);
  const homeRecent = buildWeightedRecentStatsV3(homeRecentRaw, homeId, kickoffMs, "all", 5);
  const awayRecent = buildWeightedRecentStatsV3(awayRecentRaw, awayId, kickoffMs, "all", 5);
  const homeRecentVenue = buildWeightedRecentStatsV3(homeRecentRaw, homeId, kickoffMs, "home", 5);
  const awayRecentVenue = buildWeightedRecentStatsV3(awayRecentRaw, awayId, kickoffMs, "away", 5);
  const homeVenue = buildTeamStatsV2(currentRaw, homeId, "home");
  const awayVenue = buildTeamStatsV2(currentRaw, awayId, "away");
  const previousHomeVenue = buildTeamStatsV2(previousRaw, homeId, "home");
  const previousAwayVenue = buildTeamStatsV2(previousRaw, awayId, "away");
  const cornerHistory = {
    response: [...new Map([
      ...responseFixtures(currentRaw), ...responseFixtures(previousRaw),
      ...responseFixtures(homeRecentRaw), ...responseFixtures(awayRecentRaw),
    ].map((item) => [Number(item?.fixture?.id), item])).values()],
  };
  const corners = await loadCornerProfiles(
    cornerHistory,
    cornerHistory,
    homeId,
    awayId,
    kickoffMs,
    allowCorners && hasCornerPrices,
  );
  const currentHomeResult = buildResultProfileV3(currentRaw, homeId, kickoffMs, "home");
  const currentAwayResult = buildResultProfileV3(currentRaw, awayId, kickoffMs, "away");
  const previousHomeResult = buildResultProfileV3(previousRaw, homeId, kickoffMs, "home");
  const previousAwayResult = buildResultProfileV3(previousRaw, awayId, kickoffMs, "away");
  const baseInput: Omit<StrategyInputV3, "markets" | "cornerMarkets"> = {
    contextType: isCup(fixture) ? "cup" : "league",
    homeOverall,
    awayOverall,
    homeVenue,
    awayVenue,
    homeRecent,
    awayRecent,
    homeRecentVenue,
    awayRecentVenue,
    previousHomeOverall: buildTeamStatsV2(previousRaw, homeId),
    previousAwayOverall: buildTeamStatsV2(previousRaw, awayId),
    previousHomeVenue,
    previousAwayVenue,
    h2h: buildH2HStatsV2(h2hRaw, homeId, awayId),
    league: buildLeagueBaselineV2(currentRaw),
    homeResultVenue: blendResultProfiles(currentHomeResult, previousHomeResult),
    awayResultVenue: blendResultProfiles(currentAwayResult, previousAwayResult),
    homeResultRecent: buildResultProfileV3(homeRecentRaw, homeId, kickoffMs, "all", 8, true),
    awayResultRecent: buildResultProfileV3(awayRecentRaw, awayId, kickoffMs, "all", 8, true),
    homeCorners: corners.home,
    awayCorners: corners.away,
    schedule: buildScheduleContext(
      fixtureId,
      kickoffMs,
      homeRecentRaw,
      awayRecentRaw,
      homeNextRaw,
      awayNextRaw,
    ),
  };
  const evaluated = evaluateStrategyV4({
    ...baseInput,
    markets: oddsSnapshot.markets,
    cornerMarkets: oddsSnapshot.cornerMarkets,
  });
  if (!evaluated.selection) return null;
  const selected = evaluated.selection;
  const marketPrice = selectedPrice(oddsSnapshot, selected.market, selected.line);
  const selectedReferenceOdd = marketPrice.referenceOdd ?? marketPrice.bestOdd;
  if (selectedReferenceOdd == null || selectedReferenceOdd < MIN_ODDS_V3[selected.market] || marketPrice.offers.length < 2) {
    return null;
  }

  const home = {
    id: homeId,
    name: fixture?.teams?.home?.name ?? null,
    logo: fixture?.teams?.home?.logo ?? null,
  };
  const away = {
    id: awayId,
    name: fixture?.teams?.away?.name ?? null,
    logo: fixture?.teams?.away?.logo ?? null,
  };
  const analysis = {
    version: evaluated.version,
    sampleMode: evaluated.sampleMode,
    dataQuality: round(evaluated.dataQuality),
    projection: {
      homeGoals: round(evaluated.lambdaHome),
      awayGoals: round(evaluated.lambdaAway),
      totalGoals: round(evaluated.expectedGoals),
    },
    probabilities: Object.fromEntries(
      Object.entries(evaluated.probabilities).map(([key, value]) => [key, round(value)]),
    ),
    selected: {
      market: selected.market,
      label: selected.label,
      line: selected.line,
      modelProbability: round(selected.modelProbability),
      marketProbability: selected.marketProbability == null ? null : round(selected.marketProbability),
      finalProbability: round(selected.finalProbability),
      fairOdd: round(selected.fairOdd),
      bestOdd: round(selected.bestOdd),
      referenceOdd: round(selectedReferenceOdd),
      expectedValue: round(selected.expectedValue),
      dataQuality: round(selected.dataQuality),
      robustProbability: round(selected.robustProbability),
      uncertainty: round(selected.uncertainty),
      stability: round(selected.stability),
    },
    stats: {
      homeOverall: baseInput.homeOverall,
      awayOverall: baseInput.awayOverall,
      homeVenue: baseInput.homeVenue,
      awayVenue: baseInput.awayVenue,
      homeRecent: baseInput.homeRecent,
      awayRecent: baseInput.awayRecent,
      homeRecentVenue: baseInput.homeRecentVenue,
      awayRecentVenue: baseInput.awayRecentVenue,
    },
    h2h: baseInput.h2h,
    leagueBaseline: baseInput.league,
    results: {
      homeVenue: baseInput.homeResultVenue,
      awayVenue: baseInput.awayResultVenue,
      homeRecent: baseInput.homeResultRecent,
      awayRecent: baseInput.awayResultRecent,
    },
    corners: {
      home: baseInput.homeCorners,
      away: baseInput.awayCorners,
    },
    schedule: baseInput.schedule,
    odds: {
      fetchedAt: oddsSnapshot.fetchedAt,
      providerUpdatedAt: oddsSnapshot.providerUpdatedAt,
      consensusProbability: marketPrice.consensusProbability,
    },
  };

  const pick: PrematchPickV3 = {
    fixtureId,
    date: fixture?.fixture?.date ?? null,
    contextType: baseInput.contextType,
    algorithmVersion: "brainlive-strategy-v5-complete",
    league: {
      id: leagueId,
      name: fixture?.league?.name ?? null,
      country: fixture?.league?.country ?? null,
      logo: fixture?.league?.logo ?? null,
      flag: fixture?.league?.flag ?? null,
    },
    home,
    away,
    recommendedBet: selected.label,
    confidence: round(selected.finalProbability),
    score: round(selected.score, 1),
    insightLine: "",
    reason: String(selected.market).startsWith("CORNER")
      ? `Il modello confronta corner battuti, corner concessi, variabilità e consistenza del campione sulla linea ${selected.line?.toFixed(1)}.`
      : `Il modello stima ${round(evaluated.lambdaHome)} gol per la squadra di casa e ` +
        `${round(evaluated.lambdaAway)} per l'ospite, con qualità dati ${Math.round(evaluated.dataQuality * 100)}%.`,
    odds: oddsPayload(oddsSnapshot, selected.market, selected.line),
    analysis,
  };
  pick.insightLine = insight(pick);
  return pick;
}

export function isUpcomingPrematchV3(date: string | null, now = Date.now()): boolean {
  const kickoff = new Date(date ?? "").getTime();
  return Number.isFinite(kickoff) && kickoff > now;
}

function visiblePicks(picks: PrematchPickV3[]): PrematchPickV3[] {
  return picks.filter((pick) => isUpcomingPrematchV3(pick.date));
}

function italianClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

/** Le analisi del giorno diventano pubbliche dalle 10:00 italiane. */
export function isPrematchPublicationOpenV3(
  date: string,
  now = new Date(),
): boolean {
  const clock = italianClock(now);
  return date === clock.date && clock.hour >= 10;
}

// Snapshot atomico della pubblicazione giornaliera: una volta terminato il
// calcolo, nuove card non vengono aggiunte a scaglioni durante la giornata.
const publishedDailyResults = new Map<
  string,
  { picks: PrematchPickV3[]; candidates: never[] }
>();
const preparedDailyResults = new Map<
  string,
  { picks: PrematchPickV3[]; candidates: never[] }
>();

/**
 * Dopo la pubblicazione lo snapshot resta immutabile: quote e risposte
 * temporaneamente incomplete non possono far sparire o aggiungere card.
 */
export function mergePublishedPrematchResults(
  published: { picks: PrematchPickV3[]; candidates: never[] } | null,
  scanned: { picks: PrematchPickV3[]; candidates: never[] },
) {
  if (published) return { picks: visiblePicks(published.picks), candidates: [] as never[] };
  return { picks: visiblePicks(scanned.picks), candidates: [] as never[] };
}

export async function buildBrainPrematchV3(date: string, maxMatches = 24): Promise<{
  picks: PrematchPickV3[];
  candidates: never[];
  cacheState: "fresh" | "stale" | "miss";
}> {
  const max = Math.max(1, Math.min(maxMatches, 250));
  if (!isPrematchPublicationOpenV3(date)) {
    return {
      picks: [],
      candidates: [],
      cacheState: "fresh",
    };
  }
  let published = publishedDailyResults.get(date) ?? null;
  if (!published) {
    published = await loadPublishedPrematchDay(date);
    if (published?.picks?.length) publishedDailyResults.set(date, published);
    else published = null;
  }
  if (published) {
    const stable = mergePublishedPrematchResults(published, published);
    return { ...stable, picks: stable.picks.slice(0, max), cacheState: "fresh" };
  }
  // Alle 10 viene pubblicato in un unico gesto il dossier già preparato.
  // Se il server è stato riavviato, la scansione viene completata una sola volta.
  const key = `brainPrematchV3:result:${date}:v5-complete`;
  const prepared = preparedDailyResults.get(date) ?? await runOnce(key, () => compute(date, key, "pubblicato"));
  const snapshot = mergePublishedPrematchResults(null, prepared);
  publishedDailyResults.set(date, snapshot);
  await savePublishedPrematchDay(date, snapshot);
  return { ...snapshot, picks: snapshot.picks.slice(0, max), cacheState: "miss" };
}

async function compute(date: string, key: string, phase: "preparazione" | "pubblicato") {
  const startedAt = new Date().toISOString();
  const raw = await dateFixtures(date);
  const fixtures = responseFixtures(raw);
  const supported = fixtures.filter(allowed);
  const upcoming = supported
    .filter((fixture) => NOT_STARTED.has(String(fixture?.fixture?.status?.short ?? "").toUpperCase()))
    .filter((fixture) => fixtureDate(fixture) > Date.now())
    .sort((a, b) => fixtureDate(a) - fixtureDate(b));
  const picks: PrematchPickV3[] = [];
  let rejected = 0;
  let failed = 0;
  const failureSamples: string[] = [];

  // Piccoli gruppi evitano picchi di chiamate e mantengono il server reattivo.
  for (let index = 0; index < upcoming.length; index += 6) {
    const batch = upcoming.slice(index, index + 6);
    const evaluated = await Promise.all(batch.map(async (fixture) => {
      try {
        const pick = await evaluateFixture(fixture, true);
        if (!pick) rejected += 1;
        return pick;
      } catch (error: any) {
        failed += 1;
        if (failureSamples.length < 3) {
          const fixtureId = Number(fixture?.fixture?.id ?? 0);
          failureSamples.push(`${fixtureId}: ${String(error?.message ?? error).slice(0, 160)}`);
        }
        return null;
      }
    }));
    picks.push(...evaluated.filter((pick): pick is PrematchPickV3 => pick != null));
  }
  picks.sort((a, b) => b.score - a.score);

  // Nessun tetto artificiale per campionato: se più incontri superano tutti
  // i controlli matematici vengono pubblicati. Rimane soltanto il limite
  // tecnico richiesto dal client, sufficientemente alto per proteggere l'API.
  const finalPicks = picks;

  const result = { picks: finalPicks, candidates: [] as never[] };
  console.info("[prematch-v4] scan completed", {
    date,
    fixtures: fixtures.length,
    upcoming: upcoming.length,
    accepted: finalPicks.length,
    rejected,
    failed,
    algorithmMode: "complete",
    failureSamples,
  });
  // Una scelta pubblicata non deve sparire perché un refresh successivo ha
  // dati/quote momentaneamente incompleti. Resta stabile fino al calcio
  // d'inizio; `visiblePicks` la rimuove esattamente in quel momento.
  // L'intero risultato viene pubblicato come un solo snapshot giornaliero;
  // `visiblePicks` continua comunque a rimuovere ogni gara al calcio d'inizio.
  const report: PrematchScanReport = {
    algorithmVersion: "brainlive-strategy-v5-complete",
    date,
    phase,
    startedAt,
    completedAt: new Date().toISOString(),
    publishedAt: phase === "pubblicato" ? new Date().toISOString() : null,
    providerFixtures: fixtures.length,
    supportedFixtures: supported.length,
    upcomingFixtures: upcoming.length,
    evaluatedFixtures: upcoming.length,
    acceptedFixtures: finalPicks.length,
    excluded: {
      fuoriCompetizioniSelezionate: fixtures.length - supported.length,
      nonFutureONonProgrammate: supported.length - upcoming.length,
      quotaODatiNonSufficienti: rejected,
      erroreFornitore: failed,
    },
    failures: failureSamples,
  };
  await savePrematchScanReport(report);
  setCache(key, result, 30 * 60, 60 * 60);
  return result;
}

export const buildBrainPrematch = buildBrainPrematchV3;
export default buildBrainPrematchV3;

/** Pubblica la giornata alle 10:00 italiane senza dipendere dall'apertura dell'app. */
export function startBrainPrematchSchedulerV3(): void {
  let lastScanSlot = "";
  const tick = () => {
    const clock = italianClock();
    // Tre preparazioni prima delle 10 consentono di recuperare risposte
    // temporanee del fornitore; alle 10 lo snapshot viene pubblicato tutto insieme.
    const preparing = clock.hour === 8 || clock.hour === 9;
    const publishing = clock.hour === 10;
    if (!preparing && !publishing) return;
    const intervalMinutes = preparing ? 30 : 60;
    const slot = `${clock.date}:${clock.hour}:${Math.floor(clock.minute / intervalMinutes)}`;
    if (lastScanSlot === slot) return;
    lastScanSlot = slot;
    const job = publishing
      ? buildBrainPrematchV3(clock.date, 250)
      : runOnce(`brainPrematchV3:prepare:${slot}`, async () => {
          const prepared = await compute(clock.date, `brainPrematchV3:prepared:${slot}`, "preparazione");
          preparedDailyResults.set(clock.date, prepared);
          return { ...prepared, cacheState: "miss" as const };
        });
    void job
      .then(async (result) => {
        if (publishing && result.picks.length > 0 && await claimPrematchNotification(clock.date)) {
          await sendBrainPrematchPush(result.picks.length);
        }
      })
      .catch((error) => {
        lastScanSlot = "";
        console.error("[prematch-v4] 10:00 refresh failed:", error?.message ?? error);
      });
  };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
}
