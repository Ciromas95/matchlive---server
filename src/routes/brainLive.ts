import express, { Request, Response } from "express";
import { buildBrainLive } from "../brainLive";

const brainLiveRouter = express.Router();

console.log("brainLiveRouter file loaded");

brainLiveRouter.get("/live", async (req: Request, res: Response) => {
  try {
    const maxResultsParam = Number(req.query.maxResults ?? 8);
    const maxResults = Math.max(1, Math.min(maxResultsParam || 8, 12));

    const result = await buildBrainLive(maxResults);

    return res.json({
      updatedAt: new Date().toISOString(),
      results: (result.hot ? 1 : 0) + result.others.length,
      hot: result.hot,
      others: result.others,
    });
  } catch (e: any) {
    const status = e?.response?.status;
    const details = e?.response?.data ?? e?.message ?? e;

    console.error("BRAIN LIVE ERROR:", status, details);

    return res.status(500).json({
      error: "brain live error",
      status,
      details,
    });
  }
});

brainLiveRouter.get("/live-test", (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    route: "/api/brain/live-test",
  });
});

export default brainLiveRouter;