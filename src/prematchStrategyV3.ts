import {
  evaluateStrategyV2,
  H2HStatsV2,
  LeagueBaselineV2,
  StrategyInputV2,
  TeamStatsV2,
} from "./prematchStrategyV2";

export type PrematchMarketV3 =
  | "GOAL"
  | "OVER 2.5"
  | "CASA OVER 1.5"
  | "OSPITE OVER 1.5"
  | "1"
  | "2"
  | "1X"
  | "X2"
  | "CORNER CASA"
  | "CORNER OSPITE"
  | "CORNER TOTALI";

export type CoreMarketV3 = Exclude<
  PrematchMarketV3,
  "CORNER CASA" | "CORNER OSPITE" | "CORNER TOTALI"
>;

export type CornerMarketV3 = Extract<
  PrematchMarketV3,
  "CORNER CASA" | "CORNER OSPITE" | "CORNER TOTALI"
>;

export type MarketOfferV3 = {
  bookmaker: string;
  bookmakerId?: number | null;
  odd: number;
  oppositeOdd?: number | null;
  fairProbability?: number | null;
  line?: number | null;
};

export type MarketPriceV3 = {
  bestOdd: number | null;
  referenceOdd: number | null;
  consensusProbability: number | null;
  bookmakerCount: number;
  offers: MarketOfferV3[];
  line?: number | null;
};

export type ResultProfileV3 = {
  matches: number;
  effectiveMatches: number;
  wins: number;
  draws: number;
  losses: number;
  pointsPerMatch: number;
  winRate: number;
  drawRate: number;
  lossRate: number;
  unbeatenRate: number;
  goalDifferencePerMatch: number;
};

export type CornerProfileV3 = {
  matches: number;
  effectiveMatches: number;
  averageFor: number;
  averageAgainst: number;
  varianceFor: number;
  varianceAgainst: number;
  samplesFor: number[];
  samplesAgainst: number[];
};

export type ScheduleContextV3 = {
  homeRestDays: number | null;
  awayRestDays: number | null;
  homeNextRestDays: number | null;
  awayNextRestDays: number | null;
  homeHasPriorityCupNext: boolean;
  awayHasPriorityCupNext: boolean;
  lineupsConfirmed: boolean;
  homeLineupStrength: number | null;
  awayLineupStrength: number | null;
};

export type StrategyInputV3 = Omit<StrategyInputV2, "markets"> & {
  homeResultVenue: ResultProfileV3;
  awayResultVenue: ResultProfileV3;
  homeResultRecent: ResultProfileV3;
  awayResultRecent: ResultProfileV3;
  homeCorners: CornerProfileV3;
  awayCorners: CornerProfileV3;
  schedule: ScheduleContextV3;
  markets: Record<CoreMarketV3, MarketPriceV3>;
  cornerMarkets: Record<CornerMarketV3, MarketPriceV3[]>;
};

export type StrategySelectionV3 = {
  market: PrematchMarketV3;
  label: string;
  line: number | null;
  modelProbability: number;
  marketProbability: number | null;
  finalProbability: number;
  fairOdd: number;
  bestOdd: number;
  expectedValue: number;
  dataQuality: number;
  score: number;
};

export type StrategyEvaluationV3 = {
  version: "brainlive-strategy-v3";
  lambdaHome: number;
  lambdaAway: number;
  expectedGoals: number;
  dataQuality: number;
  sampleMode: "current" | "mixed" | "early";
  probabilities: Record<CoreMarketV3, number>;
  selections: StrategySelectionV3[];
  selection: StrategySelectionV3 | null;
};

export const MIN_ODDS_V3: Record<PrematchMarketV3, number> = {
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
};

export function emptyResultProfileV3(): ResultProfileV3 {
  return {
    matches: 0,
    effectiveMatches: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    pointsPerMatch: 0,
    winRate: 0,
    drawRate: 0,
    lossRate: 0,
    unbeatenRate: 0,
    goalDifferencePerMatch: 0,
  };
}

