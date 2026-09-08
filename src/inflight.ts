const g = globalThis as any;

const inflight: Map<string, Promise<any>> =
  g.__MATCHLIVE_INFLIGHT__ ?? (g.__MATCHLIVE_INFLIGHT__ = new Map());
let reuseCount = 0;

export function getInflight<T>(key: string): Promise<T> | null {
  const existing = (inflight.get(key) as Promise<T> | undefined) ?? null;
  if (existing) reuseCount += 1;
  return existing;
}

export function runOnce<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = getInflight<T>(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await task();
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function inflightSize() {
  return inflight.size;
}

export function inflightSnapshot() { return { active: inflight.size, reuseCount }; }
