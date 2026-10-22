import { ScenarioError, type Budget, type BudgetExhaustedReason } from "./types.ts";

/**
 * Per-attempt timeout is stored for the runner, which must abort a replay and
 * return a timeout outcome. This module enforces execution count and wall clock.
 */
export function assertBudget(budget: Budget): void {
  assertSafeNonNegative("maxReplayExecutions", budget.maxReplayExecutions);
  assertSafeNonNegative("maxWallClockMs", budget.maxWallClockMs);
  if (!Number.isSafeInteger(budget.attemptTimeoutMs) || budget.attemptTimeoutMs < 1) {
    throw new ScenarioError("attemptTimeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(budget.baselineRuns) || budget.baselineRuns < 2) {
    throw new ScenarioError("baselineRuns must be an integer greater than or equal to 2");
  }
  if (!Number.isSafeInteger(budget.reductionConfirmRuns) || budget.reductionConfirmRuns < 2) {
    throw new ScenarioError("reductionConfirmRuns must be an integer greater than or equal to 2");
  }
  if (budget.verifyRuns !== 5) {
    throw new ScenarioError("verifyRuns must be 5");
  }
}

export type ReplayBudgetState = {
  startedAtMs: number;
  replayExecutions: number;
};

export function replayBlockReason(
  budget: Budget,
  state: ReplayBudgetState,
  nowMs: number,
): BudgetExhaustedReason | undefined {
  if (state.replayExecutions >= budget.maxReplayExecutions) {
    return "replay-executions";
  }
  if (nowMs - state.startedAtMs >= budget.maxWallClockMs) {
    return "wall-clock";
  }
  return undefined;
}

function assertSafeNonNegative(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScenarioError(`${name} must be a non-negative integer`);
  }
}
