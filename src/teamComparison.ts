import { getCache, setCache } from "./cache";
import { runOnce } from "./inflight";
import {
  getRedisCache,
  setRedisCache,
  withRedisSingleFlight,
} from "./redisInfrastructure";
import {
  getFixtureByIdCached,
  getFixtureStatisticsCached,
  getTeamSeasonFixturesCached,
} from "./apiFootball";

const FINISHED = new Set(["FT", "AET", "PEN", "PEN_FT"]);
const METRIC_ALIASES = {
  totalShots: new Set(["totalshots"]),
  shotsOnTarget: new Set(["shotsongoal", "shotsontarget"]),
  possession: new Set(["ballpossession", "possession"]),
  corners: new Set(["cornerkicks", "corners"]),
} as const;

type MetricKey =
  | "goalsFor"
  | "goalsAgainst"
  | "totalShots"
  | "shotsOnTarget"
  | "possession"
  | "corners";

type MetricValue = { average: number; samples: number };

export type ComparisonTeamPeriod = {
  matches: number;
  dateFrom: string | null;
  dateTo: string | null;
  metrics: Partial<Record<MetricKey, MetricValue>>;
};

export type ComparisonPeriodData = {
  home: ComparisonTeamPeriod;
  away: ComparisonTeamPeriod;
};

export type TeamComparisonPayload = {
  fixtureId: number;
  season: number;
  seasonLabel: string;
  generatedAt: string;
  period: "lastFive";
  data: ComparisonPeriodData;
  missingValuesAreZero: false;
};

export type TeamComparisonProvider = {
  getFixtureById(fixtureId: number): Promise<any>;
  getTeamSeasonFixtures(teamId: number, season: number): Promise<any>;
  getFixtureStatistics(fixtureId: number): Promise<any>;
};

const defaultProvider: TeamComparisonProvider = {
  getFixtureById: (fixtureId) => getFixtureByIdCached(fixtureId, 15 * 60),
  getTeamSeasonFixtures: getTeamSeasonFixturesCached,
  getFixtureStatistics: (fixtureId) =>
    getFixtureStatisticsCached(fixtureId, "other"),
};

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value ?? "").replace("%", "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function fixtureRows(payload: any): any[] {
  return Array.isArray(payload?.response) ? payload.response : [];
}

function fixtureTimestamp(row: any): number | null {
  const value = Date.parse(String(row?.fixture?.date ?? ""));
  return Number.isFinite(value) ? value : null;
}

function isFriendly(row: any): boolean {
  const name = String(row?.league?.name ?? "").toLowerCase();
  const type = String(row?.league?.type ?? "").toLowerCase();
  return /friendl|amichevol/.test(name) || /friendl|amichevol/.test(type);
}

/**
 * Seleziona esclusivamente gare ufficiali concluse della stagione richiesta e
 * precedenti al match aperto. Non completa mai il campione con altre stagioni.
 */
export function selectOfficialFixtures(
  payloads: any[],
  teamId: number,
  cutoffIso: string,
  currentFixtureId: number,
  season: number,
  limit?: number,
): any[] {
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) return [];
  const unique = new Map<number, any>();
  for (const payload of payloads) {
    for (const row of fixtureRows(payload)) {
      const id = numberValue(row?.fixture?.id);
      const date = fixtureTimestamp(row);
      const rowSeason = numberValue(row?.league?.season);
      const status = String(row?.fixture?.status?.short ?? "").toUpperCase();
      const homeId = numberValue(row?.teams?.home?.id);
      const awayId = numberValue(row?.teams?.away?.id);
      if (
        id == null ||
        id === currentFixtureId ||
        date == null ||
        date >= cutoff ||
        rowSeason !== season ||
        !FINISHED.has(status) ||
        isFriendly(row) ||
        (homeId !== teamId && awayId !== teamId)
      ) {
        continue;
      }
      unique.set(id, row);
    }
  }
  const rows = [...unique.values()].sort(
    (a, b) => (fixtureTimestamp(b) ?? 0) - (fixtureTimestamp(a) ?? 0),
  );
  return limit == null ? rows : rows.slice(0, Math.max(0, limit));
}

