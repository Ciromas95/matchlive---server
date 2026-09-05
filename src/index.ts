import { runtimeModeStore } from "./runtimeMode";
import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";

import * as apiFootball from "./apiFootball";
import { flagUrlFromCountryName } from "./flags";
import { toLiveCompact } from "./compact";
import { addClient, removeClient } from "./stream";
import { startPoller } from "./poller";
import { getApiStats, markAppRequest } from "./stats";
import { refreshProviderQuota } from "./providerQuotaSync";
import { cacheSize, cacheSnapshot, expireLiveCaches } from "./cache";
import { inflightSize } from "./inflight";
import leagueFixturesRouter from "./routes/leagueFixtures";
import brainPrematchRouter from "./routes/brainPrematch";
import brainLiveRouter from "./routes/brainLive";
import * as brainLiveModule from "./brainLive";
import { configuredAdminSessionStore } from "./adminSessions";
import { startBrainPrematchSchedulerV3 } from "./brainPrematchV3";
import { sendAdminPushTest } from "./push";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

function setSharedCache(res: Response, seconds: number) {
  const safe = Math.max(1, Math.min(seconds, 60));
  res.setHeader(
    "Cache-Control",
    `public, max-age=1, s-maxage=${safe}, stale-while-revalidate=${safe * 3}`
  );
}

// Protezione leggera anti-raffica. Non serve a "bloccare utenti normali",
// serve a impedire loop aggressivi o refresh martellanti dallo stesso IP.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? "60000");
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? "240");
const rateBuckets = new Map<string, { start: number; count: number }>();

function rateLimitApi(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith("/admin") || req.path.startsWith("/stream")) {
    return next();
  }

  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { start: now, count: 1 });
    return next();
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    res.setHeader("Retry-After", "10");
    return res.status(429).json({
      error: "too_many_requests",
      message: "Troppi refresh ravvicinati. Riprova tra pochi secondi.",
    });
  }

  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now - bucket.start > RATE_LIMIT_WINDOW_MS * 2) {
      rateBuckets.delete(key);
    }
  }
}, 60_000);

// ===============================
// Users metrics (anonymous heartbeat) — in memory
// ===============================
let usersDayKeyUTC = "";
let usersSeenToday = new Set<string>();
let usersSessionsToday = 0;
const usersLastSeenByInstallId = new Map<string, number>();

function utcDayKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureUsersDay() {
  const key = utcDayKey();

  if (!usersDayKeyUTC) usersDayKeyUTC = key;

  if (usersDayKeyUTC !== key) {
    usersDayKeyUTC = key;
    usersSeenToday = new Set<string>();
    usersSessionsToday = 0;
  }
}

function computeOnlineNow() {
  const now = Date.now();
  const ONLINE_WINDOW_MS = 120 * 1000;
  const GC_WINDOW_MS = 30 * 60 * 1000;

  let online = 0;

  for (const [id, ts] of usersLastSeenByInstallId.entries()) {
    const age = now - ts;

    if (age > GC_WINDOW_MS) {
      usersLastSeenByInstallId.delete(id);
      continue;
    }

    if (age < ONLINE_WINDOW_MS) {
      online += 1;
    }
  }

  return online;
}

setInterval(() => {
  computeOnlineNow();
}, 5 * 60 * 1000);

// ===============================
// Basic API protection (App Key)
// ===============================
const APP_KEY = (process.env.APP_KEY ?? "").trim();
const REQUIRE_KEY = (process.env.REQUIRE_KEY ?? "true").toLowerCase() === "true";

// ===============================
// Admin auth
// ===============================
const ADMIN_PIN = (process.env.ADMIN_PIN ?? "").trim();
const adminSessions = configuredAdminSessionStore();

function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const auth = (req.header("authorization") ?? "").trim();
  const token = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    if (!adminSessions.has(token)) {
      return res.status(401).json({ error: "Invalid token" });
    }
  } catch {
    return res.status(503).json({ error: "Session store unavailable" });
  }

  next();
}

