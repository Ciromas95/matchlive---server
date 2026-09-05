import express, { Request, Response } from "express";
import * as brainPrematchModule from "../brainPrematchV3";
import * as apiFootball from "../apiFootball";
import {
  getPrematchStats,
  reconcilePrematchPicks,
  registerPrematchPicks,
} from "../prematchTracker";

const brainPrematchRouter = express.Router();

const buildBrainPrematch =
  typeof (brainPrematchModule as any).default === "function"
    ? (brainPrematchModule as any).default
    : typeof (brainPrematchModule as any).buildBrainPrematch === "function"
      ? (brainPrematchModule as any).buildBrainPrematch
      : null;

brainPrematchRouter.get("/prematch", async (req: Request, res: Response) => {
  try {
    if (typeof buildBrainPrematch !== "function") {
      return res.status(500).json({
        error: "brainPrematch import failed",
        details: "buildBrainPrematch is not a function",
      });
    }

    const date = String(req.query.date ?? "").trim();
    const maxMatchesParam = Number(req.query.maxMatches ?? 48);
    const maxMatches = Math.max(1, Math.min(maxMatchesParam || 48, 48));

    if (!date) {
      return res.status(400).json({ error: "Missing date" });
    }

    const result = await buildBrainPrematch(date, maxMatches);
    await reconcilePrematchPicks(
      (pendingDate) => apiFootball.getFixturesByDate(pendingDate, "brainPrematch"),
      (fixtureId) => apiFootball.getFixtureStatisticsCached(fixtureId, "brainPrematch"),
    );
    await registerPrematchPicks(result.picks);
    const stats = await getPrematchStats();

    return res.json({
      updatedAt: new Date().toISOString(),
      date,
      results: result.picks.length,
      picks: result.picks,
      candidates: result.candidates,
      cacheState: result.cacheState ?? "fresh",
      stats,
    });

  } catch (e: any) {
    const status = e?.response?.status;
    const details = e?.response?.data ?? e?.message ?? e;

    console.error("BRAIN PREMATCH ERROR:", status, details);

    return res.status(500).json({
      error: "API-Football error",
      status,
      details,
    });
  }
});

export default brainPrematchRouter;
