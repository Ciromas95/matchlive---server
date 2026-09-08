import { promises as fs } from "node:fs";
import path from "node:path";
import * as api from "./apiFootball";
import { runOnce } from "./inflight";
import { shadowWriteDocument } from "./shadowStorage";

export type LineupStatus = "predicted" | "official" | "unavailable";

export type LineupPlayer = {
  id: number;
  name: string;
  photo: string | null;
  number: number | null;
  role: "P" | "D" | "C" | "A";
  probability: number;
  confirmed: boolean;
  rating?: number;
  events?: {
    goals?: number;
    assists?: number;
    yellow?: number;
    red?: number;
    in?: number;
    out?: number;
    substitution?: {
      direction: "in" | "out";
      minute: number;
      withId: number;
      withName: string;
    };
  };
  alternatives?: Array<{ id: number; name: string; probability: number }>;
};

export type LineupTeam = {
  id: number;
  name: string;
  logo: string | null;
  formation: string | null;
  coach: { name: string; photo: string | null } | null;
  starters: LineupPlayer[];
  bench: LineupPlayer[];
};

export type LineupResult = {
  fixtureId: number;
  kickoff?: string;
  status: LineupStatus;
  generatedAt: string;
  source: "brainlive" | "api-football" | "none";
  confidence: { score: number; label: "Bassa" | "Media" | "Alta" } | null;
  sample: { home: number; away: number };
  competition?: { id: number; name: string };
  teams: { home: LineupTeam | null; away: LineupTeam | null };
  accuracy?: {
    correct: number;
    total: number;
    percent: number;
    home: { correct: number; total: number; percent: number };
    away: { correct: number; total: number; percent: number };
  };
  message?: string;
};

type StoredPrediction = {
  prediction: LineupResult;
  official?: LineupResult;
  evaluatedAt?: string;
};
type Store = { version: 1; fixtures: Record<string, StoredPrediction> };

const volume = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
const storePath = path.resolve(
  (process.env.LINEUP_PREDICTIONS_FILE ?? "").trim() ||
    (volume ? path.join(volume, "lineup-predictions.json") : "data/lineup-predictions.json"),
);
let storeQueue: Promise<unknown> = Promise.resolve();
let storeMemory: Store | null = null;
let storeLoad: Promise<Store> | null = null;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const asList = (value: any): any[] => (Array.isArray(value) ? value : []);
const asNumber = (value: any): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const isLive = (short: string) => ["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT"].includes(short);
const isFinished = (short: string) => ["FT", "AET", "PEN"].includes(short);
const isCup = (name: string, round: string) =>
  /cup|coppa|copa|pokal|taça|taca|coupe|trophy|champions|europa|conference|supercop|super cup/i.test(`${name} ${round}`);
const isDecisiveRound = (round: string) =>
  /final|semi|quarter|round of 16|ottavi|quarti|semifinal/i.test(round);

async function readStore(): Promise<Store> {
  if (storeMemory) return storeMemory;
  storeLoad ??= (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
      storeMemory = parsed?.version === 1 && parsed?.fixtures
        ? parsed as Store
        : { version: 1, fixtures: {} };
    } catch {
      storeMemory = { version: 1, fixtures: {} };
    }
    return storeMemory;
  })();
  return storeLoad;
}

async function updateStore(action: (store: Store) => void) {
  const job = storeQueue.then(async () => {
    const store = await readStore();
    action(store);
    const entries = Object.entries(store.fixtures)
      .sort((a, b) => Date.parse(b[1].prediction.generatedAt) - Date.parse(a[1].prediction.generatedAt))
      .slice(0, 2500);
    store.fixtures = Object.fromEntries(entries);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(store), "utf8");
    await fs.rename(temporary, storePath);
    await shadowWriteDocument("lineup_predictions", "current", store, store.version);
  });
  storeQueue = job.catch(() => undefined);
  return job;
}

function roleOf(raw: any): "P" | "D" | "C" | "A" {
  const value = String(raw ?? "").toUpperCase();
  if (value === "G" || value.startsWith("GOAL")) return "P";
  if (value === "D" || value.startsWith("DEF")) return "D";
  if (value === "F" || value === "A" || value.startsWith("ATT") || value.startsWith("FORW")) return "A";
  return "C";
}

