import fs from "node:fs/promises";
import path from "node:path";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { features } from "./featureFlags";
import { log } from "./logger";

let pool: Pool | null = null;
let state: "disabled" | "connecting" | "ready" | "degraded" | "closed" = features.postgres ? "connecting" : "disabled";
let lastError: string | null = null;
let queryCount = 0, queryErrors = 0, slowQueries = 0;
let deadlocks = 0;
const queryTimes: number[] = [];
const poolMax = Number(process.env.POSTGRES_POOL_MAX ?? "10");
const latencies: number[] = [];

function record(ms: number, ok: boolean, error?: any) {
  queryCount += 1; if (!ok) queryErrors += 1; if (ms >= Number(process.env.POSTGRES_SLOW_QUERY_MS ?? "500")) slowQueries += 1;
  if (error?.code === "40P01") deadlocks += 1;
  queryTimes.push(Date.now()); while (queryTimes[0] != null && queryTimes[0] < Date.now()-60_000) queryTimes.shift();
  latencies.push(ms); if (latencies.length > 1000) latencies.shift();
}
function percentile(q: number) { if (!latencies.length) return 0; const s = [...latencies].sort((a,b)=>a-b); return Math.round((s[Math.floor((s.length-1)*q)] ?? 0)*10)/10; }

export async function initializePostgres(): Promise<boolean> {
  if (!features.postgres) { state = "disabled"; return false; }
  const connectionString = (process.env.DATABASE_URL ?? "").trim();
  if (!connectionString) { state = "degraded"; lastError = "DATABASE_URL missing"; return false; }
  try {
    pool = new Pool({ connectionString, max: poolMax,
      idleTimeoutMillis: 30_000, connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS ?? "2000"),
      ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false } });
    pool.on("error", (error) => { state = "degraded"; lastError = error.message; queryErrors += 1; log("error", "postgres", "pool error", { errorCode: (error as any).code }); });
    await query("SELECT 1");
    state = "ready"; lastError = null;
    if (features.postgresAutoMigrate) await migratePostgres();
    return true;
  } catch (error: any) {
    state = "degraded"; lastError = error?.message ?? String(error);
    log("warn", "postgres", "startup degraded; JSON remains authoritative", { errorCode: error?.code });
    return false;
  }
}

export function postgresReady() { return state === "ready" && Boolean(pool); }
export async function query<T extends QueryResultRow = any>(text: string, values: unknown[] = []) {
  if (!pool) throw new Error("postgres_unavailable");
  const started = performance.now();
  try { const result = await pool.query<T>(text, values); record(performance.now()-started, true); return result; }
  catch (error) { record(performance.now()-started, false, error); throw error; }
}
export async function withTransaction<T>(task: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("postgres_unavailable");
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await task(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function migratePostgres() {
  if (!postgresReady() && state !== "connecting") return;
  const file = path.resolve(__dirname, "../migrations/001_phase1_foundations.sql");
  const sql = await fs.readFile(file, "utf8");
  await query(sql);
}

export async function postgresSnapshot() {
  const total = pool?.totalCount ?? 0, idle = pool?.idleCount ?? 0;
  let storageBytes: number | null = null;
  if (postgresReady()) {
    try { storageBytes = Number((await query("SELECT pg_database_size(current_database()) AS bytes")).rows[0]?.bytes ?? 0) || null; }
    catch {}
  }
  while (queryTimes[0] != null && queryTimes[0] < Date.now()-60_000) queryTimes.shift();
  return { enabled: features.postgres, state, ready: postgresReady(), queries: queryCount, queriesPerSecond: Math.round(queryTimes.length/60*100)/100, errors: queryErrors, deadlocks,
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), slowQueries,
    pool: { max: poolMax, total, active: Math.max(0,total-idle), idle, available: Math.max(0,poolMax-total+idle), waiting: pool?.waitingCount ?? 0 }, storageBytes,
    lastError: lastError ? "connection_error" : null };
}
export async function closePostgres() { if (pool) await pool.end(); pool = null; state = features.postgres ? "closed" : "disabled"; }
export function configurePostgresPoolForTest(value: any) {
  if (process.env.NODE_ENV !== "test") throw new Error("postgres_test_pool_only");
  pool = value; state = value ? "ready" : "disabled"; lastError = null;
}
