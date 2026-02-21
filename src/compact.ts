function mapEventsLite(events: any[]) {
  return events.map((ev: any) => ({
    type: ev?.type,
    detail: ev?.detail,
    elapsed: ev?.time?.elapsed,
    teamId: ev?.team?.id,
    player: ev?.player?.name
  }));
}

export function toLiveCompact(apiData: any) {
  const list = Array.isArray(apiData?.response) ? apiData.response : [];

  return list.map((f: any) => {
    const events = Array.isArray(f?.events) ? f.events : [];

    return {
      fixtureId: f?.fixture?.id,
      date: f?.fixture?.date,
      statusShort: f?.fixture?.status?.short,
      elapsed: f?.fixture?.status?.elapsed,
      league: {
        id: f?.league?.id,
        name: f?.league?.name,
        country: f?.league?.country,
        flag: f?.league?.flag,
        logo: f?.league?.logo
      },
      home: {
        id: f?.teams?.home?.id,
        name: f?.teams?.home?.name,
        logo: f?.teams?.home?.logo
      },
      away: {
        id: f?.teams?.away?.id,
        name: f?.teams?.away?.name,
        logo: f?.teams?.away?.logo
      },
      goals: {
        home: f?.goals?.home ?? 0,
        away: f?.goals?.away ?? 0
      },
      // ✅ qui escono Card/Subst ecc (se presenti nella response live)
      events: mapEventsLite(events)
    };
  });
}