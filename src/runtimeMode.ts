import fs from "node:fs";
import path from "node:path";

export type RuntimeMode = "eco" | "fast";

export class RuntimeModeStore {
  private mode: RuntimeMode;
  private listeners = new Set<(mode: RuntimeMode) => void>();
  constructor(private file: string, fallback: RuntimeMode) {
    this.mode = fallback;
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.mode === "eco" || saved.mode === "fast") this.mode = saved.mode;
    }
  }
  get(): RuntimeMode { return this.mode; }
  subscribe(listener: (mode: RuntimeMode) => void) { this.listeners.add(listener); }
  set(mode: RuntimeMode) {
    if (mode !== "eco" && mode !== "fast") throw new Error("Invalid mode");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ mode }), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    const changed = this.mode !== mode;
    this.mode = mode;
    if (changed) for (const listener of this.listeners) listener(mode);
  }
}

let store: RuntimeModeStore | undefined;
export function runtimeModeStore() {
  return store ??= new RuntimeModeStore(
    process.env.RUNTIME_MODE_FILE || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || "data", "runtime-mode.json"),
    process.env.API_ECO_MODE?.toLowerCase() === "true" ? "eco" : "fast",
  );
}
export function isApiEcoMode() { return runtimeModeStore().get() === "eco"; }
