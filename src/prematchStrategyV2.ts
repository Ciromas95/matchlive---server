export type PrematchMarket =
  | "GOAL"
  | "OVER 2.5"
  | "CASA OVER 1.5"
  | "OSPITE OVER 1.5";

export type TeamStatsV2 = {
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
  scoredOver15Rate?: number;
  concededOver15Rate?: number;
  effectiveMatches?: number;
};

export type H2HStatsV2 = {
  matches: number;
  homeGoals: number;
  awayGoals: number;
  avgTotalGoals: number;
  bttsRate: number;
  over25Rate: number;
};

export type LeagueBaselineV2 = {
  matches: number;
  homeGoals: number;
  awayGoals: number;
  totalGoals: number;
};

export type MarketOfferV2 = {
  bookmaker: string;
  odd: number;
  oppositeOdd?: number | null;
  fairProbability?: number | null;
};

export type MarketPriceV2 = {
  bestOdd: number | null;
  consensusProbability: number | null;
  offers: MarketOfferV2[];
};

export type StrategyInputV2 = {
  contextType: "league" | "cup";
  homeOverall: TeamStatsV2;
  awayOverall: TeamStatsV2;
  homeVenue: TeamStatsV2;
  awayVenue: TeamStatsV2;
  homeRecent: TeamStatsV2;
  awayRecent: TeamStatsV2;
  homeRecentVenue: TeamStatsV2;
  awayRecentVenue: TeamStatsV2;
  previousHomeOverall: TeamStatsV2;
  previousAwayOverall: TeamStatsV2;
  previousHomeVenue: TeamStatsV2;
  previousAwayVenue: TeamStatsV2;
  h2h: H2HStatsV2;
  league: LeagueBaselineV2;
  markets: Record<PrematchMarket, MarketPriceV2>;
};

export type StrategySelectionV2 = {
  market: PrematchMarket;
  modelProbability: number;
  marketProbability: number | null;
  finalProbability: number;
  fairOdd: number;
  bestOdd: number;
  expectedValue: number;
  score: number;
};

export type StrategyEvaluationV2 = {
  version: "brainlive-strategy-v2";
  lambdaHome: number;
  lambdaAway: number;
  expectedGoals: number;
  dataQuality: number;
  sampleMode: "current" | "mixed" | "early";
  probabilities: Record<PrematchMarket, number>;
  selection: StrategySelectionV2 | null;
};

export const MIN_RECOMMENDED_ODD_V2 = 1.5;

