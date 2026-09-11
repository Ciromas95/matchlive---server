type StandingSnapshot = {
  played: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
};

type FixtureBaseline = {
  home: StandingSnapshot;
  away: StandingSnapshot;
};

const ACTIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "PEN_LIVE", "LIVE"]);
const FINISHED = new Set(["FT", "AET", "PEN", "PEN_FT"]);
const g = globalThis as any;
const completedFixtures: Map<number, { fixture: any; savedAt: number }> =
  g.__BRAINLIVE_RECENT_COMPLETED_STANDINGS__ ??
  (g.__BRAINLIVE_RECENT_COMPLETED_STANDINGS__ = new Map());
const baselines: Map<number, FixtureBaseline> =
  g.__BRAINLIVE_STANDINGS_BASELINES__ ??
  (g.__BRAINLIVE_STANDINGS_BASELINES__ = new Map());
const recentActiveFixtures: Map<number, { fixture: any; seenAt: number }> =
  g.__BRAINLIVE_RECENT_ACTIVE_STANDINGS__ ??
  (g.__BRAINLIVE_RECENT_ACTIVE_STANDINGS__ = new Map());
const baselineLoads: Map<string, Promise<void>> =
  g.__BRAINLIVE_STANDINGS_BASELINE_LOADS__ ??
  (g.__BRAINLIVE_STANDINGS_BASELINE_LOADS__ = new Map());

function numberValue(value: any): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function blockSnapshot(row: any): StandingSnapshot {
  const all = row?.all ?? {};
  return {
    played: numberValue(all?.played),
    goalsFor: numberValue(all?.goals?.for),
    goalsAgainst: numberValue(all?.goals?.against),
    points: numberValue(row?.points ?? all?.points),
  };
}

function fixtureStatus(fixture: any): string {
  return String(fixture?.fixture?.status?.short ?? "").trim().toUpperCase();
}

function fixtureLeague(fixture: any): { leagueId: number; season: number } {
  return {
    leagueId: numberValue(fixture?.league?.id),
    season: numberValue(fixture?.league?.season),
  };
}

function pointsFor(goalsFor: number, goalsAgainst: number): number {
  if (goalsFor > goalsAgainst) return 3;
  if (goalsFor == goalsAgainst) return 1;
  return 0;
}

function updateBlock(block: any, goalsFor: number, goalsAgainst: number) {
  if (!block || typeof block !== "object") return;
  block.played = numberValue(block.played) + 1;
  if (goalsFor > goalsAgainst) block.win = numberValue(block.win) + 1;
  else if (goalsFor < goalsAgainst) block.lose = numberValue(block.lose) + 1;
  else block.draw = numberValue(block.draw) + 1;
  block.goals = block.goals && typeof block.goals === "object" ? block.goals : {};
  block.goals.for = numberValue(block.goals.for) + goalsFor;
  block.goals.against = numberValue(block.goals.against) + goalsAgainst;
}

function applyFixture(row: any, venue: "home" | "away", goalsFor: number, goalsAgainst: number, fixture: any) {
  updateBlock(row.all, goalsFor, goalsAgainst);
  updateBlock(row[venue], goalsFor, goalsAgainst);
  row.points = numberValue(row.points) + pointsFor(goalsFor, goalsAgainst);
  if (row.all && typeof row.all === "object") row.all.points = row.points;
  row.goalsDiff = numberValue(row?.all?.goals?.for) - numberValue(row?.all?.goals?.against);
  row._brainLive = {
    provisional: true,
    fixtureId: numberValue(fixture?.fixture?.id),
    status: fixtureStatus(fixture),
  };
}

function absorbed(row: any, baseline: StandingSnapshot, goalsFor: number, goalsAgainst: number): boolean {
  const now = blockSnapshot(row);
  return now.played >= baseline.played + 1 &&
    now.goalsFor >= baseline.goalsFor + goalsFor &&
    now.goalsAgainst >= baseline.goalsAgainst + goalsAgainst &&
    now.points >= baseline.points + pointsFor(goalsFor, goalsAgainst);
}

