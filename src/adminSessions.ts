import crypto from "crypto";
import fs from "fs";
import path from "path";

type SessionRecord = { createdAt: string };

/** Sessioni amministratore revocabili e persistenti, senza salvare token in chiaro. */
export class AdminSessionStore {
  constructor(private readonly filePath: string) {}

  private digest(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private read(): Record<string, SessionRecord> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return parsed?.sessions ?? {};
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      return {};
    }
  }

  private write(sessions: Record<string, SessionRecord>) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  create(): string {
    const token = crypto.randomBytes(32).toString("hex");
    const sessions = this.read();
    sessions[this.digest(token)] = { createdAt: new Date().toISOString() };
    this.write(sessions);
    return token;
  }

  has(token: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    return Boolean(this.read()[this.digest(token)]);
  }

  revoke(token: string) {
    const sessions = this.read();
    delete sessions[this.digest(token)];
    this.write(sessions);
  }
}

export function configuredAdminSessionStore() {
  const volume = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
  return new AdminSessionStore(path.resolve(
    process.env.ADMIN_SESSIONS_FILE ||
      path.join(volume || "data", "admin-sessions.json"),
  ));
}
