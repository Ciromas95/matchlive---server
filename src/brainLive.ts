import { getCache, setCache } from "./cache";
import {
  markCacheHit,
  markCacheMiss,
  markBrainLiveRun,
  markBrainLiveFixturesScanned,
  markBrainLiveCandidates,
  getApiStats,
} from "./stats";
import { getTopLiveFixtures, getLiveFixtureStatisticsCached } from "./apiFootball";
import { evaluateLiveV4, LiveObservationV4, parseLiveStatsV4 } from "./liveStrategyV4";
import { sendBrainLivePush } from "./push";
import { loadBrainLiveState, saveBrainLiveState } from "./brainLiveState";
import { getLiveRawFixtures, hasLiveState } from "./liveState";

type BrainLiveCandidate = {
  fixtureId: number;
  statusShort: string | null;
  elapsed: number | null;
  league: {
    id: number | null;
    name: string | null;
    country: string | null;
    logo: string | null;
    flag: string | null;
  };
  home: {
    id: number | null;
    name: string | null;
    logo: string | null;
    goals: number;
  };
  away: {
    id: number | null;
    name: string | null;
    logo: string | null;
    goals: number;
  };
  lightScore: number;
  scoreHint: string;
};

type BrainLiveResult = {
  candidates: BrainLiveCandidate[];
  hot?: any;
  others?: any[];
  topLiveCount?: number;
};

type BrainLiveBuildOutput = {
  result: BrainLiveResult;
  topLiveCount: number;
};

const DEBUG_BRAIN_LIVE = false;
const liveHistory = new Map<number, LiveObservationV4[]>();
const halftimeBaselines = new Map<number, LiveObservationV4>();
const activeSignalScore = new Map<number, { home: number; away: number }>();
const activeSignals = new Map<number, any>();
const cooldownUntilMinute = new Map<number, number>();
const weakSignalObservations = new Map<number, number>();
const liveStatsSamples = new Map<number, { fetchedAt: number; raw: any }>();
let stateHydration: Promise<void> | null = null;

function hydratePersistentState() {
  return stateHydration ??= loadBrainLiveState().then((state) => {
    if (!state) return;
    for (const [id, value] of Object.entries(state.halftimeBaselines ?? {})) {
      halftimeBaselines.set(Number(id), value);
    }
    for (const [id, value] of Object.entries(state.activeSignalScore ?? {})) {
      activeSignalScore.set(Number(id), value);
    }
    for (const [id, value] of Object.entries(state.activeSignals ?? {})) {
      activeSignals.set(Number(id), value);
    }
    for (const [id, value] of Object.entries(state.cooldownUntilMinute ?? {})) {
      cooldownUntilMinute.set(Number(id), Number(value));
    }
    previousCandidateIds = new Set(state.previousCandidateIds ?? []);
  });
}

function persistState() {
  return saveBrainLiveState({
    halftimeBaselines: Object.fromEntries(halftimeBaselines),
    activeSignalScore: Object.fromEntries(activeSignalScore),
    activeSignals: Object.fromEntries(activeSignals),
    cooldownUntilMinute: Object.fromEntries(cooldownUntilMinute),
    previousCandidateIds: [...(previousCandidateIds ?? new Set<number>())],
  });
}

