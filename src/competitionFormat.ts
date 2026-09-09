export type CompetitionFormat = "league_stage" | "groups" | "knockout" | "hybrid";

const knockoutWords = /(?:round of|1\/\d+|eighth|quarter|semi|final|play-?off|knockout)/i;
const groupWords = /(?:group|girone)/i;

export function inferCompetitionFormat(
  leagueId: number,
  season: number,
  standingsPayload: any,
  fixturesPayload: any,
) {
  const configured = (() => {
    try {
      const overrides = JSON.parse(process.env.COMPETITION_FORMAT_OVERRIDES ?? "{}");
      return overrides[`${leagueId}:${season}`] ?? overrides[String(leagueId)];
    } catch { return null; }
  })();
  if (["league_stage", "groups", "knockout", "hybrid"].includes(configured)) {
    return { competitionFormat: configured as CompetitionFormat, source: "override" as const };
  }

  const blocks = Array.isArray(standingsPayload?.response) ? standingsPayload.response : [];
  const tables = blocks.flatMap((block: any) => block?.league?.standings ?? []);
  const groupNames: string[] = [...new Set<string>(tables.flatMap((table: any) =>
    Array.isArray(table) ? table.map((row: any) => String(row?.group ?? "").trim()).filter(Boolean) : []))];
  const fixtures = Array.isArray(fixturesPayload?.response) ? fixturesPayload.response : [];
  const rounds: string[] = [...new Set<string>(fixtures.map((row: any) => String(row?.league?.round ?? "").trim()).filter(Boolean))];
  const now = Date.now();
  const active = fixtures.filter((row: any) => {
    const at = Date.parse(row?.fixture?.date ?? "");
    const status = String(row?.fixture?.status?.short ?? "").toUpperCase();
    return ["1H", "HT", "2H", "ET", "P", "LIVE"].includes(status) || (Number.isFinite(at) && at >= now - 12 * 3600_000);
  });
  const currentRound = String((active[0] ?? fixtures.at(-1))?.league?.round ?? "");
  const hasStandings = tables.some((table: any) => Array.isArray(table) && table.length > 1);
  const hasGroups = groupNames.length > 1 || rounds.some((round) => groupWords.test(round));
  const hasKnockout = rounds.some((round) => knockoutWords.test(round));
  const currentKnockout = knockoutWords.test(currentRound);
  const format: CompetitionFormat = hasKnockout && hasStandings
    ? "hybrid"
    : hasKnockout ? "knockout" : hasGroups ? "groups" : "league_stage";
  const activeView = format === "hybrid"
    ? (currentKnockout ? "knockout" : hasGroups ? "groups" : "league_stage")
    : format;
  return {
    competitionFormat: format,
    activeView,
    currentPhase: currentRound || null,
    hasStandings,
    groups: groupNames,
    rounds,
    source: "provider_inference" as const,
  };
}