export function slotsForFormation(formation: string | null) {
  const numbers = String(formation ?? "4-3-3").split("-").map(Number).filter(Number.isFinite);
  if (numbers.length < 3 || numbers.reduce((a, b) => a + b, 0) !== 10) {
    return { P: 1, D: 4, C: 3, A: 3 };
  }
  return { P: 1, D: numbers[0], C: numbers.slice(1, -1).reduce((a, b) => a + b, 0), A: numbers.at(-1)! };
}

type Candidate = {
  id: number; name: string; photo: string | null; number: number | null;
  role: "P" | "D" | "C" | "A"; score: number; starts: number; bench: number;
  positionSamples: number; seasonStarts: number; seasonAppearances: number; seasonMinutes: number;
};

export function calculatePlayerProbability(candidate: Candidate, maxScore: number, samples: number, congested: boolean) {
  const history = maxScore > 0 ? candidate.score / maxScore : 0;
  const continuity = samples > 0 ? candidate.starts / samples : 0;
  const season = candidate.seasonAppearances > 0
    ? candidate.seasonStarts / candidate.seasonAppearances
    : 0;
  const roleStability = candidate.starts > 0 ? candidate.positionSamples / candidate.starts : 0;
  const raw = 30 + history * 37 + continuity * 16 + season * 9 + roleStability * 6 - (congested ? 4 : 0);
  return Math.round(clamp(raw, 28, 96));
}

function confidenceLabel(score: number): "Bassa" | "Media" | "Alta" {
  return score >= 78 ? "Alta" : score >= 58 ? "Media" : "Bassa";
}

function seasonPlayerMap(payload: any, teamId: number) {
  const map = new Map<number, { name: string; photo: string | null; role: "P" | "D" | "C" | "A"; starts: number; apps: number; minutes: number }>();
  for (const item of asList(payload?.response)) {
    const player = item?.player;
    if (!player?.id) continue;
    const stats = asList(item?.statistics).find((s) => Number(s?.team?.id) === teamId) ?? asList(item?.statistics)[0] ?? {};
    map.set(Number(player.id), {
      name: String(player.name ?? `Giocatore ${player.id}`),
      photo: player.photo ? String(player.photo) : null,
      role: roleOf(stats?.games?.position),
      starts: Number(stats?.games?.lineups ?? 0),
      apps: Number(stats?.games?.appearences ?? 0),
      minutes: Number(stats?.games?.minutes ?? 0),
    });
  }
  return map;
}

