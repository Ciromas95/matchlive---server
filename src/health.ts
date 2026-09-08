import { postgresReady, postgresSnapshot } from "./postgresInfrastructure";
import { redisReady, redisSnapshot } from "./redisInfrastructure";
import { features, publicFeatureSnapshot } from "./featureFlags";
import { telemetrySnapshot } from "./telemetry";
import { providerResilienceSnapshot } from "./providerResilience";

let acceptingTraffic = false;
let shuttingDown = false;
let ingestionLastSuccessAt: string | null = null;
let liveEngineLastSuccessAt: string | null = null;
let prematchLastSuccessAt: string | null = null;
let lineupLastSuccessAt: string | null = null;
let providerLastSuccessAt: string | null = null;

export function setAcceptingTraffic(value: boolean) { acceptingTraffic = value; }
export function setShuttingDown(value: boolean) { shuttingDown = value; if (value) acceptingTraffic = false; }
export function markHealthActivity(component: "ingestion"|"live"|"prematch"|"lineup"|"provider") {
  const value = new Date().toISOString();
  if (component === "ingestion") ingestionLastSuccessAt = value;
  if (component === "live") liveEngineLastSuccessAt = value;
  if (component === "prematch") prematchLastSuccessAt = value;
  if (component === "lineup") lineupLastSuccessAt = value;
  if (component === "provider") providerLastSuccessAt = value;
}

export function liveHealth() { return { status: "alive", service: process.env.SERVICE_NAME ?? "brainlive-api", uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() }; }

export function readinessHealth() {
  const requiredRedisOk = !features.redisRequiredForReady || redisReady();
  const requiredPostgresOk = !features.postgresRequiredForReady || postgresReady();
  const loopLag = telemetrySnapshot().node.eventLoopLagP95Ms;
  const eventLoopOk = loopLag < Number(process.env.READINESS_EVENT_LOOP_MAX_MS ?? "1000");
  const provider = providerResilienceSnapshot();
  const ready = acceptingTraffic && !shuttingDown && requiredRedisOk && requiredPostgresOk && eventLoopOk;
  return { status: ready ? "ready" : "not_ready", ready, acceptingTraffic, shuttingDown,
    dependencies: { redis: requiredRedisOk ? "ok" : "degraded", postgres: requiredPostgresOk ? "ok" : "degraded",
      eventLoop: eventLoopOk ? "ok" : "degraded", provider: provider.circuit.state }, timestamp: new Date().toISOString() };
}

export async function detailedHealth() {
  const [redis, postgres] = await Promise.all([redisSnapshot(), postgresSnapshot()]);
  const telemetry = telemetrySnapshot();
  const lag = telemetry.node.eventLoopLagP95Ms;
  const ages = { ingestionLastSuccessAt, liveEngineLastSuccessAt, prematchLastSuccessAt, lineupLastSuccessAt, providerLastSuccessAt };
  const provider = providerResilienceSnapshot();
  const degraded = shuttingDown || lag > 250 || provider.circuit.state !== "closed" || (features.redis && !redisReady()) || (features.postgres && !postgresReady());
  return { status: degraded ? "DEGRADED" : "HEALTHY", readiness: readinessHealth(), eventLoop: { p95Ms: lag, healthy: lag < 250 },
    dependencies: { redis, postgres }, provider, engines: ages, features: publicFeatureSnapshot(), timestamp: new Date().toISOString() };
}
