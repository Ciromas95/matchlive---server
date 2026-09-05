import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeModeStore } from "../src/runtimeMode";

test("modalità server: il cambio si applica e sopravvive al riavvio senza toccare i consumi", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mode-"));
  try {
    const file = path.join(dir, "mode.json");
    const store = new RuntimeModeStore(file, "eco");
    const notifications: string[] = [];
    store.subscribe(mode => notifications.push(mode));
    store.set("fast");
    assert.equal(store.get(), "fast");
    assert.equal(new RuntimeModeStore(file, "eco").get(), "fast");
    store.set("eco");
    store.set("eco");
    assert.deepEqual(notifications, ["fast", "eco"]);
    assert.equal(new RuntimeModeStore(file, "fast").get(), "eco");
    assert.throws(() => store.set("invalid" as any));
    assert.equal(store.get(), "eco");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