async function buildTeamPrediction(args: {
  team: any; opponentId: number; leagueId: number; leagueName: string; round: string;
  season: number; fixtureId: number; kickoff: number; injuries: Set<number>;
}): Promise<{ team: LineupTeam | null; samples: number; confidence: number }> {
  const recentPayload = await api.getTeamLastFixtures(Number(args.team.id), 8, "lineups");
  const recent = asList(recentPayload?.response)
    .filter((f) => Number(f?.fixture?.id) !== args.fixtureId && isFinished(String(f?.fixture?.status?.short ?? "")))
    .slice(0, 8);
  const ids = recent.map((f) => Number(f?.fixture?.id)).filter((id) => id > 0).slice(0, 7);
  const lineupResults = await Promise.allSettled(ids.map((id) => api.getFixtureLineupsCached(id, 7 * 24 * 3600)));
  const playerPayload = await api.getPlayersByTeam(Number(args.team.id), args.season).catch(() => ({ response: [] }));
  const players = seasonPlayerMap(playerPayload, Number(args.team.id));
  const candidates = new Map<number, Candidate>();
  const formations = new Map<string, number>();
  const coaches = new Map<string, { score: number; photo: string | null }>();
  let usable = 0;

  lineupResults.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const fixture = recent[index];
    const entry = asList(result.value?.response).find((l) => Number(l?.team?.id) === Number(args.team.id));
    if (!entry || asList(entry?.startXI).length < 7) return;
    usable += 1;
    const recency = Math.pow(0.84, index);
    const sameCompetition = Number(fixture?.league?.id) === args.leagueId;
    const historicalCup = isCup(String(fixture?.league?.name ?? ""), String(fixture?.league?.round ?? ""));
    const targetCup = isCup(args.leagueName, args.round);
    // Nelle fasi decisive di coppa le scelte fatte nella stessa competizione
    // descrivono il turnover meglio delle sole gare di campionato.
    const context = sameCompetition
      ? (targetCup && isDecisiveRound(args.round) ? 1.4 : 1.28)
      : historicalCup === targetCup ? 1 : 0.78;
    const weight = recency * context;
    const formation = String(entry?.formation ?? "").trim();
    if (formation) formations.set(formation, (formations.get(formation) ?? 0) + weight);
    const coachName = String(entry?.coach?.name ?? "").trim();
    if (coachName) coaches.set(coachName, { score: (coaches.get(coachName)?.score ?? 0) + weight, photo: entry?.coach?.photo ?? null });

    const add = (raw: any, starter: boolean) => {
      const p = raw?.player ?? raw;
      const id = Number(p?.id ?? 0);
      if (!id || args.injuries.has(id)) return;
      const season = players.get(id);
      const role = roleOf(p?.pos ?? season?.role);
      const current = candidates.get(id) ?? {
        id, name: String(p?.name ?? season?.name ?? `Giocatore ${id}`), photo: season?.photo ?? p?.photo ?? null,
        number: asNumber(p?.number), role, score: 0, starts: 0, bench: 0, positionSamples: 0,
        seasonStarts: season?.starts ?? 0, seasonAppearances: season?.apps ?? 0, seasonMinutes: season?.minutes ?? 0,
      };
      current.score += weight * (starter ? 1 : 0.16);
      if (starter) { current.starts += 1; current.positionSamples += current.role === role ? 1 : 0; }
      else current.bench += 1;
      candidates.set(id, current);
    };
    asList(entry?.startXI).forEach((p) => add(p, true));
    asList(entry?.substitutes).forEach((p) => add(p, false));
  });

  if (usable < 2 || candidates.size < 11) return { team: null, samples: usable, confidence: 0 };
  const formation = [...formations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "4-3-3";
  const slots = slotsForFormation(formation);
  const lastDate = Date.parse(String(recent[0]?.fixture?.date ?? ""));
  const congested = Number.isFinite(lastDate) && (args.kickoff - lastDate) / 86400000 <= 3.5;
  const selected: Candidate[] = [];
  const available = [...candidates.values()];
  for (const role of ["P", "D", "C", "A"] as const) {
    const rolePlayers = available.filter((p) => p.role === role).sort((a, b) => b.score - a.score || b.seasonMinutes - a.seasonMinutes);
    selected.push(...rolePlayers.slice(0, slots[role]));
  }
  if (selected.length < 11) {
    const selectedIds = new Set(selected.map((p) => p.id));
    selected.push(...available.filter((p) => !selectedIds.has(p.id)).sort((a, b) => b.score - a.score).slice(0, 11 - selected.length));
  }
  if (selected.length < 11) return { team: null, samples: usable, confidence: 0 };
  const maxScore = Math.max(...selected.map((p) => p.score), 0.01);
  const toPlayer = (p: Candidate, confirmed = false): LineupPlayer => ({
    id: p.id, name: p.name, photo: p.photo, number: p.number, role: p.role,
    probability: confirmed ? 100 : calculatePlayerProbability(p, maxScore, usable, congested), confirmed,
  });
  const starters = selected.slice(0, 11).map((candidate) => {
    const result = toPlayer(candidate);
    const rivals = available
      .filter((p) => p.id !== candidate.id && p.role === candidate.role && !selected.some((s) => s.id === p.id))
      .map((p) => ({ player: p, probability: calculatePlayerProbability(p, maxScore, usable, congested) }))
      .filter((p) => result.probability - p.probability <= 14)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 1);
    if (rivals.length) result.alternatives = rivals.map((p) => ({ id: p.player.id, name: p.player.name, probability: p.probability }));
    return result;
  });
  const selectedIds = new Set(starters.map((p) => p.id));
  const roleRank = { P: 0, D: 1, C: 2, A: 3 } as const;
  const bench = available
    .filter((p) => !selectedIds.has(p.id))
    .sort((a, b) => roleRank[a.role] - roleRank[b.role] || b.score - a.score)
    .slice(0, 12)
    .map((p) => toPlayer(p));
  const averageProbability = starters.reduce((sum, p) => sum + p.probability, 0) / starters.length;
  const formationStability = ([...formations.values()].sort((a, b) => b - a)[0] ?? 0) / ([...formations.values()].reduce((a, b) => a + b, 0) || 1);
  const confidence = Math.round(clamp(averageProbability * 0.72 + usable / 7 * 16 + formationStability * 12 - (congested ? 5 : 0), 35, 94));
  const coach = [...coaches.entries()].sort((a, b) => b[1].score - a[1].score)[0];
  return {
    samples: usable,
    confidence,
    team: {
      id: Number(args.team.id), name: String(args.team.name ?? "Squadra"), logo: args.team.logo ?? null,
      formation, coach: coach ? { name: coach[0], photo: coach[1].photo } : null, starters, bench,
    },
  };
}

