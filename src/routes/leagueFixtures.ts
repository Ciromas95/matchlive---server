import { Router, Request, Response } from "express";
import { getLeagueFixturesByDate } from "../apiFootball";
import { toLeagueFixturesCompact } from "../compact";

const router = Router();

router.get("/compact", async (req: Request, res: Response) => {
  try {
    const leagueId = Number(req.query.leagueId);
    const date = String(req.query.date ?? "").trim();
    const seasonParam = String(req.query.season ?? "").trim();
    const season = seasonParam ? Number(seasonParam) : undefined;

    if (!leagueId || !date) {
      return res.status(400).json({ error: "Missing leagueId or date" });
    }

    const data = await getLeagueFixturesByDate(leagueId, date, season, "compact");
    const fixtures = await toLeagueFixturesCompact(data);

    return res.json({
      updatedAt: new Date().toISOString(),
      leagueId,
      date,
      season: season ?? null,
      results: fixtures.length,
      fixtures,
    });
  } catch (e: any) {
    const status = e?.response?.status;
    const details = e?.response?.data ?? e?.message ?? e;
    console.error("LEAGUE FIXTURES COMPACT ERROR:", status, details);

    return res.status(500).json({
      error: "API-Football error",
      status,
      details,
    });
  }
});

export default router;