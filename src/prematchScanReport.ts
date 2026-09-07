import { promises as fs } from "fs";
import path from "path";

export type PrematchScanReport = {
  algorithmVersion: string;
  date: string;
  phase: "preparazione" | "pubblicato" | "errore";
  startedAt: string;
  completedAt: string | null;
  publishedAt: string | null;
  providerFixtures: number;
  supportedFixtures: number;
  upcomingFixtures: number;
  evaluatedFixtures: number;
  acceptedFixtures: number;
  excluded: Record<string, number>;
  failures: string[];
  decisions: Array<{
    fixtureId: number;
    kickoff: string | null;
    league: string;
    country: string;
    home: string;
    away: string;
    status: "scelta" | "esclusa" | "fornitore";
    reason: string;
    market?: string | null;
    referenceOdd?: number | null;
    probability?: number | null;
    dataQuality?: number | null;
  }>;
};

const volume = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
const file = path.resolve(volume ? path.join(volume, "prematch-scan-report.json") : "data/prematch-scan-report.json");
let latest: PrematchScanReport | null = null;

export async function savePrematchScanReport(report: PrematchScanReport) {
  latest = report;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(report), "utf8");
    await fs.rename(temporary, file);
  } catch (error: any) {
    console.error("[prematch-report] write failed:", error?.message ?? error);
  }
}

export async function getLatestPrematchScanReport(): Promise<PrematchScanReport | null> {
  if (latest) return latest;
  try {
    latest = JSON.parse(await fs.readFile(file, "utf8")) as PrematchScanReport;
  } catch {}
  return latest;
}
