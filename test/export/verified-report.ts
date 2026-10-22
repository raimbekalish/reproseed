import type { DuplicateSignature, ExecutionOutcome, MinimizeReport, Scenario } from "../../src/core/types.ts";

/** A report shape that satisfies the export gates when `keptStepIds` are the real kept steps. */
export function verifiedMinimizeReport(
  scenario: Scenario,
  keptStepIds: readonly string[],
  actual = scenario.oracle.expect + 1,
): MinimizeReport {
  if (actual === scenario.oracle.expect) {
    throw new Error("fixture failure must differ from the intended count");
  }
  const signature: DuplicateSignature = {
    oracleId: "record-count",
    code: actual > scenario.oracle.expect ? "DUPLICATE" : "COUNT_MISMATCH",
    facts: {
      email: scenario.oracle.match.value,
      actual,
      expect: scenario.oracle.expect,
    },
  };
  const inputStepIds = scenario.steps.map((step) => step.id);
  const replays = [
    ...Array.from({ length: scenario.budget.baselineRuns }, (_, index) => ({
      id: index + 1,
      phase: "baseline" as const,
      stepIds: [...inputStepIds],
      outcome: failure(signature),
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: scenario.budget.baselineRuns + index + 1,
      phase: "verify" as const,
      stepIds: [...keptStepIds],
      outcome: failure(signature),
    })),
  ];
  return {
    status: "verified-one-minimal",
    claim: "1-minimal under single deletion of this ordered scenario, given the recorded probes. This is not a proof of the globally shortest reproduction.",
    limitations: [],
    inputStepIds,
    keptStepIds: [...keptStepIds],
    baselineSignature: signature,
    counts: {
      replayExecutions: replays.length,
      candidateEvaluations: 0,
      cacheHits: 0,
      baselineReplays: scenario.budget.baselineRuns,
      searchReplays: 0,
      verifyReplays: 5,
    },
    budget: {
      maxReplayExecutions: scenario.budget.maxReplayExecutions,
      replayExecutions: replays.length,
      maxWallClockMs: scenario.budget.maxWallClockMs,
      elapsedMs: 1,
      exhausted: false,
    },
    replays,
    evaluations: [],
    singleDeletion: [],
  };
}

function failure(signature: DuplicateSignature): ExecutionOutcome {
  return { status: "fail", durationMs: 5, signature };
}
