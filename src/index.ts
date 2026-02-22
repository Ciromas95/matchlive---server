import express, { Request, Response } from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";

import { getLiveFixtures } from "./apiFootball";
import { toLiveCompact } from "./compact";
import { addClient, removeClient } from "./stream";
import { startPoller } from "./poller";
import { getApiStats, markEndpointHit } from "./stats";
import { cacheSize } from "./cache";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// Basic API protection (App Key)
// ===============================
const APP_KEY = (process.env.APP_KEY ?? "").trim();
const REQUIRE_KEY = (process.env.REQUIRE_KEY ?? "true").toLowerCase() === "true";

// ===============================
// Admin auth (PIN -> token in memory)
// ===============================
const ADMIN_PIN = (process.env.ADMIN_PIN ?? "").trim();
const ADMIN_TOKEN_SECRET = (process.env.ADMIN_TOKEN_SECRET ?? "").trim(); // opzionale
const ADMIN_TOKEN_TTL_MIN = Number(process.env.ADMIN_TOKEN_TTL_MIN ?? "1440"); // 24h default

type AdminSession = { exp: number };
const adminSessions = new Map<string, AdminSession>();

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [t, s] of adminSessions.entries()) {
    if (s.exp <= now) adminSessions.delete(t);
  }
}
setInterval(cleanupAdminSessions, 60_000);

function makeToken() {
  const rand = crypto.randomBytes(32).toString("hex");
  if (!ADMIN_TOKEN_SECRET) return rand;

  return crypto
    .createHash("sha256")
    .update(rand + ADMIN_TOKEN_SECRET)
    .digest("hex");
}

function requireAdminToken(req: Request, res: Response, next: any) {
  cleanupAdminSessions();

  const auth = (req.header("authorization") ?? "").trim();
  const token = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  if (!token) return res.status(401).json({ error: "Missing token" });

  const session = adminSessions.get(token);
  if (!session) return res.status(401).json({ error: "Invalid token" });

  if (session.exp <= Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: "Token expired" });
  }

  next();
}

// 1) AUTH middleware (APP_KEY) per /api/*, ma non per /api/admin/*
app.use("/api", (req, res, next) => {
  // ✅ /api/admin usa token auth, non APP_KEY
  if (req.path.startsWith("/admin")) return next();

  if (!REQUIRE_KEY) return next();
  if (!APP_KEY) return next(); // se non configurata, non bloccare (evita downtime)

  const got = (
    req.header("x-ml-key") ??
    req.header("X-ML-KEY") ??
    (typeof req.query.key === "string" ? req.query.key : "") ??
    ""
  ).trim();

  if (got !== APP_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// 2) ENDPOINT HITS middleware (uso app) — contiamo anche /api/admin/*
app.use("/api", (req, res, next) => {
  markEndpointHit(req.method, req.path);
  next();
});

// ===============================
// Public health
// ===============================
app.get("/", (req: Request, res: Response) => {
  res.json({ message: "MatchLive Server attivo 🚀" });
});

// ===============================
// Admin endpoints
// ===============================
app.post("/api/admin/login", (req: Request, res: Response) => {
  if (!ADMIN_PIN) {
    return res.status(500).json({ error: "ADMIN_PIN not configured" });
  }

  const pin = String(req.body?.pin ?? "").trim();
  if (!pin) return res.status(400).json({ error: "Missing pin" });

  if (pin !== ADMIN_PIN) return res.status(401).json({ error: "Wrong pin" });

  const token = makeToken();
  const exp = Date.now() + ADMIN_TOKEN_TTL_MIN * 60_000;
  adminSessions.set(token, { exp });

  res.json({ token, expiresAt: new Date(exp).toISOString() });
});

app.get("/api/admin/stats", requireAdminToken, (req: Request, res: Response) => {
  res.json({
    ...getApiStats(),
    cacheSize: cacheSize(),
  });
});

// ===============================
// Live endpoints
// ===============================
app.get("/api/live", async (req: Request, res: Response) => {
  try {
    const data = await getLiveFixtures("live");
    res.json(data);
  } catch (e: any) {
    const status = e?.response?.status;
    const details = e?.response?.data ?? e?.message ?? e;
    console.error("LIVE ERROR:", status, details);

    res.status(500).json({
      error: "API-Football error",
      status,
      details,
    });
  }
});

app.get("/api/live/compact", async (req: Request, res: Response) => {
  try {
    const data = await getLiveFixtures("compact");
    res.json({
      updatedAt: new Date().toISOString(),
      results: data?.results ?? 0,
      fixtures: toLiveCompact(data),
    });
  } catch (e: any) {
    const status = e?.response?.status;
    const details = e?.response?.data ?? e?.message ?? e;
    console.error("LIVE COMPACT ERROR:", status, details);

    res.status(500).json({
      error: "API-Football error",
      status,
      details,
    });
  }
});

app.get("/api/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  const typesParam = (req.query.types as string | undefined) ?? "";
  const types = typesParam
    .split(",")
    .map((s) => s.trim())
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

// (optional) keep /api/stats for your own debugging (still requires x-ml-key)
app.get("/api/stats", (req: Request, res: Response) => {
  res.json({
    ...getApiStats(),
    cacheSize: cacheSize(),
  });
});

const PORT = Number(process.env.PORT) || 3000;

// parte il poller (si auto-rallenta se non ci sono client SSE)
if (process.env.ENABLE_POLLER !== "false") {
  startPoller();
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});