function statsForCurrentHalf(fixtureId: number, observation: LiveObservationV4): LiveObservationV4['stats'] | null {
  if (observation.elapsed <= 45) {
    halftimeBaselines.set(fixtureId, observation);
    return observation.stats;
  }
  const baseline = halftimeBaselines.get(fixtureId);
  if (!baseline) {
    // Se il server entra durante il 2T non conosce i valori dell'intervallo:
    // registra qui il punto zero e aspetta il prossimo aggiornamento. Usare i
    // totali della gara produrrebbe una lettura 2T falsa.
    halftimeBaselines.set(fixtureId, observation);
    return null;
  }
  const delta = (now: number | null, before: number | null) =>
    now == null ? null : Math.max(0, now - (before ?? 0));
  const secondMinutes = Math.max(1, observation.elapsed - 45);
  const periodPossession = (now: number | null, first: number | null) => {
    if (now == null || first == null) return now;
    return Math.max(0, Math.min(100,
      (now * observation.elapsed - first * 45) / secondMinutes));
  };
  const current = observation.stats;
  const first = baseline.stats;
  return {
    shotsHome: delta(current.shotsHome, first.shotsHome),
    shotsAway: delta(current.shotsAway, first.shotsAway),
    shotsOnGoalHome: delta(current.shotsOnGoalHome, first.shotsOnGoalHome),
    shotsOnGoalAway: delta(current.shotsOnGoalAway, first.shotsOnGoalAway),
    cornersHome: delta(current.cornersHome, first.cornersHome),
    cornersAway: delta(current.cornersAway, first.cornersAway),
    possessionHome: periodPossession(current.possessionHome, first.possessionHome),
    possessionAway: periodPossession(current.possessionAway, first.possessionAway),
    xgHome: delta(current.xgHome, first.xgHome),
    xgAway: delta(current.xgAway, first.xgAway),
    redsHome: delta(current.redsHome, first.redsHome),
    redsAway: delta(current.redsAway, first.redsAway),
    shotsInsideBoxHome: delta(current.shotsInsideBoxHome, first.shotsInsideBoxHome),
    shotsInsideBoxAway: delta(current.shotsInsideBoxAway, first.shotsInsideBoxAway),
    goalkeeperSavesHome: delta(current.goalkeeperSavesHome, first.goalkeeperSavesHome),
    goalkeeperSavesAway: delta(current.goalkeeperSavesAway, first.goalkeeperSavesAway),
  };
}

const LIVE_STATUSES = new Set(["1H", "2H", "HT", "ET", "LIVE"]);

const ALLOWED_LEAGUE_IDS = new Set<number>([
  61,  // Ligue 1
  140, // La Liga
  78,  // Bundesliga
  135, // Serie A
  94,  // Primeira Liga
  88,  // Eredivisie
  39,  // Premier League
  218, // Austria Bundesliga
  119, // Denmark Superliga
  144, // Jupiler Pro League
  2,   // Champions League
  3,   // Europa League
  137, // Coppa Italia
  207, // Switzerland Super League
]);

const finalResultTtlSec = () => 8;
const precomputedCacheTtlSec = () => 10;

const POLL_MS_NO_TOP_LIVE = 20_000;
const POLL_MS_FEW_TOP_LIVE = 5_000;
const POLL_MS_MANY_TOP_LIVE = 5_000;

function logDebug(...args: any[]) {
  if (DEBUG_BRAIN_LIVE) {
    console.log(...args);
  }
}

function getNextPollIntervalMs(topLiveCount: number): number {
  if (topLiveCount <= 0) return POLL_MS_NO_TOP_LIVE;
  if (topLiveCount <= 3) return POLL_MS_FEW_TOP_LIVE;
  return POLL_MS_MANY_TOP_LIVE;
}

function isAllowedLeague(f: any): boolean {
  const leagueId = Number(f?.league?.id ?? 0);
  if (ALLOWED_LEAGUE_IDS.has(leagueId)) return true;

  const name = String(f?.league?.name ?? "").toLowerCase();
  const country = String(f?.league?.country ?? "").toLowerCase();

  if (country === "france" && name === "ligue 1") return true;
  if (country === "spain" && name === "la liga") return true;
  if (country === "germany" && name === "bundesliga" && !name.includes("2.")) return true;
  if (country === "italy" && name === "serie a") return true;
  if (country === "portugal" && (name.includes("primeira liga") || name.includes("liga portugal"))) return true;
  if (country === "netherlands" && name.includes("eredivisie")) return true;
  if (country === "england" && name === "premier league") return true;
  if (country.includes("austria") && name.includes("bundesliga")) return true;
  if ((country.includes("denmark") || country.includes("danish")) && name.includes("superliga")) return true;
  if (country.includes("belgium") && (name.includes("jupiler") || name.includes("pro league"))) return true;
  if (name.includes("champions league")) return true;
  if (name.includes("europa league")) return true;
  if (country === "italy" && name.includes("coppa italia")) return true;
  if ((country.includes("switzerland") || country.includes("swiss")) && name.includes("super league")) return true;

  return false;
}

