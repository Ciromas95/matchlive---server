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

let endpointHitsToday = 0;
let endpointHitsLastMinute = 0;
const endpointByPathToday: Record<string, number> = {};

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
  endpointHitsLastMinute = 0;
}, 60000);

function resetIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDay) {
apiCallsToday = 0;
cacheHits = 0;
cacheMisses = 0;
apiCallsLastMinute = 0;

endpointHitsToday = 0;
endpointHitsLastMinute = 0;
Object.keys(endpointByPathToday).forEach((k) => delete endpointByPathToday[k]);

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

export function markEndpointHit(method: string, path: string) {
  resetIfNeeded();
  endpointHitsToday++;
  endpointHitsLastMinute++;

  const key = `${method} ${path}`;
  endpointByPathToday[key] = (endpointByPathToday[key] ?? 0) + 1;
}

export function getApiStats() {
  resetIfNeeded();
  return {
    // Provider calls (costo API-Football)
    today: apiCallsToday,
    lastMinute: apiCallsLastMinute,
    byTypeToday,

    // Endpoint hits (uso app)
    endpointHitsToday,
    endpointHitsLastMinute,
    endpointByPathToday,

    // Cache
    cacheHits,
    cacheMisses,
    
  };
}