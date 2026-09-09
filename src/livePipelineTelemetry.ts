type Sample = { at: number; value: number };
type Cycle = {
  completedAt: string | null; source: string;
  providerRequestStartedAt: string | null;
  providerResponseReceivedAt: string | null;
  processingCompletedAt: string | null;
  redisPublishedAt: string | null;
  ssePublishedAt: string | null;
  providerQueueMs: number; providerResponseMs: number; processingMs: number;
  redisPublishMs: number; sseSendMs: number; internalLatencyMs: number;
  providerDelayMs: number; endToEndMeasuredMs: number; fixtures: number;
};

const stages = new Map<string, Sample[]>();
let current = {
  queueMs: 0, responseMs: 0, redisMs: 0, sseMs: 0, source: "unknown",
  providerRequestStartedAt: null as string | null,
  providerResponseReceivedAt: null as string | null,
  redisPublishedAt: null as string | null,
  ssePublishedAt: null as string | null,
};
let latest: Cycle = {
  completedAt: null, source: "waiting", providerRequestStartedAt: null,
  providerResponseReceivedAt: null, processingCompletedAt: null,
  redisPublishedAt: null, ssePublishedAt: null, providerQueueMs: 0,
  providerResponseMs: 0, processingMs: 0, redisPublishMs: 0, sseSendMs: 0,
  internalLatencyMs: 0, providerDelayMs: 0, endToEndMeasuredMs: 0, fixtures: 0,
};

function add(stage: string, value: number) {
  const rows = stages.get(stage) ?? [];
  rows.push({ at: Date.now(), value: Math.max(0, value) });
  const cutoff = Date.now() - 3_600_000;
  while (rows[0] && rows[0].at < cutoff) rows.shift();
  if (rows.length > 600) rows.shift();
  stages.set(stage, rows);
}

export function recordLiveProvider(queueMs: number, responseMs: number, source = "api-football") {
  const received = Date.now();
  current = {
    queueMs, responseMs, redisMs: 0, sseMs: 0, source,
    providerRequestStartedAt: new Date(received - responseMs).toISOString(),
    providerResponseReceivedAt: new Date(received).toISOString(),
    redisPublishedAt: null, ssePublishedAt: null,
  };
  add("providerQueueMs", queueMs);
  add("providerResponseMs", responseMs);
}

export function recordLiveCacheSource(source: "local-cache" | "redis-cache" | "inflight") {
  current = {
    queueMs: 0, responseMs: 0, redisMs: 0, sseMs: 0, source,
    providerRequestStartedAt: null,
    providerResponseReceivedAt: new Date().toISOString(),
    redisPublishedAt: null, ssePublishedAt: null,
  };
}

export function recordLiveSse(durationMs: number) {
  current.sseMs += Math.max(0, durationMs);
  current.ssePublishedAt = new Date().toISOString();
  add("sseSendMs", durationMs);
}

export function recordLiveRedis(durationMs: number) {
  current.redisMs += Math.max(0, durationMs);
  current.redisPublishedAt = new Date().toISOString();
  add("redisPublishMs", durationMs);
}

export function completeLiveCycle(input: { processingMs: number; fixtures: number; source?: string }) {
  const processingCompletedAt = new Date().toISOString();
  const internal = input.processingMs + current.redisMs + current.sseMs;
  latest = {
    completedAt: processingCompletedAt, source: input.source ?? current.source,
    providerRequestStartedAt: current.providerRequestStartedAt,
    providerResponseReceivedAt: current.providerResponseReceivedAt,
    processingCompletedAt, redisPublishedAt: current.redisPublishedAt,
    ssePublishedAt: current.ssePublishedAt, providerQueueMs: current.queueMs,
    providerResponseMs: current.responseMs, processingMs: input.processingMs,
    redisPublishMs: current.redisMs, sseSendMs: current.sseMs,
    internalLatencyMs: internal, providerDelayMs: current.queueMs + current.responseMs,
    endToEndMeasuredMs: current.queueMs + current.responseMs + internal,
    fixtures: input.fixtures,
  };
  add("processingMs", input.processingMs);
  add("internalLatencyMs", internal);
  add("providerDelayMs", latest.providerDelayMs);
  add("endToEndMeasuredMs", latest.endToEndMeasuredMs);
}

function stats(name: string) {
  const rows = stages.get(name) ?? [];
  const values = rows.map((row) => row.value).sort((a, b) => a - b);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const p95 = values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * .95) - 1)] : 0;
  return {
    lastMs: Math.round((rows.at(-1)?.value ?? 0) * 10) / 10,
    averageMs: Math.round(average * 10) / 10,
    p95Ms: Math.round(p95 * 10) / 10, samples: values.length,
  };
}

export function livePipelineSnapshot() {
  return {
    latest,
    stages: {
      providerQueue: stats("providerQueueMs"), providerResponse: stats("providerResponseMs"),
      processing: stats("processingMs"), redisPublish: stats("redisPublishMs"),
      sseSend: stats("sseSendMs"), internal: stats("internalLatencyMs"),
      providerDelay: stats("providerDelayMs"), endToEndMeasured: stats("endToEndMeasuredMs"),
    },
    attribution: latest.providerDelayMs > latest.internalLatencyMs ? "provider" : "brainlive",
    note: "Il ritardo provider è misurato dalla coda all'arrivo della risposta API-Football; non rappresenta il tempo tra l'evento in campo e la disponibilità presso il provider.",
  };
}

export function resetLivePipelineTelemetryForTest() {
  stages.clear();
  current = {
    queueMs: 0, responseMs: 0, redisMs: 0, sseMs: 0, source: "unknown",
    providerRequestStartedAt: null, providerResponseReceivedAt: null,
    redisPublishedAt: null, ssePublishedAt: null,
  };
}
