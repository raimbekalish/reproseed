import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertBudget, replayBlockReason } from "../src/core/budget.ts";
import { ScenarioError } from "../src/core/types.ts";
import { duplicateSubmitScenario } from "./fixture.ts";

describe("budget", () => {
  it("accepts the phase-0 limits and rejects weaker confirmation settings", () => {
    assert.doesNotThrow(() => assertBudget(duplicateSubmitScenario().budget));
    assert.throws(() => assertBudget(duplicateSubmitScenario({ verifyRuns: 4 }).budget), /verifyRuns must be 5/);
    assert.throws(() => assertBudget(duplicateSubmitScenario({ baselineRuns: 1 }).budget), ScenarioError);
    assert.throws(() => assertBudget(duplicateSubmitScenario({ reductionConfirmRuns: 1 }).budget), ScenarioError);
    assert.throws(() => assertBudget(duplicateSubmitScenario({ maxReplayExecutions: -1 }).budget), ScenarioError);
    assert.throws(() => assertBudget(duplicateSubmitScenario({ attemptTimeoutMs: 0 }).budget), ScenarioError);
  });

  it("blocks on execution count before wall-clock time", () => {
    const budget = duplicateSubmitScenario({ maxReplayExecutions: 2, maxWallClockMs: 1_000 }).budget;
    assert.equal(
      replayBlockReason(budget, { startedAtMs: 0, replayExecutions: 2 }, 10),
      "replay-executions",
    );
    assert.equal(
      replayBlockReason(budget, { startedAtMs: 0, replayExecutions: 1 }, 1_000),
      "wall-clock",
    );
    assert.equal(replayBlockReason(budget, { startedAtMs: 0, replayExecutions: 1 }, 999), undefined);
  });
});
