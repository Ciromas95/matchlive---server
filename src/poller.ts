import { getFixtureById, getLiveFixtures, getStandingsCached } from "./apiFootball";
import { broadcast } from "./stream";
import { liveTtlMs } from "./ttl";
import { canStartJobs, trackJob } from "./lifecycle";
import { markHealthActivity } from "./health";
import { pruneRedCardsLive, updateRedCardsFromFixture } from "./redCardsLive";
import { sendFixturePush } from "./push";
import { publishLiveState } from "./liveState";
import { completeLiveCycle } from "./livePipelineTelemetry";
import { detectScoreCorrection } from "./scoreCorrection";
import {
  primeLiveStandingsBaselines,
  rememberCompletedStandingsFixture,
  removeLiveStandingsFixture,
} from "./liveStandings";

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

function eventMinute(ev: any) {
  const elapsed = Number(ev?.time?.elapsed);
  const extra = Number(ev?.time?.extra);
  if (!Number.isFinite(elapsed)) return "";
  return `${elapsed}${Number.isFinite(extra) && extra > 0 ? `+${extra}` : ""}′`;
}

function fixtureImage(f: any, teamId?: number | null) {
  const home = f?.teams?.home;
  const away = f?.teams?.away;
  if (teamId != null && Number(home?.id) === Number(teamId)) return String(home?.logo ?? "");
  if (teamId != null && Number(away?.id) === Number(teamId)) return String(away?.logo ?? "");
  // Per gli eventi neutri (inizio/fine) mostriamo comunque una squadra:
  // il logo della competizione resta solo come ultimo ripiego.
  return String(home?.logo ?? away?.logo ?? f?.league?.logo ?? "");
}

function premiumScoreLine(
  f: any,
  highlightedTeamId?: number | null,
  event: "goal" | "red" | null = null,
) {
  const home = f?.teams?.home;
  const away = f?.teams?.away;
  const homeName = String(home?.name ?? "Casa");
  const awayName = String(away?.name ?? "Trasferta");
  const homeGoals = Number(f?.goals?.home ?? 0);
  const awayGoals = Number(f?.goals?.away ?? 0);
  const homeHighlighted = Number(home?.id) === Number(highlightedTeamId);
  const awayHighlighted = Number(away?.id) === Number(highlightedTeamId);
  const homeScore = event === "goal" && homeHighlighted ? `[${homeGoals}]` : String(homeGoals);
  const awayScore = event === "goal" && awayHighlighted ? `[${awayGoals}]` : String(awayGoals);
  const homeCard = event === "red" && homeHighlighted ? " 🟥" : "";
  const awayCard = event === "red" && awayHighlighted ? "🟥 " : "";
  return `${homeName}${homeCard}  ${homeScore}  •  ${awayScore}  ${awayCard}${awayName}`;
}

