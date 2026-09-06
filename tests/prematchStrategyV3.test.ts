import assert from "node:assert/strict";
import test from "node:test";
import {
  extractOddsSnapshotV3,
  robustReferenceOdd,
  isUpcomingPrematchV3,
  buildWeightedRecentStatsV3,
  mergePublishedPrematchResults,
} from "../src/brainPrematchV3";
import {
  CoreMarketV3,
  CornerMarketV3,
  emptyCornerProfileV3,
  evaluateStrategyV3,
  MarketPriceV3,
  MIN_ODDS_V3,
  ResultProfileV3,
} from "../src/prematchStrategyV3";
import { isPrematchPublicationOpenV3 } from "../src/brainPrematchV3";
import { emptyTeamStatsV2, TeamStatsV2 } from "../src/prematchStrategyV2";

function team(matches: number, gf: number, ga: number, btts = 0.7, over = 0.7): TeamStatsV2 {
  if (!matches) return emptyTeamStatsV2();
  return {
    matches,
    goalsFor: gf * matches,
    goalsAgainst: ga * matches,
    avgGoalsFor: gf,
    avgGoalsAgainst: ga,
    avgTotalGoals: gf + ga,
    bttsRate: btts,
    over25Rate: over,
    scoredRate: 0.9,
    concededRate: 0.78,
    failedToScoreRate: 0.1,
    cleanSheetRate: 0.22,
  };
}

function resultProfile(): ResultProfileV3 {
  return {
    matches: 10,
    effectiveMatches: 10,
    wins: 5,
    draws: 3,
    losses: 2,
    pointsPerMatch: 1.8,
    winRate: 0.5,
    drawRate: 0.3,
    lossRate: 0.2,
    unbeatenRate: 0.8,
    goalDifferencePerMatch: 0.7,
  };
}

function price(odd: number, probability = 0.56): MarketPriceV3 {
  return {
    bestOdd: odd,
    referenceOdd: odd - 0.02,
    consensusProbability: probability,
    bookmakerCount: 3,
    offers: [
      { bookmaker: "A", odd, oppositeOdd: 2.1, fairProbability: probability },
      { bookmaker: "B", odd: odd - 0.02, oppositeOdd: 2.08, fairProbability: probability },
      { bookmaker: "C", odd: odd - 0.04, oppositeOdd: 2.05, fairProbability: probability },
    ],
  };
}

function prices(odd = 1.7): Record<CoreMarketV3, MarketPriceV3> {
  return {
    GOAL: price(odd, 0.58),
    "OVER 2.5": price(odd, 0.58),
    "CASA OVER 1.5": price(odd, 0.56),
    "OSPITE OVER 1.5": price(odd, 0.56),
    "1": price(1.72, 0.57),
    "2": price(1.72, 0.57),
    "1X": price(1.78, 0.58),
    X2: price(1.78, 0.58),
  };
}

const noCorners: Record<CornerMarketV3, MarketPriceV3[]> = {
  "CORNER CASA": [],
  "CORNER OSPITE": [],
  "CORNER TOTALI": [],
};

test("prematch: al calcio d'inizio la card non è più visibile, anche dalla cache", () => {
  const kickoff = Date.parse("2026-08-30T18:45:00Z");
  assert.equal(isUpcomingPrematchV3("2026-08-30T18:45:00Z", kickoff - 1), true);
  assert.equal(isUpcomingPrematchV3("2026-08-30T18:45:00Z", kickoff), false);
  assert.equal(isUpcomingPrematchV3("2026-08-30T18:45:00Z", kickoff + 1), false);
  assert.equal(isUpcomingPrematchV3(null, kickoff), false);
});

test("prematch: le pubblicazioni giornaliere aprono alle 10:00 italiane", () => {
  assert.equal(
    isPrematchPublicationOpenV3("2026-09-02", new Date("2026-09-02T07:59:00Z")),
    false,
  );
  assert.equal(
    isPrematchPublicationOpenV3("2026-09-02", new Date("2026-09-02T08:00:00Z")),
    true,
  );
});

