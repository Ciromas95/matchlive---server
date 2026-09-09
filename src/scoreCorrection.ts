export type ScoreCorrection = {
  home: boolean;
  away: boolean;
};

export function detectScoreCorrection(
  previousScore: string | undefined,
  homeGoals: number,
  awayGoals: number,
): ScoreCorrection {
  if (!previousScore) return { home: false, away: false };
  const [previousHome, previousAway] = previousScore
    .split("-")
    .map((value) => Number(value));
  return {
    home: Number.isFinite(previousHome) && homeGoals < previousHome,
    away: Number.isFinite(previousAway) && awayGoals < previousAway,
  };
}
