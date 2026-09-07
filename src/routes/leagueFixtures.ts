import { Router, Request, Response } from "express";
import { getFixtureEventsCached, getLeagueFixturesByDate } from "../apiFootball";
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
    const rawFixtures = Array.isArray(data?.response) ? data.response : [];

    // Il payload /fixtures non contiene il referto degli eventi. Per le gare
    // ormai concluse recuperiamo il referto ufficiale una sola volta e lo
    // conserviamo a lungo nella cache condivisa: così i rossi restano visibili
    // anche nei giorni successivi senza moltiplicare le chiamate per utente.
    const historicalStatuses = new Set(["FT", "AET", "PEN", "ABD", "SUSP"]);
    const enriched = [...rawFixtures];
    for (let start = 0; start < enriched.length; start += 5) {
      await Promise.all(enriched.slice(start, start + 5).map(async (fixture, offset) => {
        const status = String(fixture?.fixture?.status?.short ?? "").toUpperCase();
        const fixtureId = Number(fixture?.fixture?.id ?? 0);
        if (!historicalStatuses.has(status) || !fixtureId) return;
        try {
          const eventData = await getFixtureEventsCached(fixtureId, "events", 24 * 60 * 60);
          const events = Array.isArray(eventData?.response) ? eventData.response : [];
          enriched[start + offset] = { ...fixture, events };
        } catch {
          // Un singolo referto indisponibile non deve bloccare l'intera lista.
        }
      }));
    }

    const fixtures = await toLeagueFixturesCompact({ ...data, response: enriched });

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

    return res.status(status && status >= 400 ? status : 500).json({
      error: "API-Football error",
      status,
      details,
    });
  }
});

export default router;
