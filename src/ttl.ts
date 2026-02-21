// src/ttl.ts
export function liveTtlMs(liveCount: number) {
  if (liveCount <= 0) return 45_000;   // niente live → cache lunga
  if (liveCount <= 5) return 15_000;
  if (liveCount <= 15) return 10_000;
  return 8_000;                        // tante live → cache corta
}