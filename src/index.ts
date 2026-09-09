import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";

import * as apiFootball from "./apiFootball";
import { flagUrlFromCountryName } from "./flags";
import { toLiveCompact } from "./compact";
import { addClient, clientsCount, removeClient, writeHeartbeat } from "./stream";
import { startPoller } from "./poller";
import { getApiStats, markAppRequest } from "./stats";
import { refreshProviderQuota } from "./providerQuotaSync";
import { cacheSize, cacheSnapshot } from "./cache";
import { inflightSize } from "./inflight";
import leagueFixturesRouter from "./routes/leagueFixtures";
import brainPrematchRouter from "./routes/brainPrematch";
import brainLiveRouter from "./routes/brainLive";
import lineupsRouter from "./routes/lineups";
import * as brainLiveModule from "./brainLive";
import { configuredAdminSessionStore } from "./adminSessions";
import { startBrainPrematchSchedulerV3 } from "./brainPrematchV3";
import { getLatestPrematchScanReport } from "./prematchScanReport";
import { sendAdminPushTest } from "./push";
import { getLiveStateSnapshot, hasLiveState, hydrateLiveStateFromPostgres } from "./liveState";
import { priorityQueueSnapshot } from "./priorityQueue";
import { providerQueueSnapshot } from "./providerRateLimiter";
import { requestContext } from "./logger";
import { observeHttp } from "./telemetry";
import { initializeRedis } from "./redisInfrastructure";
import { initializePostgres } from "./postgresInfrastructure";
import { detailedHealth, liveHealth, readinessHealth } from "./health";
import { infrastructureDashboardSnapshot } from "./adminInfrastructure";
import { installGracefulShutdown, markStartupReady, registerStopTask, trackJob } from "./lifecycle";
import { validateShadowStorage } from "./shadowStorage";
import { verifiedFirebaseUser, upsertUserActivity } from "./firebaseAuth";
import { loadOperationalMetricHistory, persistOperationalMetrics } from "./metricsPersistence";
import crypto from "node:crypto";
import { auditAdmin } from "./adminAudit";
import { postgresReady, query as postgresQuery } from "./postgresInfrastructure";
import { startLineupScheduler } from "./lineupScheduler";

dotenv.config();

const app = express();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: false }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "256kb" }));
app.use(requestContext(observeHttp));

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
  if (req.path.startsWith("/stream")) {
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
  const maximum = req.path === "/admin/login"
    ? Number(process.env.ADMIN_LOGIN_RATE_LIMIT_MAX ?? "10")
    : req.path.startsWith("/admin")
      ? Number(process.env.ADMIN_RATE_LIMIT_MAX ?? "120")
      : RATE_LIMIT_MAX;
  if (bucket.count > maximum) {
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

app.get("/api/provider", async (req: Request, res: Response) => {
  const path = String(req.query.path ?? "").trim();
  const params = { ...req.query } as Record<string, unknown>;
  delete params.path;
  try {
    const payload = await apiFootball.getProviderResource(path, params);
    setSharedCache(res, path.includes("statistics") || path.includes("events") ? 8 : 30);
    return res.json(payload);
  } catch (error: any) {
    const status = Number(error?.status ?? error?.response?.status ?? 502);
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: "provider_request_failed",
      message: error?.message ?? "Dati temporaneamente non disponibili",
    });
  }
});

// ===============================
// Metrics heartbeat
// ===============================
app.post("/api/metrics/heartbeat", async (req: Request, res: Response) => {
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

  const user = await verifiedFirebaseUser(req);
  if (user) void upsertUserActivity(user.uid, String(req.body?.platform ?? "unknown"));

  return res.json({ ok: true });
});

// ===============================
// Public health
// ===============================
app.get("/", (_req: Request, res: Response) => {
  return res.json({ message: "MatchLive Server attivo 🚀" });
});
app.get("/health/live", (_req: Request, res: Response) => res.json(liveHealth()));
app.get("/health/ready", (_req: Request, res: Response) => {
  const health = readinessHealth();
  return res.status(health.ready ? 200 : 503).json(health);
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

  const pinBuffer = Buffer.from(pin);
  const expectedBuffer = Buffer.from(ADMIN_PIN);
  if (pinBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(pinBuffer, expectedBuffer)) {
    void auditAdmin("login_failed", { ip: req.ip });
    return res.status(401).json({ error: "Wrong pin" });
  }

  try {
    const token = adminSessions.create();
    void auditAdmin("login_success", { token, ip: req.ip });
    return res.json({ token, expiresAt: adminSessions.expiresAt(token) });
  } catch {
    return res.status(503).json({ error: "Session store unavailable" });
  }
});

app.post("/api/admin/logout", requireAdminToken, (req: Request, res: Response) => {
  const token = (req.header("authorization") ?? "").slice(7).trim();
  try {
    adminSessions.revoke(token);
    void auditAdmin("logout", { token, ip: req.ip });
    return res.json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Session store unavailable" });
  }
});

app.get("/health/details", rateLimitApi, requireAdminToken, async (_req: Request, res: Response) => {
  return res.json(await detailedHealth());
});

app.get("/api/admin/infrastructure", requireAdminToken, async (_req: Request, res: Response) => {
  return res.json(await infrastructureDashboardSnapshot(getApiStats()));
});

