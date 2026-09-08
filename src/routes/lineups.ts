import express, { Request, Response } from "express";
import { getLineupAccuracySummary, getLineupForFixture } from "../lineupPrediction";
import { lineupCompleted, lineupFailed, lineupRequested } from "../engineTelemetry";
import { markHealthActivity } from "../health";

const router = express.Router();

router.get("/fixture/:fixtureId", async (req: Request, res: Response) => {
  const fixtureId = Number(req.params.fixtureId);
  if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
    return res.status(400).json({ error: "invalid_fixture_id" });
  }
  try {
    lineupRequested();
    const started = performance.now();
    const result = await getLineupForFixture(fixtureId);
    lineupCompleted(result.status, performance.now() - started);
    markHealthActivity("lineup");
    const seconds = result.status === "official" ? 10 : 30;
    res.setHeader("Cache-Control", `public, max-age=5, s-maxage=${seconds}, stale-while-revalidate=${seconds * 2}`);
    return res.json(result);
  } catch (error: any) {
    lineupFailed();
    const status = Number(error?.status ?? error?.response?.status ?? 502);
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: "lineup_unavailable",
      message: error?.message ?? "Formazioni temporaneamente non disponibili",
    });
  }
});

router.get("/accuracy", async (_req: Request, res: Response) => {
  return res.json(await getLineupAccuracySummary());
});

export default router;