function isYouthOrReserveFixture(f: any): boolean {
  const leagueName = String(f?.league?.name ?? "").toLowerCase();
  const homeName = String(f?.teams?.home?.name ?? "").toLowerCase();
  const awayName = String(f?.teams?.away?.name ?? "").toLowerCase();

  const text = `${leagueName} ${homeName} ${awayName}`;

  return (
    text.includes("u17") ||
    text.includes("u18") ||
    text.includes("u19") ||
    text.includes("u20") ||
    text.includes("u21") ||
    text.includes("u23") ||
    text.includes("youth") ||
    text.includes("reserve") ||
    text.includes("reserves") ||
    text.includes("women")
  );
}

function isUsefulLiveFixture(f: any): boolean {
  const status = String(f?.fixture?.status?.short ?? "").toUpperCase();
  const elapsed = Number(f?.fixture?.status?.elapsed ?? 0);

  if (!LIVE_STATUSES.has(status)) return false;
  if (elapsed < 1) return false;
  if (elapsed > 80 || (elapsed >= 35 && elapsed < 46)) return false;
  if (!isAllowedLeague(f)) return false;
  if (isYouthOrReserveFixture(f)) return false;

  return true;
}

export function isLiveSignalDiscoveryMinute(elapsed: number): boolean {
  return (elapsed >= 4 && elapsed <= 34) || (elapsed >= 46 && elapsed <= 80);
}

export function shouldRetainLiveSignal(
  discoveredAt: number,
  currentElapsed: number,
  statusShort: string,
): boolean {
  const status = statusShort.toUpperCase();
  if (!["1H", "2H", "HT", "ET", "LIVE"].includes(status)) return false;
  if (discoveredAt <= 45) return status === "1H" || status === "HT";
  return currentElapsed <= 88;
}

function getScoreHint(f: any): string {
  const homeGoals = Number(f?.goals?.home ?? 0);
  const awayGoals = Number(f?.goals?.away ?? 0);
  const totalGoals = homeGoals + awayGoals;
  const goalDiff = Math.abs(homeGoals - awayGoals);

  if (
    (homeGoals === 0 && awayGoals === 0) ||
    (homeGoals === 1 && awayGoals === 0) ||
    (homeGoals === 0 && awayGoals === 1) ||
    (homeGoals === 1 && awayGoals === 1)
  ) {
    return "open-score";
  }

  if (totalGoals <= 3 && goalDiff <= 1) {
    return "balanced";
  }

  if (goalDiff >= 2) {
    return "one-sided";
  }

  return "generic";
}

function getLightCandidateScore(f: any): number {
  const elapsed = Number(f?.fixture?.status?.elapsed ?? 0);
  const homeGoals = Number(f?.goals?.home ?? 0);
  const awayGoals = Number(f?.goals?.away ?? 0);
  const totalGoals = homeGoals + awayGoals;
  const goalDiff = Math.abs(homeGoals - awayGoals);
  const leagueId = Number(f?.league?.id ?? 0);

  let score = 0;

  if (elapsed >= 1 && elapsed < 18) score += 22;
  if (elapsed >= 18 && elapsed <= 40) score += 16;
  if (elapsed >= 46 && elapsed <= 70) score += 20;
  if (elapsed > 70 && elapsed <= 89) score += 4;

  if (
    (homeGoals === 0 && awayGoals === 0) ||
    (homeGoals === 1 && awayGoals === 0) ||
    (homeGoals === 0 && awayGoals === 1) ||
    (homeGoals === 1 && awayGoals === 1)
  ) {
    score += 24;
  } else if (totalGoals <= 3 && goalDiff <= 1) {
    score += 12;
  } else if (goalDiff >= 2) {
    score -= 12;
  }

  if ([39, 140, 135, 78, 61, 2, 3].includes(leagueId)) {
    score += 8;
  }

  if (goalDiff === 0) score += 6;

  return score;
}

function dedupeByFixture(fixtures: any[]): any[] {
  const seen = new Set<number>();
  const result: any[] = [];

  for (const f of fixtures) {
    const fixtureId = Number(f?.fixture?.id ?? 0);
    if (!fixtureId) continue;
    if (seen.has(fixtureId)) continue;
    seen.add(fixtureId);
    result.push(f);
  }

  return result;
}

