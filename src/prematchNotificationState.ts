import { promises as fs } from "fs";
import path from "path";

const railwayVolumePath = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
const configuredPath = (process.env.PREMATCH_NOTIFICATION_FILE ?? "").trim();
const filePath = path.resolve(
  configuredPath || (railwayVolumePath
    ? path.join(railwayVolumePath, "prematch-notifications.json")
    : "data/prematch-notifications.json"),
);

export async function claimPrematchNotification(date: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed?.date === date) return false;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error("[prematch-notification] read failed:", error?.message ?? error);
    }
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ date, claimedAt: new Date().toISOString() }), "utf8");
    await fs.rename(temporary, filePath);
    return true;
  } catch (error: any) {
    console.error("[prematch-notification] write failed:", error?.message ?? error);
    return false;
  }
}

