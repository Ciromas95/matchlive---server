import { promises as fs } from "fs";
import path from "path";

type PickRecord = {
  fixtureId: number;
  date: string;
  bet:
    | "GOAL"
    | "OVER 2.5"
    | "CASA OVER 1.5"
    | "OSPITE OVER 1.5"
    | "1X"
    | "X2"
    | "CORNER CASA"
    | "CORNER OSPITE"
    | "CORNER TOTALI";
  line?: number;
  createdAt: string;
  algorithmVersion?: string;
  probability?: number;
  modelProbability?: number;
  marketProbability?: number;
  dataQuality?: number;
  quote?: number;
  expectedGoals?: number;
  result?: "won" | "lost";
  homeGoals?: number;
  awayGoals?: number;
  resolvedAt?: string;
};

type Store = { version: 3; picks: Record<string, PickRecord> };

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
    // v3 avvia il nuovo storico richiesto per il Cervello. La migrazione
    // azzera una sola volta i contatori precedenti; i dati v3 persistono poi
    // normalmente sul volume Railway anche dopo restart e deploy.
    if (parsed?.version !== 3) return { version: 3, picks: {} };
    return { version: 3, picks: parsed?.picks ?? {} };
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error("[prematch-stats] read failed:", error?.message ?? error);
    }
    return { version: 3, picks: {} };
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
      const selected = pick?.analysis?.selected ?? {};
      const bet = String(selected?.market ?? pick?.recommendedBet ?? "").toUpperCase();
      const line = Number(selected?.line);
      const date = String(pick?.date ?? "").slice(0, 10);
      if (
        !fixtureId ||
        !date ||
        ![
          "GOAL", "OVER 2.5", "CASA OVER 1.5", "OSPITE OVER 1.5",
          "1X", "X2", "CORNER CASA", "CORNER OSPITE", "CORNER TOTALI",
        ].includes(bet)
      ) {
        continue;
      }
      if (bet.startsWith("CORNER") && !Number.isFinite(line)) continue;
      const algorithmVersion = String(pick?.algorithmVersion ?? "legacy");
      const key = `${fixtureId}:${bet}:${Number.isFinite(line) ? line : ""}:${algorithmVersion}`;
      if (store.picks[key]) continue;
      store.picks[key] = {
        fixtureId,
        date,
        bet: bet as PickRecord["bet"],
        line: Number.isFinite(line) ? line : undefined,
        createdAt: new Date().toISOString(),
        algorithmVersion,
        probability: Number(selected?.finalProbability ?? pick?.confidence) || undefined,
        modelProbability: Number(selected?.modelProbability) || undefined,
        marketProbability: Number(selected?.marketProbability) || undefined,
        dataQuality: Number(pick?.analysis?.dataQuality) || undefined,
        quote: Number(selected?.bestOdd) || undefined,
        expectedGoals: Number(pick?.analysis?.projection?.totalGoals) || undefined,
      };
      changed = true;
    }
    if (changed) await writeStore(store);
  });
}

export async function reconcilePrematchPicks(
  fetchFixturesByDate: (date: string) => Promise<any>,
  fetchFixtureStatistics?: (fixtureId: number) => Promise<any>,
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

        let won: boolean;
        if (pick.bet.startsWith("CORNER")) {
          if (!fetchFixtureStatistics || pick.line == null) continue;
          let statisticsPayload: any;
          try {
            statisticsPayload = await fetchFixtureStatistics(pick.fixtureId);
          } catch (error: any) {
            console.error("[prematch-stats] corner reconcile failed:", pick.fixtureId, error?.message ?? error);
            continue;
          }
          const entries = Array.isArray(statisticsPayload?.response)
            ? statisticsPayload.response
            : [];
          const cornerCount = (entry: any) => {
            const statistic = (Array.isArray(entry?.statistics) ? entry.statistics : [])
              .find((item: any) => /corner/i.test(String(item?.type ?? "")));
            if (statistic?.value == null || statistic.value === "") return null;
            const value = Number(statistic?.value);
            return Number.isFinite(value) ? value : null;
          };
          const homeTeamId = Number(fixture?.teams?.home?.id ?? 0);
          const awayTeamId = Number(fixture?.teams?.away?.id ?? 0);
          const homeCorners = cornerCount(entries.find((entry: any) => Number(entry?.team?.id) === homeTeamId));
          const awayCorners = cornerCount(entries.find((entry: any) => Number(entry?.team?.id) === awayTeamId));
          if (homeCorners == null || awayCorners == null) continue;
          const actual = pick.bet === "CORNER CASA"
            ? homeCorners
            : pick.bet === "CORNER OSPITE"
              ? awayCorners
              : homeCorners + awayCorners;
          won = actual > pick.line;
        } else {
          won =
          pick.bet === "GOAL"
            ? home > 0 && away > 0
            : pick.bet === "OVER 2.5"
              ? home + away >= 3
              : pick.bet === "CASA OVER 1.5"
                ? home >= 2
                : pick.bet === "OSPITE OVER 1.5"
                  ? away >= 2
                  : pick.bet === "1X"
                    ? home >= away
                    : away >= home;
        }
        pick.result = won ? "won" : "lost";
        pick.homeGoals = home;
        pick.awayGoals = away;
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
  const byMarket = Object.fromEntries(
    [
      "GOAL", "OVER 2.5", "CASA OVER 1.5", "OSPITE OVER 1.5",
      "1X", "X2", "CORNER CASA", "CORNER OSPITE", "CORNER TOTALI",
    ].map((market) => {
      const marketRecords = records.filter((pick) => pick.bet === market);
      const marketWon = marketRecords.filter((pick) => pick.result === "won").length;
      const marketLost = marketRecords.filter((pick) => pick.result === "lost").length;
      const marketSettled = marketWon + marketLost;
      return [market, {
        won: marketWon,
        lost: marketLost,
        pending: marketRecords.filter((pick) => !pick.result).length,
        accuracy: marketSettled ? Math.round((marketWon / marketSettled) * 1000) / 10 : null,
      }];
    }),
  );
  const pricedSettled = records.filter(
    (pick) => pick.result && pick.quote != null && pick.quote > 1,
  );
  const profit = pricedSettled.reduce(
    (sum, pick) => sum + (pick.result === "won" ? (pick.quote ?? 1) - 1 : -1),
    0,
  );
  const calibration = [
    { min: 0.5, max: 0.6 },
    { min: 0.6, max: 0.7 },
    { min: 0.7, max: 0.8 },
    { min: 0.8, max: 1.01 },
  ].map((bucket) => {
    const items = records.filter(
      (pick) =>
        pick.result &&
        pick.probability != null &&
        pick.probability >= bucket.min &&
        pick.probability < bucket.max,
    );
    return {
      range: `${Math.round(bucket.min * 100)}-${Math.round(Math.min(1, bucket.max) * 100)}%`,
      picks: items.length,
      predicted: items.length
        ? Math.round((items.reduce((sum, pick) => sum + (pick.probability ?? 0), 0) / items.length) * 1000) / 10
        : null,
      actual: items.length
        ? Math.round((items.filter((pick) => pick.result === "won").length / items.length) * 1000) / 10
        : null,
    };
  });
  return {
    won,
    lost,
    pending,
    settled,
    accuracy: settled === 0 ? null : Math.round((won / settled) * 1000) / 10,
    byMarket,
    pricedSettled: pricedSettled.length,
    theoreticalProfit: Math.round(profit * 100) / 100,
    theoreticalRoi: pricedSettled.length
      ? Math.round((profit / pricedSettled.length) * 10_000) / 100
      : null,
    calibration,
  };
}
