export function liveTtlSeconds(liveCount: number) {
  if (liveCount <= 0) return 45;
  if (liveCount <= 5) return 15;
  if (liveCount <= 15) return 10;
  return 8;
}