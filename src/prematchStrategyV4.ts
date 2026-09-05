import {
  CoreMarketV3,
  PrematchMarketV3,
  StrategyEvaluationV3,
  StrategyInputV3,
  StrategySelectionV3,
  evaluateStrategyV3,
} from "./prematchStrategyV3";

export type StrategySelectionV4 = StrategySelectionV3 & {
  robustProbability: number;
  uncertainty: number;
  stability: number;
};

export type StrategyEvaluationV4 = Omit<StrategyEvaluationV3, "version" | "selections" | "selection"> & {
  version: "brainlive-strategy-v4";
  selections: StrategySelectionV4[];
  selection: StrategySelectionV4 | null;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function marketRate(input: StrategyInputV3, market: PrematchMarketV3, recent: boolean): number | null {
  const home = recent ? input.homeRecent : input.homeVenue;
  const away = recent ? input.awayRecent : input.awayVenue;
  if (market === "GOAL") return (home.bttsRate + away.bttsRate) / 2;
  if (market === "OVER 2.5") return (home.over25Rate + away.over25Rate) / 2;
  if (market === "CASA OVER 1.5") return home.scoredOver15Rate ?? null;
  if (market === "OSPITE OVER 1.5") return away.scoredOver15Rate ?? null;
  if (market === "1X") return recent
    ? input.homeResultRecent.unbeatenRate
    : input.homeResultVenue.unbeatenRate;
  if (market === "X2") return recent
    ? input.awayResultRecent.unbeatenRate
    : input.awayResultVenue.unbeatenRate;
  return null;
}

function currentSample(input: StrategyInputV3, market: PrematchMarketV3): number {
  if (market.startsWith("CORNER")) {
    return Math.min(input.homeCorners.effectiveMatches, input.awayCorners.effectiveMatches);
  }
  if (market === "1X" || market === "X2") {
    return Math.min(input.homeResultVenue.effectiveMatches, input.awayResultVenue.effectiveMatches);
  }
  return Math.min(input.homeOverall.effectiveMatches ?? input.homeOverall.matches,
    input.awayOverall.effectiveMatches ?? input.awayOverall.matches);
}

/**
 * V4 aggiunge al modello V3 un vero strato di robustezza: misura divergenza
 * tra forma e struttura, dimensione del campione corrente e distanza dal
 * mercato. La probabilità mostrata non è il valore ottimistico, ma il limite
 * prudente della stima. Questo permette di lavorare anche nelle prime giornate
 * senza attribuire alla stagione precedente un'autorità che non possiede.
 */
export function evaluateStrategyV4(input: StrategyInputV3): StrategyEvaluationV4 {
  const base = evaluateStrategyV3(input);
  const selections: StrategySelectionV4[] = base.selections.map((selection) => {
    const recent = marketRate(input, selection.market, true);
    const structural = marketRate(input, selection.market, false);
    const disagreement = recent == null || structural == null
      ? 0.08
      : Math.abs(recent - structural);
    const sample = currentSample(input, selection.market);
    const sampleSupport = sample / (sample + 5);
    const marketGap = selection.marketProbability == null
      ? 0.08
      : Math.abs(selection.modelProbability - selection.marketProbability);
    const uncertainty = clamp(
      0.025 + (1 - selection.dataQuality) * 0.075 +
      disagreement * 0.10 + marketGap * 0.08 + (1 - sampleSupport) * 0.025,
      0.025,
      0.13,
    );
    const robustProbability = clamp(selection.finalProbability - uncertainty * 0.45, 0.02, 0.98);
    const stability = clamp(1 - uncertainty * 3.4, 0.45, 0.96);
    const robustEdge = robustProbability * selection.bestOdd - 1;
    return {
      ...selection,
      finalProbability: robustProbability,
      fairOdd: 1 / robustProbability,
      expectedValue: robustEdge,
      robustProbability,
      uncertainty,
      stability,
      score: clamp(
        robustProbability * 62 + selection.dataQuality * 18 + stability * 12 +
        clamp(robustEdge, -0.05, 0.30) * 100 * 0.08,
        0,
        100,
      ),
    };
  }).filter((selection) => {
    // Il V3 ha già superato le soglie del mercato. V4 elimina soltanto i casi
    // nei quali l'intervallo prudente annulla completamente il valore quota.
    return selection.expectedValue > 0 && selection.stability >= 0.55;
  });

  selections.sort((left, right) => {
    const leftRank = left.score * 0.72 + left.robustProbability * 100 * 0.18 + left.expectedValue * 100 * 0.10;
    const rightRank = right.score * 0.72 + right.robustProbability * 100 * 0.18 + right.expectedValue * 100 * 0.10;
    return rightRank - leftRank;
  });

  return {
    ...base,
    version: "brainlive-strategy-v4",
    selections,
    selection: selections[0] ?? null,
  };
}

export type { StrategyInputV3, CoreMarketV3 };

