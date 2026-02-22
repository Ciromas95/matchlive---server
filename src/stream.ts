import { Response } from "express";

type Client = {
  res: Response;
  types: Set<string>;
};

let clients: Client[] = [];

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
  clients.push({
    res,
    types: new Set(types.map(t => t.toLowerCase()))
  });
}

export function removeClient(res: Response) {
  clients = clients.filter((c) => c.res !== res);
}

export function broadcast(payload: any) {
  const type = (payload?.type ?? "").toString().toLowerCase();

  // DEDUPE solo per goal
  let msg: string;

  if (type.toLowerCase() === "goal") {
    const gate = shouldEmitGoal(payload);
    if (!gate.ok) return; // DUPLICATO -> non inviare

    // arricchiamo il payload con dedupeKey
    const enriched = { ...payload, dedupeKey: gate.key };

    // SSE: inviamo anche id + event per aiutare il client (EventSource)
    msg =
      `id: ${gate.key}\n` +
      `event: goal\n` +
      `data: ${JSON.stringify(enriched)}\n\n`;
  } else {
    // comportamento originale per tutto il resto
    msg = `data: ${JSON.stringify(payload)}\n\n`;
  }

  const alive: Client[] = [];

  for (const c of clients) {
    try {
      if (c.types.size === 0 || c.types.has(type)) {
        c.res.write(msg);
      }
      alive.push(c);
    } catch {
      try { c.res.end(); } catch {}
    }
  }

  clients = alive;
}

export function clientsCount() {
  return clients.length;
}