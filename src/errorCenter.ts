type ErrorGroup = {
  fingerprint: string; service: string; module: string; errorCode: string | null;
  message: string; count: number; firstAt: string; lastAt: string;
  requestId?: string; fixtureId?: number;
};
const groups = new Map<string, ErrorGroup>();

export function recordOperationalError(input: Omit<ErrorGroup, "fingerprint"|"count"|"firstAt"|"lastAt">) {
  const fingerprint = `${input.service}|${input.module}|${input.errorCode ?? ""}|${input.message}`.slice(0,600);
  const now = new Date().toISOString();
  const current = groups.get(fingerprint);
  groups.set(fingerprint, current ? { ...current, count: current.count + 1, lastAt: now, requestId: input.requestId ?? current.requestId, fixtureId: input.fixtureId ?? current.fixtureId }
    : { ...input, fingerprint, count: 1, firstAt: now, lastAt: now });
  if (groups.size > 500) {
    const oldest = [...groups.entries()].sort((a,b)=>a[1].lastAt.localeCompare(b[1].lastAt)).slice(0, groups.size-500);
    for (const [key] of oldest) groups.delete(key);
  }
}
export function errorCenterSnapshot() {
  const cutoff = Date.now() - 24*60*60_000;
  const values = [...groups.values()].filter((item)=>Date.parse(item.lastAt)>=cutoff).sort((a,b)=>b.lastAt.localeCompare(a.lastAt));
  return { last24h: values.reduce((sum,item)=>sum+item.count,0), groups: values.slice(0,100) };
}
