import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type CounterKey =
  | "live"
  | "compact"
  | "events"
  | "stats"
  | "lineups"
  | "standings"
  | "brainPrematch"
  | "brainLive"
  | "other";

type BrainLiveMetrics = {
  runsTotal: number;
  runsToday: number;
  fixturesScannedTotal: number;
  fixturesScannedToday: number;
  candidatesTotal: number;
  candidatesToday: number;
  statsFetchedTotal: number;
  statsFetchedToday: number;
  statsCacheHitsTotal: number;
  statsCacheHitsToday: number;
};

type TrafficMetrics = {
  appRequestsTotal: number;
  appRequestsToday: number;
  appRequestsLastMinute: number;
  endpointByPathToday: Record<string, number>;
};

type ProviderMetrics = {
  callsTotal: number;
  callsToday: number;
  callsLastMinute: number;
  byTypeToday: Record<CounterKey, number>;
};

type ProviderHealthMetrics = {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

type ProviderQuotaMetrics = {
  day: string | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  minuteLimit: number | null;
  minuteRemaining: number | null;
  syncedAt: string | null;
  observedAt?: string | null;
};

type CacheMetrics = {
  hitsTotal: number;
  hitsToday: number;
  missesTotal: number;
  missesToday: number;
};

const DAILY_API_BUDGET = Number(process.env.API_DAILY_BUDGET ?? "75000");
const METRICS_STORE_PATH = process.env.METRICS_STORE_PATH ?? "/data/brainlive-api-metrics.json";
const API_KEY_FINGERPRINT = process.env.API_FOOTBALL_KEY
  ? createHash("sha256").update(process.env.API_FOOTBALL_KEY).digest("hex").slice(0, 16)
  : null;

let lastResetDay = new Date().toISOString().slice(0, 10);

const provider: ProviderMetrics = {
  callsTotal: 0,
  callsToday: 0,
  callsLastMinute: 0,
  byTypeToday: {
    live: 0,
    compact: 0,
    events: 0,
    stats: 0,
    lineups: 0,
    standings: 0,
    brainPrematch: 0,
    brainLive: 0,
    other: 0,
  },
};
const providerHealth: ProviderHealthMetrics = {
  successes: 0,
  failures: 0,
  consecutiveFailures: 0,
  lastLatencyMs: null,
  lastSuccessAt: null,
  lastFailureAt: null,
};
const providerLatencySamples: number[] = [];

const providerQuota: ProviderQuotaMetrics = {
  day: null,
  dailyLimit: null,
  dailyRemaining: null,
  minuteLimit: null,
  minuteRemaining: null,
  syncedAt: null,
};

const traffic: TrafficMetrics = {
  appRequestsTotal: 0,
  appRequestsToday: 0,
  appRequestsLastMinute: 0,
  endpointByPathToday: {},
};

const cache: CacheMetrics = {
  hitsTotal: 0,
  hitsToday: 0,
  missesTotal: 0,
  missesToday: 0,
};

const brainLive: BrainLiveMetrics = {
  runsTotal: 0,
  runsToday: 0,
  fixturesScannedTotal: 0,
  fixturesScannedToday: 0,
  candidatesTotal: 0,
  candidatesToday: 0,
  statsFetchedTotal: 0,
  statsFetchedToday: 0,
  statsCacheHitsTotal: 0,
  statsCacheHitsToday: 0,
};

type PersistedMetrics = {
  apiKeyFingerprint?: string | null;
  lastResetDay?: string;
  provider?: Partial<ProviderMetrics>;
  providerQuota?: Partial<ProviderQuotaMetrics>;
  traffic?: Partial<TrafficMetrics>;
  cache?: Partial<CacheMetrics>;
  brainLive?: Partial<BrainLiveMetrics>;
};

/**
 * Il volume /data di Railway sopravvive ai deploy: salva qui quota e dettaglio
 * della dashboard, così un riavvio non fa sembrare azzerato il consumo reale.
 */
function restoreMetrics() {
  try {
    if (!fs.existsSync(METRICS_STORE_PATH)) return;
    const saved = JSON.parse(fs.readFileSync(METRICS_STORE_PATH, "utf8")) as PersistedMetrics;
    if (typeof saved.lastResetDay === "string") lastResetDay = saved.lastResetDay;
    const sameProviderAccount = saved.apiKeyFingerprint === API_KEY_FINGERPRINT;
    Object.assign(provider, saved.provider ?? {});
    Object.assign(provider.byTypeToday, saved.provider?.byTypeToday ?? {});
    if (sameProviderAccount) {
      Object.assign(providerQuota, saved.providerQuota ?? {});
    } else {
      provider.callsToday = 0;
      provider.callsLastMinute = 0;
      Object.keys(provider.byTypeToday).forEach((key) => {
        provider.byTypeToday[key as CounterKey] = 0;
      });
    }
    Object.assign(traffic, saved.traffic ?? {});
    Object.assign(traffic.endpointByPathToday, saved.traffic?.endpointByPathToday ?? {});
    Object.assign(cache, saved.cache ?? {});
    Object.assign(brainLive, saved.brainLive ?? {});
  } catch (error: any) {
    console.warn("[stats] impossibile ripristinare le metriche:", error?.message ?? error);
  }
}

function persistMetrics() {
  try {
    fs.mkdirSync(path.dirname(METRICS_STORE_PATH), { recursive: true });
    const tempPath = `${METRICS_STORE_PATH}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify({
        apiKeyFingerprint: API_KEY_FINGERPRINT,
        lastResetDay,
        provider,
        providerQuota,
        traffic,
        cache,
        brainLive,
      }),
      "utf8",
    );
    fs.renameSync(tempPath, METRICS_STORE_PATH);
  } catch (error: any) {
    // In sviluppo locale il volume potrebbe non esistere o non essere scrivibile.
    console.warn("[stats] impossibile salvare le metriche:", error?.message ?? error);
  }
}

restoreMetrics();

const minuteResetTimer = setInterval(() => {
  provider.callsLastMinute = 0;
  traffic.appRequestsLastMinute = 0;
}, 60_000);
minuteResetTimer.unref?.();

function resetIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);

  if (today !== lastResetDay) {
    lastResetDay = today;

    provider.callsToday = 0;
    provider.callsLastMinute = 0;
    Object.keys(provider.byTypeToday).forEach((k) => {
      provider.byTypeToday[k as CounterKey] = 0;
    });

    traffic.appRequestsToday = 0;
    traffic.appRequestsLastMinute = 0;
    Object.keys(traffic.endpointByPathToday).forEach((k) => {
      delete traffic.endpointByPathToday[k];
    });

    cache.hitsToday = 0;
    cache.missesToday = 0;

    brainLive.runsToday = 0;
    brainLive.fixturesScannedToday = 0;
    brainLive.candidatesToday = 0;
    brainLive.statsFetchedToday = 0;
    brainLive.statsCacheHitsToday = 0;
    persistMetrics();
  }
}

export function markApiCall(type: CounterKey) {
  resetIfNeeded();
  provider.callsTotal += 1;
  provider.callsToday += 1;
  provider.callsLastMinute += 1;
  provider.byTypeToday[type] += 1;
  persistMetrics();
}

export function markProviderResult(durationMs: number, successful: boolean) {
  const safeDuration = Math.max(0, Math.round(durationMs));
  providerHealth.lastLatencyMs = safeDuration;
  providerLatencySamples.push(safeDuration);
  if (providerLatencySamples.length > 120) providerLatencySamples.shift();
  if (successful) {
    providerHealth.successes += 1;
    providerHealth.consecutiveFailures = 0;
    providerHealth.lastSuccessAt = new Date().toISOString();
  } else {
    providerHealth.failures += 1;
    providerHealth.consecutiveFailures += 1;
    providerHealth.lastFailureAt = new Date().toISOString();
  }
}

function providerHealthSnapshot() {
  const sorted = [...providerLatencySamples].sort((a, b) => a - b);
  const average = sorted.length > 0
    ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
    : null;
  const p95 = sorted.length > 0
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
    : null;
  return {
    ...providerHealth,
    averageLatencyMs: average,
    p95LatencyMs: p95,
    sampleSize: sorted.length,
    status: providerHealth.consecutiveFailures >= 3
      ? "degraded"
      : (p95 != null && p95 > 4000 ? "slow" : "healthy"),
  };
}

/** Conteggio ufficiale restituito da API-Football in ogni risposta. */
export function syncProviderQuota(
  headers: any,
  requestedAt = Date.now(),
  authoritative = false,
) {
  const read = (name: string): unknown => {
    if (!headers) return null;
    if (typeof headers.get === "function") {
      const value = headers.get(name);
      if (value != null) return value;
    }
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) return value;
    }
    return null;
  };
  const number = (value: unknown, signed = false): number | null => {
    // Number(null), Number("") and Number(false) are zero, not quota readings.
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && (signed || parsed >= 0) ? parsed : null;
  };

  const dailyLimit = number(read("x-ratelimit-requests-limit"));
  const dailyRemaining = number(read("x-ratelimit-requests-remaining"), true);
  const minuteLimit = number(read("x-ratelimit-limit"));
  const minuteRemaining = number(read("x-ratelimit-remaining"));
  // A delayed response from before midnight cannot overwrite the new period.
  // Prefer the provider's HTTP Date, falling back to the request start time.
  const rawDate = read("date");
  const date = typeof rawDate === "string" ? Date.parse(rawDate) : NaN;
  const observedAt = Number.isFinite(date) && date <= Date.now() + 60_000
    ? date : requestedAt;
  const day = new Date(observedAt).toISOString().slice(0, 10);
  const previousAt = Date.parse(providerQuota.observedAt ?? providerQuota.syncedAt ?? "");
  if (providerQuota.day && day < providerQuota.day) return;
  if (Number.isFinite(previousAt) && observedAt < previousAt) return;

  // Never combine partial daily headers with a previous response or use minute
  // limits as daily limits. Error/429/timeout responses must preserve the count.
  if (dailyLimit != null && dailyLimit > 0 &&
      dailyRemaining != null && dailyRemaining <= dailyLimit) {
    const previousUsed = providerQuota.dailyLimit != null && providerQuota.dailyLimit > 0 &&
        providerQuota.dailyRemaining != null
      ? providerQuota.dailyLimit - providerQuota.dailyRemaining : null;
    const incomingUsed = dailyLimit - dailyRemaining;
    const samePeriod = providerQuota.day === day;
    const used = !authoritative && samePeriod && previousUsed != null
      ? Math.max(previousUsed, incomingUsed) : incomingUsed;
    providerQuota.dailyLimit = dailyLimit;
    providerQuota.dailyRemaining = dailyLimit - used;
    providerQuota.day = day;
    providerQuota.syncedAt = new Date().toISOString();
    providerQuota.observedAt = new Date(observedAt).toISOString();
    if (minuteLimit != null && minuteLimit > 0 &&
        minuteRemaining != null && minuteRemaining <= minuteLimit) {
      providerQuota.minuteLimit = minuteLimit;
      providerQuota.minuteRemaining = minuteRemaining;
    } else {
      providerQuota.minuteLimit = null;
      providerQuota.minuteRemaining = null;
    }
    persistMetrics();
  }
}

export function markCacheHit() {
  resetIfNeeded();
  cache.hitsTotal += 1;
  cache.hitsToday += 1;
  persistMetrics();
}

export function markCacheMiss() {
  resetIfNeeded();
  cache.missesTotal += 1;
  cache.missesToday += 1;
  persistMetrics();
}

export function markAppRequest(method: string, path: string) {
  resetIfNeeded();
  traffic.appRequestsTotal += 1;
  traffic.appRequestsToday += 1;
  traffic.appRequestsLastMinute += 1;

  const key = `${method} ${path}`;
  traffic.endpointByPathToday[key] = (traffic.endpointByPathToday[key] ?? 0) + 1;
  persistMetrics();
}

export function markBrainLiveRun() {
  resetIfNeeded();
  brainLive.runsTotal += 1;
  brainLive.runsToday += 1;
  persistMetrics();
}

export function markBrainLiveFixturesScanned(count: number) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.fixturesScannedTotal += safe;
  brainLive.fixturesScannedToday += safe;
  persistMetrics();
}

export function markBrainLiveCandidates(count: number) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.candidatesTotal += safe;
  brainLive.candidatesToday += safe;
  persistMetrics();
}

export function markBrainLiveStatsFetched(count: number = 1) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.statsFetchedTotal += safe;
  brainLive.statsFetchedToday += safe;
  persistMetrics();
}

export function markBrainLiveStatsCacheHit(count: number = 1) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.statsCacheHitsTotal += safe;
  brainLive.statsCacheHitsToday += safe;
  persistMetrics();
}

export function getApiStats() {
  resetIfNeeded();
  const today = new Date().toISOString().slice(0, 10);
  const quotaIsCurrent = providerQuota.day === today;
  // Calendar rollover only resets local activity, never the last official quota.
  // Keep an exhausted quota until a complete provider response confirms renewal.
  const officialLimit = providerQuota.dailyLimit != null && providerQuota.dailyLimit > 0
    ? providerQuota.dailyLimit : null;
  const officialRemaining = officialLimit != null ? providerQuota.dailyRemaining : null;
  const dailyBudget = officialLimit ?? DAILY_API_BUDGET;
  const officialUsed =
    officialLimit != null && officialRemaining != null
      ? Math.max(0, officialLimit - officialRemaining)
      : null;
  const externalToday = officialUsed ?? provider.callsToday;
  const officialMinuteUsed =
    quotaIsCurrent &&
    providerQuota.minuteLimit != null &&
    providerQuota.minuteRemaining != null
      ? Math.max(0, providerQuota.minuteLimit - providerQuota.minuteRemaining)
      : null;
  const externalLastMinute = officialMinuteUsed ?? provider.callsLastMinute;
  const memoryServedToday = cache.hitsToday;
  const memoryTotalToday = cache.hitsToday + cache.missesToday;
  const memorySaveRate = memoryTotalToday > 0 ? cache.hitsToday / memoryTotalToday : 0;
  const usedPct = dailyBudget > 0 ? externalToday / dailyBudget : 0;
  const classifiedToday = Object.values(provider.byTypeToday).reduce(
    (sum, value) => sum + (Number(value) || 0),
    0,
  );
  const beforeCurrentServer = Math.max(0, externalToday - classifiedToday);
  const topExternal = readableProviderUsage(
    provider.byTypeToday,
    beforeCurrentServer,
  );
  const topAppSections = readableEndpointUsage(traffic.endpointByPathToday);

  return {
    provider: {
      callsTotal: provider.callsTotal,
      callsToday: externalToday,
      callsLastMinute: externalLastMinute,
      countedByServerToday: provider.callsToday,
      byTypeToday: { ...provider.byTypeToday },
      quota: {
        dailyLimit: officialLimit,
        dailyRemaining: officialRemaining,
        minuteLimit: quotaIsCurrent ? providerQuota.minuteLimit : null,
        minuteRemaining: quotaIsCurrent ? providerQuota.minuteRemaining : null,
        syncedAt: providerQuota.syncedAt,
        awaitingRenewal: officialUsed != null && !quotaIsCurrent,
        isOfficial: officialUsed != null,
      },
    },
    providerHealth: providerHealthSnapshot(),
    traffic: {
      appRequestsTotal: traffic.appRequestsTotal,
      appRequestsToday: traffic.appRequestsToday,
      appRequestsLastMinute: traffic.appRequestsLastMinute,
      endpointByPathToday: { ...traffic.endpointByPathToday },
    },
    cache: {
      hitsTotal: cache.hitsTotal,
      hitsToday: cache.hitsToday,
      missesTotal: cache.missesTotal,
      missesToday: cache.missesToday,
    },
    brainLive: {
      runsTotal: brainLive.runsTotal,
      runsToday: brainLive.runsToday,
      fixturesScannedTotal: brainLive.fixturesScannedTotal,
      fixturesScannedToday: brainLive.fixturesScannedToday,
      candidatesTotal: brainLive.candidatesTotal,
      candidatesToday: brainLive.candidatesToday,
      statsFetchedTotal: brainLive.statsFetchedTotal,
      statsFetchedToday: brainLive.statsFetchedToday,
      statsCacheHitsTotal: brainLive.statsCacheHitsTotal,
      statsCacheHitsToday: brainLive.statsCacheHitsToday,
    },
    legacy: {
      today: externalToday,
      lastMinute: externalLastMinute,
      byTypeToday: { ...provider.byTypeToday },
      endpointHitsToday: traffic.appRequestsToday,
      endpointHitsLastMinute: traffic.appRequestsLastMinute,
      endpointByPathToday: { ...traffic.endpointByPathToday },
      cacheHits: cache.hitsTotal,
      cacheMisses: cache.missesTotal,
    },
    readable: {
      dailyBudget,
      externalCallsToday: externalToday,
      externalCallsLastMinute: externalLastMinute,
      externalBudgetUsedPct: usedPct,
      externalCallsRemainingEstimate:
        dailyBudget > 0 ? Math.max(0, dailyBudget - externalToday) : null,
      providerCountIsOfficial: officialUsed != null,
      providerSyncedAt: providerQuota.syncedAt,
      providerAwaitingRenewal: officialUsed != null && !quotaIsCurrent,
      providerCountNote:
        officialUsed != null
          ? (!quotaIsCurrent
              ? "Ultimo conteggio confermato. In attesa del rinnovo API-Football"
              : "Conteggio letto direttamente da API-Football")
          : "In attesa della prima risposta API-Football dopo l'avvio del server",
      memoryServedToday,
      memorySaveRate,
      appRequestsToday: traffic.appRequestsToday,
      appRequestsLastMinute: traffic.appRequestsLastMinute,
      mostExpensiveSections: topExternal,
      classifiedCallsToday: classifiedToday,
      callsBeforeCurrentServer: beforeCurrentServer,
      mostUsedAppSections: topAppSections,
      status: getReadableStatus(usedPct),
    },
  };
}

function getReadableStatus(usedPct: number) {
  if (usedPct >= 1) {
    return {
      label: "Quota esaurita",
      description: "Il consumo resta visibile fino al rinnovo confermato da API-Football.",
    };
  }
  if (usedPct >= 0.9) {
    return {
      label: "Consumo elevato",
      description:
        "Hai superato il 90% del budget giornaliero. La cache condivisa continua a proteggere il servizio.",
    };
  }
  if (usedPct >= 0.7) {
    return {
      label: "Attenzione",
      description:
        "Consumo alto ma ancora gestibile. Controlla quali sezioni stanno usando più chiamate.",
    };
  }
  return {
    label: "Normale",
    description: "Consumo sotto controllo. Il live classico resta in corsia veloce.",
  };
}

function readableProviderUsage(
  byType: Record<CounterKey, number>,
  beforeCurrentServer: number = 0,
) {
  const labels: Record<CounterKey, string> = {
    live: "Live classico",
    compact: "Liste partite",
    events: "Eventi partita",
    stats: "Statistiche",
    lineups: "Formazioni",
    standings: "Classifiche",
    brainPrematch: "Cervello Prematch",
    brainLive: "Cervello Live",
    other: "Altro",
  };

  const rows = Object.entries(byType)
    .map(([key, value]) => ({
      key,
      label: labels[key as CounterKey] ?? key,
      calls: Number(value) || 0,
    }))
    .filter((x) => x.calls > 0)
    .sort((a, b) => b.calls - a.calls);
  if (beforeCurrentServer > 0) {
    rows.push({
      key: "beforeCurrentServer",
      label: "Prima dell'ultimo avvio o da altri server",
      calls: beforeCurrentServer,
    });
  }
  return rows.sort((a, b) => b.calls - a.calls).slice(0, 9);
}

function readableEndpointUsage(byPath: Record<string, number>) {
  return Object.entries(byPath)
    .map(([path, requests]) => ({
      path,
      label: readablePath(path),
      requests: Number(requests) || 0,
    }))
    .filter((x) => x.requests > 0)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 8);
}

function readablePath(path: string) {
  if (path.includes("/api/live/compact")) return "Schermata Live";
  if (path.includes("/api/live")) return "Live classico";
  if (path.includes("/api/brain/prematch")) return "Cervello Prematch";
  if (path.includes("/api/brain/live")) return "Cervello Live";
  if (path.includes("/api/league/fixtures")) return "Partite campionato";
  if (path.includes("/api/metrics/heartbeat")) return "Utenti online";
  if (path.includes("/api/admin")) return "Pannello admin";
  return path.replace(/^GET /, "").replace(/^POST /, "");
}
