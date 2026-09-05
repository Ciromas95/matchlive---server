import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyTeamStatsV2,
  evaluateStrategyV2,
  marketProbabilitiesV2,
  MarketPriceV2,
  PrematchMarket,
  shrunkAverageV2,
  TeamStatsV2,
} from "../src/prematchStrategyV2";
import {
  buildTeamStatsV2,
  extractOddsSnapshotV2,
} from "../src/brainPrematchV2";

function stats(matches: number, gf: number, ga: number): TeamStatsV2 {
  if (!matches) return emptyTeamStatsV2();
  return {
    matches,
    goalsFor: gf * matches,
    goalsAgainst: ga * matches,
    avgGoalsFor: gf,
    avgGoalsAgainst: ga,
    avgTotalGoals: gf + ga,
    bttsRate: 0.68,
    over25Rate: 0.66,
    scoredRate: 0.86,
    concededRate: 0.78,
    failedToScoreRate: 0.14,
    cleanSheetRate: 0.22,
  };
}

function markets(odd: number): Record<PrematchMarket, MarketPriceV2> {
  const price = (): MarketPriceV2 => ({
    bestOdd: odd,
    consensusProbability: 0.56,
    offers: [{ bookmaker: "Test", odd, oppositeOdd: 1.9, fairProbability: 0.56 }],
  });
  return {
    GOAL: price(),
    "OVER 2.5": price(),
    "CASA OVER 1.5": price(),
    "OSPITE OVER 1.5": price(),
  };
}

test("le probabilità crescono quando aumentano i gol attesi", () => {
  const low = marketProbabilitiesV2(0.8, 0.7);
  const high = marketProbabilitiesV2(1.8, 1.5);
  assert.ok(high.GOAL > low.GOAL);
  assert.ok(high["OVER 2.5"] > low["OVER 2.5"]);
  assert.ok(high["CASA OVER 1.5"] > low["CASA OVER 1.5"]);
  assert.ok(high["OSPITE OVER 1.5"] > low["OSPITE OVER 1.5"]);
});

test("lo shrinkage iniziale non copia la media precedente né quella corrente", () => {
  const value = shrunkAverageV2(3.5, 1, 1.4, 1.8, 20, 5);
  assert.ok(value > 1.4);
  assert.ok(value < 3.5);
});

test("quota inferiore a 1.50 non produce alcun pronostico", () => {
  const strong = stats(12, 1.9, 1.35);
  const evaluation = evaluateStrategyV2({
    contextType: "league",
    homeOverall: strong,
    awayOverall: strong,
    homeVenue: strong,
    awayVenue: strong,
    homeRecent: stats(5, 2, 1.4),
    awayRecent: stats(5, 1.8, 1.5),
    homeRecentVenue: stats(5, 2, 1.4),
    awayRecentVenue: stats(5, 1.8, 1.5),
    previousHomeOverall: strong,
    previousAwayOverall: strong,
    previousHomeVenue: strong,
    previousAwayVenue: strong,
    h2h: { matches: 6, homeGoals: 10, awayGoals: 8, avgTotalGoals: 3, bttsRate: 0.67, over25Rate: 0.67 },
    league: { matches: 100, homeGoals: 1.5, awayGoals: 1.2, totalGoals: 2.7 },
    markets: markets(1.49),
  });
  assert.equal(evaluation.selection, null);
});

test("il motore restituisce esclusivamente uno dei quattro mercati consentiti", () => {
  const strong = stats(14, 2.05, 1.4);
  const evaluation = evaluateStrategyV2({
    contextType: "league",
    homeOverall: strong,
    awayOverall: stats(14, 1.85, 1.5),
    homeVenue: stats(7, 2.2, 1.3),
    awayVenue: stats(7, 1.8, 1.6),
    homeRecent: stats(5, 2.2, 1.5),
    awayRecent: stats(5, 2, 1.6),
    homeRecentVenue: stats(4, 2.25, 1.5),
    awayRecentVenue: stats(4, 2, 1.5),
    previousHomeOverall: strong,
    previousAwayOverall: strong,
    previousHomeVenue: strong,
    previousAwayVenue: strong,
    h2h: { matches: 7, homeGoals: 12, awayGoals: 10, avgTotalGoals: 22 / 7, bttsRate: 0.71, over25Rate: 0.71 },
    league: { matches: 120, homeGoals: 1.5, awayGoals: 1.22, totalGoals: 2.72 },
    markets: markets(1.8),
  });
  assert.ok(evaluation.selection);
  assert.ok([
    "GOAL",
    "OVER 2.5",
    "CASA OVER 1.5",
    "OSPITE OVER 1.5",
  ].includes(evaluation.selection!.market));
});

test("totale e rendimento in casa restano campioni realmente distinti", () => {
  const fixture = (id: number, homeId: number, awayId: number, home: number, away: number) => ({
    fixture: { id, date: `2026-08-${20 + id}T18:00:00Z`, status: { short: "FT" } },
    league: { name: "Serie A" },
    teams: { home: { id: homeId }, away: { id: awayId } },
    goals: { home, away },
  });
  const raw = {
    response: [
      fixture(1, 10, 20, 3, 1),
      fixture(2, 30, 10, 2, 0),
      fixture(3, 10, 40, 2, 0),
    ],
  };
  const overall = buildTeamStatsV2(raw, 10);
  const home = buildTeamStatsV2(raw, 10, "home");
  assert.equal(overall.matches, 3);
  assert.equal(home.matches, 2);
  assert.notEqual(overall.avgGoalsFor, home.avgGoalsFor);
});

test("le quote sono abbinate al bookmaker e includono i quattro mercati", () => {
  const values = (over: string, under: string) => [
    { value: over, odd: "1.80" },
    { value: under, odd: "2.00" },
  ];
  const raw = {
    fetchedAt: "2026-08-30T10:00:00Z",
    payload: {
      response: [{
        update: "2026-08-30T09:58:00Z",
        bookmakers: [{
          name: "Book A",
          bets: [
            { name: "Both Teams Score", values: [{ value: "Yes", odd: "1.75" }, { value: "No", odd: "2.05" }] },
            { name: "Goals Over/Under", values: values("Over 2.5", "Under 2.5") },
            { name: "Total - Home", values: values("Over 1.5", "Under 1.5") },
            { name: "Total - Away", values: values("Over 1.5", "Under 1.5") },
          ],
        }],
      }],
    },
  };
  const snapshot = extractOddsSnapshotV2(raw);
  assert.equal(snapshot.fetchedAt, "2026-08-30T10:00:00Z");
  assert.equal(snapshot.markets.GOAL.bestOdd, 1.75);
  assert.equal(snapshot.markets["OVER 2.5"].bestOdd, 1.8);
  assert.equal(snapshot.markets["CASA OVER 1.5"].bestOdd, 1.8);
  assert.equal(snapshot.markets["OSPITE OVER 1.5"].bestOdd, 1.8);
  assert.equal(snapshot.markets.GOAL.offers[0].bookmaker, "Book A");
  assert.ok(snapshot.markets.GOAL.consensusProbability);
});
