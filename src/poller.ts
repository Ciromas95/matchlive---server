import { getFixtureById, getLiveFixtures } from "./apiFootball";
import { broadcast, clientsCount } from "./stream";
import { liveTtlMs } from "./ttl";
import { pruneRedCardsLive, updateRedCardsFromFixture } from "./redCardsLive";
import { pushEnabled, sendFixturePush } from "./push";

const lastScore = new Map<number, string>();

// eventId -> lastSeenEpochMs (così possiamo pulire)
const seenEvents = new Map<string, number>();
const trackedLive = new Map<number, { fixture: any; missing: number }>();

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
  const detail = String(ev?.detail ?? "").toLowerCase();
  return t === "goal" || (t === "card" && (detail.includes("red") || detail.includes("second yellow")));
}

function matchName(f: any) {
  return `${f?.teams?.home?.name ?? "Casa"} – ${f?.teams?.away?.name ?? "Trasferta"}`;
}

async function sendNewEventPush(f: any, ev: any, fixtureId: number) {
  const type = String(ev?.type ?? "").toLowerCase();
  const detail = String(ev?.detail ?? "").toLowerCase();
  const player = String(ev?.player?.name ?? "").trim();
  const team = String(ev?.team?.name ?? "").trim();
  const score = `${f?.goals?.home ?? 0}-${f?.goals?.away ?? 0}`;
  const fixture = matchName(f);
  if (type === "goal") {
    await Promise.all([
      sendFixturePush(fixtureId, "goal", "GOAL", `${team || fixture} · ${score}`),
      sendFixturePush(fixtureId, "scorer", player || "Marcatore", `${team || fixture} · ${score}`),
      sendFixturePush(fixtureId, "goal_scorer", `GOAL${player ? ` · ${player}` : ""}`, `${team || fixture} · ${score}`),
    ]);
  } else if (type === "card" && (detail.includes("red") || detail.includes("second yellow"))) {
    await sendFixturePush(
      fixtureId,
      "red",
      `Espulsione${player ? ` · ${player}` : ""}`,
      team || fixture,
    );
  }
}

async function checkFinishedFixtures(liveIds: Set<number>) {
  for (const [fixtureId, tracked] of trackedLive.entries()) {
    if (liveIds.has(fixtureId)) continue;
    tracked.missing += 1;
    if (tracked.missing < 2) continue;
    const raw = await getFixtureById(fixtureId).catch(() => null);
    const fixture = raw?.response?.[0];
    const status = String(fixture?.fixture?.status?.short ?? "").toUpperCase();
    if (["FT", "AET", "PEN"].includes(status)) {
      const score = `${fixture?.goals?.home ?? 0}-${fixture?.goals?.away ?? 0}`;
      await sendFixturePush(
        fixtureId,
        "finished",
        "Partita terminata",
        `${matchName(fixture)} · ${score}`,
      );
      trackedLive.delete(fixtureId);
    } else if (tracked.missing >= 5) {
      trackedLive.delete(fixtureId);
    }
  }
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
      if (clientsCount() === 0 && !pushEnabled()) {
        scheduleNext(30000);
        return;
      }

      const data = await getLiveFixtures("live");
      const fixtures = Array.isArray(data?.response) ? data.response : [];
      const liveCount = fixtures.length;

      // per pulizia lastScore + redcards
      const liveIds = new Set<number>();

      for (const f of fixtures) {
        const fixtureId = f?.fixture?.id;
        if (!fixtureId) continue;

        liveIds.add(fixtureId);
        const alreadyTracked = trackedLive.has(fixtureId);
        trackedLive.set(fixtureId, { fixture: f, missing: 0 });
        const elapsed = Number(f?.fixture?.status?.elapsed ?? 0);
        if (!alreadyTracked && elapsed <= 2) {
          await sendFixturePush(
            fixtureId,
            "kickoff",
            "Partita iniziata",
            matchName(f),
          );
        }

        // ✅ RED CARDS: aggiorna cache dai events del fixture (non broadcast)
        // TTL 90s per sicurezza
        updateRedCardsFromFixture(fixtureId, f, 90_000);

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
          // Al riavvio del server inizializza la timeline senza notificare
          // come nuovi tutti gli episodi già avvenuti nel match.
          if (!alreadyTracked && elapsed > 2) continue;

          broadcast({
            eventId,
            fixtureId,
            type: ev?.type,
            detail: ev?.detail,
            teamId: ev?.team?.id,
            elapsed: ev?.time?.elapsed,
            player: ev?.player?.name,
          });
          await sendNewEventPush(f, ev, fixtureId);
        }
      }

      // pulizie memoria
      pruneSeenEvents(6 * 60 * 60 * 1000); // 6 ore
      pruneLastScore(liveIds);
      pruneRedCardsLive(liveIds); // ✅
      await checkFinishedFixtures(liveIds);

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
