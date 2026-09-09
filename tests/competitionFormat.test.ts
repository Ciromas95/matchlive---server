import test from "node:test";
import assert from "node:assert/strict";
import { inferCompetitionFormat } from "../src/competitionFormat";

test("detects grouped competitions", () => {
  const standings = { response: [{ league: { standings: [
    [{ group: "Group A" }, { group: "Group A" }],
    [{ group: "Group B" }, { group: "Group B" }],
  ] } }] };
  assert.equal(inferCompetitionFormat(1, 2026, standings, { response: [] }).competitionFormat, "groups");
});

test("detects hybrid and current knockout view", () => {
  const standings = { response: [{ league: { standings: [[{ group: "League" }, { group: "League" }]] } }] };
  const fixtures = { response: [{ fixture: { date: new Date(Date.now() + 1000).toISOString(), status: { short: "NS" } }, league: { round: "Quarter-finals" } }] };
  const result = inferCompetitionFormat(2, 2026, standings, fixtures);
  assert.equal(result.competitionFormat, "hybrid");
  assert.equal(result.activeView, "knockout");
});
