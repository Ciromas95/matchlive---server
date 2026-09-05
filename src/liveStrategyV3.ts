export type LiveStatsV3 = {
  shotsHome: number | null; shotsAway: number | null;
  shotsOnGoalHome: number | null; shotsOnGoalAway: number | null;
  cornersHome: number | null; cornersAway: number | null;
  possessionHome: number | null; possessionAway: number | null;
  xgHome: number | null; xgAway: number | null;
  redsHome: number | null; redsAway: number | null;
};

export type LiveObservationV3 = {
  elapsed: number;
  homeGoals: number;
  awayGoals: number;
  stats: LiveStatsV3;
};

function value(entry: any, aliases: string[]): number | null {
  const row = (Array.isArray(entry?.statistics) ? entry.statistics : [])
    .find((item: any) => aliases.includes(String(item?.type ?? "").toLowerCase().replace(/[_\s]+/g, " ").trim()));
  if (row?.value == null || row.value === "") return null;
  const number = Number(String(row.value).replace("%", "").replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseLiveStatsV3(raw: any, homeId: number, awayId: number): LiveStatsV3 | null {
  const rows = Array.isArray(raw?.response) ? raw.response : [];
  const home = rows.find((entry: any) => Number(entry?.team?.id) === homeId);
  const away = rows.find((entry: any) => Number(entry?.team?.id) === awayId);
  if (!home || !away) return null;
  return {
    shotsHome: value(home, ["total shots"]), shotsAway: value(away, ["total shots"]),
    shotsOnGoalHome: value(home, ["shots on goal", "shots on target"]),
    shotsOnGoalAway: value(away, ["shots on goal", "shots on target"]),
    cornersHome: value(home, ["corner kicks", "corners"]), cornersAway: value(away, ["corner kicks", "corners"]),
    possessionHome: value(home, ["ball possession", "possession"]), possessionAway: value(away, ["ball possession", "possession"]),
    xgHome: value(home, ["xg", "expected goals"]), xgAway: value(away, ["xg", "expected goals"]),
    redsHome: value(home, ["red cards"]), redsAway: value(away, ["red cards"]),
  };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function evaluateLiveV3(current: LiveObservationV3, previous?: LiveObservationV3) {
  const { elapsed, homeGoals, awayGoals, stats: s } = current;
  if (elapsed < 18 || elapsed > 78 || homeGoals + awayGoals >= 5) return null;
  if ([s.shotsHome, s.shotsAway, s.shotsOnGoalHome, s.shotsOnGoalAway].some((item) => item == null)) return null;
  const shotsH = s.shotsHome!, shotsA = s.shotsAway!;
  const sotH = s.shotsOnGoalHome!, sotA = s.shotsOnGoalAway!;
  const shots = shotsH + shotsA, sot = sotH + sotA;
  const gap = Math.abs(homeGoals - awayGoals);
  const secondary = [s.cornersHome, s.possessionHome, s.xgHome].filter((item) => item != null).length;
  if (secondary === 0 || shots < 7 || sot < 3) return null;
  const window = previous ? elapsed - previous.elapsed : 0;
  const hasWindow = previous != null && window >= 3 && window <= 12 &&
    previous.homeGoals === homeGoals && previous.awayGoals === awayGoals;
  const delta = (now: number, before: number | null | undefined) => before == null ? 0 : Math.max(0, now - before);
  const recentShotsH = hasWindow ? delta(shotsH, previous!.stats.shotsHome) : null;
  const recentShotsA = hasWindow ? delta(shotsA, previous!.stats.shotsAway) : null;
  const recentSotH = hasWindow ? delta(sotH, previous!.stats.shotsOnGoalHome) : null;
  const recentSotA = hasWindow ? delta(sotA, previous!.stats.shotsOnGoalAway) : null;
  const options: Array<{ tagType: string; badgeText: string; finalScore: number; interestingMicroInsight: string }> = [];

  for (const home of [true, false]) {
    const ownShots = home ? shotsH : shotsA, oppShots = home ? shotsA : shotsH;
    const ownSot = home ? sotH : sotA, oppSot = home ? sotA : sotH;
    const ownXg = home ? s.xgHome : s.xgAway, oppXg = home ? s.xgAway : s.xgHome;
    const ownPoss = home ? s.possessionHome : s.possessionAway;
    const ownCorners = home ? s.cornersHome : s.cornersAway;
    const recentShots = home ? recentShotsH : recentShotsA;
    const recentSot = home ? recentSotH : recentSotA;
    const ownRed = home ? s.redsHome : s.redsAway;
    const leading = home ? homeGoals - awayGoals : awayGoals - homeGoals;
    const share = ownShots / Math.max(1, shots);
    if (ownShots < 6 || ownSot < 3 || ownSot - oppSot < 2 || share < 0.64 || leading >= 2) continue;
    if ((ownRed ?? 0) > 0) continue;
    if (hasWindow && (recentShots ?? 0) < 2 && (recentSot ?? 0) < 1) continue;
    let score = 38 + clamp((ownSot - oppSot) * 4, 0, 20) + clamp((share - 0.5) * 35, 0, 14);
    score += clamp((ownShots - oppShots) * 1.2, 0, 10);
    if (ownPoss != null) score += clamp((ownPoss - 50) * 0.25, 0, 5);
    if (ownCorners != null) score += clamp(ownCorners, 0, 5);
    if (ownXg != null && oppXg != null) score += clamp((ownXg - oppXg) * 6, -7, 7);
    if (hasWindow) score += clamp((recentSot ?? 0) * 2 + (recentShots ?? 0), 0, 8);
    if (score < 62) continue;
    options.push({
      tagType: home ? "homeDom" : "awayDom",
      badgeText: home ? "DOMINIO CASA" : "DOMINIO OSPITE",
      finalScore: clamp(score, 0, 95),
      interestingMicroInsight: `${ownShots} tiri · ${ownSot} nello specchio${ownXg != null ? ` · xG ${ownXg.toFixed(2)}` : ""}`,
    });
  }

  const pace = (shots + 20 * 12 / 90) * 90 / (elapsed + 12);
  const bothThreaten = shotsH >= 3 && shotsA >= 3 && sotH >= 1 && sotA >= 1;
  const recentTotal = (recentShotsH ?? 0) + (recentShotsA ?? 0);
  if (gap <= 1 && bothThreaten && sot >= 5 && shots >= 12 && pace >= 22 &&
      (!hasWindow || recentTotal >= 3)) {
    let score = 45 + clamp((sot - 4) * 3, 0, 18) + clamp((pace - 20) * 0.7, 0, 12);
    if (s.xgHome != null && s.xgAway != null) score += clamp((s.xgHome + s.xgAway - 0.8) * 5, 0, 10);
    if (hasWindow) score += clamp(recentTotal, 0, 8);
    if (score >= 64) options.push({
      tagType: "hot", badgeText: "MATCH APERTO", finalScore: clamp(score, 0, 95),
      interestingMicroInsight: `${shots} tiri totali · ${sot} nello specchio · entrambe pericolose`,
    });
  }
  options.sort((a, b) => b.finalScore - a.finalScore);
  return options[0] ? { ...options[0], stats: s, algorithmVersion: "brainlive-live-v3" } : null;
}
