import axios from "axios";
import { getCache, getCacheState, setCache } from "./cache";
import { runOnce } from "./inflight";
import { markApiCall, markCacheHit, markCacheMiss, syncProviderQuota } from "./stats";
import {
  emptyTeamStatsV2,
  evaluateStrategyV2,
  H2HStatsV2,
  LeagueBaselineV2,
  MarketOfferV2,
  MarketPriceV2,
  MIN_RECOMMENDED_ODD_V2,
  PrematchMarket,
  StrategyInputV2,
  TeamStatsV2,
} from "./prematchStrategyV2";

const BASE_URL = "https://v3.football.api-sports.io";
import { isApiEcoMode } from "./runtimeMode";
const FINISHED = new Set(["FT", "AET", "PEN"]);
const NOT_STARTED = new Set(["NS", "TBD"]);
const MAX_PICKS_PER_LEAGUE = 2;
const MARKETS: PrematchMarket[] = [
  "GOAL",
  "OVER 2.5",
  "CASA OVER 1.5",
  "OSPITE OVER 1.5",
];

type Venue = "all" | "home" | "away";
type BookmakerMarket = {
  selectionOdd?: number;
  oppositeOdd?: number;
};
type OddsSnapshotV2 = {
  fetchedAt: string;
  providerUpdatedAt: string | null;
  markets: Record<PrematchMarket, MarketPriceV2>;
};

type PrematchPickV2 = {
  fixtureId: number;
  date: string | null;
  contextType: "league" | "cup";
  algorithmVersion: "brainlive-strategy-v2";
  league: Record<string, unknown>;
  home: Record<string, unknown>;
  away: Record<string, unknown>;
  recommendedBet: PrematchMarket;
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
    `brainPrematchV2:date:${date}`,
    isApiEcoMode() ? 6 * 3600 : 10 * 60,
    30 * 60,
    () => apiGet("/fixtures", { date }),
  );
}

function leagueSeasonFixtures(leagueId: number, season: number, previous = false) {
  return cached(
    `brainPrematchV2:league:${leagueId}:${season}`,
    previous ? 24 * 3600 : isApiEcoMode() ? 6 * 3600 : 30 * 60,
    24 * 3600,
    () => apiGet("/fixtures", { league: leagueId, season }),
  );
}

function recentTeamFixtures(teamId: number) {
  return cached(
    `brainPrematchV2:recent:${teamId}:10`,
    isApiEcoMode() ? 6 * 3600 : 60 * 60,
    6 * 3600,
    () => apiGet("/fixtures", { team: teamId, last: 10 }),
  );
}

