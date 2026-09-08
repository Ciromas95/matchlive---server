import { detailedHealth } from "./health";
import { telemetrySnapshot } from "./telemetry";
import { redisSnapshot } from "./redisInfrastructure";
import { postgresReady, postgresSnapshot, query } from "./postgresInfrastructure";
import { shadowStorageSnapshot } from "./shadowStorage";
import { sseSnapshot } from "./stream";
import { publicFeatureSnapshot } from "./featureFlags";
import { errorCenterSnapshot } from "./errorCenter";
import { engineTelemetrySnapshot } from "./engineTelemetry";
import { pushTelemetrySnapshot } from "./pushTelemetry";
import { cacheSnapshot } from "./cache";
import { inflightSnapshot } from "./inflight";
import { priorityQueueSnapshot } from "./priorityQueue";
import { providerQueueSnapshot } from "./providerRateLimiter";
import { lineupSchedulerSnapshot } from "./lineupScheduler";
import { providerResilienceSnapshot } from "./providerResilience";

let cached: { at: number; value: any } | null = null;

async function userSnapshot() {
  if (!postgresReady()) return { source: "unavailable", registered: null, newToday: null, new7d: null, new30d: null, premium: null, free: null, withFavorites: null, withNotifications: null, byPlatform: {} };
  try {
    const result = await query(`SELECT
      count(*)::int registered,
      count(*) FILTER (WHERE created_at>=date_trunc('day',now()))::int new_today,
      count(*) FILTER (WHERE created_at>=now()-interval '7 days')::int new_7d,
      count(*) FILTER (WHERE created_at>=now()-interval '30 days')::int new_30d,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id=app_users.id AND e.status='active' AND (e.expires_at IS NULL OR e.expires_at>now())))::int premium,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_favorites f WHERE f.user_id=app_users.id))::int with_favorites
      FROM app_users`);
    const platforms = await query("SELECT platform,count(*)::int count FROM app_users GROUP BY platform");
    const row = result.rows[0] ?? {};
    return { source: "postgres", registered: row.registered, newToday: row.new_today, new7d: row.new_7d, new30d: row.new_30d,
      premium: row.premium, free: Math.max(0, Number(row.registered)-Number(row.premium)), withFavorites: row.with_favorites,
      withNotifications: null, byPlatform: Object.fromEntries(platforms.rows.map((p:any)=>[p.platform,p.count])) };
  } catch { return { source: "postgres_error", registered: null }; }
}

function alertSnapshot(input: { health: any; telemetry: any; redis: any; postgres: any; sse: any; providerResilience: any; notifications: any; queues: any }) {
  const notificationTotal = input.notifications.sent + input.notifications.failed;
  const notificationFailureRate = notificationTotal ? input.notifications.failed / notificationTotal : 0;
  const memoryLimit = Number(process.env.MEMORY_ALERT_RSS_BYTES ?? String(768 * 1024 * 1024));
  const providerAge = input.providerResilience.lastValidResponseAgeMs;
  const age = (value: unknown) => value ? Math.max(0,Date.now()-Date.parse(String(value))) : null;
  const engines = input.health.engines ?? {};
  const rules = [
    ["api_p95", input.telemetry.api.p95Ms > 500, "warning", `API p95 ${input.telemetry.api.p95Ms} ms`],
    ["api_p99", input.telemetry.api.p99Ms > 1000, "critical", `API p99 ${input.telemetry.api.p99Ms} ms`],
    ["error_rate", input.telemetry.api.errorRate > .01, "critical", `Error rate ${(input.telemetry.api.errorRate*100).toFixed(1)}%`],
    ["event_loop", input.telemetry.node.eventLoopLagP95Ms > 150, "warning", `Event loop ${input.telemetry.node.eventLoopLagP95Ms} ms`],
    ["redis_down", input.redis.enabled && !input.redis.ready, "critical", "Redis non disponibile: fallback locale attivo"],
    ["postgres_down", input.postgres.enabled && !input.postgres.ready, "critical", "PostgreSQL non disponibile: JSON autorevole"],
    ["sse_capacity", input.sse.active/input.sse.max > .8, "warning", "Connessioni SSE oltre 80%"],
    ["sse_reconnect", input.sse.reconnectsPerMinute > Number(process.env.SSE_RECONNECT_ALERT_PER_MINUTE ?? "120"), "warning", "Riconnessioni SSE elevate"],
    ["memory_rss", input.telemetry.node.rssBytes > memoryLimit, "warning", "Memoria RSS oltre la soglia configurata"],
    ["provider_circuit", input.providerResilience.circuit.state !== "closed", "critical", `Circuito provider ${input.providerResilience.circuit.state}`],
    ["provider_stale", providerAge != null && providerAge > Number(process.env.PROVIDER_STALE_ALERT_MS ?? "120000"), "warning", "Ultima risposta valida del provider troppo vecchia"],
    ["provider_timeouts", input.providerResilience.timeouts >= Number(process.env.PROVIDER_TIMEOUT_ALERT_COUNT ?? "5"), "warning", "Timeout provider elevati"],
    ["live_poller_stale", age(engines.liveEngineLastSuccessAt) != null && age(engines.liveEngineLastSuccessAt)! > 90_000, "critical", "Brain LIVE non completa un ciclo da oltre 90 secondi"],
    ["ingestion_stale", age(engines.ingestionLastSuccessAt) != null && age(engines.ingestionLastSuccessAt)! > 90_000, "critical", "Ingestion live ferma da oltre 90 secondi"],
    ["prematch_stale", age(engines.prematchLastSuccessAt) != null && age(engines.prematchLastSuccessAt)! > 30*60*60_000, "warning", "PREMATCH non completa un job da oltre 30 ore"],
    ["notification_failures", notificationTotal >= 10 && notificationFailureRate > .05, "warning", `Notifiche fallite ${(notificationFailureRate*100).toFixed(1)}%`],
    ["notification_queue", input.queues.notifications.pendingCritical + input.queues.notifications.pendingNormal > 100, "critical", "Coda notifiche oltre 100 elementi"],
    ["provider_queue", input.queues.provider.pendingCritical + input.queues.provider.pendingNormal > 100, "critical", "Coda provider oltre 100 elementi"],
    ["postgres_deadlock", input.postgres.deadlocks > 0, "critical", "PostgreSQL ha rilevato deadlock"],
  ] as const;
  return rules.filter(([,active])=>active).map(([id,,severity,message])=>({ id:String(id),severity:String(severity),message:String(message),active:true,detectedAt:new Date().toISOString() })) as Array<{id:string;severity:string;message:string;active:boolean;detectedAt:string}>;
}