test("la forma recente include le amichevoli con peso ridotto e non usa partite future", () => {
  const fixture = (id: number, date: string, friendly: boolean, goals: number) => ({
    fixture: { id, date, status: { short: "FT" } },
    league: { name: friendly ? "Friendlies Clubs" : "Premier League" },
    teams: { home: { id: 1 }, away: { id: 2 } }, goals: { home: goals, away: 1 },
  });
  const stats = buildWeightedRecentStatsV3({ response: [
    fixture(1, "2026-08-29T10:00:00Z", true, 4),
    fixture(2, "2026-08-28T10:00:00Z", false, 1),
    fixture(3, "2026-09-01T10:00:00Z", false, 9),
  ] }, 1, Date.parse("2026-08-30T10:00:00Z"));
  assert.equal(stats.matches, 2);
  assert.ok(stats.avgGoalsFor > 1 && stats.avgGoalsFor < 2.5);
  assert.ok((stats.scoredOver15Rate ?? 0) > 0);
});

test("i corner mantengono separati squadra, linea e quote del mercato", () => {
  const bets = [
    { id: 57, values: [{ value: "Over 7.5", odd: "1.80" }, { value: "Under 7.5", odd: "2.00" }] },
    { id: 58, values: [{ value: "Over 3.5", odd: "1.70" }, { value: "Under 3.5", odd: "2.10" }] },
    { id: 45, values: [{ value: "Over 10.5", odd: "1.90" }, { value: "Under 10.5", odd: "1.90" }] },
  ];
  const snapshot = extractOddsSnapshotV3({ response: [{ bookmakers: [
    { id: 1, name: "A", bets }, { id: 2, name: "B", bets },
  ] }] });
  assert.equal(snapshot.cornerMarkets["CORNER CASA"][0].line, 7.5);
  assert.equal(snapshot.cornerMarkets["CORNER OSPITE"][0].line, 3.5);
  assert.equal(snapshot.cornerMarkets["CORNER TOTALI"][0].line, 10.5);
});

test("1X e X2 vengono entrambi estratti dalla doppia chance con probabilità coerenti", () => {
  const snapshot = extractOddsSnapshotV3({ response: [{ bookmakers: [{ id: 1, name: "A", bets: [
    { id: 1, values: [{ value: "Home", odd: "2.50" }, { value: "Draw", odd: "3.20" }, { value: "Away", odd: "2.80" }] },
    { id: 12, values: [{ value: "Home/Draw", odd: "1.70" }, { value: "Draw/Away", odd: "1.80" }] },
  ] }] }] });
  assert.equal(snapshot.markets["1X"].bestOdd, 1.7);
  assert.equal(snapshot.markets.X2.bestOdd, 1.8);
  assert.ok((snapshot.markets.X2.consensusProbability ?? 0) > 0.5);
});

test("1 e 2 vengono estratti dal mercato 1X2 usando la quota media robusta", () => {
  const bookmaker = (name: string, home: string, away: string) => ({
    name,
    bets: [{ id: 1, values: [
      { value: "Home", odd: home },
      { value: "Draw", odd: "3.40" },
      { value: "Away", odd: away },
    ] }],
  });
  const snapshot = extractOddsSnapshotV3({ response: [{ bookmakers: [
    bookmaker("A", "1.52", "5.80"),
    bookmaker("B", "1.50", "5.90"),
    bookmaker("C", "1.48", "6.00"),
  ] }] });
  assert.equal(snapshot.markets["1"].bookmakerCount, 3);
  assert.equal(snapshot.markets["1"].referenceOdd, 1.5);
  assert.equal(snapshot.markets["2"].bookmakerCount, 3);
});

test("la quota gol ospite non può essere contaminata dal mercato fuorigioco ospite", () => {
  const bookmaker = (name: string, correctOdd: string, offsidesOdd: string) => ({
    id: name === "A" ? 1 : 2,
    name,
    bets: [
      { id: 17, name: "Total - Away", values: [
        { value: "Over 1.5", odd: correctOdd },
        { value: "Under 1.5", odd: "3.50" },
      ] },
      { id: 168, name: "Offsides Away Total", values: [
        { value: "Over 1.5", odd: offsidesOdd },
        { value: "Under 1.5", odd: "1.35" },
      ] },
    ],
  });
  const snapshot = extractOddsSnapshotV3({
    fetchedAt: "2026-08-30T10:00:00Z",
    payload: { response: [{ bookmakers: [bookmaker("A", "1.28", "2.98"), bookmaker("B", "1.30", "3.00")] }] },
  });
  assert.equal(snapshot.markets["OSPITE OVER 1.5"].bestOdd, 1.3);
  assert.ok(snapshot.markets["OSPITE OVER 1.5"].offers.every((offer) => offer.odd < 1.5));
});