/**
 * Salva il riferimento ufficiale appena una gara entra nel feed LIVE. Avviene
 * in background e usa la cache oraria condivisa delle classifiche: anche se
 * nessun utente apre la pagina durante il match, BrainLive può mantenere il
 * risultato provvisorio dopo il fischio finale senza rischiare doppi conteggi.
 */
export async function primeLiveStandingsBaselines(
  liveFixtures: any[],
  loadStandings: (leagueId: number, season: number) => Promise<any>,
) {
  const grouped = new Map<string, any[]>();
  for (const fixture of Array.isArray(liveFixtures) ? liveFixtures : []) {
    const id = numberValue(fixture?.fixture?.id);
    if (id <= 0 || baselines.has(id) || !ACTIVE.has(fixtureStatus(fixture))) continue;
    const league = fixtureLeague(fixture);
    if (league.leagueId <= 0 || league.season <= 0) continue;
    const key = `${league.leagueId}:${league.season}`;
    const rows = grouped.get(key) ?? [];
    rows.push(fixture);
    grouped.set(key, rows);
  }

  await Promise.all(
    [...grouped.entries()].map(async ([key, fixtures]) => {
      const existing = baselineLoads.get(key);
      if (existing) return existing;
      const league = fixtureLeague(fixtures[0]);
      const load = (async () => {
        const payload = await loadStandings(league.leagueId, league.season);
        const tables: any[][] = (Array.isArray(payload?.response) ? payload.response : [])
          .flatMap((entry: any) =>
            Array.isArray(entry?.league?.standings) ? entry.league.standings : [],
          )
          .filter(Array.isArray);
        for (const fixture of fixtures) {
          const id = numberValue(fixture?.fixture?.id);
          const homeId = numberValue(fixture?.teams?.home?.id);
          const awayId = numberValue(fixture?.teams?.away?.id);
          for (const table of tables) {
            const home = table.find((row: any) => numberValue(row?.team?.id) === homeId);
            const away = table.find((row: any) => numberValue(row?.team?.id) === awayId);
            if (!home || !away) continue;
            if (!baselines.has(id)) {
              baselines.set(id, { home: blockSnapshot(home), away: blockSnapshot(away) });
            }
            break;
          }
        }
      })().finally(() => baselineLoads.delete(key));
      baselineLoads.set(key, load);
      return load;
    }),
  );
}

export function rememberCompletedStandingsFixture(fixture: any) {
  const id = numberValue(fixture?.fixture?.id);
  if (id <= 0 || !FINISHED.has(fixtureStatus(fixture))) return;
  recentActiveFixtures.delete(id);
  completedFixtures.set(id, { fixture, savedAt: Date.now() });
  pruneCompletedFixtures();
}

export function removeLiveStandingsFixture(fixtureId: number) {
  if (fixtureId > 0) recentActiveFixtures.delete(fixtureId);
}

function pruneCompletedFixtures() {
  const cutoff = Date.now() - 3 * 60 * 60_000;
  for (const [id, value] of completedFixtures) {
    if (value.savedAt < cutoff) {
      completedFixtures.delete(id);
      baselines.delete(id);
    }
  }
}

