type CacheEntry<T> = {
  value: T;
  expiry: number;
  staleUntil: number;
  createdAt: number;
  lastAccessAt: number;
};

const g = globalThis as any;

const cache: Map<string, CacheEntry<any>> =
  g.__MATCHLIVE_CACHE__ ?? (g.__MATCHLIVE_CACHE__ = new Map());

const DEFAULT_STALE_SECONDS = 10 * 60;
const MAX_CACHE_ITEMS = Number(process.env.CACHE_MAX_ITEMS ?? "1500");

function nowMs() {
  return Date.now();
}

function pruneExpired() {
  const now = nowMs();
  for (const [key, entry] of cache.entries()) {
    if (entry.staleUntil <= now) {
      cache.delete(key);
    }
  }
}

function enforceMaxSize() {
  if (cache.size <= MAX_CACHE_ITEMS) return;

  const entries = [...cache.entries()].sort(
    (a, b) => a[1].lastAccessAt - b[1].lastAccessAt
  );

  const toDelete = cache.size - MAX_CACHE_ITEMS;
  for (let i = 0; i < toDelete; i++) {
    const key = entries[i]?.[0];
    if (key) cache.delete(key);
  }
}

export function setCache<T>(
  key: string,
  value: T,
  ttlSeconds: number,
  staleSeconds: number = DEFAULT_STALE_SECONDS
) {
  const now = nowMs();
  const ttlMs = Math.max(1, ttlSeconds) * 1000;
  const staleMs = Math.max(0, staleSeconds) * 1000;

  cache.set(key, {
    value,
    expiry: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
    createdAt: now,
    lastAccessAt: now,
  });

  pruneExpired();
  enforceMaxSize();
}

export function getCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (nowMs() > entry.expiry) {
    cache.delete(key);
    return null;
  }

  entry.lastAccessAt = nowMs();
  return entry.value as T;
}

export function getCacheState<T>(
  key: string
): { state: "fresh" | "stale" | "miss"; value: T | null; ageMs: number | null } {
  const entry = cache.get(key);
  if (!entry) return { state: "miss", value: null, ageMs: null };

  const now = nowMs();
  if (now > entry.staleUntil) {
    cache.delete(key);
    return { state: "miss", value: null, ageMs: null };
  }

  entry.lastAccessAt = now;

  return {
    state: now <= entry.expiry ? "fresh" : "stale",
    value: entry.value as T,
    ageMs: now - entry.createdAt,
  };
}

export function cacheSize() {
  pruneExpired();
  return cache.size;
}

export function cacheSnapshot() {
  pruneExpired();

  const now = nowMs();
  let fresh = 0;
  let stale = 0;

  for (const entry of cache.values()) {
    if (now <= entry.expiry) {
      fresh++;
    } else if (now <= entry.staleUntil) {
      stale++;
    }
  }

  return {
    total: cache.size,
    fresh,
    stale,
    maxItems: MAX_CACHE_ITEMS,
  };
}