test("il parser accetta soltanto gli ID esatti dei nove mercati", () => {
  const snapshot = extractOddsSnapshotV3({ payload: { response: [{ bookmakers: [{
    id: 1,
    name: "A",
    bets: [
      { id: 999, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "4.00" }, { value: "Under 2.5", odd: "1.20" }] },
      { id: 5, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "1.75" }, { value: "Under 2.5", odd: "2.05" }] },
    ],
  }] }] } });
  assert.equal(snapshot.markets["OVER 2.5"].bestOdd, 1.75);
});

test("le soglie minime V3 corrispondono ai mercati approvati", () => {
  assert.deepEqual(MIN_ODDS_V3, {
    GOAL: 1.47,
    "OVER 2.5": 1.47,
    "CASA OVER 1.5": 1.47,
    "OSPITE OVER 1.5": 1.47,
    "1": 1.47,
    "2": 1.47,
    "1X": 1.47,
    X2: 1.47,
    "CORNER CASA": 1.47,
    "CORNER OSPITE": 1.47,
    "CORNER TOTALI": 1.47,
  });
});

test("la quota di riferimento scarta gli estremi anomali", () => {
  assert.equal(robustReferenceOdd([1.2, 1.48, 1.50, 1.52, 4.8]), 1.5);
});

test("un profilo tipo Chelsea-Brighton non viene scartato solo per la forma recente", () => {
  const strong = team(14, 1.95, 1.35, 0.69, 0.72);
  const recentHome = team(5, 2.8, 1.2, 0.8, 1);
  const recentAway = team(5, 2.4, 1.4, 0.6, 0.8);
  const evaluation = evaluateStrategyV3({
    contextType: "league",
    homeOverall: strong,
    awayOverall: team(14, 1.8, 1.55, 0.68, 0.7),
    homeVenue: team(7, 2.1, 1.2, 0.7, 0.75),
    awayVenue: team(7, 1.75, 1.65, 0.7, 0.72),
    homeRecent: recentHome,
    awayRecent: recentAway,
    homeRecentVenue: recentHome,
    awayRecentVenue: recentAway,
    previousHomeOverall: strong,
    previousAwayOverall: strong,
    previousHomeVenue: strong,
    previousAwayVenue: strong,
    h2h: { matches: 5, homeGoals: 13, awayGoals: 6, avgTotalGoals: 3.8, bttsRate: 0.6, over25Rate: 0.8 },
    league: { matches: 110, homeGoals: 1.55, awayGoals: 1.28, totalGoals: 2.83 },
    homeResultVenue: resultProfile(),
    awayResultVenue: resultProfile(),
    homeResultRecent: resultProfile(),
    awayResultRecent: resultProfile(),
    homeCorners: emptyCornerProfileV3(),
    awayCorners: emptyCornerProfileV3(),
    schedule: {
      homeRestDays: 6, awayRestDays: 6, homeNextRestDays: 7, awayNextRestDays: 7,
      homeHasPriorityCupNext: false, awayHasPriorityCupNext: false,
      lineupsConfirmed: false, homeLineupStrength: null, awayLineupStrength: null,
    },
    markets: prices(1.7),
    cornerMarkets: noCorners,
  });
  assert.ok(evaluation.selections.some((selection) => selection.market === "OVER 2.5"));
});

test("dopo le 10 lo snapshot resta atomico e non aggiunge card tardive", () => {
  const original = {
    fixtureId: 1,
    date: "2099-09-06T15:00:00+02:00",
    recommendedBet: "GOAL",
    odds: { selectedOdd: 1.62 },
  } as any;
  const recalculated = {
    ...original,
    recommendedBet: "OVER 2.5",
    odds: { selectedOdd: 1.55 },
  } as any;
  const addition = {
    fixtureId: 2,
    date: "2099-09-06T18:00:00+02:00",
    recommendedBet: "1X",
  } as any;
  const merged = mergePublishedPrematchResults(
    { picks: [original], candidates: [] },
    { picks: [recalculated, addition], candidates: [] },
  );
  assert.equal(merged.picks.length, 1);
  assert.equal(merged.picks[0].recommendedBet, "GOAL");
  assert.deepEqual(merged.picks[0].odds, { selectedOdd: 1.62 });
});