export function eventMap(eventsPayload: any) {
  const map = new Map<number, NonNullable<LineupPlayer["events"]>>();
  const entry = (id: number) => map.get(id) ?? {};
  for (const event of asList(eventsPayload?.response)) {
    const id = Number(event?.player?.id ?? 0);
    const assistId = Number(event?.assist?.id ?? 0);
    const minute = Number(event?.time?.elapsed ?? 0) + Number(event?.time?.extra ?? 0);
    if (/goal/i.test(String(event?.type)) && !/missed|cancelled|disallowed/i.test(String(event?.detail))) {
      if (id) { const e = entry(id); e.goals = (e.goals ?? 0) + 1; map.set(id, e); }
      if (assistId) { const e = entry(assistId); e.assists = (e.assists ?? 0) + 1; map.set(assistId, e); }
    } else if (/card/i.test(String(event?.type))) {
      if (id) { const e = entry(id); if (/red|second yellow/i.test(String(event?.detail))) e.red = (e.red ?? 0) + 1; else e.yellow = (e.yellow ?? 0) + 1; map.set(id, e); }
    } else if (/subst/i.test(String(event?.type))) {
      if (id) {
        const e = entry(id);
        e.out = minute;
        e.substitution = {
          direction: "out",
          minute,
          withId: assistId,
          withName: String(event?.assist?.name ?? "").trim(),
        };
        map.set(id, e);
      }
      if (assistId) {
        const e = entry(assistId);
        e.in = minute;
        e.substitution = {
          direction: "in",
          minute,
          withId: id,
          withName: String(event?.player?.name ?? "").trim(),
        };
        map.set(assistId, e);
      }
    }
  }
  return map;
}

function ratingMap(payload: any) {
  const map = new Map<number, number>();
  for (const team of asList(payload?.response)) for (const item of asList(team?.players)) {
    const id = Number(item?.player?.id ?? 0);
    const rawRating = asList(item?.statistics)[0]?.games?.rating;
    if (rawRating == null || String(rawRating).trim() === "") continue;
    const rating = Number(rawRating);
    if (id && Number.isFinite(rating) && rating > 0) map.set(id, Math.round(rating * 10) / 10);
  }
  return map;
}

function officialTeam(raw: any, events: Map<number, any>, ratings: Map<number, number>): LineupTeam {
  const convert = (rawPlayer: any): LineupPlayer => {
    const p = rawPlayer?.player ?? rawPlayer;
    const id = Number(p?.id ?? 0);
    return { id, name: String(p?.name ?? "Giocatore"), photo: p?.photo ?? (id ? `https://media.api-sports.io/football/players/${id}.png` : null), number: asNumber(p?.number), role: roleOf(p?.pos), probability: 100, confirmed: true, rating: ratings.get(id), events: events.get(id) };
  };
  const roleRank = { P: 0, D: 1, C: 2, A: 3 } as const;
  const bench = asList(raw?.substitutes)
    .map(convert)
    .sort((a, b) => roleRank[a.role] - roleRank[b.role] || a.name.localeCompare(b.name));
  return {
    id: Number(raw?.team?.id ?? 0), name: String(raw?.team?.name ?? "Squadra"), logo: raw?.team?.logo ?? null,
    formation: raw?.formation ? String(raw.formation) : null,
    coach: raw?.coach?.name ? { name: String(raw.coach.name), photo: raw.coach.photo ?? null } : null,
    starters: asList(raw?.startXI).map(convert), bench,
  };
}

export function predictionAccuracy(prediction: LineupResult, official: LineupResult) {
  const side = (key: "home" | "away") => {
    const predictedIds = new Set((prediction.teams[key]?.starters ?? []).map((p) => p.id));
    const actual = (official.teams[key]?.starters ?? []).map((p) => p.id).filter(Boolean);
    const correct = actual.filter((id) => predictedIds.has(id)).length;
    return { correct, total: actual.length, percent: actual.length ? Math.round(correct / actual.length * 1000) / 10 : 0 };
  };
  const home = side("home"), away = side("away");
  const correct = home.correct + away.correct, total = home.total + away.total;
  return { correct, total, percent: total ? Math.round(correct / total * 1000) / 10 : 0, home, away };
}