function toCandidate(f: any): BrainLiveCandidate | null {
  const fixtureId = Number(f?.fixture?.id ?? 0);
  if (!fixtureId) return null;

  const elapsedRaw = Number(f?.fixture?.status?.elapsed ?? 0);
  const elapsed = Number.isFinite(elapsedRaw) ? elapsedRaw : null;

  return {
    fixtureId,
    statusShort: f?.fixture?.status?.short ?? null,
    elapsed,
    league: {
      id: f?.league?.id ?? null,
      name: f?.league?.name ?? null,
      country: f?.league?.country ?? null,
      logo: f?.league?.logo ?? null,
      flag: f?.league?.flag ?? null,
    },
    home: {
      id: f?.teams?.home?.id ?? null,
      name: f?.teams?.home?.name ?? null,
      logo: f?.teams?.home?.logo ?? null,
      goals: Number(f?.goals?.home ?? 0),
    },
    away: {
      id: f?.teams?.away?.id ?? null,
      name: f?.teams?.away?.name ?? null,
      logo: f?.teams?.away?.logo ?? null,
      goals: Number(f?.goals?.away ?? 0),
    },
    lightScore: getLightCandidateScore(f),
    scoreHint: getScoreHint(f),
  };
}

function getLightResultCacheKey(maxResults: number): string {
  return `brainLive_light_candidates_${maxResults}`;
}

function getPrecomputedCacheKey(maxResults: number): string {
  return `brainLive_precomputed_${maxResults}`;
}

function getBrainLiveFromCache(maxResults: number): BrainLiveResult | null {
  const raw = getCache<any>(getPrecomputedCacheKey(maxResults));

  if (!raw || !Array.isArray(raw?.candidates)) {
    return null;
  }

  return raw as BrainLiveResult;
}

async function loadSharedLiveFixtures(): Promise<any[]> {
  const shared = getLiveRawFixtures();
  if (hasLiveState()) return shared;
  const raw = await getTopLiveFixtures("brainLive");
  return Array.isArray(raw?.response) ? raw.response : [];
}

function statisticsCadenceMs(candidate: BrainLiveCandidate): number {
  if (activeSignals.has(candidate.fixtureId)) return 6_000;
  if (candidate.lightScore >= 5) return 10_000;
  if (candidate.lightScore >= 3) return 16_000;
  return 25_000;
}

async function loadAdaptiveStatistics(candidate: BrainLiveCandidate): Promise<any> {
  const cadenceMs = statisticsCadenceMs(candidate);
  const previous = liveStatsSamples.get(candidate.fixtureId);
  if (previous && Date.now() - previous.fetchedAt < cadenceMs) return previous.raw;

  try {
    const raw = await getLiveFixtureStatisticsCached(
      candidate.fixtureId,
      Math.max(4, Math.ceil(cadenceMs / 1000)),
    );
    liveStatsSamples.set(candidate.fixtureId, { fetchedAt: Date.now(), raw });
    return raw;
  } catch {
    return previous?.raw ?? null;
  }
}

