import crypto from "node:crypto";
import { createClient, RedisClientType } from "redis";
import { features } from "./featureFlags";
import { log } from "./logger";

type RedisState = "disabled" | "connecting" | "ready" | "degraded" | "closed";
let client: RedisClientType | null = null;
let state: RedisState = features.redis ? "connecting" : "disabled";
let lastError: string | null = null;
let lastLatencyMs: number | null = null;
let errors = 0;
let hits = 0;
let misses = 0;
let lockAcquired = 0;
let lockFailed = 0;
let singleFlightReuse = 0;
let leases = 0;
let reconnectRetries = 0;
let cacheWrites = 0;
let cacheTtlSecondsTotal = 0;
let rateLimiterRuns = 0, rateLimiterWaits = 0, rateLimiterWaitMs = 0;
let liveStateWrites = 0, liveStateWriteErrors = 0, liveStateWriteMs = 0;

const prefix = (process.env.REDIS_KEY_PREFIX ?? "brainlive:v1").replace(/:+$/, "");
const key = (value: string) => `${prefix}:${value}`;

export async function initializeRedis(): Promise<boolean> {
  if (!features.redis) { state = "disabled"; return false; }
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) { state = "degraded"; lastError = "REDIS_URL missing"; return false; }
  try {
    state = "connecting";
    client = createClient({
      url,
      socket: {
        connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? "1500"),
        reconnectStrategy: (retries) => { reconnectRetries += 1; return retries > 4 ? false : Math.min(1000, 100 * 2 ** retries); },
      },
    }) as RedisClientType;
    client.on("error", (error) => {
      errors += 1; state = "degraded"; lastError = error.message;
      log("warn", "redis", "client error", { errorCode: (error as any)?.code, message: error.message });
    });
    client.on("ready", () => { state = "ready"; lastError = null; });
    await client.connect();
    await pingRedis();
    return true;
  } catch (error: any) {
    state = "degraded"; errors += 1; lastError = error?.message ?? String(error);
    client = null;
    log("warn", "redis", "startup degraded; local fallback remains active", { errorCode: error?.code });
    return false;
  }
}

export function redisReady() { return state === "ready" && Boolean(client?.isReady); }

export async function pingRedis(): Promise<boolean> {
  if (!redisReady()) return false;
  const started = performance.now();
  try { await client!.ping(); lastLatencyMs = performance.now() - started; return true; }
  catch (error: any) { errors += 1; state = "degraded"; lastError = error?.message ?? String(error); return false; }
}

type CacheEnvelope<T> = { value: T; expiry: number; staleUntil: number; createdAt: number };

export async function getRedisCache<T>(cacheKey: string): Promise<{ state: "fresh" | "stale" | "miss"; value: T | null; ageMs: number | null }> {
  if (!features.redisCache || !redisReady()) return { state: "miss", value: null, ageMs: null };
  try {
    const raw = await client!.get(key(`cache:${cacheKey}`));
    if (!raw) { misses += 1; return { state: "miss", value: null, ageMs: null }; }
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    const now = Date.now();
    if (now > parsed.staleUntil) { misses += 1; return { state: "miss", value: null, ageMs: null }; }
    hits += 1;
    return { state: now <= parsed.expiry ? "fresh" : "stale", value: parsed.value, ageMs: now - parsed.createdAt };
  } catch (error: any) { errors += 1; lastError = error?.message ?? String(error); return { state: "miss", value: null, ageMs: null }; }
}

export async function setRedisCache<T>(cacheKey: string, value: T, ttlSeconds: number, staleSeconds: number): Promise<void> {
  if (!features.redisCache || !redisReady()) return;
  const now = Date.now();
  const envelope: CacheEnvelope<T> = {
    value, createdAt: now, expiry: now + ttlSeconds * 1000,
    staleUntil: now + (ttlSeconds + staleSeconds) * 1000,
  };
  try { await client!.set(key(`cache:${cacheKey}`), JSON.stringify(envelope), { EX: Math.max(1, ttlSeconds + staleSeconds) }); cacheWrites += 1; cacheTtlSecondsTotal += Math.max(1, ttlSeconds + staleSeconds); }
  catch (error: any) { errors += 1; lastError = error?.message ?? String(error); }
}

export async function setRedisJson(redisKey: string, value: unknown, ttlSeconds?: number): Promise<void> {
  if (!redisReady()) return;
  const started = performance.now();
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) await client!.set(key(redisKey), serialized, { EX: Math.max(1, ttlSeconds) });
    else await client!.set(key(redisKey), serialized);
    if (redisKey === "live:snapshot") { liveStateWrites += 1; liveStateWriteMs += performance.now()-started; }
  } catch (error: any) { errors += 1; if(redisKey === "live:snapshot") liveStateWriteErrors += 1; lastError = error?.message ?? String(error); }
}

export async function getRedisJson<T>(redisKey: string): Promise<T | null> {
  if (!redisReady()) return null;
  try { const raw = await client!.get(key(redisKey)); return raw ? JSON.parse(raw) as T : null; }
  catch (error: any) { errors += 1; lastError = error?.message ?? String(error); return null; }
}