function finalScore(row: any): { home: number | null; away: number | null } {
  const status = String(row?.fixture?.status?.short ?? "").toUpperCase();
  const afterExtraTime = new Set(["AET", "PEN", "PEN_FT"]).has(status);
  const preferred = afterExtraTime ? row?.score?.extratime : row?.goals;
  const fallback = row?.goals ?? row?.score?.fulltime;
  return {
    home: numberValue(preferred?.home ?? fallback?.home),
    away: numberValue(preferred?.away ?? fallback?.away),
  };
}

function statisticsForTeam(payload: any, teamId: number): any[] | null {
  for (const entry of fixtureRows(payload)) {
    if (
      numberValue(entry?.team?.id) === teamId &&
      Array.isArray(entry?.statistics)
    ) {
      return entry.statistics;
    }
  }
  return null;
}

function statisticValue(
  statistics: any[] | null,
  aliases: ReadonlySet<string>,
): number | null {
  if (!statistics) return null;
  for (const row of statistics) {
    const key = String(row?.type ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (!aliases.has(key)) continue;
    return numberValue(row?.value);
  }
  return null;
}

function dateOnly(row: any): string | null {
  const value = String(row?.fixture?.date ?? "");
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : null;
}

/** Aggrega le medie usando, metrica per metrica, soltanto dati reali. */
export function aggregateTeamPeriod(
  rows: any[],
  teamId: number,
  statsByFixture: Map<number, any>,
): ComparisonTeamPeriod {
  const samples = new Map<MetricKey, number[]>([
    ["goalsFor", []],
    ["goalsAgainst", []],
    ["totalShots", []],
    ["shotsOnTarget", []],
    ["possession", []],
    ["corners", []],
  ]);

  for (const row of rows) {
    const homeId = numberValue(row?.teams?.home?.id);
    const awayId = numberValue(row?.teams?.away?.id);
    const score = finalScore(row);
    if (score.home != null && score.away != null) {
      if (homeId === teamId) {
        samples.get("goalsFor")!.push(score.home);
        samples.get("goalsAgainst")!.push(score.away);
      } else if (awayId === teamId) {
        samples.get("goalsFor")!.push(score.away);
        samples.get("goalsAgainst")!.push(score.home);
      }
    }

    const fixtureId = numberValue(row?.fixture?.id);
    const statistics = fixtureId == null
      ? null
      : statisticsForTeam(statsByFixture.get(fixtureId), teamId);
    for (const [metric, aliases] of Object.entries(METRIC_ALIASES) as [
      keyof typeof METRIC_ALIASES,
      ReadonlySet<string>,
    ][]) {
      const value = statisticValue(statistics, aliases);
      if (value != null) samples.get(metric)!.push(value);
    }
  }

  const metrics: Partial<Record<MetricKey, MetricValue>> = {};
  for (const [metric, values] of samples) {
    if (values.length === 0) continue;
    const average =
      values.reduce((sum, value) => sum + value, 0) / values.length;
    metrics[metric] = {
      average: Math.round(average * 10_000) / 10_000,
      samples: values.length,
    };
  }

  const dates = rows
    .map(dateOnly)
    .filter((value): value is string => value != null)
    .sort();
  return {
    matches: rows.length,
    dateFrom: dates[0] ?? null,
    dateTo: dates.length > 0 ? dates[dates.length - 1] : null,
    metrics,
  };
}

export function comparisonSeasonLabel(season: number, payloads: any[]): string {
  const years = payloads
    .flatMap(fixtureRows)
    .map((row) => fixtureTimestamp(row))
    .filter((value): value is number => value != null)
    .map((value) => new Date(value).getUTCFullYear());
  const spansNextYear = years.some((year) => year > season);
  return spansNextYear
    ? `${season}/${String((season + 1) % 100).padStart(2, "0")}`
    : String(season);
}

async function mapWithLimit<T, R>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        result[index] = await task(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return result;
}

async function cachedComparison<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const ttl = 15 * 60;
  const stale = 6 * 60 * 60;
  const local = getCache<T>(key);
  if (local != null) return local;
  const shared = await getRedisCache<T>(key);
  if (shared.value != null) {
    setCache(key, shared.value, ttl, stale);
    return shared.value;
  }
  return runOnce(key, () =>
    withRedisSingleFlight(
      key,
      async () => (await getRedisCache<T>(key)).value,
      async () => {
        const value = await task();
        // La scrittura avviene solo dopo il completamento di tutte le fixture:
        // gli errori temporanei non generano aggregati parziali definitivi.
        setCache(key, value, ttl, stale);
        await setRedisCache(key, value, ttl, stale);
        return value;
      },
      120_000,
      { followerWaitMs: 25_000, pollIntervalMs: 150 },
    ),
  );
}

