import express, { Request, Response } from "express";
import buildBrainPrematch from "../brainPrematch";

const brainPrematchRouter = express.Router();

brainPrematchRouter.get("/prematch", async (req: Request, res: Response) => {
  try {
    const date = String(req.query.date ?? "").trim();
    const maxMatchesParam = Number(req.query.maxMatches ?? 5);
    const maxMatches = Math.max(1, Math.min(maxMatchesParam || 5, 10));

    if (!date) {
      return res.status(400).json({ error: "Missing date" });
    }

    const picks = await buildBrainPrematch(date, maxMatches);

    return res.json({
      updatedAt: new Date().toISOString(),
      date,
      results: picks.length,
      picks,
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