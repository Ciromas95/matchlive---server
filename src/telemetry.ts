import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";

type HttpSample = { at: number; path: string; method: string; status: number; durationMs: number; bytes: number };
type MinuteBucket = {
  minute: number; requests: number; errors: number; bytes: number;
  durations: number[]; sseConnections: number; providerCalls: number;
};

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const httpSamples: HttpSample[] = [];
const buckets = new Map<number, MinuteBucket>();
let activeRequests = 0;
let totalRequests = 0;
const statusCounts = new Map<number, number>();
let gcCount = 0;
let gcDurationMs = 0;
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

function allocatedCpuCores(): number {
  const configured = Number(process.env.RAILWAY_CPU_LIMIT ?? process.env.CPU_LIMIT_CORES ?? "");
  if (Number.isFinite(configured) && configured > 0) return configured;
  try {
    const [quotaRaw, periodRaw] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quotaRaw !== "max") {
      const value = Number(quotaRaw) / Number(periodRaw);
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch {}
  try {
    const quota = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8"));
    const period = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8"));
    if (quota > 0 && period > 0) return quota / period;
  } catch {}
  return Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
}

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount += 1;
      gcDurationMs += entry.duration;
    }
  }).observe({ entryTypes: ["gc"] });
} catch {}

function bucket(at = Date.now()): MinuteBucket {
  const minute = Math.floor(at / 60_000) * 60_000;
  let value = buckets.get(minute);
  if (!value) {
    value = { minute, requests: 0, errors: 0, bytes: 0, durations: [], sseConnections: 0, providerCalls: 0 };
    buckets.set(minute, value);
  }
  return value;
}

function prune() {
  const cutoff = Date.now() - RETENTION_MS;
  while (httpSamples[0]?.at < Date.now() - 60 * 60_000) httpSamples.shift();
  for (const key of buckets.keys()) if (key < cutoff) buckets.delete(key);
}

export function requestStarted() { activeRequests += 1; }
export function observeHttp(sample: Omit<HttpSample, "at">) {
  activeRequests = Math.max(0, activeRequests - 1);
  totalRequests += 1;
  statusCounts.set(sample.status, (statusCounts.get(sample.status) ?? 0) + 1);
  const row = { at: Date.now(), ...sample };
  httpSamples.push(row);
  const b = bucket(row.at);
  b.requests += 1;
  if (row.status >= 500) b.errors += 1;
  b.bytes += Math.max(0, row.bytes);
  if (b.durations.length < 2000) b.durations.push(row.durationMs);
  prune();
}

export function markProviderTelemetryCall() { bucket().providerCalls += 1; }
export function sampleSseConnections(count: number) { bucket().sseConnections = count; }

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0) * 10) / 10;
}

export function telemetrySnapshot() {
  prune();
  const now = Date.now();
  const recent = httpSamples.filter((row) => row.at >= now - 5 * 60_000);
  const durations = recent.map((row) => row.durationMs);
  const errors = recent.filter((row) => row.status >= 500).length;
  const byEndpoint = new Map<string, number>();
  for (const row of recent) byEndpoint.set(`${row.method} ${row.path}`, (byEndpoint.get(`${row.method} ${row.path}`) ?? 0) + 1);
  const memory = process.memoryUsage();
  const cpuNow = process.cpuUsage();
  const cpuAt = process.hrtime.bigint();
  const elapsedMicros = Math.max(1, Number(cpuAt - lastCpuAt) / 1000);
  const processCpuPct = Math.max(0, ((cpuNow.user-lastCpu.user+cpuNow.system-lastCpu.system)/elapsedMicros)*100);
  const cpuCores = allocatedCpuCores();
  const cpuPct = Math.min(100, processCpuPct / cpuCores);
  lastCpu = cpuNow;
  lastCpuAt = cpuAt;
  const handles = typeof (process as any)._getActiveHandles === "function" ? (process as any)._getActiveHandles().length : null;
  let fileDescriptors: number | null = null;
  try { fileDescriptors = fs.readdirSync("/proc/self/fd").length; } catch {}
  return {
    api: {
      totalRequests,
      requestsPerSecond: Math.round((recent.length / 300) * 100) / 100,
      activeRequests,
      errorRate: recent.length ? errors / recent.length : 0,
      p50Ms: quantile(durations, .5), p95Ms: quantile(durations, .95), p99Ms: quantile(durations, .99),
      averageMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      averagePayloadBytes: recent.length ? Math.round(recent.reduce((sum, row) => sum + row.bytes, 0) / recent.length) : 0,
      estimatedEgressBytes5m: recent.reduce((sum, row) => sum + row.bytes, 0),
      statusCounts: Object.fromEntries([...statusCounts.entries()].sort(([a],[b]) => a-b)),
      topEndpoints: [...byEndpoint.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([endpoint, requests]) => ({ endpoint, requests })),
    },
    node: {
      cpuPct: Math.round(cpuPct*10)/10, processCpuPct:Math.round(processCpuPct*10)/10,
      allocatedCpuCores:Math.round(cpuCores*100)/100, cpuNormalization:"cgroup_quota_or_runtime_capacity",
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external, uptimeSeconds: Math.round(process.uptime()), activeHandles: handles, fileDescriptors,
      eventLoopLagMeanMs: Number.isFinite(loop.mean) ? Math.round(loop.mean / 1e5) / 10 : 0,
      eventLoopLagP95Ms: Math.round(loop.percentile(95) / 1e5) / 10,
      eventLoopLagP99Ms: Math.round(loop.percentile(99) / 1e5) / 10,
      gcCount, gcDurationMs: Math.round(gcDurationMs * 10) / 10,
    },
    series: [...buckets.values()].sort((a, b) => a.minute - b.minute).map((b) => ({
      at: new Date(b.minute).toISOString(), requests: b.requests, errors: b.errors, bytes: b.bytes,
      p50Ms: quantile(b.durations, .5), p95Ms: quantile(b.durations, .95), p99Ms: quantile(b.durations, .99),
      sseConnections: b.sseConnections, providerCalls: b.providerCalls,
    })),
  };
}

export function stopTelemetry() { loop.disable(); }