async function sendNewEventPush(f: any, ev: any, fixtureId: number) {
  const type = String(ev?.type ?? "").toLowerCase();
  const detail = String(ev?.detail ?? "").toLowerCase();
  const team = String(ev?.team?.name ?? "").trim();
  const score = `${f?.goals?.home ?? 0}-${f?.goals?.away ?? 0}`;
  const fixture = matchName(f);
  const teamId = Number(ev?.team?.id) || null;
  const imageUrl = fixtureImage(f, teamId);
  const minute = eventMinute(ev);
  const common = {
    imageUrl,
    homeName: String(f?.teams?.home?.name ?? ""),
    awayName: String(f?.teams?.away?.name ?? ""),
    homeLogo: String(f?.teams?.home?.logo ?? ""),
    awayLogo: String(f?.teams?.away?.logo ?? ""),
    teamName: team,
    minute,
    score,
  };
  if (type === "goal") {
    await sendFixturePush(
      fixtureId,
      "goal",
      `⚽ GOOOL · ${team || "RETE"}`,
      `${premiumScoreLine(f, teamId, "goal")}${minute ? ` · ${minute}` : ""}`,
      common,
    );
  } else if (type === "card" && (detail.includes("red") || detail.includes("second yellow"))) {
    await sendFixturePush(
      fixtureId,
      "red",
      `🟥 ESPULSIONE · ${team || "CARTELLINO ROSSO"}`,
      `${premiumScoreLine(f, teamId, "red")}${minute ? ` · ${minute}` : ""}`,
      common,
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
    if (["FT", "AET", "PEN", "PEN_FT"].includes(status)) {
      rememberCompletedStandingsFixture(fixture);
      const score = `${fixture?.goals?.home ?? 0}-${fixture?.goals?.away ?? 0}`;
      await sendFixturePush(
        fixtureId,
        "finished",
        "🏁 TRIPLICE FISCHIO",
        `${String(fixture?.teams?.home?.name ?? "Casa")}  ${fixture?.goals?.home ?? 0}  •  ${fixture?.goals?.away ?? 0}  ${String(fixture?.teams?.away?.name ?? "Trasferta")}`,
        {
          imageUrl: fixtureImage(fixture),
          score,
          homeName: String(fixture?.teams?.home?.name ?? ""),
          awayName: String(fixture?.teams?.away?.name ?? ""),
          homeLogo: String(fixture?.teams?.home?.logo ?? ""),
          awayLogo: String(fixture?.teams?.away?.logo ?? ""),
        },
      );
      trackedLive.delete(fixtureId);
    } else if (status && !["1H", "HT", "2H", "ET", "BT", "P", "PEN_LIVE", "LIVE"].includes(status)) {
      // Sospesa, interrotta, abbandonata, rinviata o cancellata: la sua
      // proiezione deve sparire senza alterare punti e reti ufficiali.
      removeLiveStandingsFixture(fixtureId);
      if (tracked.missing >= 5) trackedLive.delete(fixtureId);
    } else if (tracked.missing >= 5) {
      trackedLive.delete(fixtureId);
    }
  }
}

export function startPoller() {
  let timer: any;
  let stopped = false;

  const scheduleNext = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { if (!stopped && canStartJobs()) void trackJob(run()); }, ms);
  };

  const run = async () => {
    if (stopped || !canStartJobs()) return;
    try {
      const data = await getLiveFixtures("live", true);
      const processingStarted = performance.now();
      const fixtures = Array.isArray(data?.response) ? data.response : [];
      const liveCount = fixtures.length;
      void primeLiveStandingsBaselines(fixtures, getStandingsCached).catch((error: any) => {
        console.warn("[liveStandings] baseline non disponibile:", error?.message ?? error);
      });

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
            "🏟️ SI COMINCIA",
            `${String(f?.teams?.home?.name ?? "Casa")}  0  •  0  ${String(f?.teams?.away?.name ?? "Trasferta")}`,
            {
              imageUrl: fixtureImage(f),
              homeName: String(f?.teams?.home?.name ?? ""),
              awayName: String(f?.teams?.away?.name ?? ""),
              homeLogo: String(f?.teams?.home?.logo ?? ""),
              awayLogo: String(f?.teams?.away?.logo ?? ""),
              score: "0-0",
            },
          );
        }

        // ✅ RED CARDS: aggiorna cache dai events del fixture (non broadcast)
        // TTL 90s per sicurezza
        updateRedCardsFromFixture(fixtureId, f, 90_000);

        // Una diminuzione reale del punteggio tra due snapshot consecutivi è
        // la fonte autorevole per una rete annullata. Non deduciamo VAR,
        // fuorigioco o altre motivazioni se API-Football non le comunica.
        const homeGoals = Number(f?.goals?.home ?? 0);
        const awayGoals = Number(f?.goals?.away ?? 0);
        const scoreStr = `${homeGoals}-${awayGoals}`;
        const prev = lastScore.get(fixtureId);
        if (prev != null && prev !== scoreStr) {
          const {
            home: homeCorrected,
            away: awayCorrected,
          } = detectScoreCorrection(prev, homeGoals, awayGoals);
          if (homeCorrected || awayCorrected) {
            const correctedTeam = homeCorrected
              ? f?.teams?.home
              : f?.teams?.away;
            await sendFixturePush(
              fixtureId,
              "correction",
              "↩️ CORREZIONE",
              premiumScoreLine(f),
              {
                imageUrl: fixtureImage(
                  f,
                  Number(correctedTeam?.id) || null,
                ),
                homeName: String(f?.teams?.home?.name ?? ""),
                awayName: String(f?.teams?.away?.name ?? ""),
                homeLogo: String(f?.teams?.home?.logo ?? ""),
                awayLogo: String(f?.teams?.away?.logo ?? ""),
                teamName: String(correctedTeam?.name ?? ""),
                score: scoreStr,
                previousScore: prev,
                elapsed: String(f?.fixture?.status?.elapsed ?? ""),
                eventKey: `correction:${prev}:${scoreStr}`,
              },
            );
          }
        }
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
      const processingMs = performance.now() - processingStarted;
      // Pubblica una sola fotografia coerente dopo aver aggiornato anche la
      // cache dei cartellini. Tutte le schermate ricevono lo stesso delta.
      await publishLiveState(data);
      markHealthActivity("ingestion");
      await checkFinishedFixtures(liveIds);
      completeLiveCycle({ processingMs, fixtures: liveCount });

      // Poll dinamico coerente con la cache TTL live (ms)
      const nextMs = Math.max(4_000, liveTtlMs(liveCount));
      scheduleNext(nextMs);
    } catch (e: any) {
      console.error("poller error:", e?.message || e);
      scheduleNext(15_000);
    }
  };

  void trackJob(run());
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
