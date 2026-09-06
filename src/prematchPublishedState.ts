import { promises as fs } from "fs";
import path from "path";

type PublishedPrematchState = {
  version: 1;
  days: Record<string, { picks: any[]; candidates: never[] }>;
};

const volumePath = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
const configuredPath = (process.env.BRAIN_PREMATCH_STATE_FILE ?? "").trim();
const statePath = path.resolve(
  configuredPath || (volumePath
    ? path.join(volumePath, "brain-prematch-published.json")
    : "data/brain-prematch-published.json"),
);

export async function loadPublishedPrematchDay(date: string) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as PublishedPrematchState;
    if (parsed?.version !== 1) return null;
    const day = parsed.days?.[date];
    return day && Array.isArray(day.picks) ? day : null;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error("[prematch-state] read failed:", error?.message ?? error);
    }
    return null;
  }
}

export async function savePublishedPrematchDay(
  date: string,
  value: { picks: any[]; candidates: never[] },
) {
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    let days: PublishedPrematchState["days"] = {};
    try {
      const current = JSON.parse(await fs.readFile(statePath, "utf8")) as PublishedPrematchState;
      if (current?.version === 1 && current.days) days = current.days;
    } catch {}
    days[date] = value;
    for (const key of Object.keys(days)) if (key < date) delete days[key];
    const temporary = `${statePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, days }), "utf8");
    await fs.rename(temporary, statePath);
  } catch (error: any) {
    console.error("[prematch-state] write failed:", error?.message ?? error);
  }
}