export function emptyCornerProfileV3(): CornerProfileV3 {
  return {
    matches: 0,
    effectiveMatches: 0,
    averageFor: 0,
    averageAgainst: 0,
    varianceFor: 0,
    varianceAgainst: 0,
    samplesFor: [],
    samplesAgainst: [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function weightedRate(values: Array<[number, number]>): number {
  const valid = values.filter(([value, weight]) => Number.isFinite(value) && weight > 0);
  const denominator = valid.reduce((sum, [, weight]) => sum + weight, 0);
  if (!denominator) return 0;
  return valid.reduce((sum, [value, weight]) => sum + value * weight, 0) / denominator;
}

function factorial(value: number): number {
  let result = 1;
  for (let index = 2; index <= value; index += 1) result *= index;
  return result;
}

function poisson(value: number, lambda: number): number {
  return Math.exp(-lambda) * Math.pow(lambda, value) / factorial(value);
}

function scoreProbabilities(lambdaHome: number, lambdaAway: number) {
  let total = 0;
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let hg = 0; hg <= 10; hg += 1) {
    for (let ag = 0; ag <= 10; ag += 1) {
      const probability = poisson(hg, lambdaHome) * poisson(ag, lambdaAway);
      total += probability;
      if (hg > ag) home += probability;
      else if (hg === ag) draw += probability;
      else away += probability;
    }
  }
  const normalize = (value: number) => (total > 0 ? value / total : 0);
  return { home: normalize(home), draw: normalize(draw), away: normalize(away) };
}

function goalEvidenceProbability(
  market: "GOAL" | "OVER 2.5" | "CASA OVER 1.5" | "OSPITE OVER 1.5",
  poissonProbability: number,
  input: StrategyInputV3,
): number {
  const observedRate = (left: TeamStatsV2, right: TeamStatsV2, key: "bttsRate" | "over25Rate") => {
    const leftWeight = clamp((left.effectiveMatches ?? left.matches) / 5, 0, 1);
    const rightWeight = clamp((right.effectiveMatches ?? right.matches) / 5, 0, 1);
    return {
      rate: weightedRate([[left[key], leftWeight], [right[key], rightWeight]]),
      support: (leftWeight + rightWeight) / 2,
    };
  };
  if (market === "GOAL") {
    const recent = observedRate(input.homeRecent, input.awayRecent, "bttsRate");
    const structural = observedRate(input.homeOverall, input.awayOverall, "bttsRate");
    const venue = observedRate(input.homeVenue, input.awayVenue, "bttsRate");
    return clamp(weightedRate([
      [poissonProbability, 0.58],
      [recent.rate, 0.2 * recent.support],
      [structural.rate, 0.1 * structural.support],
      [venue.rate, 0.06 * venue.support],
      [input.h2h.bttsRate, input.h2h.matches >= 3 ? 0.06 : 0],
    ]), 0.03, 0.97);
  }
  if (market === "OVER 2.5") {
    const recent = observedRate(input.homeRecent, input.awayRecent, "over25Rate");
    const structural = observedRate(input.homeOverall, input.awayOverall, "over25Rate");
    const venue = observedRate(input.homeVenue, input.awayVenue, "over25Rate");
    return clamp(weightedRate([
      [poissonProbability, 0.56],
      [recent.rate, 0.22 * recent.support],
      [structural.rate, 0.1 * structural.support],
      [venue.rate, 0.05 * venue.support],
      [input.h2h.over25Rate, input.h2h.matches >= 3 ? 0.07 : 0],
    ]), 0.03, 0.97);
  }
  const isHome = market === "CASA OVER 1.5";
  const attackOverall = isHome ? input.homeOverall : input.awayOverall;
  const attackVenue = isHome ? input.homeVenue : input.awayVenue;
  const attackRecent = isHome ? input.homeRecent : input.awayRecent;
  const defenceOverall = isHome ? input.awayOverall : input.homeOverall;
  const evidence = weightedRate([
    [poissonProbability, 0.72],
    [attackRecent.scoredOver15Rate ?? poissonProbability, attackRecent.matches > 0 ? 0.1 : 0],
    [weightedRate([
      [attackOverall.scoredOver15Rate ?? poissonProbability, attackOverall.matches > 0 ? 1 : 0],
      [defenceOverall.concededOver15Rate ?? poissonProbability, defenceOverall.matches > 0 ? 1 : 0],
    ]), attackOverall.matches + defenceOverall.matches > 0 ? 0.1 : 0],
    [attackVenue.scoredOver15Rate ?? poissonProbability, attackVenue.matches > 0 ? 0.08 : 0],
  ]);
  return clamp(evidence, 0.02, 0.98);
}

function resultEvidenceProbability(
  market: "1" | "2" | "1X" | "X2",
  poissonProbability: number,
  input: StrategyInputV3,
): number {
  const homeSide = market === "1" || market === "1X";
  const protectedResult = market === "1X" || market === "X2";
  const sideVenue = homeSide ? input.homeResultVenue : input.awayResultVenue;
  const sideRecent = homeSide ? input.homeResultRecent : input.awayResultRecent;
  const opponentVenue = homeSide ? input.awayResultVenue : input.homeResultVenue;
  const venue = protectedResult ? sideVenue.unbeatenRate : sideVenue.winRate;
  const recent = protectedResult ? sideRecent.unbeatenRate : sideRecent.winRate;
  const opponentFailure = protectedResult
    ? 1 - opponentVenue.winRate
    : opponentVenue.lossRate;
  let result = weightedRate([
    [poissonProbability, 0.64],
    [venue, 0.17],
    [recent, 0.11],
    [opponentFailure, 0.08],
  ]);
  const protectedProfile = sideVenue;
  const opponentProfile = opponentVenue;
  if (protectedProfile.effectiveMatches >= 5 && opponentProfile.effectiveMatches >= 5) {
    result += clamp((protectedProfile.pointsPerMatch - opponentProfile.pointsPerMatch) * 0.012, -0.018, 0.018);
    result += clamp((protectedProfile.goalDifferencePerMatch - opponentProfile.goalDifferencePerMatch) * 0.006, -0.012, 0.012);
  }

  const relevantRest = homeSide
    ? input.schedule.awayNextRestDays
    : input.schedule.homeNextRestDays;
  const opponentCup = homeSide
    ? input.schedule.awayHasPriorityCupNext
    : input.schedule.homeHasPriorityCupNext;
  if (opponentCup && relevantRest != null && relevantRest <= 4) result += 0.012;

  // Le formazioni ufficiali arrivano troppo vicino al calcio d'inizio per
  // guidare una selezione pubblicata alle 10:00. Restano disponibili nel
  // payload informativo, ma non alterano il pronostico.
  return clamp(result, 0.03, 0.97);
}

function primaryDataQuality(baseQuality: number, market: PrematchMarketV3, input: StrategyInputV3) {
  if (["1", "2", "1X", "X2"].includes(market)) {
    const resultSample = Math.min(
      input.homeResultVenue.effectiveMatches,
      input.awayResultVenue.effectiveMatches,
    );
    return clamp(baseQuality * 0.72 + clamp(resultSample / 8, 0, 1) * 0.28, 0, 1);
  }
  return baseQuality;
}

function robustFinalProbability(
  modelProbability: number,
  marketProbability: number | null,
  quality: number,
): number {
  if (marketProbability == null) return modelProbability;
  const modelWeight = quality >= 0.8 ? 0.8 : quality >= 0.68 ? 0.74 : 0.68;
  return modelProbability * modelWeight + marketProbability * (1 - modelWeight);
}

function coreThreshold(market: CoreMarketV3): number {
  if (market === "GOAL") return 0.575;
  if (market === "OVER 2.5") return 0.58;
  if (market === "1" || market === "2") return 0.49;
  if (market === "1X" || market === "X2") return 0.55;
  return 0.535;
}

function addCoreSelection(
  selections: StrategySelectionV3[],
  market: CoreMarketV3,
  probability: number,
  price: MarketPriceV3,
  quality: number,
) {
  const referenceOdd = price.referenceOdd ?? price.bestOdd;
  if (referenceOdd == null || referenceOdd < MIN_ODDS_V3[market]) return;
  if (price.bookmakerCount < 2 || price.consensusProbability == null) return;
  const resultMarket = ["1", "2", "1X", "X2"].includes(market);
  if (quality < (resultMarket ? 0.72 : 0.5)) return;
  if (probability < coreThreshold(market)) return;
  if (Math.abs(probability - price.consensusProbability) > 0.16) return;
  const finalProbability = robustFinalProbability(
    probability,
    price.consensusProbability,
    quality,
  );
  const uncertainty = (1 - quality) * (resultMarket ? 0.09 : 0.065);
  const stableProbability = finalProbability - uncertainty;
  const expectedValue = finalProbability * referenceOdd - 1;
  const minimumEdge = resultMarket ? 0.035 : 0.015;
  if (stableProbability < coreThreshold(market) - 0.03) return;
  if (expectedValue < minimumEdge) return;
  selections.push({
    market,
    label: market,
    line: null,
    modelProbability: probability,
    marketProbability: price.consensusProbability,
    finalProbability,
    fairOdd: 1 / finalProbability,
    bestOdd: referenceOdd,
    expectedValue,
    dataQuality: quality,
    score: clamp(finalProbability * 72 + quality * 18 + expectedValue * 100 * 0.1, 0, 100),
  });
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function probabilityOverLine(mean: number, variance: number, line: number): number {
  const safeVariance = Math.max(mean * 1.05, variance, 1.5);
  const threshold = Math.floor(line) + 0.5;
  const z = (threshold - mean) / Math.sqrt(safeVariance);
  return clamp(1 - normalCdf(z), 0.01, 0.99);
}

function cornerProjection(
  market: CornerMarketV3,
  home: CornerProfileV3,
  away: CornerProfileV3,
): { mean: number; variance: number; sample: number } {
  if (market === "CORNER CASA") {
    return {
      mean: Math.sqrt(Math.max(0.5, home.averageFor) * Math.max(0.5, away.averageAgainst)),
      variance: (home.varianceFor + away.varianceAgainst) / 2,
      sample: Math.min(home.effectiveMatches, away.effectiveMatches),
    };
  }
  if (market === "CORNER OSPITE") {
    return {
      mean: Math.sqrt(Math.max(0.5, away.averageFor) * Math.max(0.5, home.averageAgainst)),
      variance: (away.varianceFor + home.varianceAgainst) / 2,
      sample: Math.min(away.effectiveMatches, home.effectiveMatches),
    };
  }
  const homeProjection = cornerProjection("CORNER CASA", home, away);
  const awayProjection = cornerProjection("CORNER OSPITE", home, away);
  return {
    mean: homeProjection.mean + awayProjection.mean,
    variance: homeProjection.variance + awayProjection.variance,
    sample: Math.min(homeProjection.sample, awayProjection.sample),
  };
}

function addCornerSelections(
  selections: StrategySelectionV3[],
  market: CornerMarketV3,
  prices: MarketPriceV3[],
  input: StrategyInputV3,
) {
  const projection = cornerProjection(market, input.homeCorners, input.awayCorners);
  const quality = clamp(projection.sample / 10, 0, 1);
  if (quality < 0.78) return;
  for (const price of prices) {
    const referenceOdd = price.referenceOdd ?? price.bestOdd;
    if (price.line == null || referenceOdd == null) continue;
    if (referenceOdd < MIN_ODDS_V3[market]) continue;
    if (price.bookmakerCount < 2 || price.consensusProbability == null) continue;
    const modelProbability = probabilityOverLine(projection.mean, projection.variance, price.line);
    if (modelProbability < 0.62) continue;
    if (Math.abs(modelProbability - price.consensusProbability) > 0.14) continue;
    const finalProbability = robustFinalProbability(modelProbability, price.consensusProbability, quality);
    const stableProbability = finalProbability - (1 - quality) * 0.09;
    const expectedValue = finalProbability * referenceOdd - 1;
    if (stableProbability < 0.58 || expectedValue < 0.04) continue;
    selections.push({
      market,
      label: `${market} OVER ${price.line.toFixed(1)}`,
      line: price.line,
      modelProbability,
      marketProbability: price.consensusProbability,
      finalProbability,
      fairOdd: 1 / finalProbability,
      bestOdd: referenceOdd,
      expectedValue,
      dataQuality: quality,
      score: clamp(finalProbability * 70 + quality * 20 + expectedValue * 10, 0, 100),
    });
  }
}

export function evaluateStrategyV3(input: StrategyInputV3): StrategyEvaluationV3 {
  const goalMarkets = {
    GOAL: input.markets.GOAL,
    "OVER 2.5": input.markets["OVER 2.5"],
    "CASA OVER 1.5": input.markets["CASA OVER 1.5"],
    "OSPITE OVER 1.5": input.markets["OSPITE OVER 1.5"],
  };
  const base = evaluateStrategyV2({
    ...input,
    markets: goalMarkets,
  });
  const resultProbabilities = scoreProbabilities(base.lambdaHome, base.lambdaAway);
  const probabilities: Record<CoreMarketV3, number> = {
    GOAL: goalEvidenceProbability("GOAL", base.probabilities.GOAL, input),
    "OVER 2.5": goalEvidenceProbability("OVER 2.5", base.probabilities["OVER 2.5"], input),
    "CASA OVER 1.5": goalEvidenceProbability("CASA OVER 1.5", base.probabilities["CASA OVER 1.5"], input),
    "OSPITE OVER 1.5": goalEvidenceProbability("OSPITE OVER 1.5", base.probabilities["OSPITE OVER 1.5"], input),
    "1": resultEvidenceProbability("1", resultProbabilities.home, input),
    "2": resultEvidenceProbability("2", resultProbabilities.away, input),
    "1X": resultEvidenceProbability("1X", resultProbabilities.home + resultProbabilities.draw, input),
    X2: resultEvidenceProbability("X2", resultProbabilities.away + resultProbabilities.draw, input),
  };

  const selections: StrategySelectionV3[] = [];
  for (const market of Object.keys(probabilities) as CoreMarketV3[]) {
    addCoreSelection(
      selections,
      market,
      probabilities[market],
      input.markets[market],
      primaryDataQuality(base.dataQuality, market, input),
    );
  }
  addCornerSelections(selections, "CORNER CASA", input.cornerMarkets["CORNER CASA"], input);
  addCornerSelections(selections, "CORNER OSPITE", input.cornerMarkets["CORNER OSPITE"], input);
  addCornerSelections(selections, "CORNER TOTALI", input.cornerMarkets["CORNER TOTALI"], input);

  selections.sort((left, right) => {
    const leftRank = left.score * 0.76 + left.expectedValue * 100 * 0.24;
    const rightRank = right.score * 0.76 + right.expectedValue * 100 * 0.24;
    return rightRank - leftRank;
  });

  return {
    version: "brainlive-strategy-v3",
    lambdaHome: base.lambdaHome,
    lambdaAway: base.lambdaAway,
    expectedGoals: base.expectedGoals,
    dataQuality: base.dataQuality,
    sampleMode: base.sampleMode,
    probabilities,
    selections,
    selection: selections[0] ?? null,
  };
}

export type {
  H2HStatsV2,
  LeagueBaselineV2,
  TeamStatsV2,
};
