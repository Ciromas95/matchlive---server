import express, { Request, Response } from "express";
import {
  buildBrainLive,
  getBrainLiveFromCache,
  getDefaultBrainLivePayload,
} from "../brainLive";

const brainLiveRouter = express.Router();

brainLiveRouter.get("/live", async (req: Request, res: Response) => {
  try {
    res.setHeader(
      "Cache-Control",
      "public, max-age=1, s-maxage=8, stale-while-revalidate=24"
    );

    const maxResultsParam = Number(req.query.maxResults ?? 8);
    const maxResults = Math.max(1, Math.min(maxResultsParam || 8, 12));

    const cached = getBrainLiveFromCache(maxResults);
    const onDemand = cached ? null : await buildBrainLive(maxResults);
    const fallback = getDefaultBrainLivePayload(maxResults);
    const rawResult: any = cached ?? onDemand?.result ?? fallback;

    const candidates = Array.isArray(rawResult?.candidates)
      ? rawResult.candidates
      : [];
    const hot = rawResult.hot ?? null;
    const others = Array.isArray(rawResult.others) ? rawResult.others : [];

    return res.json({
      updatedAt: new Date().toISOString(),
      cached: Boolean(cached),
      generatedNow: Boolean(!cached && onDemand),
      results: (hot == null ? 0 : 1) + others.length,

      candidates,
      hot,
      others,
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