app.get("/api/admin/infrastructure/history", requireAdminToken, async (req: Request, res: Response) => {
  const range = String(req.query.range ?? "15m");
  return res.json({ range, source: "postgres", rows: await loadOperationalMetricHistory(range) });
});

app.get("/api/admin/users", requireAdminToken, async (req: Request, res: Response) => {
  if (!postgresReady()) return res.json({ source: "unavailable", users: [], total: 0 });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const result = await postgresQuery(`SELECT u.id,u.display_name,u.platform,u.created_at,u.last_active_at,
    EXISTS(SELECT 1 FROM user_entitlements e WHERE e.user_id=u.id AND e.status='active' AND (e.expires_at IS NULL OR e.expires_at>now())) premium,
    (SELECT count(*)::int FROM user_favorites f WHERE f.user_id=u.id) favorite_count,
    count(*) OVER()::int total FROM app_users u ORDER BY u.last_active_at DESC NULLS LAST LIMIT $1 OFFSET $2`, [limit,offset]);
  return res.json({ source: "postgres", total: result.rows[0]?.total ?? 0, users: result.rows.map(({ total, ...row }: any)=>row) });
});

app.get("/api/admin/users/:id", requireAdminToken, async (req: Request, res: Response) => {
  if (!postgresReady()) return res.status(503).json({ error: "database_unavailable" });
  const userId = String(req.params.id ?? "");
  const result = await postgresQuery(`SELECT u.id,u.display_name,u.platform,u.created_at,u.last_active_at,
    (SELECT count(*)::int FROM user_favorites f WHERE f.user_id=u.id) favorite_count,
    (SELECT count(*)::int FROM user_entitlements e WHERE e.user_id=u.id AND e.status='active') active_entitlements
    FROM app_users u WHERE u.id=$1`, [userId]);
  if (!result.rows[0]) return res.status(404).json({ error: "user_not_found" });
  void auditAdmin("user_detail_viewed", { token: String(req.header("authorization")??"").slice(7), ip:req.ip, targetType:"user", targetId:userId });
  return res.json(result.rows[0]);
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
  const prematchScan = await getLatestPrematchScanReport();
  const liveSnapshot = getLiveStateSnapshot();
  const infrastructure = await infrastructureDashboardSnapshot(stats);

  return res.json({
    ...stats,
    cacheSize: cacheSize(),
    serverMemory: cache,
    workInProgress: {
      externalUpdatesRunning: inflightSize(),
    },
    livePipeline: {
      revision: liveSnapshot.revision,
      fixtures: liveSnapshot.fixtures.length,
      connectedDevices: clientsCount(),
      updatedAt: liveSnapshot.updatedAt,
      ageMs: liveSnapshot.updatedAt
        ? Math.max(0, Date.now() - Date.parse(liveSnapshot.updatedAt))
        : null,
    },
    priorityQueue: priorityQueueSnapshot(),
    providerQueue: providerQueueSnapshot(),
    users: {
      onlineNow: computeOnlineNow(),
      dauToday: usersSeenToday.size,
      sessionsToday: usersSessionsToday,
    },
    prematchScan,
    infrastructure,
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
    setSharedCache(res, 2);
    if (hasLiveState()) {
      const snapshot = getLiveStateSnapshot();
      return res.json({
        updatedAt: snapshot.updatedAt,
        revision: snapshot.revision,
        results: snapshot.fixtures.length,
        fixtures: snapshot.fixtures,
      });
    }
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
app.use("/api/lineups", lineupsRouter);

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
  if (types.length === 0 || types.includes("live_snapshot") || types.includes("live_delta")) {
    const snapshot = getLiveStateSnapshot();
    res.write(`data: ${JSON.stringify({
      type: "live_snapshot",
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      fixtures: snapshot.fixtures,
    })}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try {
      writeHeartbeat(res, `: ping ${Date.now()}\n\n`);
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
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
installGracefulShutdown(server);

async function bootstrap() {
  await Promise.allSettled([initializeRedis(), initializePostgres()]);
  await hydrateLiveStateFromPostgres();
  if (process.env.ENABLE_POLLER !== "false") {
    const stop = startPoller();
    registerStopTask("live-poller", stop);
  }
  if (process.env.ENABLE_BRAIN_LIVE_POLLER !== "false") {
    brainLiveModule.startBrainLivePoller(8);
    registerStopTask("brain-live-poller", brainLiveModule.stopBrainLivePoller);
  }
  if (process.env.ENABLE_PREMATCH_SCHEDULER !== "false") {
    const stopPrematch = startBrainPrematchSchedulerV3();
    registerStopTask("prematch-scheduler", stopPrematch);
  }
  registerStopTask("lineup-scheduler", startLineupScheduler());
  const shadowValidationTimer = setInterval(() => void validateShadowStorage(), 5 * 60_000);
  shadowValidationTimer.unref();
  registerStopTask("shadow-validator", () => clearInterval(shadowValidationTimer));
  const metricsTimer = setInterval(() => void persistOperationalMetrics(), 60_000);
  metricsTimer.unref();
  registerStopTask("metrics-persistence", async () => { clearInterval(metricsTimer); await persistOperationalMetrics(); });
  if (process.env.NODE_ENV === "test" && Number(process.env.TEST_ACTIVE_JOB_MS) > 0) {
    void trackJob(new Promise((resolve) => setTimeout(resolve, Number(process.env.TEST_ACTIVE_JOB_MS))));
  }
  markStartupReady();
}

void bootstrap();
