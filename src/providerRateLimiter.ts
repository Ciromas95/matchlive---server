/**
 * Coda unica e prioritaria per API-Football. Le letture live passano davanti
 * ai caricamenti non urgenti senza superare il limite al minuto.
 */
const MIN_START_GAP_MS = Number(process.env.API_MIN_REQUEST_GAP_MS ?? "180");

export type ProviderPriority = "critical" | "normal";
type Waiting = { enqueuedAt: number; resolve: () => void };

const critical: Waiting[] = [];
const normal: Waiting[] = [];
let processing = false;
let lastStartedAt = 0;
let totalReleased = 0;
let totalWaitMs = 0;
let maxWaitMs = 0;

function takeNext(): Waiting | undefined {
  return critical.shift() ?? normal.shift();
}

async function drain() {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      if (critical.length === 0 && normal.length === 0) return;
      const gap = Math.max(0, lastStartedAt + MIN_START_GAP_MS - Date.now());
      if (gap > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, gap));
      }
      // Scegli dopo l'attesa: un evento live arrivato nel frattempo può così
      // superare davvero le richieste normali già accodate.
      const next = takeNext();
      if (!next) continue;
      lastStartedAt = Date.now();
      const waited = Math.max(0, lastStartedAt - next.enqueuedAt);
      totalReleased += 1;
      totalWaitMs += waited;
      maxWaitMs = Math.max(maxWaitMs, waited);
      next.resolve();
    }
  } finally {
    processing = false;
    if (critical.length > 0 || normal.length > 0) void drain();
  }
}

export function waitForProviderSlot(
  priority: ProviderPriority = "normal",
): Promise<void> {
  return new Promise<void>((resolve) => {
    const waiting = { enqueuedAt: Date.now(), resolve };
    (priority === "critical" ? critical : normal).push(waiting);
    void drain();
  });
}

export function providerQueueSnapshot() {
  return {
    pendingCritical: critical.length,
    pendingNormal: normal.length,
    averageWaitMs: totalReleased > 0 ? Math.round(totalWaitMs / totalReleased) : 0,
    maxWaitMs,
    minimumStartGapMs: MIN_START_GAP_MS,
  };
}