async function buildBrainLive(maxResults: number = 8): Promise<BrainLiveBuildOutput> {
  await hydratePersistentState();
  const cacheKey = getLightResultCacheKey(maxResults);
  const cached = getCache<BrainLiveResult>(cacheKey);

  if (cached) {
    markCacheHit();
    return {
      result: cached,
      topLiveCount: Number(cached.topLiveCount ?? cached.candidates.length ?? 0),
    };
  }

  markCacheMiss();

  const startedAt = Date.now();
  markBrainLiveRun();

  const fixtures = await loadSharedLiveFixtures();
  markBrainLiveFixturesScanned(fixtures.length);

  const filtered = fixtures.filter(isUsefulLiveFixture);

  const preliminary = dedupeByFixture(filtered)
    .map((f) => ({
      fixture: f,
      lightScore: getLightCandidateScore(f),
    }))
    .filter((x) => x.lightScore > 0)
    .sort((a, b) => {
      if (b.lightScore !== a.lightScore) return b.lightScore - a.lightScore;

      const aElapsed = Number(a.fixture?.fixture?.status?.elapsed ?? 0);
      const bElapsed = Number(b.fixture?.fixture?.status?.elapsed ?? 0);
      return aElapsed - bElapsed;
    })
    .slice(0, Math.max(maxResults, 40))
    .map((x) => toCandidate(x.fixture))
    .filter((x): x is BrainLiveCandidate => x != null);

  for (const fixture of fixtures) {
    const id = Number(fixture?.fixture?.id ?? 0);
    const home = Number(fixture?.goals?.home ?? 0);
    const away = Number(fixture?.goals?.away ?? 0);
    const elapsed = Number(fixture?.fixture?.status?.elapsed ?? 0);
    const baseline = activeSignalScore.get(id);
    if (baseline && (home !== baseline.home || away !== baseline.away)) {
      // Il risultato è cambiato: l'obiettivo della card precedente è concluso.
      // Ripartiamo da statistiche successive al gol dopo tre minuti di verifica.
      activeSignalScore.delete(id);
      activeSignals.delete(id);
      cooldownUntilMinute.set(id, elapsed + 3);
      liveHistory.delete(id);
    }
  }
  const evaluated: any[] = [];
  for (let index = 0; index < preliminary.length; index += 3) {
    const batch = await Promise.all(preliminary.slice(index, index + 3).map(async (candidate) => {
      const cooldown = cooldownUntilMinute.get(candidate.fixtureId) ?? 0;
      if ((candidate.elapsed ?? 0) < cooldown) return null;
      const rawStats = await loadAdaptiveStatistics(candidate);
      const statistics = parseLiveStatsV4(rawStats, candidate.home.id ?? 0, candidate.away.id ?? 0);
      if (!statistics || candidate.elapsed == null) return null;
      const fullObservation: LiveObservationV4 = {
        elapsed: candidate.elapsed, homeGoals: candidate.home.goals,
        awayGoals: candidate.away.goals, stats: statistics,
      };
      if (fullObservation.elapsed <= 45) {
        halftimeBaselines.set(candidate.fixtureId, fullObservation);
      }
      const periodStats = statsForCurrentHalf(candidate.fixtureId, fullObservation);
      if (!periodStats) return null;
      const observation: LiveObservationV4 = {
        ...fullObservation,
        phaseElapsed: fullObservation.elapsed > 45
          ? fullObservation.elapsed - 45
          : fullObservation.elapsed,
        stats: periodStats,
      };
      const history = liveHistory.get(candidate.fixtureId) ?? [];
      const previous = [...history].reverse().find((item) =>
        (item.elapsed > 45) === (observation.elapsed > 45) &&
        observation.elapsed - item.elapsed >= 1 && observation.elapsed - item.elapsed <= 12
      );
      const previous5 = [...history].reverse().find((item) =>
        (item.elapsed > 45) === (observation.elapsed > 45) &&
        observation.elapsed - item.elapsed >= 2 && observation.elapsed - item.elapsed <= 7
      );
      const last = history[history.length - 1];
      if (!last || last.elapsed !== observation.elapsed || JSON.stringify(last.stats) !== JSON.stringify(observation.stats)) {
        history.push(observation);
      }
      liveHistory.set(candidate.fixtureId, history.filter((item) => observation.elapsed - item.elapsed <= 15));
      const signal = evaluateLiveV4(observation, previous, previous5);
      if (!signal) {
        const active = activeSignals.get(candidate.fixtureId);
        if (!active) return null;
        const weakCount = (weakSignalObservations.get(candidate.fixtureId) ?? 0) + 1;
        weakSignalObservations.set(candidate.fixtureId, weakCount);
        // Isteresi: una sola fotografia debole non fa lampeggiare/sparire la card.
        if (weakCount >= 2) {
          activeSignals.delete(candidate.fixtureId);
          activeSignalScore.delete(candidate.fixtureId);
          weakSignalObservations.delete(candidate.fixtureId);
          return null;
        }
        const homeTarget = active.goalTarget === "home";
        const ownShots = homeTarget ? observation.stats.shotsHome : observation.stats.shotsAway;
        const ownSot = homeTarget ? observation.stats.shotsOnGoalHome : observation.stats.shotsOnGoalAway;
        const ownCorners = homeTarget ? observation.stats.cornersHome : observation.stats.cornersAway;
        const retained = {
          ...active,
          ...candidate,
          elapsed: candidate.elapsed,
          phase: observation.elapsed > 45 ? "2H" : "1H",
          phaseElapsed: observation.phaseElapsed,
          stats: observation.stats,
          interestingMicroInsight: `${ownShots ?? 0} tiri · ${ownSot ?? 0} nello specchio · ${ownCorners ?? 0} corner`,
        };
        activeSignals.set(candidate.fixtureId, retained);
        return retained;
      }
      weakSignalObservations.delete(candidate.fixtureId);
      activeSignalScore.set(candidate.fixtureId, {
        home: candidate.home.goals,
        away: candidate.away.goals,
      });
      const published = {
        ...candidate,
        ...signal,
        discoveredAt: candidate.elapsed,
        phase: observation.elapsed > 45 ? "2H" : "1H",
        phaseElapsed: observation.elapsed > 45
          ? observation.elapsed - 45
          : observation.elapsed,
        stats: observation.stats,
      };
      activeSignals.set(candidate.fixtureId, published);
      return published;
    }));
    evaluated.push(...batch.filter(Boolean));
  }
  const liveFixtureById = new Map(fixtures.map((fixture) => [Number(fixture?.fixture?.id ?? 0), fixture]));
  for (const fixtureId of liveStatsSamples.keys()) {
    if (!liveFixtureById.has(fixtureId)) liveStatsSamples.delete(fixtureId);
  }
  for (const [fixtureId, signal] of [...activeSignals.entries()]) {
    if (evaluated.some((candidate) => candidate.fixtureId === fixtureId)) continue;
    const fixture = liveFixtureById.get(fixtureId);
    const elapsed = Number(fixture?.fixture?.status?.elapsed ?? signal.elapsed ?? 0);
    const statusShort = String(fixture?.fixture?.status?.short ?? "").toUpperCase();
    const baseline = activeSignalScore.get(fixtureId);
    const homeGoals = Number(fixture?.goals?.home ?? signal.home?.goals ?? 0);
    const awayGoals = Number(fixture?.goals?.away ?? signal.away?.goals ?? 0);
    const scoreChanged = baseline != null &&
      (homeGoals !== baseline.home || awayGoals !== baseline.away);
    if (!fixture || scoreChanged || !shouldRetainLiveSignal(
      Number(signal.discoveredAt ?? signal.elapsed ?? 0), elapsed, statusShort,
    )) {
      activeSignals.delete(fixtureId);
      weakSignalObservations.delete(fixtureId);
      if (!fixture || !LIVE_STATUSES.has(statusShort)) activeSignalScore.delete(fixtureId);
      continue;
    }
    evaluated.push({
      ...signal,
      statusShort,
      elapsed,
      home: { ...signal.home, goals: homeGoals },
      away: { ...signal.away, goals: awayGoals },
    });
  }
  evaluated.sort((a, b) => b.finalScore - a.finalScore);
  const hot = evaluated.find((pick) => pick.tagType === "hot") ?? null;
  const others = evaluated.filter((pick) => pick.fixtureId !== hot?.fixtureId);
  const candidates: BrainLiveCandidate[] = evaluated;

  markBrainLiveCandidates(candidates.length);

  const result: BrainLiveResult = {
    candidates,
    hot,
    others,
    topLiveCount: filtered.length,
  };

  setCache(cacheKey, result, finalResultTtlSec());
  void persistState();

  const totalMs = Date.now() - startedAt;
  const stats = getApiStats();

  logDebug(
    `[brainLive] done | ms=${totalMs} | liveTotal=${fixtures.length} | filtered=${filtered.length} | candidates=${candidates.length} | providerCallsTotal=${stats.provider.callsTotal} | providerCallsToday=${stats.provider.callsToday} | appRequestsToday=${stats.traffic.appRequestsToday} | cacheHitsTotal=${stats.cache.hitsTotal} | cacheMissesTotal=${stats.cache.missesTotal}`
  );

  logDebug(
    "[brainLive] candidates",
    candidates.map((c) => ({
      fixtureId: c.fixtureId,
      match: `${c.home.name} vs ${c.away.name}`,
      minute: c.elapsed,
      lightScore: c.lightScore,
      scoreHint: c.scoreHint,
    }))
  );

  return {
    result,
    topLiveCount: filtered.length,
  };
}

