type Sample = { at: number; value: number };
const delivery: Sample[] = [];
const storeApply: Sample[] = [];
const render: Sample[] = [];
let reports = 0;
let lastReportAt: string | null = null;

function add(rows: Sample[], value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 120_000) return;
  rows.push({ at: Date.now(), value: parsed });
  const cutoff = Date.now() - 3_600_000;
  while (rows[0] && rows[0].at < cutoff) rows.shift();
  if (rows.length > 2_000) rows.shift();
}

function summary(rows: Sample[]) {
  const values = rows.map((row) => row.value).sort((a, b) => a - b);
  const percentile = (ratio: number) => values.length
    ? values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]
    : 0;
  return {
    lastMs: Math.round((rows.at(-1)?.value ?? 0) * 10) / 10,
    p50Ms: Math.round(percentile(.5) * 10) / 10,
    p95Ms: Math.round(percentile(.95) * 10) / 10,
    samples: values.length,
  };
}

export function recordClientLiveTelemetry(payload: any) {
  add(delivery, payload?.deliveryMs);
  add(storeApply, payload?.storeApplyMs);
  add(render, payload?.renderMs);
  reports += 1;
  lastReportAt = new Date().toISOString();
}

export function clientLiveTelemetrySnapshot() {
  return {
    reports,
    lastReportAt,
    sampledWindow: "1h",
    delivery: summary(delivery),
    storeApply: summary(storeApply),
    render: summary(render),
    note: "Misure campionate dai client; delivery include rete e possibile differenza di orologio tra server e dispositivo.",
  };
}
