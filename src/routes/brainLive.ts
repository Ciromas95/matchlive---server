import express, { Request, Response } from "express";
import {
  buildBrainLive,
  getBrainLiveFromCache,
  getDefaultBrainLivePayload,
} from "../brainLive";

const brainLiveRouter = express.Router();

function toSharedPick(candidate: any, index: number) {
  const lightScore = Number(candidate?.lightScore ?? 0);
  const isHot = index === 0 && lightScore >= 55;
  return {
    ...candidate,
    tagType: isHot ? "hot" : "interesting",
    badgeText: isHot ? "HOT MATCH" : "MATCH INTERESSANTE",
    finalScore: Math.round(lightScore),
    phase: candidate?.statusShort ?? null,
    phaseElapsed: candidate?.elapsed ?? null,
    interestingMicroInsight: candidate?.scoreHint ?? "Match vivo e aperto",
  };
}

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
    const picks = candidates.map(toSharedPick);
    const hot = picks.length > 0 ? picks[0] : null;
    const others = picks.slice(1);

    return res.json({
      updatedAt: new Date().toISOString(),
      cached: Boolean(cached),
      generatedNow: Boolean(!cached && onDemand),
      results: picks.length,

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