async function refreshBrainLiveCache(maxResults: number = 8): Promise<BrainLiveBuildOutput> {
  const built = await buildBrainLive(maxResults);
  setCache(getPrecomputedCacheKey(maxResults), built.result, precomputedCacheTtlSec());
  return built;
}

function getDefaultBrainLivePayload(_maxResults: number = 8): BrainLiveResult {
  return {
    candidates: [],
    topLiveCount: 0,
  };
}

let brainLivePollerStarted = false;
let brainLivePollerBusy = false;
let brainLiveTimer: NodeJS.Timeout | null = null;
let previousCandidateIds: Set<number> | null = null;
import { canStartJobs, trackJob } from "./lifecycle";
import { markHealthActivity } from "./health";

async function notifyNewCandidates(candidates: BrainLiveCandidate[]) {
  await hydratePersistentState();
  const currentIds = new Set(candidates.map((candidate) => candidate.fixtureId));
  // Al primo ciclo dopo un deploy inizializziamo lo stato senza inviare
  // notifiche duplicate per match già rilevati.
  if (previousCandidateIds == null) {
    previousCandidateIds = currentIds;
    return;
  }
  for (const candidate of candidates) {
    if (previousCandidateIds.has(candidate.fixtureId)) continue;
    await sendBrainLivePush(
      candidate.fixtureId,
      candidate.home.name ?? "Casa",
      candidate.away.name ?? "Trasferta",
    );
  }
  previousCandidateIds = currentIds;
  await persistState();
}

