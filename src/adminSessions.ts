import crypto from "crypto";
import fs from "fs";
import path from "path";

type SessionRecord = { createdAt: string; expiresAt?: string };

/** Sessioni amministratore revocabili e persistenti, senza salvare token in chiaro. */
export class AdminSessionStore {
  constructor(private readonly filePath: string, private readonly ttlMs = 12 * 60 * 60 * 1000) {}

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
    sessions[this.digest(token)] = {
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
    this.write(sessions);
    return token;
  }

  has(token: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const sessions = this.read();
    const digest = this.digest(token);
    const record = sessions[digest];
    if (!record) return false;
    const expiresAt = record.expiresAt
      ? Date.parse(record.expiresAt)
      : Date.parse(record.createdAt) + this.ttlMs;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      delete sessions[digest];
      this.write(sessions);
      return false;
    }
    return true;
  }

  revoke(token: string) {
    const sessions = this.read();
    delete sessions[this.digest(token)];
    this.write(sessions);
  }

  expiresAt(token: string): string | null {
    const record = this.read()[this.digest(token)];
    if (!record) return null;
    return record.expiresAt ?? new Date(Date.parse(record.createdAt) + this.ttlMs).toISOString();
  }
}

export function configuredAdminSessionStore() {
  const volume = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
  return new AdminSessionStore(path.resolve(
    process.env.ADMIN_SESSIONS_FILE ||
      path.join(volume || "data", "admin-sessions.json"),
  ), Number(process.env.ADMIN_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000));
}
