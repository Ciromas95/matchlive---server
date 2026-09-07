export function liveTtlMs(liveCount: number) {
  // Un solo profilo rapido, condiviso da tutti gli utenti. Quando non ci sono
  // gare live evitiamo richieste inutili; durante il gioco aggiorniamo ogni
  // 8-12 secondi in base al carico corrente.
  if (liveCount <= 0) return 30_000;
  if (liveCount <= 5) return 8_000;
  if (liveCount <= 20) return 10_000;
  return 12_000;
}
