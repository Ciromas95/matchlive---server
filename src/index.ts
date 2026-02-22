import express, { Request, Response } from "express";
import dotenv from "dotenv";
import cors from "cors";
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

app.use("/api", (req, res, next) => {
  // se non hai configurato APP_KEY e REQUIRE_KEY=true, meglio non bloccare in dev
  if (!REQUIRE_KEY) return next();
  if (!APP_KEY) return next(); // fallback: non blocca se non configurato (evita downtime)

app.use("/api", (req, res, next) => {
  // Conta utilizzo dei tuoi endpoint (NON è costo provider)
  markEndpointHit(req.method, req.path);
  next();
});
  
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

app.get("/", (req: Request, res: Response) => {
  res.json({ message: "MatchLive Server attivo 🚀" });
});

app.get("/api/live", async (req: Request, res: Response) => {
  try {
    const data = await getLiveFixtures();
    res.json(data);
  } catch (e: any) {
    const status = e?.response?.status;
    const details = e?.response?.data ?? e?.message ?? e;
    console.error("LIVE ERROR:", status, details);

    res.status(500).json({
      error: "API-Football error",
      status,
      details
    });
  }
});

app.get("/api/live/compact", async (req: Request, res: Response) => {
  try {
    const data = await getLiveFixtures();
    res.json({
      updatedAt: new Date().toISOString(),
      results: data?.results ?? 0,
      fixtures: toLiveCompact(data)
    });
  } catch (e: any) {
    const status = e?.response?.status;
    const details = e?.response?.data ?? e?.message ?? e;
    console.error("LIVE COMPACT ERROR:", status, details);

    res.status(500).json({
      error: "API-Football error",
      status,
      details
    });
  }
});

app.get("/api/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // messaggio iniziale
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  const typesParam = (req.query.types as string | undefined) ?? "";
  const types = typesParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  addClient(res, types);

  // ✅ heartbeat (fondamentale su cloud/proxy)
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

app.get("/api/stats", (req: Request, res: Response) => {
  res.json({
    ...getApiStats(),
    cacheSize: cacheSize()
  });
});


const PORT = Number(process.env.PORT) || 3000;

// parte il poller (si auto-rallenta se non ci sono client SSE)
startPoller();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});