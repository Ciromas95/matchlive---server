export type CounterKey =
  | "live"
  | "compact"
  | "events"
  | "stats"
  | "lineups"
  | "other";

let apiCallsToday = 0;
let apiCallsLastMinute = 0;

let cacheHits = 0;
let cacheMisses = 0;

let lastResetDay = new Date().toISOString().slice(0, 10);

const byTypeToday: Record<CounterKey, number> = {
  live: 0,
  compact: 0,
  events: 0,
  stats: 0,
  lineups: 0,
  other: 0,
};

setInterval(() => {
  apiCallsLastMinute = 0;
}, 60000);

function resetIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDay) {
    apiCallsToday = 0;
    cacheHits = 0;
    cacheMisses = 0;
    Object.keys(byTypeToday).forEach(k => {
      byTypeToday[k as CounterKey] = 0;
    });
    lastResetDay = today;
  }
}

export function markApiCall(type: CounterKey) {
  resetIfNeeded();
  apiCallsToday++;
  apiCallsLastMinute++;
  byTypeToday[type]++;
}

export function markCacheHit() {
  resetIfNeeded();
  cacheHits++;
}

export function markCacheMiss() {
  resetIfNeeded();
  cacheMisses++;
}

export function getApiStats() {
  resetIfNeeded();
  return {
    today: apiCallsToday,
    lastMinute: apiCallsLastMinute,
    byTypeToday,
    cacheHits,
    cacheMisses,
  };
}