function headToHead(homeId: number, awayId: number) {
  return cached(
    `brainPrematchV2:h2h:${homeId}:${awayId}:10`,
    12 * 3600,
    24 * 3600,
    () => apiGet("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 10 }),
  );
}

function oddsTtlSeconds(kickoff: string | null): number {
  if (isApiEcoMode()) return 6 * 3600;
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
    `brainPrematchV2:odds:${fixtureId}`,
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

function marketFromBetName(name: string): PrematchMarket | null {
  if (["both teams score", "both teams to score", "btts"].includes(name)) return "GOAL";
  if (
    name.includes("total home") ||
    name.includes("home total") ||
    name.includes("home team total") ||
    name.includes("total goals home")
  ) return "CASA OVER 1.5";
  if (
    name.includes("total away") ||
    name.includes("away total") ||
    name.includes("away team total") ||
    name.includes("total goals away")
  ) return "OSPITE OVER 1.5";
  if (["over under", "goals over under", "total goals"].includes(name)) return "OVER 2.5";
  return null;
}

function isSelectionValue(market: PrematchMarket, value: string): boolean {
  if (market === "GOAL") return ["yes", "si", "sì"].includes(value);
  if (market === "OVER 2.5") return value === "over 2.5" || value === "over 2.5 goals";
  return value === "over 1.5" || value === "over 1.5 goals";
}

function isOppositeValue(market: PrematchMarket, value: string): boolean {
  if (market === "GOAL") return ["no"].includes(value);
  if (market === "OVER 2.5") return value === "under 2.5" || value === "under 2.5 goals";
  return value === "under 1.5" || value === "under 1.5 goals";
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function extractOddsSnapshotV2(raw: any): OddsSnapshotV2 {
  const byMarket = new Map<PrematchMarket, Map<string, BookmakerMarket>>();
  for (const market of MARKETS) byMarket.set(market, new Map());
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
      for (const bet of Array.isArray(bookmaker?.bets) ? bookmaker.bets : []) {
        const market = marketFromBetName(normalized(bet?.name));
        if (!market) continue;
        const current = byMarket.get(market)!.get(bookmakerName) ?? {};
        for (const value of Array.isArray(bet?.values) ? bet.values : []) {
          const parsedOdd = odd(value?.odd);
          if (parsedOdd == null) continue;
          const label = normalized(value?.value);
          if (isSelectionValue(market, label)) current.selectionOdd = parsedOdd;
          if (isOppositeValue(market, label)) current.oppositeOdd = parsedOdd;
        }
        byMarket.get(market)!.set(bookmakerName, current);
      }
    }
  }

  const markets = {} as Record<PrematchMarket, MarketPriceV2>;
  for (const market of MARKETS) {
    const offers: MarketOfferV2[] = [];
    for (const [bookmaker, values] of byMarket.get(market)!) {
      if (values.selectionOdd == null) continue;
      const fairProbability = values.oppositeOdd == null
        ? null
        : (1 / values.selectionOdd) /
          (1 / values.selectionOdd + 1 / values.oppositeOdd);
      offers.push({
        bookmaker,
        odd: values.selectionOdd,
        oppositeOdd: values.oppositeOdd ?? null,
        fairProbability,
      });
    }
    offers.sort((a, b) => b.odd - a.odd);
    markets[market] = {
      bestOdd: offers[0]?.odd ?? null,
      consensusProbability: median(
        offers
          .map((offer) => offer.fairProbability)
          .filter((value): value is number => value != null),
      ),
      offers: offers.slice(0, 3),
    };
  }

  return {
    fetchedAt: String(raw?.fetchedAt ?? new Date().toISOString()),
    providerUpdatedAt,
    markets,
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
  return !name.includes("friendly");
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
    .slice(0, 10);
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

function allowed(fixture: any): boolean {
  const id = Number(fixture?.league?.id ?? 0);
  const ids = new Set([135, 78, 39, 88, 140, 61, 94, 119, 2, 3, 848, 1, 4, 5, 32, 960, 15]);
  return ids.has(id);
}

function isCup(fixture: any): boolean {
  return new Set([2, 3, 848, 1, 4, 5, 32, 960, 15]).has(Number(fixture?.league?.id ?? 0));
}

function emptyMarkets(bestOdd: number | null = null): Record<PrematchMarket, MarketPriceV2> {
  return {
    GOAL: { bestOdd, consensusProbability: null, offers: [] },
    "OVER 2.5": { bestOdd, consensusProbability: null, offers: [] },
    "CASA OVER 1.5": { bestOdd, consensusProbability: null, offers: [] },
    "OSPITE OVER 1.5": { bestOdd, consensusProbability: null, offers: [] },
  };
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function insight(pick: PrematchPickV2): string {
  const a: any = pick.analysis;
  const s: any = a.stats;
  return [
    `${String(pick.home.name)} totale ${s.homeOverall.matches}: ${round(s.homeOverall.avgGoalsFor)} fatti / ${round(s.homeOverall.avgGoalsAgainst)} subiti`,
    `${String(pick.away.name)} totale ${s.awayOverall.matches}: ${round(s.awayOverall.avgGoalsFor)} fatti / ${round(s.awayOverall.avgGoalsAgainst)} subiti`,
    `${String(pick.home.name)} casa ${s.homeVenue.matches}: ${round(s.homeVenue.avgGoalsFor)} fatti / ${round(s.homeVenue.avgGoalsAgainst)} subiti`,
    `${String(pick.away.name)} trasferta ${s.awayVenue.matches}: ${round(s.awayVenue.avgGoalsFor)} fatti / ${round(s.awayVenue.avgGoalsAgainst)} subiti`,
    `forma 5: ${round(s.homeRecent.avgTotalGoals)} + ${round(s.awayRecent.avgTotalGoals)}`,
    `H2H ${a.h2h.matches}: ${round(a.h2h.avgTotalGoals)} gol medi`,
    `proiezioni gol ${round(a.projection.homeGoals)} / ${round(a.projection.awayGoals)}`,
  ].join(" | ");
}

function offersFor(snapshot: OddsSnapshotV2, market: PrematchMarket): MarketOfferV2[] {
  return snapshot.markets[market].offers;
}

function legacyOdds(snapshot: OddsSnapshotV2, selected: PrematchMarket) {
  const goal = snapshot.markets.GOAL;
  const over = snapshot.markets["OVER 2.5"];
  const home = snapshot.markets["CASA OVER 1.5"];
  const away = snapshot.markets["OSPITE OVER 1.5"];
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
    fetchedAt: snapshot.fetchedAt,
    providerUpdatedAt: snapshot.providerUpdatedAt,
  };
}

async function evaluateFixture(fixture: any): Promise<PrematchPickV2 | null> {
  const fixtureId = Number(fixture?.fixture?.id ?? 0);
  const homeId = Number(fixture?.teams?.home?.id ?? 0);
  const awayId = Number(fixture?.teams?.away?.id ?? 0);
  const leagueId = Number(fixture?.league?.id ?? 0);
  const season = seasonOf(fixture);
  if (!fixtureId || !homeId || !awayId || !leagueId) return null;

  const [currentRaw, previousRaw, h2hRaw] = await Promise.all([
    leagueSeasonFixtures(leagueId, season),
    leagueSeasonFixtures(leagueId, season - 1, true).catch(() => null),
    headToHead(homeId, awayId).catch(() => null),
  ]);
  const homeOverall = buildTeamStatsV2(currentRaw, homeId);
  const awayOverall = buildTeamStatsV2(currentRaw, awayId);
  let homeRecent = buildTeamStatsV2(currentRaw, homeId, "all", 5);
  let awayRecent = buildTeamStatsV2(currentRaw, awayId, "all", 5);
  let homeRecentVenue = buildTeamStatsV2(currentRaw, homeId, "home", 5);
  let awayRecentVenue = buildTeamStatsV2(currentRaw, awayId, "away", 5);
  if (homeRecent.matches < 3 || awayRecent.matches < 3) {
    const [homeFallback, awayFallback] = await Promise.all([
      recentTeamFixtures(homeId).catch(() => null),
      recentTeamFixtures(awayId).catch(() => null),
    ]);
    if (homeRecent.matches < 3) {
      homeRecent = buildTeamStatsV2(homeFallback, homeId, "all", 5);
      homeRecentVenue = buildTeamStatsV2(homeFallback, homeId, "home", 5);
    }
    if (awayRecent.matches < 3) {
      awayRecent = buildTeamStatsV2(awayFallback, awayId, "all", 5);
      awayRecentVenue = buildTeamStatsV2(awayFallback, awayId, "away", 5);
    }
  }

  const baseInput: Omit<StrategyInputV2, "markets"> = {
    contextType: isCup(fixture) ? "cup" : "league",
    homeOverall,
    awayOverall,
    homeVenue: buildTeamStatsV2(currentRaw, homeId, "home"),
    awayVenue: buildTeamStatsV2(currentRaw, awayId, "away"),
    homeRecent,
    awayRecent,
    homeRecentVenue,
    awayRecentVenue,
    previousHomeOverall: buildTeamStatsV2(previousRaw, homeId),
    previousAwayOverall: buildTeamStatsV2(previousRaw, awayId),
    previousHomeVenue: buildTeamStatsV2(previousRaw, homeId, "home"),
    previousAwayVenue: buildTeamStatsV2(previousRaw, awayId, "away"),
    h2h: buildH2HStatsV2(h2hRaw, homeId, awayId),
    league: buildLeagueBaselineV2(currentRaw),
  };

  // Prefiltro statistico prima della chiamata quote.
  const provisional = evaluateStrategyV2({ ...baseInput, markets: emptyMarkets(2) });
  if (!provisional.selection && provisional.dataQuality < 0.48) return null;

  const oddsRaw = await fixtureOdds(fixtureId, fixture?.fixture?.date ?? null).catch(() => null);
  const oddsSnapshot = extractOddsSnapshotV2(oddsRaw);
  const evaluated = evaluateStrategyV2({ ...baseInput, markets: oddsSnapshot.markets });
  if (!evaluated.selection) return null;
  const selected = evaluated.selection;
  const marketPrice = oddsSnapshot.markets[selected.market];
  if (selected.bestOdd < MIN_RECOMMENDED_ODD_V2 || !offersFor(oddsSnapshot, selected.market).length) {
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
      modelProbability: round(selected.modelProbability),
      marketProbability: selected.marketProbability == null ? null : round(selected.marketProbability),
      finalProbability: round(selected.finalProbability),
      fairOdd: round(selected.fairOdd),
      bestOdd: round(selected.bestOdd),
      expectedValue: round(selected.expectedValue),
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
    odds: {
      fetchedAt: oddsSnapshot.fetchedAt,
      providerUpdatedAt: oddsSnapshot.providerUpdatedAt,
      consensusProbability: marketPrice.consensusProbability,
    },
  };

  const pick: PrematchPickV2 = {
    fixtureId,
    date: fixture?.fixture?.date ?? null,
    contextType: baseInput.contextType,
    algorithmVersion: "brainlive-strategy-v2",
    league: {
      id: leagueId,
      name: fixture?.league?.name ?? null,
      country: fixture?.league?.country ?? null,
      logo: fixture?.league?.logo ?? null,
      flag: fixture?.league?.flag ?? null,
    },
    home,
    away,
    recommendedBet: selected.market,
    confidence: round(selected.finalProbability),
    score: round(selected.score, 1),
    insightLine: "",
    reason:
      `Il modello stima ${round(evaluated.lambdaHome)} gol per la squadra di casa e ` +
      `${round(evaluated.lambdaAway)} per l'ospite, con qualità dati ${Math.round(evaluated.dataQuality * 100)}%.`,
    odds: legacyOdds(oddsSnapshot, selected.market),
    analysis,
  };
  pick.insightLine = insight(pick);
  return pick;
}

export async function buildBrainPrematchV2(date: string, maxMatches = 5): Promise<{
  picks: PrematchPickV2[];
  candidates: never[];
  cacheState: "fresh" | "stale" | "miss";
}> {
  const max = Math.max(1, Math.min(maxMatches, 10));
  const key = `brainPrematchV2:result:${date}:${max}:v2`;
  const state = getCacheState<{ picks: PrematchPickV2[]; candidates: never[] }>(key);
  if (state.state === "fresh" && state.value) return { ...state.value, cacheState: "fresh" };
  if (state.state === "stale" && state.value) {
    void runOnce(key, () => compute(date, max, key)).catch(() => undefined);
    return { ...state.value, cacheState: "stale" };
  }
  const fresh = await runOnce(key, () => compute(date, max, key));
  return { ...fresh, cacheState: "miss" };
}

async function compute(date: string, max: number, key: string) {
  const raw = await dateFixtures(date);
  const upcoming = responseFixtures(raw)
    .filter((fixture) => NOT_STARTED.has(String(fixture?.fixture?.status?.short ?? "").toUpperCase()))
    .filter(allowed)
    .sort((a, b) => fixtureDate(a) - fixtureDate(b))
    .slice(0, 36);
  const picks: PrematchPickV2[] = [];

  // Piccoli gruppi evitano picchi di chiamate e mantengono il server reattivo.
  for (let index = 0; index < upcoming.length; index += 4) {
    const batch = upcoming.slice(index, index + 4);
    const evaluated = await Promise.all(batch.map((fixture) => evaluateFixture(fixture).catch(() => null)));
    picks.push(...evaluated.filter((pick): pick is PrematchPickV2 => pick != null));
  }
  picks.sort((a, b) => b.score - a.score);

  const perLeague = new Map<string, number>();
  const finalPicks: PrematchPickV2[] = [];
  for (const pick of picks) {
    const leagueKey = String(pick.league.id ?? pick.league.name ?? "unknown");
    const used = perLeague.get(leagueKey) ?? 0;
    if (used >= MAX_PICKS_PER_LEAGUE) continue;
    perLeague.set(leagueKey, used + 1);
    finalPicks.push(pick);
    if (finalPicks.length >= max) break;
  }

  const result = { picks: finalPicks, candidates: [] as never[] };
  setCache(key, result, isApiEcoMode() ? 6 * 3600 : 30 * 60, 6 * 3600);
  return result;
}

export const buildBrainPrematch = buildBrainPrematchV2;
export default buildBrainPrematchV2;
