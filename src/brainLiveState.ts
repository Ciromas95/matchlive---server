import { promises as fs } from "fs";
import path from "path";
import { LiveObservationV4 } from "./liveStrategyV4";

export type PersistedBrainLiveState = {
  version: 1;
  savedAt: string;
  halftimeBaselines: Record<string, LiveObservationV4>;
  activeSignalScore: Record<string, { home: number; away: number }>;
  activeSignals?: Record<string, any>;
  cooldownUntilMinute: Record<string, number>;
  previousCandidateIds: number[];
};

const railwayVolumePath = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
const configuredPath = (process.env.BRAIN_LIVE_STATE_FILE ?? "").trim();
const statePath = path.resolve(
  configuredPath || (railwayVolumePath
    ? path.join(railwayVolumePath, "brain-live-state.json")
    : "data/brain-live-state.json"),
);

export async function loadBrainLiveState(): Promise<PersistedBrainLiveState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (parsed?.version !== 1) return null;
    // Una vecchia giornata non deve contaminare i live correnti.
    const age = Date.now() - new Date(parsed.savedAt ?? 0).getTime();
    if (!Number.isFinite(age) || age > 18 * 60 * 60 * 1000) return null;
    return parsed as PersistedBrainLiveState;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error("[brain-live-state] read failed:", error?.message ?? error);
    }
    return null;
  }
}

export async function saveBrainLiveState(state: Omit<PersistedBrainLiveState, "version" | "savedAt">) {
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      ...state,
    }), "utf8");
    await fs.rename(temporary, statePath);
  } catch (error: any) {
    console.error("[brain-live-state] write failed:", error?.message ?? error);
  }
}