export function emptyTeamStatsV2(): TeamStatsV2 {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeLeague(input: LeagueBaselineV2): LeagueBaselineV2 {
  if (input.matches > 0 && input.homeGoals > 0 && input.awayGoals > 0) {
    return input;
  }
  return { matches: 0, homeGoals: 1.45, awayGoals: 1.15, totalGoals: 2.6 };
}

/**
 * Media con shrinkage: i dati reali restano distinti, mentre la proiezione
 * usa campionato e stagione precedente come prior solo quando il campione è piccolo.
 */
export function shrunkAverageV2(
  currentAverage: number,
  currentMatches: number,
  leaguePrior: number,
  previousAverage: number,
  previousMatches: number,
  priorStrength = 5,
): number {
  const n = Math.max(0, currentMatches);
  const previousPseudo =
    // La stagione precedente è soltanto un debole orientamento nelle prime
    // giornate: non deve mai prevalere su campionato, mercato o forma attuale.
    previousMatches > 0 ? clamp((6 - n) * 0.25, 0, 1.5) : 0;
  const previousValue = previousAverage > 0 ? previousAverage : leaguePrior;
  const currentValue = currentAverage >= 0 ? currentAverage : leaguePrior;
  const numerator =
    currentValue * n +
    previousValue * previousPseudo +
    leaguePrior * priorStrength;
  const denominator = n + previousPseudo + priorStrength;
  return denominator > 0 ? numerator / denominator : leaguePrior;
}

function projectionForSide(args: {
  leagueBase: number;
  attackOverall: TeamStatsV2;
  attackVenue: TeamStatsV2;
  attackRecent: TeamStatsV2;
  attackRecentVenue: TeamStatsV2;
  previousAttackOverall: TeamStatsV2;
  previousAttackVenue: TeamStatsV2;
  defenceOverall: TeamStatsV2;
  defenceVenue: TeamStatsV2;
  defenceRecent: TeamStatsV2;
  defenceRecentVenue: TeamStatsV2;
  previousDefenceOverall: TeamStatsV2;
  previousDefenceVenue: TeamStatsV2;
}): number {
  const leagueTeamAverage = args.leagueBase;
  const attackOverall = shrunkAverageV2(
    args.attackOverall.avgGoalsFor,
    args.attackOverall.matches,
    leagueTeamAverage,
    args.previousAttackOverall.avgGoalsFor,
    args.previousAttackOverall.matches,
    6,
  );
  const attackVenue = shrunkAverageV2(
    args.attackVenue.avgGoalsFor,
    args.attackVenue.matches,
    leagueTeamAverage,
    args.previousAttackVenue.avgGoalsFor,
    args.previousAttackVenue.matches,
    5,
  );
  const defenceOverall = shrunkAverageV2(
    args.defenceOverall.avgGoalsAgainst,
    args.defenceOverall.matches,
    leagueTeamAverage,
    args.previousDefenceOverall.avgGoalsAgainst,
    args.previousDefenceOverall.matches,
    6,
  );
  const defenceVenue = shrunkAverageV2(
    args.defenceVenue.avgGoalsAgainst,
    args.defenceVenue.matches,
    leagueTeamAverage,
    args.previousDefenceVenue.avgGoalsAgainst,
    args.previousDefenceVenue.matches,
    5,
  );

  const structuralAttack = attackVenue * 0.62 + attackOverall * 0.38;
  const structuralDefence = defenceVenue * 0.62 + defenceOverall * 0.38;
  let projected = Math.sqrt(
    Math.max(0.05, structuralAttack) * Math.max(0.05, structuralDefence),
  );

  const recentAttack = args.attackRecentVenue.matches >= 2
    ? args.attackRecentVenue.avgGoalsFor * 0.58 + args.attackRecent.avgGoalsFor * 0.42
    : args.attackRecent.avgGoalsFor;
  const recentDefence = args.defenceRecentVenue.matches >= 2
    ? args.defenceRecentVenue.avgGoalsAgainst * 0.58 + args.defenceRecent.avgGoalsAgainst * 0.42
    : args.defenceRecent.avgGoalsAgainst;
  if (args.attackRecent.matches >= 3 && args.defenceRecent.matches >= 3) {
    const recentSignal = (recentAttack + recentDefence) / 2;
    const multiplier = clamp(recentSignal / Math.max(0.5, projected), 0.82, 1.18);
    projected *= 0.84 + multiplier * 0.16;
  }

  return clamp(projected, 0.2, 3.6);
}

function poisson(k: number, lambda: number): number {
  let factorial = 1;
  for (let i = 2; i <= k; i += 1) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function dixonColesTau(home: number, away: number, lh: number, la: number): number {
  // Correzione prudente per la dipendenza dei punteggi bassi.
  const rho = -0.06;
  if (home === 0 && away === 0) return 1 - lh * la * rho;
  if (home === 0 && away === 1) return 1 + lh * rho;
  if (home === 1 && away === 0) return 1 + la * rho;
  if (home === 1 && away === 1) return 1 - rho;
  return 1;
}

export function marketProbabilitiesV2(
  lambdaHome: number,
  lambdaAway: number,
): Record<PrematchMarket, number> {
  let total = 0;
  let goal = 0;
  let over25 = 0;
  let homeOver15 = 0;
  let awayOver15 = 0;

  for (let home = 0; home <= 10; home += 1) {
    for (let away = 0; away <= 10; away += 1) {
      const p =
        poisson(home, lambdaHome) *
        poisson(away, lambdaAway) *
        dixonColesTau(home, away, lambdaHome, lambdaAway);
      total += p;
      if (home > 0 && away > 0) goal += p;
      if (home + away >= 3) over25 += p;
      if (home >= 2) homeOver15 += p;
      if (away >= 2) awayOver15 += p;
    }
  }

  const normalize = (value: number) => clamp(total > 0 ? value / total : 0, 0, 1);
  return {
    GOAL: normalize(goal),
    "OVER 2.5": normalize(over25),
    "CASA OVER 1.5": normalize(homeOver15),
    "OSPITE OVER 1.5": normalize(awayOver15),
  };
}

function dataQualityV2(input: StrategyInputV2): number {
  const overall = clamp(
    Math.min(input.homeOverall.matches, input.awayOverall.matches) / 10,
    0,
    1,
  );
  const venue = clamp(
    Math.min(input.homeVenue.matches, input.awayVenue.matches) / 6,
    0,
    1,
  );
  const recent = clamp(
    Math.min(input.homeRecent.matches, input.awayRecent.matches) / 5,
    0,
    1,
  );
  const previous = clamp(
    Math.min(input.previousHomeOverall.matches, input.previousAwayOverall.matches) / 10,
    0,
    1,
  );
  const marketCoverage = Object.values(input.markets).some(
    (market) => market.consensusProbability != null,
  )
    ? 1
    : 0.45;
  const h2h = clamp(input.h2h.matches / 6, 0, 1);
  const earlySupport = overall < 0.4 ? previous * 0.12 : 0;
  return clamp(
    0.18 + overall * 0.28 + venue * 0.23 + recent * 0.16 +
      marketCoverage * 0.08 + h2h * 0.03 + earlySupport,
    0,
    1,
  );
}

function probabilityThreshold(market: PrematchMarket): number {
  if (market === "GOAL") return 0.56;
  if (market === "OVER 2.5") return 0.57;
  return 0.53;
}

export function evaluateStrategyV2(input: StrategyInputV2): StrategyEvaluationV2 {
  const league = safeLeague(input.league);
  let lambdaHome = projectionForSide({
    leagueBase: league.homeGoals,
    attackOverall: input.homeOverall,
    attackVenue: input.homeVenue,
    attackRecent: input.homeRecent,
    attackRecentVenue: input.homeRecentVenue,
    previousAttackOverall: input.previousHomeOverall,
    previousAttackVenue: input.previousHomeVenue,
    defenceOverall: input.awayOverall,
    defenceVenue: input.awayVenue,
    defenceRecent: input.awayRecent,
    defenceRecentVenue: input.awayRecentVenue,
    previousDefenceOverall: input.previousAwayOverall,
    previousDefenceVenue: input.previousAwayVenue,
  });
  let lambdaAway = projectionForSide({
    leagueBase: league.awayGoals,
    attackOverall: input.awayOverall,
    attackVenue: input.awayVenue,
    attackRecent: input.awayRecent,
    attackRecentVenue: input.awayRecentVenue,
    previousAttackOverall: input.previousAwayOverall,
    previousAttackVenue: input.previousAwayVenue,
    defenceOverall: input.homeOverall,
    defenceVenue: input.homeVenue,
    defenceRecent: input.homeRecent,
    defenceRecentVenue: input.homeRecentVenue,
    previousDefenceOverall: input.previousHomeOverall,
    previousDefenceVenue: input.previousHomeVenue,
  });

  // Gli H2H sono solo una conferma recente e non possono muovere la stima oltre il 3%.
  if (input.h2h.matches >= 3) {
    const h2hExpected = input.h2h.avgTotalGoals;
    const currentExpected = lambdaHome + lambdaAway;
    const multiplier = clamp(h2hExpected / Math.max(1.2, currentExpected), 0.97, 1.03);
    lambdaHome *= multiplier;
    lambdaAway *= multiplier;
  }
  if (input.contextType === "cup") {
    lambdaHome *= 0.99;
    lambdaAway *= 0.99;
  }

  lambdaHome = clamp(lambdaHome, 0.2, 3.6);
  lambdaAway = clamp(lambdaAway, 0.2, 3.6);
  const probabilities = marketProbabilitiesV2(lambdaHome, lambdaAway);
  const quality = dataQualityV2(input);
  const sampleMode =
    Math.min(input.homeOverall.matches, input.awayOverall.matches) <= 3
      ? "early"
      : Math.min(input.homeOverall.matches, input.awayOverall.matches) < 8
        ? "mixed"
        : "current";

  const candidates: StrategySelectionV2[] = [];
  for (const market of Object.keys(probabilities) as PrematchMarket[]) {
    const price = input.markets[market];
    if (price.bestOdd == null || price.bestOdd < MIN_RECOMMENDED_ODD_V2) continue;
    const modelProbability = probabilities[market];
    const marketProbability = price.consensusProbability;
    const modelWeight = quality >= 0.75 ? 0.78 : quality >= 0.58 ? 0.7 : 0.62;
    const finalProbability = marketProbability == null
      ? modelProbability
      : modelProbability * modelWeight + marketProbability * (1 - modelWeight);
    const expectedValue = finalProbability * price.bestOdd - 1;
    const uncertainty = (1 - quality) * 0.075;
    const stableProbability = finalProbability - uncertainty;
    const threshold = probabilityThreshold(market);

    if (quality < 0.48) continue;
    if (modelProbability < threshold - 0.015) continue;
    if (stableProbability < threshold - 0.035) continue;
    if (expectedValue < 0) continue;

    candidates.push({
      market,
      modelProbability,
      marketProbability,
      finalProbability,
      fairOdd: 1 / Math.max(0.01, finalProbability),
      bestOdd: price.bestOdd,
      expectedValue,
      score: clamp(finalProbability * 100 * (0.86 + quality * 0.14), 0, 100),
    });
  }

  candidates.sort((a, b) => {
    const aRank = a.score * 0.72 + a.expectedValue * 100 * 0.28;
    const bRank = b.score * 0.72 + b.expectedValue * 100 * 0.28;
    return bRank - aRank;
  });

  return {
    version: "brainlive-strategy-v2",
    lambdaHome,
    lambdaAway,
    expectedGoals: lambdaHome + lambdaAway,
    dataQuality: quality,
    sampleMode,
    probabilities,
    selection: candidates[0] ?? null,
  };
}
