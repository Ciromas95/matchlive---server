export type CounterKey =
  | "live"
  | "compact"
  | "events"
  | "stats"
  | "lineups"
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

type CacheMetrics = {
  hitsTotal: number;
  hitsToday: number;
  missesTotal: number;
  missesToday: number;
};

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
    brainPrematch: 0,
    brainLive: 0,
    other: 0,
  },
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

setInterval(() => {
  provider.callsLastMinute = 0;
  traffic.appRequestsLastMinute = 0;
}, 60_000);

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
  }
}

export function markApiCall(type: CounterKey) {
  resetIfNeeded();
  provider.callsTotal += 1;
  provider.callsToday += 1;
  provider.callsLastMinute += 1;
  provider.byTypeToday[type] += 1;
}

export function markCacheHit() {
  resetIfNeeded();
  cache.hitsTotal += 1;
  cache.hitsToday += 1;
}

export function markCacheMiss() {
  resetIfNeeded();
  cache.missesTotal += 1;
  cache.missesToday += 1;
}

export function markAppRequest(method: string, path: string) {
  resetIfNeeded();
  traffic.appRequestsTotal += 1;
  traffic.appRequestsToday += 1;
  traffic.appRequestsLastMinute += 1;

  const key = `${method} ${path}`;
  traffic.endpointByPathToday[key] = (traffic.endpointByPathToday[key] ?? 0) + 1;
}

export function markBrainLiveRun() {
  resetIfNeeded();
  brainLive.runsTotal += 1;
  brainLive.runsToday += 1;
}

export function markBrainLiveFixturesScanned(count: number) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.fixturesScannedTotal += safe;
  brainLive.fixturesScannedToday += safe;
}

export function markBrainLiveCandidates(count: number) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.candidatesTotal += safe;
  brainLive.candidatesToday += safe;
}

export function markBrainLiveStatsFetched(count: number = 1) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.statsFetchedTotal += safe;
  brainLive.statsFetchedToday += safe;
}

export function markBrainLiveStatsCacheHit(count: number = 1) {
  resetIfNeeded();
  const safe = Math.max(0, Number(count) || 0);
  brainLive.statsCacheHitsTotal += safe;
  brainLive.statsCacheHitsToday += safe;
}

export function getApiStats() {
  resetIfNeeded();

  return {
    provider: {
      callsTotal: provider.callsTotal,
      callsToday: provider.callsToday,
      callsLastMinute: provider.callsLastMinute,
      byTypeToday: { ...provider.byTypeToday },
    },
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
      today: provider.callsToday,
      lastMinute: provider.callsLastMinute,
      byTypeToday: { ...provider.byTypeToday },
      endpointHitsToday: traffic.appRequestsToday,
      endpointHitsLastMinute: traffic.appRequestsLastMinute,
      endpointByPathToday: { ...traffic.endpointByPathToday },
      cacheHits: cache.hitsTotal,
      cacheMisses: cache.missesTotal,
    },
  };
}