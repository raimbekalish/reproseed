import type { Budget, DuplicateSignature, ExecutionOutcome, Probe, Scenario, Step } from "../src/core/types.ts";

export const CORE_IDS = ["open", "email", "slow", "submit-1", "gap", "submit-2"] as const;

export const TARGET_SIGNATURE: DuplicateSignature = {
  oracleId: "record-count",
  code: "DUPLICATE",
  facts: { email: "a@example.com", actual: 2, expect: 1 },
};

export function duplicateSignature(actual = 2): DuplicateSignature {
  return {
    oracleId: "record-count",
    code: "DUPLICATE",
    facts: { email: "a@example.com", actual, expect: 1 },
  };
}

export function duplicateSubmitSteps(): Step[] {
  return [
    { id: "open", kind: "goto", path: "/", dependsOn: [] },
    { id: "preview", kind: "click", selector: "#preview", dependsOn: ["open"] },
    { id: "email", kind: "fill", selector: "#email", value: "a@example.com", dependsOn: ["open"] },
    { id: "note", kind: "fill", selector: "#note", value: "hello", dependsOn: ["open"] },
    { id: "decoy-wait", kind: "wait", ms: 100, dependsOn: [] },
    {
      id: "slow",
      kind: "delay",
      urlIncludes: "/api/records",
      method: "POST",
      ms: 2000,
      dependsOn: [],
    },
    { id: "submit-1", kind: "click", selector: "#submit", dependsOn: ["open", "email"] },
    { id: "gap", kind: "wait", ms: 800, dependsOn: [] },
    { id: "submit-2", kind: "click", selector: "#submit", dependsOn: ["open", "email"] },
  ];
}

export function duplicateSubmitScenario(overrides: Partial<Budget> = {}): Scenario {
  return {
    id: "duplicate-submit",
    target: {
      origin: "http://127.0.0.1:4010",
      appId: "duplicate-submit",
      resetAuthorization: "local-demo-token",
    },
    reset: { method: "POST", path: "/__reproseed/reset" },
    steps: duplicateSubmitSteps(),
    oracle: {
      id: "record-count",
      request: { method: "GET", path: "/api/records" },
      match: { field: "email", value: "a@example.com" },
      expect: 1,
    },
    budget: {
      maxReplayExecutions: 2000,
      maxWallClockMs: 120_000,
      attemptTimeoutMs: 20_000,
      baselineRuns: 3,
      reductionConfirmRuns: 2,
      verifyRuns: 5,
      ...overrides,
    },
  };
}

/** Synthetic duplicate-submit predicate. Note, preview, and the decoy wait are not required. */
export function outcomeForDuplicateSubmit(ids: readonly string[]): ExecutionOutcome {
  const present = new Set(ids);
  if (CORE_IDS.every((id) => present.has(id))) {
    return { status: "fail", durationMs: 5, signature: duplicateSignature(2) };
  }
  const gapChangedCount =
    present.has("open") &&
    present.has("email") &&
    present.has("slow") &&
    present.has("submit-1") &&
    present.has("submit-2") &&
    !present.has("gap");
  if (gapChangedCount) {
    return { status: "fail", durationMs: 5, signature: duplicateSignature(3) };
  }
  return { status: "pass", durationMs: 5 };
}

export function recordingProbe(impl: Probe): { probe: Probe; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    probe: async (ids) => {
      calls.push([...ids]);
      return impl(ids);
    },
  };
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
