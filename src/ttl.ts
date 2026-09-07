export function liveTtlMs(liveCount: number) {
  // Una sola chiamata aggiorna tutti gli utenti. Con il piano da 75k possiamo
  // tenere punteggi ed eventi in corsia rapida senza moltiplicare le richieste
  // per ogni dispositivo collegato.
  if (liveCount <= 0) return 20_000;
  if (liveCount <= 8) return 4_000;
  if (liveCount <= 30) return 5_000;
  return 6_000;
}
