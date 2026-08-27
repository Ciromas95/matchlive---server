import { promises as fs } from "fs";
import path from "path";

type PickRecord = {
  fixtureId: number;
  date: string;
  bet: "GOAL" | "OVER 2.5";
  createdAt: string;
  result?: "won" | "lost";
  resolvedAt?: string;
};

type Store = { version: 1; picks: Record<string, PickRecord> };

const railwayVolumePath = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
const configuredStorePath = (process.env.PREMATCH_STATS_FILE ?? "").trim();
const storePath = path.resolve(
  configuredStorePath ||
    (railwayVolumePath
      ? path.join(railwayVolumePath, "prematch-stats.json")
      : "data/prematch-stats.json")
);

if (process.env.RAILWAY_ENVIRONMENT && !railwayVolumePath && !configuredStorePath) {
  console.warn(
    "[prematch-stats] Railway volume missing: counters may reset after deploy"
  );
}
let queue: Promise<unknown> = Promise.resolve();

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, picks: parsed?.picks ?? {} };
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error("[prematch-stats] read failed:", error?.message ?? error);
    }
    return { version: 1, picks: {} };
  }
}

async function writeStore(store: Store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(temporaryPath, storePath);
}

function runExclusive<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.then(action, action);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

export async function registerPrematchPicks(picks: any[]) {
  return runExclusive(async () => {
    const store = await readStore();
    let changed = false;
    for (const pick of picks) {
      const fixtureId = Number(pick?.fixtureId ?? 0);
      const bet = String(pick?.recommendedBet ?? "").toUpperCase();
      const date = String(pick?.date ?? "").slice(0, 10);
      if (!fixtureId || !date || (bet !== "GOAL" && bet !== "OVER 2.5")) {
        continue;
      }
      const key = String(fixtureId);
      if (store.picks[key]) continue;
      store.picks[key] = {
        fixtureId,
        date,
        bet,
        createdAt: new Date().toISOString(),
      };
      changed = true;
    }
    if (changed) await writeStore(store);
  });
}

export async function reconcilePrematchPicks(
  fetchFixturesByDate: (date: string) => Promise<any>
) {
  return runExclusive(async () => {
    const store = await readStore();
    const pending = Object.values(store.picks).filter((pick) => !pick.result);
    const dates = [...new Set(pending.map((pick) => pick.date))];
    let changed = false;

    for (const date of dates) {
      let payload: any;
      try {
        payload = await fetchFixturesByDate(date);
      } catch (error: any) {
        console.error("[prematch-stats] reconcile failed:", date, error?.message ?? error);
        continue;
      }
      const fixtures = Array.isArray(payload?.response) ? payload.response : [];
      const byId = new Map<number, any>(
        fixtures.map((fixture: any) => [Number(fixture?.fixture?.id ?? 0), fixture])
      );

      for (const pick of pending.filter((item) => item.date === date)) {
        const fixture = byId.get(pick.fixtureId);
        const status = String(fixture?.fixture?.status?.short ?? "").toUpperCase();
        if (!new Set(["FT", "AET", "PEN"]).has(status)) continue;
        const home = Number(fixture?.score?.fulltime?.home ?? fixture?.goals?.home);
        const away = Number(fixture?.score?.fulltime?.away ?? fixture?.goals?.away);
        if (!Number.isFinite(home) || !Number.isFinite(away)) continue;

        const won = pick.bet === "GOAL" ? home > 0 && away > 0 : home + away >= 3;
        pick.result = won ? "won" : "lost";
        pick.resolvedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await writeStore(store);
  });
}

export async function getPrematchStats() {
  await queue;
  const store = await readStore();
  const records = Object.values(store.picks);
  const won = records.filter((pick) => pick.result === "won").length;
  const lost = records.filter((pick) => pick.result === "lost").length;
  const pending = records.filter((pick) => !pick.result).length;
  const settled = won + lost;
  return {
    won,
    lost,
    pending,
    settled,
    accuracy: settled === 0 ? null : Math.round((won / settled) * 1000) / 10,
  };
}
