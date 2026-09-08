type LineupMetrics = { requested: number; generated: number; official: number; unavailable: number; cacheHits: number; failed: number; durations: number[]; lastSuccessAt: string | null; algorithmVersion: string };
const lineup: LineupMetrics = { requested: 0, generated: 0, official: 0, unavailable: 0, cacheHits: 0, failed: 0, durations: [], lastSuccessAt: null, algorithmVersion: "lineup-v1" };
export function lineupRequested() { lineup.requested += 1; }
export function lineupCompleted(status: string, durationMs: number, cacheHit = false) {
  if (status === "predicted") lineup.generated += 1; else if (status === "official") lineup.official += 1; else lineup.unavailable += 1;
  if (cacheHit) lineup.cacheHits += 1;
  lineup.durations.push(durationMs); if (lineup.durations.length > 500) lineup.durations.shift(); lineup.lastSuccessAt = new Date().toISOString();
}
export function lineupFailed() { lineup.failed += 1; }
export function engineTelemetrySnapshot() {
  const average = lineup.durations.length ? lineup.durations.reduce((a,b)=>a+b,0)/lineup.durations.length : 0;
  return { lineup: { ...lineup, durations: undefined, averageGenerationMs: Math.round(average), pending: 0 } };
}