// ===============================
// Middleware APP_KEY
// ===============================
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/admin")) return next();
  if (!REQUIRE_KEY || !APP_KEY) return next();

  const got =
    req.header("x-ml-key") ??
    req.header("X-ML-KEY") ??
    (typeof req.query.key === "string" ? req.query.key : "") ??
    "";

  if (got.trim() !== APP_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// ===============================
// Endpoint hits
// ===============================
app.use("/api", (req: Request, _res: Response, next: NextFunction) => {
  markAppRequest(req.method, req.path);
  next();
});

app.use("/api", rateLimitApi);

// ===============================
// Metrics heartbeat
// ===============================
app.post("/api/metrics/heartbeat", (req: Request, res: Response) => {
  ensureUsersDay();

  const installId = String(req.body?.installId ?? "").trim();

  if (!installId || installId.length < 8) {
    return res.status(400).json({ error: "installId required" });
  }

  const now = Date.now();
  const prev = usersLastSeenByInstallId.get(installId);
  const SESSION_WINDOW_MS = 10 * 60 * 1000;

  if (!prev || now - prev > SESSION_WINDOW_MS) {
    usersSessionsToday += 1;
  }

  usersLastSeenByInstallId.set(installId, now);
  usersSeenToday.add(installId);

  return res.json({ ok: true });
});

// ===============================
// Public health
// ===============================
app.get("/", (_req: Request, res: Response) => {
  return res.json({ message: "MatchLive Server attivo 🚀" });
});

// ===============================
// Admin endpoints
// ===============================
app.post("/api/admin/login", (req: Request, res: Response) => {
  if (!ADMIN_PIN) {
    return res.status(500).json({ error: "ADMIN_PIN not configured" });
  }

  const pin = String(req.body?.pin ?? "").trim();

  if (!pin) {
    return res.status(400).json({ error: "Missing pin" });
  }

  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: "Wrong pin" });
  }

  try {
    const token = adminSessions.create();
    return res.json({ token, expiresAt: null });
  } catch {
    return res.status(503).json({ error: "Session store unavailable" });
  }
});

app.post("/api/admin/logout", requireAdminToken, (req: Request, res: Response) => {
  const token = (req.header("authorization") ?? "").slice(7).trim();
  try {
    adminSessions.revoke(token);
    return res.json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Session store unavailable" });
  }
});

app.get("/api/admin/runtime-mode", requireAdminToken, (_req, res) => {
  res.json({ mode: runtimeModeStore().get() });
});
app.post("/api/admin/runtime-mode", requireAdminToken, (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "eco" && mode !== "fast") return res.status(400).json({ error: "Invalid mode" });
  try {
    const previous = runtimeModeStore().get();
    runtimeModeStore().set(mode);
    if (previous !== mode && mode === "fast") expireLiveCaches();
    return res.json({ mode });
  } catch {
    return res.status(503).json({ error: "Impossibile salvare la modalità" });
  }
});

app.post("/api/admin/push-test", requireAdminToken, async (_req, res) => {
  const sent = await sendAdminPushTest();
  if (!sent) return res.status(503).json({ error: "Push Firebase non disponibile" });
  return res.json({ ok: true });
});

app.get("/api/admin/stats", requireAdminToken, async (_req: Request, res: Response) => {
  await refreshProviderQuota();
  ensureUsersDay();
  const stats = getApiStats();
  const cache = cacheSnapshot();

  return res.json({
    ...stats,
    cacheSize: cacheSize(),
    serverMemory: cache,
    workInProgress: {
      externalUpdatesRunning: inflightSize(),
    },
    users: {
      onlineNow: computeOnlineNow(),
      dauToday: usersSeenToday.size,
      sessionsToday: usersSessionsToday,
    },
  });
});

// ===============================
// Live endpoints
// ===============================
app.get("/api/live", async (_req: Request, res: Response) => {
  try {
    setSharedCache(res, 5);
    const data = await apiFootball.getLiveFixtures("live");
    return res.json(data);
  } catch (e: any) {
    console.error("LIVE ERROR:", e?.response?.data ?? e?.message ?? e);
    const status = e?.response?.status;
    return res.status(status && status >= 400 ? status : 500).json({
      error: "API-Football error",
      status,
      details: e?.response?.data ?? e?.message ?? e,
    });
  }
});

app.get("/api/live/compact", async (_req: Request, res: Response) => {
  try {
    setSharedCache(res, 5);
    const data = await apiFootball.getLiveFixtures("compact");
    const fixtures = await toLiveCompact(data);

    return res.json({
      updatedAt: new Date().toISOString(),
      results: fixtures.length,
      fixtures,
    });
  } catch (e: any) {
    console.error("LIVE COMPACT ERROR:", e?.response?.data ?? e?.message ?? e);
    const status = e?.response?.status;
    return res.status(status && status >= 400 ? status : 500).json({
      error: "API-Football error",
      status,
      details: e?.response?.data ?? e?.message ?? e,
    });
  }
});

