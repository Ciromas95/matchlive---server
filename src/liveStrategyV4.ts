export type LiveStatsV4 = {
  shotsHome: number | null; shotsAway: number | null;
  shotsOnGoalHome: number | null; shotsOnGoalAway: number | null;
  cornersHome: number | null; cornersAway: number | null;
  possessionHome: number | null; possessionAway: number | null;
  xgHome: number | null; xgAway: number | null;
  redsHome: number | null; redsAway: number | null;
  shotsInsideBoxHome: number | null; shotsInsideBoxAway: number | null;
  goalkeeperSavesHome: number | null; goalkeeperSavesAway: number | null;
};

export type LiveObservationV4 = {
  elapsed: number;
  phaseElapsed?: number;
  homeGoals: number;
  awayGoals: number;
  stats: LiveStatsV4;
};

function value(entry: any, aliases: string[]): number | null {
  const normalizedAliases = aliases.map((item) => item.toLowerCase());
  const row = (Array.isArray(entry?.statistics) ? entry.statistics : []).find((item: any) => {
    const type = String(item?.type ?? "").toLowerCase().replace(/[_\s]+/g, " ").trim();
    return normalizedAliases.includes(type);
  });
  if (row?.value == null || row.value === "") return null;
  const parsed = Number(String(row.value).replace("%", "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseLiveStatsV4(raw: any, homeId: number, awayId: number): LiveStatsV4 | null {
  const rows = Array.isArray(raw?.response) ? raw.response : [];
  const home = rows.find((entry: any) => Number(entry?.team?.id) === homeId);
  const away = rows.find((entry: any) => Number(entry?.team?.id) === awayId);
  if (!home || !away) return null;
  return {
    shotsHome: value(home, ["total shots"]),
    shotsAway: value(away, ["total shots"]),
    shotsOnGoalHome: value(home, ["shots on goal", "shots on target"]),
    shotsOnGoalAway: value(away, ["shots on goal", "shots on target"]),
    cornersHome: value(home, ["corner kicks", "corners"]),
    cornersAway: value(away, ["corner kicks", "corners"]),
    possessionHome: value(home, ["ball possession", "possession"]),
    possessionAway: value(away, ["ball possession", "possession"]),
    xgHome: value(home, ["expected goals", "xg"]),
    xgAway: value(away, ["expected goals", "xg"]),
    redsHome: value(home, ["red cards"]),
    redsAway: value(away, ["red cards"]),
    shotsInsideBoxHome: value(home, ["shots insidebox", "shots inside box"]),
    shotsInsideBoxAway: value(away, ["shots insidebox", "shots inside box"]),
    goalkeeperSavesHome: value(home, ["goalkeeper saves"]),
    goalkeeperSavesAway: value(away, ["goalkeeper saves"]),
  };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const numberOrZero = (value: number | null | undefined) => value ?? 0;

type GoalTargetV4 = "home" | "away" | "either";

type LiveSignalV4 = {
  tagType: string;
  badgeText: string;
  finalScore: number;
  goalTarget: GoalTargetV4;
  signalKind: "pressure" | "equalizer" | "open";
  forecastWindowMinutes: number;
  goalProbability: number;
  interestingMicroInsight: string;
};

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/**
 * Engine Live V4. Osserva dal calcio d'inizio e consente la prima card dal
 * quarto minuto soltanto con una pressione eccezionale. Il risultato decide
 * quale segnale sia sensato: una squadra già avanti non riceve una card di
 * dominio; la squadra sotto di un gol può invece generare un segnale pareggio.
 */
export function evaluateLiveV4(current: LiveObservationV4, previous?: LiveObservationV4) {
  const { elapsed, homeGoals, awayGoals, stats: s } = current;
  const phaseElapsed = current.phaseElapsed ?? elapsed;
  const insideBettingWindow =
    (elapsed >= 4 && elapsed <= 30) || (elapsed >= 46 && elapsed <= 80);
  if (!insideBettingWindow || homeGoals + awayGoals >= 5) return null;
  if ([s.shotsHome, s.shotsAway, s.shotsOnGoalHome, s.shotsOnGoalAway].some((item) => item == null)) return null;

  const shotsH = s.shotsHome!, shotsA = s.shotsAway!;
  const sotH = s.shotsOnGoalHome!, sotA = s.shotsOnGoalAway!;
  const totalShots = shotsH + shotsA;
  const totalSot = sotH + sotA;
  const scoreGap = Math.abs(homeGoals - awayGoals);
  if (scoreGap >= 2) return null;

  const window = previous ? elapsed - previous.elapsed : 0;
  const sameScore = previous != null && previous.homeGoals === homeGoals && previous.awayGoals === awayGoals;
  const hasWindow = sameScore && window >= 1 && window <= 12;
  const delta = (now: number, before: number | null | undefined) => before == null ? 0 : Math.max(0, now - before);
  const recentShotsH = hasWindow ? delta(shotsH, previous!.stats.shotsHome) : null;
  const recentShotsA = hasWindow ? delta(shotsA, previous!.stats.shotsAway) : null;
  const recentSotH = hasWindow ? delta(sotH, previous!.stats.shotsOnGoalHome) : null;
  const recentSotA = hasWindow ? delta(sotA, previous!.stats.shotsOnGoalAway) : null;
  const recentCornersH = hasWindow ? delta(numberOrZero(s.cornersHome), previous!.stats.cornersHome) : null;
  const recentCornersA = hasWindow ? delta(numberOrZero(s.cornersAway), previous!.stats.cornersAway) : null;

  const early = phaseElapsed < 15;
  const veryEarly = phaseElapsed < 8;
  const options: LiveSignalV4[] = [];

  for (const home of [true, false]) {
    const ownGoals = home ? homeGoals : awayGoals;
    const opponentGoals = home ? awayGoals : homeGoals;
    // Il dominio della squadra già in vantaggio ha già raggiunto il proprio
    // obiettivo. Attendiamo un nuovo stato invece di inseguire il risultato.
    if (ownGoals > opponentGoals) continue;

    const ownShots = home ? shotsH : shotsA;
    const opponentShots = home ? shotsA : shotsH;
    const ownSot = home ? sotH : sotA;
    const opponentSot = home ? sotA : sotH;
    const ownCorners = numberOrZero(home ? s.cornersHome : s.cornersAway);
    const ownPossession = home ? s.possessionHome : s.possessionAway;
    const ownXg = home ? s.xgHome : s.xgAway;
    const opponentXg = home ? s.xgAway : s.xgHome;
    const ownInside = numberOrZero(home ? s.shotsInsideBoxHome : s.shotsInsideBoxAway);
    const ownRed = numberOrZero(home ? s.redsHome : s.redsAway);
    const recentShots = home ? recentShotsH : recentShotsA;
    const recentSot = home ? recentSotH : recentSotA;
    const recentCorners = home ? recentCornersH : recentCornersA;
    if (ownRed > 0) continue;

    const share = ownShots / Math.max(1, totalShots);
    const shotsPerMinute = ownShots / Math.max(1, phaseElapsed);
    const sotPerMinute = ownSot / Math.max(1, phaseElapsed);
    const extremeStart = veryEarly && ownShots >= 5 && ownSot >= 2 && ownCorners >= 2 && share >= 0.72;
    const minimumShots = veryEarly ? 5 : early ? 6 : 6;
    const minimumSot = veryEarly ? 2 : early ? 2 : 3;
    const minimumShare = veryEarly ? 0.72 : early ? 0.68 : 0.64;
    if (ownShots < minimumShots || ownSot < minimumSot || share < minimumShare) continue;
    if (veryEarly && !extremeStart) continue;
    if (!veryEarly && ownSot - opponentSot < (early ? 1 : 2)) continue;
    if (hasWindow && (recentShots ?? 0) < 2 && (recentSot ?? 0) < 1 && (recentCorners ?? 0) < 1) continue;

    const trailing = ownGoals < opponentGoals;
    let evidence = -1.0;
    evidence += clamp((share - 0.5) * 4.0, 0, 1.3);
    evidence += clamp((ownSot - opponentSot) * 0.22, 0, 1.0);
    evidence += clamp(shotsPerMinute * 1.4, 0, 1.0);
    evidence += clamp(sotPerMinute * 2.2, 0, 0.7);
    evidence += clamp(ownCorners * 0.07, 0, 0.35);
    evidence += clamp(ownInside * 0.06, 0, 0.35);
    if (ownPossession != null) evidence += clamp((ownPossession - 50) * 0.012, -0.15, 0.3);
    if (ownXg != null && opponentXg != null) evidence += clamp((ownXg - opponentXg) * 0.38, -0.2, 0.55);
    if (hasWindow) evidence += clamp(numberOrZero(recentShots) * 0.08 + numberOrZero(recentSot) * 0.16, 0, 0.55);
    if (trailing) evidence += 0.12;
    const probability = clamp(logistic(evidence), 0.05, 0.94);
    const threshold = veryEarly ? 0.72 : early ? 0.68 : trailing ? 0.64 : 0.66;
    if (probability < threshold) continue;

    const side = home ? "CASA" : "OSPITE";
    options.push({
      tagType: home ? "homeDom" : "awayDom",
      badgeText: trailing ? `REAZIONE ${side}` : `PRESSIONE ${side}`,
      finalScore: clamp(probability * 100, 0, 95),
      goalTarget: home ? "home" : "away",
      signalKind: trailing ? "equalizer" : "pressure",
      forecastWindowMinutes: 10,
      goalProbability: probability,
      interestingMicroInsight:
        `${ownShots} tiri · ${ownSot} nello specchio · ${ownCorners} corner` +
        `${ownXg != null ? ` · xG ${ownXg.toFixed(2)}` : ""}`,
    });
  }

  // Match aperto soltanto con punteggio in equilibrio: 0-0 o 1-1.
  const levelAndUseful = homeGoals === awayGoals && (homeGoals === 0 || homeGoals === 1);
  const bothThreaten = shotsH >= (early ? 2 : 3) && shotsA >= (early ? 2 : 3) && sotH >= 1 && sotA >= 1;
  const projectedPace = totalShots * 45 / Math.max(6, phaseElapsed);
  const recentTotal = numberOrZero(recentShotsH) + numberOrZero(recentShotsA);
  const openThresholdMet = early
    ? totalShots >= 9 && totalSot >= 4 && projectedPace >= 34
    : totalShots >= 12 && totalSot >= 5 && projectedPace >= 22;
  if (levelAndUseful && bothThreaten && openThresholdMet && (!hasWindow || recentTotal >= 3)) {
    let evidence = -0.8 + clamp((totalSot - 3) * 0.18, 0, 1.2) + clamp((projectedPace - 20) * 0.025, 0, 0.8);
    if (s.xgHome != null && s.xgAway != null) evidence += clamp((s.xgHome + s.xgAway) * 0.22, 0, 0.65);
    if (hasWindow) evidence += clamp(recentTotal * 0.07, 0, 0.4);
    const probability = clamp(logistic(evidence), 0.05, 0.94);
    if (probability >= (early ? 0.70 : 0.65)) {
      options.push({
        tagType: "hot",
        badgeText: homeGoals === 0 ? "MATCH APERTO" : "EQUILIBRIO AD ALTA INTENSITÀ",
        finalScore: clamp(probability * 100, 0, 95),
        goalTarget: "either",
        signalKind: "open",
        forecastWindowMinutes: 10,
        goalProbability: probability,
        interestingMicroInsight: `${totalShots} tiri totali · ${totalSot} nello specchio · entrambe pericolose`,
      });
    }
  }

  options.sort((left, right) => right.finalScore - left.finalScore);
  return options[0]
    ? { ...options[0], stats: s, algorithmVersion: "brainlive-live-v4" }
    : null;
}