export async function infrastructureDashboardSnapshot(stats?: any) {
  if (cached && Date.now()-cached.at < 8000) return cached.value;
  const [health, redis, postgres, users] = await Promise.all([detailedHealth(), redisSnapshot(), postgresSnapshot(), userSnapshot()]);
  const telemetry = telemetrySnapshot();
  const sse = sseSnapshot();
  const shadow = shadowStorageSnapshot();
  const providerResilience = providerResilienceSnapshot();
  const notifications = pushTelemetrySnapshot();
  const queues = { notifications: priorityQueueSnapshot(), provider: providerQueueSnapshot() };
  const provider = stats?.provider ?? {};
  const readable = stats?.readable ?? {};
  const callsToday = Number(provider.callsToday ?? readable.externalCallsToday ?? 0);
  const dailyLimit = Number(readable.dailyBudget ?? provider.dailyLimit ?? 0);
  const utc = new Date();
  const elapsedDayFraction = Math.max(.01, (utc.getUTCHours()*3600+utc.getUTCMinutes()*60+utc.getUTCSeconds())/86400);
  const projected = Math.round(callsToday / elapsedDayFraction);
  const quotaPct = dailyLimit > 0 ? callsToday / dailyLimit : 0;
  const alerts = alertSnapshot({ health, telemetry, redis, postgres, sse, providerResilience, notifications, queues });
  if (quotaPct >= .95) alerts.push({ id:"provider_quota_95", severity:"critical", message:`Quota provider al ${(quotaPct*100).toFixed(1)}%`, active:true, detectedAt:new Date().toISOString() });
  else if (quotaPct >= .8) alerts.push({ id:"provider_quota_80", severity:"warning", message:`Quota provider al ${(quotaPct*100).toFixed(1)}%`, active:true, detectedAt:new Date().toISOString() });
  const status = alerts.some((a)=>a.severity==="critical") ? "CRITICAL" : alerts.length ? "DEGRADED" : "HEALTHY";
  const value = {
    enabled: publicFeatureSnapshot().newAdminDashboard,
    systemStatus: status, generatedAt: new Date().toISOString(), health, telemetry, sse, redis, postgres, shadow,
    users, errors: errorCenterSnapshot(), alerts,
    engines: { ...engineTelemetrySnapshot(), lineupScheduler: lineupSchedulerSnapshot() }, notifications,
    providerControl: { callsToday, dailyLimit, remaining: Math.max(0,dailyLimit-callsToday), quotaPct,
      projectedEndOfDay: projected, projectionSource: "technical_estimate", officialCount: readable.providerCountIsOfficial === true,
      health: stats?.providerHealth ?? null, resilience: providerResilience, usage: readable.mostExpensiveSections ?? [] },
    cache: { local: cacheSnapshot(), redis }, inflight: inflightSnapshot(), queues,
    costs: { source: "technical_estimate", currency: "EUR", actualBillingConnected: false,
      note: "Stima tecnica: nessuna API Railway Billing collegata.", assumptions: {
        railwayMemoryEurPerGbMonth: 10, railwayCpuEurPerVcpuMonth: 20, railwayEgressEurPerGb: .05,
      }, currentMonthEstimate: null, perActiveUserEstimate: null },
    featureFlags: publicFeatureSnapshot(),
  };
  cached = { at: Date.now(), value }; return value;
}
