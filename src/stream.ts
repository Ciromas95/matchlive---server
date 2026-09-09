import { Response } from "express";
import { sampleSseConnections } from "./telemetry";
import { livePipelineSnapshot, recordLiveSse } from "./livePipelineTelemetry";

type Client = {
  res: Response;
  types: Set<string>;
  connectedAt: number;
  bytes: number;
};

let clients: Client[] = [];
const MAX_SSE_CLIENTS = Number(process.env.MAX_SSE_CLIENTS ?? "2000");
let opened = 0, closed = 0, eventsSent = 0, bytesSent = 0, heartbeats = 0, errors = 0, slowClients = 0;
let connectionDurationMs = 0;
let sequence = 0;
const openedAt: number[] = [];

// ===============================
// SSE DEDUPE (anti-duplicati goal)
// ===============================
const SSE_DEDUPE_TTL_MS = 15 * 60 * 1000; // 15 minuti
const seenGoalKeys = new Map<string, number>(); // key -> expireAt (epoch ms)

function gcSeenGoals() {
  const now = Date.now();
  for (const [k, exp] of seenGoalKeys.entries()) {
    if (exp <= now) seenGoalKeys.delete(k);
  }
}

function safeStr(v: any) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Costruisce una key "stabile" del goal.
 * Supporta sia payload flat (fixtureId, teamId, elapsed, extra...)
 * sia payload nested (fixture.id, team.id, time.elapsed...)
 */
function makeGoalKey(p: any) {
  const fixtureId = safeStr(p?.fixtureId ?? p?.fixture?.id);
  const teamId = safeStr(p?.team?.id ?? p?.teamId);
  const elapsed = safeStr(p?.time?.elapsed ?? p?.elapsed);
  const extra = safeStr(p?.time?.extra ?? p?.extra ?? "");
  const player = safeStr(p?.player?.id ?? p?.playerId ?? p?.player?.name ?? p?.player);
  const detail = safeStr(p?.detail ?? p?.subtype ?? p?.comments ?? p?.reason ?? "");

  return `goal|${fixtureId}|${teamId}|${elapsed}+${extra}|${player}|${detail}`;
}

function shouldEmitGoal(p: any) {
  gcSeenGoals();
  const key = makeGoalKey(p);

  // se manca fixtureId, non blocchiamo (ma idealmente deve esserci)
  const parts = key.split("|");
  const fixtureId = parts[1] ?? "";
  if (!fixtureId) return { ok: true as const, key };

  if (seenGoalKeys.has(key)) return { ok: false as const, key };

  seenGoalKeys.set(key, Date.now() + SSE_DEDUPE_TTL_MS);
  return { ok: true as const, key };
}

export function addClient(res: Response, types: string[]) {
  if (clients.length >= MAX_SSE_CLIENTS) {
    res.status(429).json({
      error: "stream_busy",
      message: "Troppi utenti collegati allo stream: usa refresh cache.",
      retryAfterSeconds: 20,
    });
    return false;
  }

  clients.push({
    res,
    types: new Set(types.map(t => t.toLowerCase())),
    connectedAt: Date.now(),
    bytes: 0,
  });
  opened += 1;
  openedAt.push(Date.now());
  sampleSseConnections(clients.length);
  return true;
}

export function removeClient(res: Response) {
  const found = clients.find((c) => c.res === res);
  if (found) { closed += 1; connectionDurationMs += Date.now() - found.connectedAt; }
  clients = clients.filter((c) => c.res !== res);
  sampleSseConnections(clients.length);
}

export function broadcast(payload: any) {
  const started = performance.now();
  const type = (payload?.type ?? "").toString().toLowerCase();

  // DEDUPE solo per goal
  let msg: string;

  if (type.toLowerCase() === "goal") {
    const gate = shouldEmitGoal(payload);
    if (!gate.ok) return 0; // DUPLICATO -> non inviare

    // arricchiamo il payload con dedupeKey
    const enriched = { ...payload, dedupeKey: gate.key };

    // SSE: inviamo anche id + event per aiutare il client (EventSource)
    msg =
      `id: ${gate.key}\n` +
      `event: goal\n` +
      `data: ${JSON.stringify(enriched)}\n\n`;
  } else {
    // comportamento originale per tutto il resto
    msg = `id: ${++sequence}\nevent: ${type || "message"}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  const alive: Client[] = [];

  for (const c of clients) {
    try {
      if (c.types.size === 0 || c.types.has(type)) {
        const writable = c.res.write(msg);
        eventsSent += 1; bytesSent += Buffer.byteLength(msg); c.bytes += Buffer.byteLength(msg);
        if (!writable) slowClients += 1;
      }
      alive.push(c);
    } catch {
      errors += 1;
      try { c.res.end(); } catch {}
    }
  }

  clients = alive;
  const durationMs = performance.now() - started;
  if (["live_delta", "goal", "card", "var"].includes(type)) recordLiveSse(durationMs);
  return durationMs;
}

export function clientsCount() {
  return clients.length;
}

export function writeHeartbeat(res: Response, message: string) {
  try { const ok = res.write(message); heartbeats += 1; bytesSent += Buffer.byteLength(message); if (!ok) slowClients += 1; return ok; }
  catch { errors += 1; return false; }
}

export function closeAllClients(reason = "server_shutdown") {
  const message = `event: shutdown\ndata: ${JSON.stringify({ type: "shutdown", reason, retryAfterSeconds: 4 })}\n\n`;
  for (const client of clients) { try { client.res.write(message); client.res.end(); } catch {} }
  for (const client of clients) connectionDurationMs += Date.now() - client.connectedAt;
  closed += clients.length; clients = []; sampleSseConnections(0);
}

export function sseSnapshot() {
  const reconnectCutoff = Date.now() - 60_000;
  while (openedAt[0] != null && openedAt[0] < reconnectCutoff) openedAt.shift();
  return { active: clients.length, max: MAX_SSE_CLIENTS, opened, closed,
    averageDurationMs: closed ? Math.round(connectionDurationMs / closed) : 0,
    eventsSent, bytesSent, heartbeats, errors, slowClients,
    reconnectsPerMinute: openedAt.length, backlog: slowClients, droppedEvents: 0,
    deliveryLatency: livePipelineSnapshot().stages.sseSend,
    replay: { enabled: false, readyForRedisStreams: true } };
}
