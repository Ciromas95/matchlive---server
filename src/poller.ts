import { getLiveFixtures } from "./apiFootball";
import { broadcast, clientsCount } from "./stream";
import { liveTtlMs } from "./ttl";

const lastScore = new Map<number, string>();

// eventId -> lastSeenEpochMs (così possiamo pulire)
const seenEvents = new Map<string, number>();

function makeEventId(ev: any, fixtureId: number) {
  const type = ev?.type ?? "";
  const teamId = ev?.team?.id ?? "";
  const elapsed = ev?.time?.elapsed ?? "";
  const player = ev?.player?.id ?? ev?.player?.name ?? "";
  const detail = ev?.detail ?? "";
  return `${fixtureId}|${type}|${teamId}|${elapsed}|${player}|${detail}`;
}

// Pulisce eventi vecchi per non crescere all’infinito
function pruneSeenEvents(maxAgeMs: number) {
  const now = Date.now();
  for (const [id, ts] of seenEvents.entries()) {
    if (now - ts > maxAgeMs) seenEvents.delete(id);
  }
}

// (opzionale) pulisci score di partite che non sono più live
function pruneLastScore(liveFixtureIds: Set<number>) {
  for (const id of lastScore.keys()) {
    if (!liveFixtureIds.has(id)) lastScore.delete(id);
  }
}

// Filtro: manda solo GOAL (consigliato). Se vuoi anche cartellini/VAR ecc lo allarghiamo.
function isInterestingEvent(ev: any) {
  const t = String(ev?.type ?? "").toLowerCase();
  return t === "goal";
}

export function startPoller() {
  let timer: any;

  const scheduleNext = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  const run = async () => {
    try {
      // Se non c’è nessun client SSE, rallenta molto (risparmi API)
      if (clientsCount() === 0) {
        scheduleNext(30000);
        return;
      }

      const data = await getLiveFixtures("live");
      const fixtures = Array.isArray(data?.response) ? data.response : [];
      const liveCount = fixtures.length;

      // per pulizia lastScore
      const liveIds = new Set<number>();

      for (const f of fixtures) {
        const fixtureId = f?.fixture?.id;
        if (!fixtureId) continue;
        liveIds.add(fixtureId);

        // score tracking (utile per debug / UI, ma NON lo usiamo più come “trigger unico”)
        const scoreStr = `${f?.goals?.home ?? 0}-${f?.goals?.away ?? 0}`;
        const prev = lastScore.get(fixtureId);
        if (prev !== scoreStr) lastScore.set(fixtureId, scoreStr);

        // eventi: controlliamo SEMPRE (non solo se cambia score)
        const events = Array.isArray(f?.events) ? f.events : [];
        for (const ev of events) {
          if (!isInterestingEvent(ev)) continue;

          const eventId = makeEventId(ev, fixtureId);
          if (seenEvents.has(eventId)) continue;

          seenEvents.set(eventId, Date.now());

          broadcast({
            eventId,
            fixtureId,
            type: ev?.type,
            detail: ev?.detail,
            teamId: ev?.team?.id,
            elapsed: ev?.time?.elapsed,
            player: ev?.player?.name,
          });

        }
      }

      // pulizie memoria
      pruneSeenEvents(6 * 60 * 60 * 1000); // 6 ore (puoi mettere 2 ore se vuoi)
      pruneLastScore(liveIds);

      // Poll dinamico coerente con la cache TTL live
// Poll dinamico coerente con la cache TTL live (ms)
const nextMs = Math.max(4000, liveTtlMs(liveCount) + 300);
scheduleNext(nextMs);
    } catch (e: any) {
      console.error("poller error:", e?.message || e);
      scheduleNext(15000);
    }
  };

  run();
}