export type RedisLock = { name: string; token: string };
export async function acquireRedisLock(name: string, ttlMs: number): Promise<RedisLock | null> {
  if (!features.redisLock || !redisReady()) return null;
  const token = crypto.randomUUID();
  try {
    const result = await client!.set(key(`lock:${name}`), token, { NX: true, PX: Math.max(500, ttlMs) });
    if (result === "OK") { lockAcquired += 1; return { name, token }; }
    lockFailed += 1; return null;
  } catch { errors += 1; lockFailed += 1; return null; }
}

export async function releaseRedisLock(lock: RedisLock): Promise<void> {
  if (!redisReady()) return;
  try {
    await client!.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [key(`lock:${lock.name}`)], arguments: [lock.token] },
    );
  } catch { errors += 1; }
}

export function redisLocksReady() { return features.redisLock && redisReady(); }

/// Deduplica durevole cross-instance per eventi one-shot (push, alert, job).
export async function claimRedisOnce(name: string, ttlSeconds: number): Promise<boolean | null> {
  if (!redisReady()) return null;
  try {
    const result = await client!.set(key(`once:${name}`), String(Date.now()), {
      NX: true,
      EX: Math.max(1, ttlSeconds),
    });
    return result === "OK";
  } catch (error: any) {
    errors += 1;
    lastError = error?.message ?? String(error);
    return null;
  }
}

/**
 * Cross-instance single flight. The lock owner fills the cache; followers wait
 * briefly for that value. If the owner dies or Redis is unavailable, the
 * caller proceeds normally so the legacy local path remains operational.
 */
export async function withRedisSingleFlight<T>(
  name: string,
  readShared: () => Promise<T | null>,
  task: () => Promise<T>,
  ttlMs = 15_000,
): Promise<T> {
  if (!redisLocksReady()) return task();
  const lock = await acquireRedisLock(`singleflight:${name}`, ttlMs);
  if (lock) {
    try { return await task(); }
    finally { await releaseRedisLock(lock); }
  }
  singleFlightReuse += 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40 + attempt * 20));
    const shared = await readShared();
    if (shared != null) return shared;
  }
  return task();
}

export async function withJobLease<T>(name: string, ttlMs: number, task: () => Promise<T>): Promise<T | null> {
  if (!features.redisLock || !redisReady()) return task();
  const lock = await acquireRedisLock(`job:${name}`, ttlMs);
  if (!lock) { singleFlightReuse += 1; return null; }
  leases += 1;
  try { return await task(); } finally { leases = Math.max(0, leases - 1); await releaseRedisLock(lock); }
}

export async function waitForRedisProviderSlot(gapMs: number): Promise<void> {
  if (!features.redisRateLimit || !redisReady()) return;
  try {
    rateLimiterRuns += 1;
    const now = Date.now();
    const wait = Number(await client!.eval(
      "local n=tonumber(redis.call('get',KEYS[1]) or '0'); local s=math.max(tonumber(ARGV[1]),n); redis.call('set',KEYS[1],s+tonumber(ARGV[2]),'PX',10000); return s-tonumber(ARGV[1])",
      { keys: [key("provider:next-slot")], arguments: [String(now), String(gapMs)] },
    ));
    if (wait > 0) { rateLimiterWaits += 1; rateLimiterWaitMs += wait; await new Promise((resolve) => setTimeout(resolve, wait)); }
  } catch { errors += 1; }
}

export async function redisSnapshot() {
  let keyCount: number | null = null;
  let memoryBytes: number | null = null;
  let connections: number | null = null;
  if (redisReady()) {
    try {
      const [db, memory, clients] = await Promise.all([client!.dbSize(), client!.info("memory"), client!.info("clients")]);
      keyCount = db;
      memoryBytes = Number(/used_memory:(\d+)/.exec(memory)?.[1] ?? 0) || null;
      connections = Number(/connected_clients:(\d+)/.exec(clients)?.[1] ?? 0) || null;
    } catch { errors += 1; }
  }
  return { enabled: features.redis, state, ready: redisReady(), latencyMs: lastLatencyMs == null ? null : Math.round(lastLatencyMs * 10) / 10,
    keyCount, memoryBytes, connections, hits, misses, errors, lastError: lastError ? "connection_error" : null,
    locks: { active: leases, acquired: lockAcquired, failed: lockFailed }, singleFlightReuse, reconnectRetries,
    averageConfiguredTtlSeconds: cacheWrites ? Math.round(cacheTtlSecondsTotal/cacheWrites) : 0, keyPrefix: prefix,
    rateLimiter:{enabled:features.redisRateLimit,runs:rateLimiterRuns,waits:rateLimiterWaits,averageWaitMs:rateLimiterWaits?Math.round(rateLimiterWaitMs/rateLimiterWaits):0},
    liveState:{enabled:features.redisLiveState,writes:liveStateWrites,errors:liveStateWriteErrors,averageWriteMs:liveStateWrites?Math.round(liveStateWriteMs/liveStateWrites*10)/10:0} };
}

export async function closeRedis() {
  if (client?.isOpen) { try { await client.quit(); } catch { client.disconnect(); } }
  state = features.redis ? "closed" : "disabled";
}

export function configureRedisClientForTest(value: any) {
  if (process.env.NODE_ENV !== "test") throw new Error("redis_test_client_only");
  client = value; state = value ? "ready" : "disabled"; lastError = null;
}