function scheduleNextRun(run: () => Promise<void>, delayMs: number) {
  if (brainLiveTimer) {
    clearTimeout(brainLiveTimer);
  }

  brainLiveTimer = setTimeout(() => {
    if (canStartJobs()) void trackJob(run());
  }, delayMs);
}

function startBrainLivePoller(maxResults: number = 8): void {
  if (brainLivePollerStarted) {
    logDebug("[brainLive] poller already started");
    return;
  }

  brainLivePollerStarted = true;

  const run = async () => {
    if (!canStartJobs()) return;
    if (brainLivePollerBusy) {
      logDebug("[brainLive] poller skipped: previous run still in progress");
      scheduleNextRun(run, POLL_MS_FEW_TOP_LIVE);
      return;
    }

    brainLivePollerBusy = true;

    try {
      const built = await refreshBrainLiveCache(maxResults);
      await notifyNewCandidates(built.result.candidates);
      markHealthActivity("live");
      const nextMs = getNextPollIntervalMs(built.topLiveCount);

      logDebug(
        `[brainLive] next poll in ${nextMs}ms | topLiveCount=${built.topLiveCount}`
      );

      scheduleNextRun(run, nextMs);
    } catch (e: any) {
      console.error(
        "[brainLive] poller refresh error:",
        e?.response?.data ?? e?.message ?? e
      );

      scheduleNextRun(run, POLL_MS_FEW_TOP_LIVE);
    } finally {
      brainLivePollerBusy = false;
    }
  };

  void trackJob(run());

  logDebug(
    `[brainLive] dynamic top-live poller started | maxResults=${maxResults}`
  );
}

function stopBrainLivePoller(): void {
  if (brainLiveTimer) clearTimeout(brainLiveTimer);
  brainLiveTimer = null;
  brainLivePollerStarted = false;
}

export {
  buildBrainLive,
  refreshBrainLiveCache,
  getBrainLiveFromCache,
  getDefaultBrainLivePayload,
  startBrainLivePoller,
  stopBrainLivePoller,
};

export type {
  BrainLiveCandidate,
  BrainLiveResult,
};

export default buildBrainLive;
