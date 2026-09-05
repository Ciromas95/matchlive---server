import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminSessionStore } from "../src/adminSessions";

test("la sessione admin sopravvive al riavvio ed è revocata dal logout", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "brainlive-admin-test-"));
  const file = path.join(folder, "sessions.json");
  try {
    const first = new AdminSessionStore(file);
    const token = first.create();
    assert.equal(first.has(token), true);
    assert.equal(fs.readFileSync(file, "utf8").includes(token), false);
    const restarted = new AdminSessionStore(file);
    assert.equal(restarted.has(token), true);
    restarted.revoke(token);
    assert.equal(first.has(token), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
