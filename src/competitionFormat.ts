import { normalizeFixtureStatus } from "./fixtureLifecycle";

export type CompetitionFormat =
  | "round_robin"
  | "knockout"
  | "groups_then_knockout"
  | "single_table_then_knockout"
  | "multi_league_playoffs"
  | "qualification_to_main"
  | "single_match";

export type CompetitionPhaseKind =
  | "qualification"
  | "league"
  | "groups"
  | "knockout"
  | "final";

export type CompetitionPhaseDefinition = {
  key: string;
  label: string;
  kind: CompetitionPhaseKind;
};

type CompetitionDefinition = {
  fromSeason?: number;
  toSeason?: number;
  format: CompetitionFormat;
  phases: CompetitionPhaseDefinition[];
  description?: string;
  thirdPlace?: boolean;
};

const phase = (
  key: string,
  label: string,
  kind: CompetitionPhaseKind,
): CompetitionPhaseDefinition => ({ key, label, kind });

const knockout = [
  phase("knockout", "Eliminazione diretta", "knockout"),
  phase("final", "Finale", "final"),
];

const finalRounds = [
  phase("round_of_16", "Ottavi", "knockout"),
  phase("quarter_finals", "Quarti", "knockout"),
  phase("semi_finals", "Semifinali", "knockout"),
  phase("final", "Finale", "final"),
];

const groupsAndKnockout = [
  phase("groups", "Fase a gironi", "groups"),
  ...finalRounds,
];

const groupsFromQuarters = [
  phase("groups", "Fase a gironi", "groups"),
  phase("quarter_finals", "Quarti", "knockout"),
  phase("semi_finals", "Semifinali", "knockout"),
  phase("final", "Finale", "final"),
];

const modernUefa = [
  phase("qualification", "Qualificazione", "qualification"),
  phase("qualification_playoff", "Play-off", "qualification"),
  phase("league", "Fase campionato", "league"),
  phase("knockout_playoff", "Spareggi", "knockout"),
  ...finalRounds,
];

const worldCup2026 = [
  phase("groups", "Gironi", "groups"),
  phase("round_of_32", "Sedicesimi", "knockout"),
  phase("round_of_16", "Ottavi", "knockout"),
  phase("quarter_finals", "Quarti", "knockout"),
  phase("semi_finals", "Semifinali", "knockout"),
  phase("final", "Finale", "final"),
];