// ===============================
// Players flags
// ===============================
app.get("/api/players/flags", async (req: Request, res: Response) => {
  try {
    const team = Number(req.query.team);
    const season = Number(req.query.season);
    const playerIds = String(req.query.playerIds ?? "")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0);

    if (!team || !season) {
      return res.status(400).json({ error: "Missing team or season" });
    }

    const data = await apiFootball.getPlayersByTeam(team, season);
    const resp = Array.isArray(data?.response) ? data.response : [];
    const map: Record<string, { nationality: string | null; flagUrl: string | null }> = {};

    const addPlayerFlag = (p: any) => {
      const id = p?.id;
      if (!id) return;

      const nationality = String(p?.nationality || p?.birth?.country || "").trim();
      const flagUrl = flagUrlFromCountryName(nationality, 40);

      map[String(id)] = {
        nationality: nationality || null,
        flagUrl,
      };
    };

    for (const item of resp) {
      addPlayerFlag(item?.player);
    }

    const missingPlayerIds = [...new Set(playerIds)]
      .filter((playerId) => !map[String(playerId)])
      .slice(0, 30);

    for (const playerId of missingPlayerIds) {
      const playerData = await apiFootball.getPlayerById(playerId, season);
      const playerResp = Array.isArray(playerData?.response)
        ? playerData.response
        : [];
      addPlayerFlag(playerResp[0]?.player);
    }

    return res.json({
      team,
      season,
      count: Object.keys(map).length,
      map,
    });
  } catch (e: any) {
    console.error("[players/flags] ERROR:", e?.message ?? e);
    return res.status(500).json({ error: "players_flags_failed" });
  }
});

// ===============================
// Routers
// ===============================
app.use("/api/league/fixtures", leagueFixturesRouter);
app.get("/api/standings", async (req: Request, res: Response) => {
  const leagueId = Number(req.query.leagueId);
  const season = Number(req.query.season);
  if (!Number.isInteger(leagueId) || leagueId <= 0 ||
      !Number.isInteger(season) || season < 1900) {
    return res.status(400).json({ error: "Missing or invalid leagueId/season" });
  }
  try {
    const data = await apiFootball.getStandingsCached(leagueId, season);
    res.setHeader(
      "Cache-Control",
      "public, max-age=60, s-maxage=3600, stale-while-revalidate=300",
    );
    return res.json(data);
  } catch (error: any) {
    const status = error?.response?.status;
    return res.status(status && status >= 400 ? status : 502).json({
      error: "Standings unavailable",
    });
  }
});
app.get("/api/fixtures/final", async (req: Request, res: Response) => {
  const fixtureId = Number(req.query.id);
  if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
    return res.status(400).json({ error: "Missing or invalid fixture id" });
  }
  try {
    const data = await apiFootball.getFinishedFixtureDetailsCached(fixtureId);
    res.setHeader(
      "Cache-Control",
      "public, max-age=300, s-maxage=86400, stale-while-revalidate=3600",
    );
    return res.json(data);
  } catch (error: any) {
    const status = error?.response?.status;
    return res.status(status && status >= 400 ? status : 502).json({
      error: "Finished fixture unavailable",
    });
  }
});
app.use("/api/brain", brainPrematchRouter);
app.use("/api/brain", brainLiveRouter);

// ===============================
// SSE stream
// ===============================
app.get("/api/stream", (req: Request, res: Response) => {
  const typesParam = (req.query.types as string | undefined) ?? "";
  const types = typesParam
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const accepted = addClient(res, types);
  if (!accepted) return;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      removeClient(res);
      try {
        res.end();
      } catch {}
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

// ===============================
// Optional stats endpoint
// ===============================
app.get("/api/stats", (_req: Request, res: Response) => {
  return res.json({
    ...getApiStats(),
    cacheSize: cacheSize(),
    serverMemory: cacheSnapshot(),
  });
});

// ===============================
// Debug route
// ===============================
app.get("/api/brain-test", (_req: Request, res: Response) => {
  return res.json({ ok: true, route: "brain-test" });
});

// ===============================
// Server & poller
// ===============================
const PORT = Number(process.env.PORT) || 3000;

if (process.env.ENABLE_POLLER !== "false") {
  startPoller();
}
if (process.env.ENABLE_BRAIN_LIVE_POLLER !== "false") {
  brainLiveModule.startBrainLivePoller(8);
}
startBrainPrematchSchedulerV3();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
