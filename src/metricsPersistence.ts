import { features } from "./featureFlags";
import { postgresReady, query } from "./postgresInfrastructure";
import { telemetrySnapshot } from "./telemetry";
import { sseSnapshot } from "./stream";
import { providerResilienceSnapshot } from "./providerResilience";
import { redisSnapshot } from "./redisInfrastructure";
import { postgresSnapshot } from "./postgresInfrastructure";
import { cacheSnapshot } from "./cache";
import { priorityQueueSnapshot } from "./priorityQueue";
import { providerQueueSnapshot } from "./providerRateLimiter";

export async function persistOperationalMetrics() {
  if (!features.observability || !postgresReady()) return;
  const telemetry = telemetrySnapshot();
  const sse = sseSnapshot();
  const provider = providerResilienceSnapshot();
  const [redis, postgres] = await Promise.all([redisSnapshot(), postgresSnapshot()]);
  const cache = cacheSnapshot();
  const notificationQueue = priorityQueueSnapshot();
  const providerQueue = providerQueueSnapshot();
  const currentSeries = telemetry.series.at(-1);
  const at = new Date(Math.floor(Date.now()/60_000)*60_000).toISOString();
  const values: Array<[string,number]> = [
    ["api.requests_per_second", telemetry.api.requestsPerSecond], ["api.p50_ms", telemetry.api.p50Ms],
    ["api.p95_ms", telemetry.api.p95Ms], ["api.p99_ms", telemetry.api.p99Ms], ["api.error_rate", telemetry.api.errorRate],
    ["node.cpu_pct", telemetry.node.cpuPct], ["node.rss_bytes", telemetry.node.rssBytes],
    ["node.event_loop_p95_ms", telemetry.node.eventLoopLagP95Ms], ["sse.active", sse.active], ["sse.bytes_sent", sse.bytesSent],
    ["provider.retries", provider.retries], ["provider.failures", provider.failures], ["provider.timeouts", provider.timeouts],
    ["provider.calls_per_minute", currentSeries?.providerCalls ?? 0], ["cache.local_hit_rate", cache.hitRate],
    ["redis.latency_ms", redis.latencyMs ?? 0], ["postgres.p95_ms", postgres.p95Ms],
    ["queue.notifications", notificationQueue.pendingCritical+notificationQueue.pendingNormal],
    ["queue.provider", providerQueue.pendingCritical+providerQueue.pendingNormal],
    ["api.egress_bytes", telemetry.api.estimatedEgressBytes5m],
  ];
  await query(`INSERT INTO operational_metrics(bucket_at,metric_name,value)
    SELECT $1::timestamptz, rows.metric_name, rows.value
    FROM unnest($2::text[],$3::double precision[]) AS rows(metric_name,value)
    ON CONFLICT(bucket_at,metric_name,labels) DO UPDATE SET value=EXCLUDED.value`,
  [at, values.map(([name])=>name), values.map(([,value])=>value)]);
  if (new Date().getUTCMinutes() === 7) {
    await query("DELETE FROM operational_metrics WHERE bucket_at < now()-interval '30 days'");
  }
}

export async function loadOperationalMetricHistory(range: string) {
  if (!postgresReady()) return [];
  const intervals: Record<string,string> = { "5m":"5 minutes", "15m":"15 minutes", "1h":"1 hour", "6h":"6 hours", "24h":"24 hours", "7d":"7 days" };
  const interval = intervals[range] ?? intervals["15m"];
  const result = await query("SELECT bucket_at,metric_name,value FROM operational_metrics WHERE bucket_at>=now()-$1::interval ORDER BY bucket_at ASC LIMIT 20000", [interval]);
  return result.rows;
}
