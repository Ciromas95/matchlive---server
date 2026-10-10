function text(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventText(event: any): string {
  return `${text(event?.type)} ${text(event?.detail)} ${text(event?.comments)}`;
}

export function isConfirmedScoringGoalEvent(event: any): boolean {
  const type = text(event?.type);
  const detail = eventText(event);
  if (type !== "goal" && !type.includes("goal")) return false;
  if (
    detail.includes("cancel") ||
    detail.includes("disallow") ||
    detail.includes("annull") ||
    detail.includes("no goal") ||
    detail.includes("missed") ||
    detail.includes("sbagli") ||
    detail.includes("saved") ||
    detail.includes("shootout")
  ) return false;
  const elapsed = numberOrNull(event?.time?.elapsed);
  // Gli eventi della serie di rigori non fanno parte del punteggio ufficiale
  // `goals` e non devono essere validati contro di esso.
  if (elapsed != null && elapsed > 120) return false;
  return true;
}

function playerIsKnown(event: any): boolean {
  return text(event?.player?.name).length > 0 || event?.player?.id != null;
}

/**
 * Riconcilia gli eventi rete con il punteggio ufficiale della fixture.
 *
 * API-Football puo pubblicare per pochi secondi un record Goal provvisorio e
 * poi lasciare la fixture a 0-0. BrainLive non mostra e non notifica reti in
 * eccedenza rispetto a `goals`; se il punteggio si aggiorna al polling
 * successivo, lo stesso evento diventa automaticamente confermato.
 */
export function reconcileFixtureEvents(fixture: any): any[] {
  const events = Array.isArray(fixture?.events) ? fixture.events : [];
  const homeGoals = numberOrNull(fixture?.goals?.home);
  const awayGoals = numberOrNull(fixture?.goals?.away);
  const homeId = numberOrNull(fixture?.teams?.home?.id);
  const awayId = numberOrNull(fixture?.teams?.away?.id);
  if (homeGoals == null || awayGoals == null) return events;

  const scoring: Array<{ event: any; index: number }> = events
    .map((event: any, index: number) => ({ event, index }))
    .filter((row: { event: any; index: number }) =>
      isConfirmedScoringGoalEvent(row.event)
    );
  const accepted = new Set<number>();

  const acceptForTeam = (teamId: number | null, limit: number) => {
    if (limit <= 0) return;
    const candidates = scoring
      .filter((row) => numberOrNull(row.event?.team?.id) === teamId)
      .sort((a: { event: any; index: number }, b: { event: any; index: number }) => {
        const known = Number(playerIsKnown(b.event)) - Number(playerIsKnown(a.event));
        if (known != 0) return known;
        return a.index - b.index;
      });
    for (const row of candidates.slice(0, limit)) accepted.add(row.index);
  };

  acceptForTeam(homeId, Math.max(0, homeGoals));
  acceptForTeam(awayId, Math.max(0, awayGoals));

  // Se manca il team sull'evento, usiamo soltanto l'eventuale capacita
  // residua complessiva. A 0-0 anche questi Goal anonimi vengono scartati.
  const acceptedHome = [...accepted].filter((index) =>
    numberOrNull(events[index]?.team?.id) === homeId
  ).length;
  const acceptedAway = [...accepted].filter((index) =>
    numberOrNull(events[index]?.team?.id) === awayId
  ).length;
  let unknownCapacity = Math.max(
    0,
    homeGoals + awayGoals - acceptedHome - acceptedAway,
  );
  for (const row of scoring) {
    const teamId = numberOrNull(row.event?.team?.id);
    if (teamId === homeId || teamId === awayId || unknownCapacity <= 0) continue;
    accepted.add(row.index);
    unknownCapacity -= 1;
  }

  return events.filter((event: any, index: number) =>
    !isConfirmedScoringGoalEvent(event) || accepted.has(index)
  );
}