// Regole editoriali versionate. I dati del provider restano la fonte per
// partite e classifiche; queste definizioni spiegano come comporre la pagina.
const definitions: Record<number, CompetitionDefinition[]> = {
  1: [
    {
      toSeason: 2022,
      format: "groups_then_knockout",
      phases: groupsAndKnockout,
      thirdPlace: true,
      description: "Torneo mondiale per nazionali disputato ogni quattro anni.",
    },
    {
      fromSeason: 2026,
      format: "groups_then_knockout",
      phases: worldCup2026,
      thirdPlace: true,
      description: "Torneo mondiale per nazionali: dodici gironi e fase finale dai sedicesimi.",
    },
  ],
  2: [
    { toSeason: 2023, format: "groups_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), ...groupsAndKnockout] },
    { fromSeason: 2024, format: "single_table_then_knockout", phases: modernUefa },
  ],
  3: [
    { toSeason: 2023, format: "groups_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), ...groupsAndKnockout] },
    { fromSeason: 2024, format: "single_table_then_knockout", phases: modernUefa },
  ],
  848: [
    { toSeason: 2023, format: "groups_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), ...groupsAndKnockout] },
    { fromSeason: 2024, format: "single_table_then_knockout", phases: modernUefa },
  ],
  4: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  5: [{
    format: "multi_league_playoffs",
    phases: [phase("leagues", "Leghe e gironi", "groups"), phase("playoffs", "Play-off", "knockout"), phase("final", "Fase finale", "final")],
  }],
  6: [{ format: "groups_then_knockout", phases: groupsAndKnockout, thirdPlace: true }],
  7: [{ format: "groups_then_knockout", phases: groupsAndKnockout, thirdPlace: true }],
  9: [{ format: "groups_then_knockout", phases: groupsFromQuarters, thirdPlace: true }],
  15: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  16: [{ format: "knockout", phases: knockout }],
  22: [{ format: "groups_then_knockout", phases: groupsFromQuarters, thirdPlace: true }],
  536: [{
    format: "multi_league_playoffs",
    phases: [phase("leagues", "Leghe e gironi", "groups"), phase("playoffs", "Play-off", "knockout"), phase("final", "Fase finale", "final")],
  }],
  806: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  11: [{ format: "groups_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), ...groupsAndKnockout] }],
  12: [{ format: "groups_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), ...groupsAndKnockout] }],
  13: [{ format: "groups_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), ...groupsAndKnockout] }],
  17: [{ format: "single_table_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), phase("league", "Fase campionato", "league"), ...knockout] }],
  18: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  20: [{ format: "groups_then_knockout", phases: [phase("qualification", "Qualificazione", "qualification"), ...groupsAndKnockout] }],
  27: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  772: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  1028: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  1132: [{ format: "groups_then_knockout", phases: groupsAndKnockout }],
  1168: [{
    format: "knockout",
    phases: [
      phase("regional_playoffs", "Spareggi continentali", "knockout"),
      phase("challenger", "Coppa Challenger", "knockout"),
      phase("final", "Finale", "final"),
    ],
  }],
};

const qualificationIds = new Set([29, 30, 31, 32, 33, 34, 35, 36, 37, 858, 960]);
const singleMatchIds = new Set([531, 533, 541, 913, 526, 528, 529, 543, 547, 550, 551]);
const domesticKnockoutIds = new Set([
  45, 48, 66, 73, 81, 90, 96, 97, 115, 130, 137, 143, 147, 181, 185,
  206, 241, 246, 257, 267, 285, 294, 335, 359, 384,
]);

const knockoutWords = /(?:round of|1\/\d+|eighth|quarter|semi|final|play-?off|knockout|sedicesimi|ottavi|quarti|semifinali)/i;
const groupWords = /(?:group|girone)/i;
const qualificationWords = /(?:qualif|prelim)/i;
const leagueWords = /(?:regular season|league phase|league stage|fase campionato)/i;
const qualifyingPlayoffWords = /(?:play-?off round)/i;

function configuredDefinition(leagueId: number, season: number): CompetitionDefinition | null {
  const candidates = definitions[leagueId] ?? [];
  return candidates.find((item) =>
    (item.fromSeason == null || season >= item.fromSeason) &&
    (item.toSeason == null || season <= item.toSeason)) ?? null;
}

function envOverride(leagueId: number, season: number): CompetitionFormat | null {
  try {
    const overrides = JSON.parse(process.env.COMPETITION_FORMAT_OVERRIDES ?? "{}");
    const value = overrides[`${leagueId}:${season}`] ?? overrides[String(leagueId)];
    return [
      "round_robin", "knockout", "groups_then_knockout",
      "single_table_then_knockout", "multi_league_playoffs",
      "qualification_to_main", "single_match",
    ].includes(value) ? value : null;
  } catch {
    return null;
  }
}

function defaultPhases(format: CompetitionFormat, rounds: string[]): CompetitionPhaseDefinition[] {
  switch (format) {
    case "round_robin": return [phase("league", "Campionato", "league")];
    case "knockout": return knockout;
    case "groups_then_knockout": return groupsAndKnockout;
    case "single_table_then_knockout": return [phase("league", "Fase campionato", "league"), ...knockout];
    case "multi_league_playoffs": return [phase("leagues", "Leghe e gironi", "groups"), phase("playoffs", "Play-off", "knockout"), phase("final", "Fase finale", "final")];
    case "qualification_to_main": {
      const hasGroups = rounds.some((round) => groupWords.test(round));
      return [phase("qualification", "Qualificazione", "qualification"), ...(hasGroups ? [phase("groups", "Fase a gironi", "groups")] : []), phase("playoffs", "Spareggi", "knockout")];
    }
    case "single_match": return [phase("final", "Finale", "final")];
  }
}

function tabsFor(format: CompetitionFormat, hasStandings: boolean): string[] {
  const tabs = ["overview", "calendar"];
  if (hasStandings || ["round_robin", "groups_then_knockout", "single_table_then_knockout", "multi_league_playoffs", "qualification_to_main"].includes(format)) tabs.push("standings");
  if (["knockout", "groups_then_knockout", "single_table_then_knockout", "multi_league_playoffs"].includes(format)) tabs.push("bracket");
  tabs.push("scorers");
  return tabs;
}

export function inferCompetitionFormat(
  leagueId: number,
  season: number,
  standingsPayload: any,
  fixturesPayload: any,
) {
  const blocks = Array.isArray(standingsPayload?.response) ? standingsPayload.response : [];
  const tables = blocks.flatMap((block: any) => block?.league?.standings ?? []);
  const groupNames: string[] = [...new Set<string>(tables.flatMap((table: any) =>
    Array.isArray(table) ? table.map((row: any) => String(row?.group ?? "").trim()).filter(Boolean) : []))];
  const fixtures = Array.isArray(fixturesPayload?.response) ? fixturesPayload.response : [];
  const rounds: string[] = [...new Set<string>(fixtures.map((row: any) => String(row?.league?.round ?? "").trim()).filter(Boolean))];
  const now = Date.now();
  const chronological = [...fixtures].sort((a: any, b: any) => Date.parse(a?.fixture?.date ?? "") - Date.parse(b?.fixture?.date ?? ""));
  const live = chronological.find((row: any) =>
    normalizeFixtureStatus(row?.fixture?.status).isLive);
  const next = chronological.find((row: any) => {
    const at = Date.parse(row?.fixture?.date ?? "");
    const lifecycle = normalizeFixtureStatus(row?.fixture?.status);
    return (lifecycle.isScheduled || lifecycle.isPostponed) && Number.isFinite(at) && at >= now - 12 * 3600_000;
  });
  const completed = chronological.filter((row: any) =>
    normalizeFixtureStatus(row?.fixture?.status).isFinished);
  const currentRound = String((live ?? next ?? completed.at(-1) ?? chronological.at(-1))?.league?.round ?? "");
  const hasStandings = tables.some((table: any) => Array.isArray(table) && table.length > 1);
  const hasGroups = groupNames.length > 1 || rounds.some((round) => groupWords.test(round));
  const hasLeagueStage = rounds.some((round) => leagueWords.test(round));
  const hasKnockout = rounds.some((round) => knockoutWords.test(round));
  const hasQualification = rounds.some((round) => qualificationWords.test(round));

  const configured = configuredDefinition(leagueId, season);
  const override = envOverride(leagueId, season);
  let format: CompetitionFormat;
  let source: "override" | "catalog" | "provider_inference";
  if (override != null) {
    format = override;
    source = "override";
  } else if (configured != null) {
    format = configured.format;
    source = "catalog";
  } else if (qualificationIds.has(leagueId) || (hasQualification && !hasKnockout && !hasLeagueStage)) {
    format = "qualification_to_main";
    source = "catalog";
  } else if (singleMatchIds.has(leagueId) || (fixtures.length === 1 && !hasStandings)) {
    format = "single_match";
    source = singleMatchIds.has(leagueId) ? "catalog" : "provider_inference";
  } else if (domesticKnockoutIds.has(leagueId)) {
    format = "knockout";
    source = "catalog";
  } else if (hasKnockout && hasLeagueStage) {
    format = "single_table_then_knockout";
    source = "provider_inference";
  } else if (hasKnockout && (hasGroups || hasStandings)) {
    format = "groups_then_knockout";
    source = "provider_inference";
  } else if (hasKnockout) {
    format = "knockout";
    source = "provider_inference";
  } else if (hasGroups) {
    format = "groups_then_knockout";
    source = "provider_inference";
  } else {
    format = "round_robin";
    source = "provider_inference";
  }

  const currentKnockout = knockoutWords.test(currentRound);
  const currentQualification = qualificationWords.test(currentRound) ||
    (qualifyingPlayoffWords.test(currentRound) && !/knockout/i.test(currentRound));
  const currentLeague = leagueWords.test(currentRound);
  const currentGroups = groupWords.test(currentRound);
  const activeView = currentQualification ? "qualification" : currentKnockout ? "knockout" : currentLeague ? "league_stage" : currentGroups ? "groups" : format === "single_match" ? "single_match" : hasStandings ? (groupNames.length > 1 ? "groups" : "league_stage") : "knockout";
  const phases = configured?.phases ?? defaultPhases(format, rounds);

  return {
    schemaVersion: 3,
    competitionFormat: format,
    activeView,
    currentPhase: currentRound || null,
    phases,
    tabs: tabsFor(format, hasStandings),
    hasStandings,
    hasBracket: ["knockout", "groups_then_knockout", "single_table_then_knockout", "multi_league_playoffs"].includes(format),
    thirdPlace: configured?.thirdPlace ?? rounds.some((round) => /3rd place|third place/i.test(round)),
    description: configured?.description ?? null,
    groups: groupNames,
    rounds,
    source,
  };
}

export function resolveCompetitionChampion(
  format: CompetitionFormat,
  standingsPayload: any,
  fixturesPayload: any,
): any | null {
  if (format === "round_robin") {
    const groups = standingsPayload?.response?.[0]?.league?.standings;
    if (!Array.isArray(groups) || groups.length !== 1 || !Array.isArray(groups[0])) return null;
    return groups[0][0]?.team ?? null;
  }
  const fixtures = Array.isArray(fixturesPayload?.response) ? fixturesPayload.response : [];
  const finals = fixtures.filter((row: any) => {
    const round = String(row?.league?.round ?? "").toLowerCase().trim();
    const isFinal = /(^|\s)(grand )?final(s)?($|\s|-)/.test(round) && !/(semi|quarter|1\/|round of|third|3rd|play-?off)/.test(round);
    return isFinal && normalizeFixtureStatus(row?.fixture?.status).isFinished;
  }).sort((a: any, b: any) => Date.parse(b?.fixture?.date ?? "") - Date.parse(a?.fixture?.date ?? ""));
  const final = finals[0];
  if (!final) return null;
  if (final?.teams?.home?.winner === true) return final.teams.home;
  if (final?.teams?.away?.winner === true) return final.teams.away;
  const home = Number(final?.goals?.home);
  const away = Number(final?.goals?.away);
  if (Number.isFinite(home) && Number.isFinite(away) && home !== away) return home > away ? final?.teams?.home ?? null : final?.teams?.away ?? null;
  return null;
}
