const g = globalThis as any;

const inflight: Map<string, Promise<any>> =
  g.__MATCHLIVE_INFLIGHT__ ?? (g.__MATCHLIVE_INFLIGHT__ = new Map());

export function getInflight<T>(key: string): Promise<T> | null {
  return (inflight.get(key) as Promise<T> | undefined) ?? null;
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