export function projectLiveStandings(
  officialPayload: any,
  liveFixtures: any[],
  leagueId: number,
  season: number,
): any {
  const clone = JSON.parse(JSON.stringify(officialPayload ?? {}));
  const response = Array.isArray(clone?.response) ? clone.response : [];
  const tables: any[][] = response.flatMap((entry: any) =>
    Array.isArray(entry?.league?.standings) ? entry.league.standings : []
  ).filter(Array.isArray);
  if (tables.length === 0) return clone;

  pruneCompletedFixtures();
  const providerRows = (Array.isArray(liveFixtures) ? liveFixtures : []).filter((fixture) => {
    const league = fixtureLeague(fixture);
    return league.leagueId === leagueId && league.season === season;
  });
  const presentIds = new Set<number>();
  const current: any[] = [];
  for (const fixture of providerRows) {
    const id = numberValue(fixture?.fixture?.id);
    if (id <= 0) continue;
    presentIds.add(id);
    if (ACTIVE.has(fixtureStatus(fixture))) {
      recentActiveFixtures.set(id, { fixture, seenAt: Date.now() });
      current.push(fixture);
    } else {
      // Sospesa/interrotta/abbandonata: nessun dato provvisorio finché il
      // provider non segnala nuovamente uno stato di gioco attivo.
      recentActiveFixtures.delete(id);
    }
  }
  // Il feed /fixtures?live=all può rimuovere una gara pochi secondi prima che
  // il controllo finale la registri. Manteniamo l'ultima fotografia attiva per
  // una breve finestra, evitando che la classifica "torni indietro".
  const activeGraceCutoff = Date.now() - 45_000;
  for (const [id, value] of recentActiveFixtures) {
    if (value.seenAt < activeGraceCutoff) {
      recentActiveFixtures.delete(id);
      continue;
    }
    const league = fixtureLeague(value.fixture);
    if (!presentIds.has(id) && league.leagueId === leagueId && league.season === season) {
      current.push(value.fixture);
    }
  }
  const pending = [...completedFixtures.values()].map((value) => value.fixture).filter((fixture) => {
    const league = fixtureLeague(fixture);
    return league.leagueId === leagueId && league.season === season;
  });
  const candidateById = new Map<number, any>();
  for (const fixture of [...current, ...pending]) {
    candidateById.set(numberValue(fixture?.fixture?.id), fixture);
  }
  const candidates = [...candidateById.values()];
  const projectedFixtureIds: number[] = [];
  const projectedTeamIds = new Set<number>();

  for (const fixture of candidates) {
    const id = numberValue(fixture?.fixture?.id);
    const homeId = numberValue(fixture?.teams?.home?.id);
    const awayId = numberValue(fixture?.teams?.away?.id);
    const homeGoals = numberValue(fixture?.goals?.home);
    const awayGoals = numberValue(fixture?.goals?.away);
    if (id <= 0 || homeId <= 0 || awayId <= 0) continue;

    let homeRow: any;
    let awayRow: any;
    let containingTable: any[] | null = null;
    for (const table of tables) {
      const candidateHome = table.find((row: any) => numberValue(row?.team?.id) === homeId);
      const candidateAway = table.find((row: any) => numberValue(row?.team?.id) === awayId);
      if (candidateHome && candidateAway) {
        homeRow = candidateHome;
        awayRow = candidateAway;
        containingTable = table;
        break;
      }
    }
    if (!homeRow || !awayRow || !containingTable) continue;

    let baseline = baselines.get(id);
    const isActive = ACTIVE.has(fixtureStatus(fixture));
    if (!baseline && isActive) {
      baseline = { home: blockSnapshot(homeRow), away: blockSnapshot(awayRow) };
      baselines.set(id, baseline);
    }
    // Un finale viene mantenuto solo se BrainLive possiede il riferimento
    // ufficiale precedente. Così un riavvio non può creare doppi conteggi.
    if (!isActive && !baseline) continue;
    if (!isActive && baseline &&
        absorbed(homeRow, baseline.home, homeGoals, awayGoals) &&
        absorbed(awayRow, baseline.away, awayGoals, homeGoals)) {
      completedFixtures.delete(id);
      baselines.delete(id);
      continue;
    }

    applyFixture(homeRow, "home", homeGoals, awayGoals, fixture);
    applyFixture(awayRow, "away", awayGoals, homeGoals, fixture);
    projectedFixtureIds.push(id);
    projectedTeamIds.add(homeId);
    projectedTeamIds.add(awayId);
  }

  if (projectedFixtureIds.length > 0) {
    for (const table of tables) {
      table.sort((a: any, b: any) =>
        numberValue(b?.points) - numberValue(a?.points) ||
        numberValue(b?.goalsDiff) - numberValue(a?.goalsDiff) ||
        numberValue(b?.all?.goals?.for) - numberValue(a?.all?.goals?.for) ||
        numberValue(a?.rank) - numberValue(b?.rank)
      );
      table.forEach((row: any, index: number) => { row.rank = index + 1; });
    }
  }
  clone._brainLive = {
    provisional: projectedFixtureIds.length > 0,
    fixtureIds: projectedFixtureIds,
    teamIds: [...projectedTeamIds],
    updatedAt: new Date().toISOString(),
  };
  return clone;
}

export function resetLiveStandingsForTests() {
  completedFixtures.clear();
  baselines.clear();
  recentActiveFixtures.clear();
  baselineLoads.clear();
}
