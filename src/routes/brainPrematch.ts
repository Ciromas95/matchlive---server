import express, { Request, Response } from "express";
import * as brainPrematchModule from "../brainPrematch";

const brainPrematchRouter = express.Router();

const buildBrainPrematch =
  typeof (brainPrematchModule as any).default === "function"
    ? (brainPrematchModule as any).default
    : typeof (brainPrematchModule as any).buildBrainPrematch === "function"
    ? (brainPrematchModule as any).buildBrainPrematch
    : null;

console.log("brainPrematchModule =", brainPrematchModule);
console.log("typeof resolved buildBrainPrematch =", typeof buildBrainPrematch);

brainPrematchRouter.get("/prematch", async (req: Request, res: Response) => {
  try {
    if (typeof buildBrainPrematch !== "function") {
      return res.status(500).json({
        error: "brainPrematch import failed",
        details: "buildBrainPrematch is not a function",
      });
    }

    const date = String(req.query.date ?? "").trim();
    const maxMatchesParam = Number(req.query.maxMatches ?? 5);
    const maxMatches = Math.max(1, Math.min(maxMatchesParam || 5, 10));

    if (!date) {
      return res.status(400).json({ error: "Missing date" });
    }

const result = await buildBrainPrematch(date, maxMatches);

return res.json({
  updatedAt: new Date().toISOString(),
  date,
  results: result.picks.length,
  picks: result.picks,
  candidates: result.candidates,
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