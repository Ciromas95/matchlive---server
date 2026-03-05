import { getFixtureEventsCached } from "./apiFootball";

function mapEventsLite(events: any[]) {
  return events.map((ev: any) => ({
    type: ev?.type,
    detail: ev?.detail,
    elapsed: ev?.time?.elapsed,
    teamId: ev?.team?.id,
    player: ev?.player?.name,
  }));
}

function hasAnyCard(events: any[]) {
  return events.some((ev: any) => String(ev?.type ?? "").toLowerCase() === "card");
}

function countRedCards(events: any[], homeTeamId: number, awayTeamId: number) {
  let home = 0;
  let away = 0;

  for (const ev of events) {
    const type = String(ev?.type ?? "").toLowerCase();
    if (type !== "card") continue;

    const detail = String(ev?.detail ?? "").toLowerCase();
    const isRed = detail.includes("red card") || detail.includes("second yellow");
    if (!isRed) continue;

    const teamId = ev?.team?.id;
    if (teamId === homeTeamId) home++;
    else if (teamId === awayTeamId) away++;
  }

  return { home, away };
}

// ✅ ORA È ASYNC (perché può fare fetch eventi)
export async function toLiveCompact(apiData: any) {
  const list = Array.isArray(apiData?.response) ? apiData.response : [];

  const out: any[] = [];

  for (const f of list) {
    const fixtureId = f?.fixture?.id;

    const homeId = f?.teams?.home?.id;
    const awayId = f?.teams?.away?.id;

    // eventi inline (spesso solo Goal)
    let events = Array.isArray(f?.events) ? f.events : [];

    // fallback: se non ci sono Card negli eventi inline -> fetch eventi completi (cache 60s)
    if (fixtureId && (!events.length || !hasAnyCard(events))) {
      try {
        const evData = await getFixtureEventsCached(fixtureId, "other");
        const full = Array.isArray(evData?.response) ? evData.response : [];
        if (full.length) events = full;
      } catch (e) {
        // non blocchiamo compact se events fallisce
      }
    }

    const reds =
      homeId && awayId ? countRedCards(events, homeId, awayId) : { home: 0, away: 0 };

    out.push({
      fixtureId,
      date: f?.fixture?.date,
      statusShort: f?.fixture?.status?.short,
      elapsed: f?.fixture?.status?.elapsed,
      league: {
        id: f?.league?.id,
        name: f?.league?.name,
        country: f?.league?.country,
        flag: f?.league?.flag,
        logo: f?.league?.logo,
      },
      home: {
        id: homeId,
        name: f?.teams?.home?.name,
        logo: f?.teams?.home?.logo,
        redCards: reds.home,
      },
      away: {
        id: awayId,
        name: f?.teams?.away?.name,
        logo: f?.teams?.away?.logo,
        redCards: reds.away,
      },
      goals: {
        home: f?.goals?.home ?? 0,
        away: f?.goals?.away ?? 0,
      },
      // eventi lite per UI
      events: mapEventsLite(events),
    });
  }

  return out;
}