export async function getLineupForFixture(fixtureId: number): Promise<LineupResult> {
  return runOnce(`lineupPrediction:${fixtureId}`, async () => {
    const storedBeforeFetch = (await readStore()).fixtures[String(fixtureId)];
    if (storedBeforeFetch?.prediction.status === "predicted") {
      const storedKickoff = Date.parse(storedBeforeFetch.prediction.kickoff ?? "");
      const storedAgeMinutes = (Date.now() - Date.parse(storedBeforeFetch.prediction.generatedAt)) / 60000;
      const storedMinutesToKickoff = Number.isFinite(storedKickoff)
        ? (storedKickoff - Date.now()) / 60000
        : 0;
      const storedMaxAge = storedMinutesToKickoff <= 1440 ? 90 : 360;
      if (storedMinutesToKickoff > 180 && storedAgeMinutes < storedMaxAge) {
        return storedBeforeFetch.prediction;
      }
    }
    let fixturePayload: any;
    try {
      fixturePayload = await api.getFixtureByIdCached(fixtureId, 30);
    } catch (error) {
      if (storedBeforeFetch?.official) return storedBeforeFetch.official;
      if (storedBeforeFetch?.prediction) return storedBeforeFetch.prediction;
      throw error;
    }
    const fixture = asList(fixturePayload?.response)[0];
    if (!fixture) throw Object.assign(new Error("Fixture non disponibile"), { status: 404 });
    const short = String(fixture?.fixture?.status?.short ?? "NS").toUpperCase();
    const kickoff = Date.parse(String(fixture?.fixture?.date ?? ""));
    const minutesToKickoff = Number.isFinite(kickoff) ? (kickoff - Date.now()) / 60000 : 9999;
    const officialTtl = isLive(short)
      ? 12
      : minutesToKickoff <= 90 ? 30 : minutesToKickoff <= 180 ? 120 : 5 * 60;
    const officialPayload = await api.getFixtureLineupsCached(fixtureId, officialTtl).catch(() => ({ response: [] }));
    const officialRows = asList(officialPayload?.response);
    const hasOfficial = officialRows.length >= 2 && officialRows.every((row) => asList(row?.startXI).length >= 11);
    const stored = (await readStore()).fixtures[String(fixtureId)];

    if (hasOfficial) {
      let events = new Map<number, any>();
      let ratings = new Map<number, number>();
      if (isLive(short) || isFinished(short)) {
        const eventTtl = isLive(short) ? 10 : 24 * 3600;
        const playerTtl = isLive(short) ? 30 : 24 * 3600;
        const [eventPayload, playerPayload] = await Promise.all([
          api.getFixtureEventsRealtimeCached(fixtureId, eventTtl).catch(() => null),
          api.getFixturePlayersCached(fixtureId, playerTtl).catch(() => null),
        ]);
        events = eventMap(eventPayload);
        ratings = ratingMap(playerPayload);
      }
      const homeId = Number(fixture?.teams?.home?.id ?? 0);
      const homeRow = officialRows.find((row) => Number(row?.team?.id) === homeId) ?? officialRows[0];
      const awayRow = officialRows.find((row) => Number(row?.team?.id) !== homeId) ?? officialRows[1];
      const result: LineupResult = {
        fixtureId, kickoff: fixture?.fixture?.date, status: "official", generatedAt: new Date().toISOString(), source: "api-football", confidence: { score: 100, label: "Alta" },
        sample: stored?.prediction.sample ?? { home: 0, away: 0 }, competition: { id: Number(fixture?.league?.id ?? 0), name: String(fixture?.league?.name ?? "") },
        teams: { home: officialTeam(homeRow, events, ratings), away: officialTeam(awayRow, events, ratings) },
      };
      if (stored?.prediction.status === "predicted") result.accuracy = predictionAccuracy(stored.prediction, result);
      if (!stored?.official || !stored.evaluatedAt) {
        await updateStore((store) => { store.fixtures[String(fixtureId)] = { prediction: stored?.prediction ?? result, official: result, evaluatedAt: new Date().toISOString() }; });
      }
      return result;
    }

    if (stored?.prediction.status === "predicted") {
      const ageMinutes = (Date.now() - Date.parse(stored.prediction.generatedAt)) / 60000;
      const maxAge = minutesToKickoff <= 180 ? 20 : minutesToKickoff <= 1440 ? 90 : 360;
      if (ageMinutes < maxAge) return stored.prediction;
    }

    const home = fixture?.teams?.home;
    const away = fixture?.teams?.away;
    const leagueId = Number(fixture?.league?.id ?? 0);
    const season = Number(fixture?.league?.season ?? new Date().getUTCFullYear());
    const leagueName = String(fixture?.league?.name ?? "");
    const round = String(fixture?.league?.round ?? "");
    const injuriesPayload = await api.getFixtureInjuriesCached(fixtureId).catch(() => ({ response: [] }));
    const unavailable = new Map<number, Set<number>>();
    for (const item of asList(injuriesPayload?.response)) {
      const teamId = Number(item?.team?.id ?? 0), playerId = Number(item?.player?.id ?? 0);
      if (!teamId || !playerId) continue;
      const set = unavailable.get(teamId) ?? new Set<number>(); set.add(playerId); unavailable.set(teamId, set);
    }
    const [homePrediction, awayPrediction] = await Promise.all([
      buildTeamPrediction({ team: home, opponentId: Number(away?.id), leagueId, leagueName, round, season, fixtureId, kickoff, injuries: unavailable.get(Number(home?.id)) ?? new Set() }),
      buildTeamPrediction({ team: away, opponentId: Number(home?.id), leagueId, leagueName, round, season, fixtureId, kickoff, injuries: unavailable.get(Number(away?.id)) ?? new Set() }),
    ]);
    if (!homePrediction.team || !awayPrediction.team) {
      return { fixtureId, kickoff: fixture?.fixture?.date, status: "unavailable", generatedAt: new Date().toISOString(), source: "none", confidence: null,
        sample: { home: homePrediction.samples, away: awayPrediction.samples }, teams: { home: homePrediction.team, away: awayPrediction.team },
        message: "Dati recenti insufficienti per una previsione affidabile." };
    }
    const score = Math.round((homePrediction.confidence + awayPrediction.confidence) / 2);
    const result: LineupResult = { fixtureId, kickoff: fixture?.fixture?.date, status: "predicted", generatedAt: new Date().toISOString(), source: "brainlive",
      confidence: { score, label: confidenceLabel(score) }, sample: { home: homePrediction.samples, away: awayPrediction.samples }, competition: { id: leagueId, name: leagueName },
      teams: { home: homePrediction.team, away: awayPrediction.team } };
    await updateStore((store) => { store.fixtures[String(fixtureId)] = { prediction: result }; });
    return result;
  });
}

