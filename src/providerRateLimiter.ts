/**
 * Coda unica per tutte le chiamate API-Football del processo.
 * Il piano consente 450 richieste/minuto: 180 ms tra due partenze mantiene
 * margine per /status e per eventuali retry senza creare raffiche 429.
 */
const MIN_START_GAP_MS = Number(process.env.API_MIN_REQUEST_GAP_MS ?? "180");

let tail: Promise<void> = Promise.resolve();
let lastStartedAt = 0;

export function waitForProviderSlot(): Promise<void> {
  const turn = tail.then(async () => {
    const waitMs = Math.max(0, lastStartedAt + MIN_START_GAP_MS - Date.now());
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    lastStartedAt = Date.now();
  });
  // Un errore in un chiamante non deve bloccare la coda dei successivi.
  tail = turn.catch(() => undefined);
  return turn;
}
