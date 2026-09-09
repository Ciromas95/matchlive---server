import assert from "node:assert/strict";
import test from "node:test";
import { detectScoreCorrection } from "../src/scoreCorrection";

test("rileva la squadra il cui punteggio è stato corretto", () => {
  assert.deepEqual(detectScoreCorrection("3-0", 2, 0), {
    home: true,
    away: false,
  });
  assert.deepEqual(detectScoreCorrection("1-2", 1, 1), {
    home: false,
    away: true,
  });
});

test("non inventa una correzione al primo snapshot o su un aumento", () => {
  assert.deepEqual(detectScoreCorrection(undefined, 1, 0), {
    home: false,
    away: false,
  });
  assert.deepEqual(detectScoreCorrection("0-0", 1, 0), {
    home: false,
    away: false,
  });
});