export async function getLineupAccuracySummary() {
  const store = await readStore();
  const evaluated = Object.values(store.fixtures).filter((entry) => entry.official?.accuracy || entry.official);
  let correct = 0, total = 0;
  const byCompetition: Record<string, { correct: number; total: number; percent: number }> = {};
  const byTeam: Record<string, { correct: number; total: number; percent: number }> = {};
  for (const entry of evaluated) {
    if (!entry.official || entry.prediction.status !== "predicted") continue;
    const accuracy = predictionAccuracy(entry.prediction, entry.official);
    correct += accuracy.correct; total += accuracy.total;
    const competition = entry.prediction.competition?.name || "Altra competizione";
    const competitionRow = byCompetition[competition] ?? { correct: 0, total: 0, percent: 0 };
    competitionRow.correct += accuracy.correct; competitionRow.total += accuracy.total;
    competitionRow.percent = Math.round(competitionRow.correct / competitionRow.total * 1000) / 10;
    byCompetition[competition] = competitionRow;
    for (const side of ["home", "away"] as const) {
      const team = entry.prediction.teams[side];
      if (!team) continue;
      const sideAccuracy = accuracy[side];
      const key = `${team.id}:${team.name}`;
      const row = byTeam[key] ?? { correct: 0, total: 0, percent: 0 };
      row.correct += sideAccuracy.correct; row.total += sideAccuracy.total;
      row.percent = Math.round(row.correct / row.total * 1000) / 10;
      byTeam[key] = row;
    }
  }
  return { fixturesEvaluated: evaluated.length, correct, total, percent: total ? Math.round(correct / total * 1000) / 10 : 0, byCompetition, byTeam };
}
