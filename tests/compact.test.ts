import assert from "node:assert/strict";
import test from "node:test";
import { mergeLiveCompactFixtures } from "../src/compact";

test("la riconciliazione Live aggiunge una fixture appena iniziata senza duplicati", () => {
  const snapshot = [
    { fixtureId: 10, statusShort: "1H", elapsed: 3 },
  ];
  const current = [
    { fixtureId: 10, statusShort: "1H", elapsed: 4 },
    { fixtureId: 11, statusShort: "1H", elapsed: 1 },
  ];

  const merged = mergeLiveCompactFixtures(snapshot, current);
  assert.deepEqual(merged.map((row) => row.fixtureId).sort(), [10, 11]);
  assert.equal(merged.find((row) => row.fixtureId === 10)?.elapsed, 4);
  assert.equal(merged.filter((row) => row.fixtureId === 11).length, 1);
});