export function comparisonCacheKey(input: {
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  season: number;
  cutoffIso: string;
}): string {
  const cutoff = Date.parse(input.cutoffIso);
  return [
    "teamComparison:v3",
    "lastFive",
    input.fixtureId,
    input.homeTeamId,
    input.awayTeamId,
    `season-${input.season}`,
    `before-${Number.isFinite(cutoff) ? cutoff : input.cutoffIso}`,
  ].join(":");
}

export function createTeamComparisonService(
  provider: TeamComparisonProvider = defaultProvider,
) {
  return async function getOverview(input: {
    fixtureId: number;
    homeTeamId: number;
    awayTeamId: number;
  }): Promise<TeamComparisonPayload> {
    const { fixtureId, homeTeamId, awayTeamId } = input;
    const details = await provider.getFixtureById(fixtureId);
    const current = fixtureRows(details)[0];
    if (!current) {
      throw Object.assign(new Error("Fixture not found"), { status: 404 });
    }
    const season = numberValue(current?.league?.season);
    const cutoffIso = String(current?.fixture?.date ?? "");
    const currentHome = numberValue(current?.teams?.home?.id);
    const currentAway = numberValue(current?.teams?.away?.id);
    if (season == null || !Number.isFinite(Date.parse(cutoffIso))) {
      throw Object.assign(new Error("Fixture season or date unavailable"), {
        status: 422,
      });
    }
    if (
      ![currentHome, currentAway].includes(homeTeamId) ||
      ![currentHome, currentAway].includes(awayTeamId) ||
      homeTeamId === awayTeamId
    ) {
      throw Object.assign(new Error("Teams do not match fixture"), {
        status: 400,
      });
    }

    const cacheKey = comparisonCacheKey({
      fixtureId,
      homeTeamId,
      awayTeamId,
      season,
      cutoffIso,
    });
    return cachedComparison(cacheKey, async () => {
      const [homeSeason, awaySeason] = await Promise.all([
        provider.getTeamSeasonFixtures(homeTeamId, season),
        provider.getTeamSeasonFixtures(awayTeamId, season),
      ]);
      const homeRows = selectOfficialFixtures(
        [homeSeason],
        homeTeamId,
        cutoffIso,
        fixtureId,
        season,
        5,
      );
      const awayRows = selectOfficialFixtures(
        [awaySeason],
        awayTeamId,
        cutoffIso,
        fixtureId,
        season,
        5,
      );
      const fixtureIds = [
        ...new Set(
          [...homeRows, ...awayRows]
            .map((row) => numberValue(row?.fixture?.id))
            .filter((value): value is number => value != null),
        ),
      ];
      // Un errore provider viene propagato: non salviamo un risultato parziale.
      const statisticPayloads = await mapWithLimit(
        fixtureIds,
        6,
        (id) => provider.getFixtureStatistics(id),
      );
      const statsByFixture = new Map<number, any>(
        fixtureIds.map((id, index) => [id, statisticPayloads[index]]),
      );
      const data: ComparisonPeriodData = {
        home: aggregateTeamPeriod(homeRows, homeTeamId, statsByFixture),
        away: aggregateTeamPeriod(awayRows, awayTeamId, statsByFixture),
      };
      return {
        fixtureId,
        season,
        seasonLabel: comparisonSeasonLabel(season, [homeSeason, awaySeason]),
        generatedAt: new Date().toISOString(),
        period: "lastFive",
        data,
        missingValuesAreZero: false,
      };
    });
  };
}

const defaultService = createTeamComparisonService();

export const getTeamComparisonOverview = (input: {
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
}) => defaultService(input);
