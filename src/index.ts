import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";

import * as apiFootball from "./apiFootball";
import { flagUrlFromCountryName } from "./flags";
import { toLiveCompact } from "./compact";
import { addClient, removeClient } from "./stream";
import { startPoller } from "./poller";
import { getApiStats, markEndpointHit } from "./stats";
import { cacheSize } from "./cache";
import leagueFixturesRouter from "./routes/leagueFixtures";
import brainPrematchRouter from "./routes/brainPrematch";
import brainLiveRouter from "./routes/brainLive";
import * as brainLiveModule from "./brainLive";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

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
const ADMIN_TOKEN_SECRET = (process.env.ADMIN_TOKEN_SECRET ?? "").trim();
const ADMIN_TOKEN_TTL_MIN = Number(process.env.ADMIN_TOKEN_TTL_MIN ?? "1440");

type AdminSession = {
  exp: number;
};

const adminSessions = new Map<string, AdminSession>();

function cleanupAdminSessions() {
  const now = Date.now();

  for (const [token, session] of adminSessions.entries()) {
    if (session.exp <= now) {
      adminSessions.delete(token);
    }
  }
}

setInterval(cleanupAdminSessions, 60_000);

function makeToken() {
  const rand = crypto.randomBytes(32).toString("hex");

  if (!ADMIN_TOKEN_SECRET) {
    return rand;
  }

  return crypto.createHash("sha256").update(rand + ADMIN_TOKEN_SECRET).digest("hex");
}

function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  cleanupAdminSessions();

  const auth = (req.header("authorization") ?? "").trim();
  const token = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  const session = adminSessions.get(token);

  if (!session) {
    return res.status(401).json({ error: "Invalid token" });
  }

  if (session.exp <= Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: "Token expired" });
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
  markEndpointHit(req.method, req.path);
  next();
});

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

  const token = makeToken();
  const exp = Date.now() + ADMIN_TOKEN_TTL_MIN * 60_000;

  adminSessions.set(token, { exp });

  return res.json({
    token,
    expiresAt: new Date(exp).toISOString(),
  });
});

app.get("/api/admin/stats", requireAdminToken, (_req: Request, res: Response) => {
  ensureUsersDay();

  return res.json({
    ...getApiStats(),
    cacheSize: cacheSize(),
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
    const data = await apiFootball.getLiveFixtures("live");
    return res.json(data);
  } catch (e: any) {
    console.error("LIVE ERROR:", e?.response?.data ?? e?.message ?? e);
    return res.status(500).json({
      error: "API-Football error",
      details: e?.response?.data ?? e?.message ?? e,
    });
  }
});

app.get("/api/live/compact", async (_req: Request, res: Response) => {
  try {
    const data = await apiFootball.getLiveFixtures("compact");
    const fixtures = await toLiveCompact(data);

    return res.json({
      updatedAt: new Date().toISOString(),
      results: fixtures.length,
      fixtures,
    });
  } catch (e: any) {
    console.error("LIVE COMPACT ERROR:", e?.response?.data ?? e?.message ?? e);
    return res.status(500).json({
      error: "API-Football error",
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

    if (!team || !season) {
      return res.status(400).json({ error: "Missing team or season" });
    }

    const data = await apiFootball.getPlayersByTeam(team, season);
    const resp = Array.isArray(data?.response) ? data.response : [];
    const map: Record<string, { nationality: string | null; flagUrl: string | null }> = {};

    for (const item of resp) {
      const p = item?.player;
      const id = p?.id;
      if (!id) continue;

      const nationality = String(p?.nationality || p?.birth?.country || "").trim();
      const flagUrl = flagUrlFromCountryName(nationality, 40);

      map[String(id)] = {
        nationality: nationality || null,
        flagUrl,
      };
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
app.use("/api/brain", brainPrematchRouter);
app.use("/api/brain", brainLiveRouter);
console.log("Mounted brainLiveRouter on /api/brain");

// ===============================
// SSE stream
// ===============================
app.get("/api/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  const typesParam = (req.query.types as string | undefined) ?? "";
  const types = typesParam
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  addClient(res, types);

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
console.log("brainLive exports:", Object.keys(brainLiveModule));
brainLiveModule.startBrainLivePoller(8);
brainLiveModule.startBrainLivePoller(8);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});