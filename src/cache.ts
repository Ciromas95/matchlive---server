type CacheEntry<T> = {
  value: T;
  expiry: number;
};

// ✅ singleton globale (evita reset in dev/hot reload)
const g = globalThis as any;
const cache: Map<string, CacheEntry<any>> =
  g.__MATCHLIVE_CACHE__ ?? (g.__MATCHLIVE_CACHE__ = new Map());

export function setCache<T>(key: string, value: T, ttlSeconds: number) {
  cache.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
}

export function getCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }

  return entry.value as T;
}
export function cacheSize() {
  return cache.size;
}