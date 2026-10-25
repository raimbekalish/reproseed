import { findMissingDependencies, orderIds } from "./dependencies.ts";
import { signaturesEqual } from "./signature.ts";
import {
  ScenarioError,
  type BudgetExhaustedReason,
  type DelayedMethod,
  type ExecutionOutcome,
  type MinimizeReport,
  type Oracle,
  type ResetSpec,
  type Scenario,
  type Signature,
  type Step,
  type TargetSignature,
} from "./types.ts";

/**
 * Optional second stage. It does not change delta debugging.
 * A reported duration is the smallest confirmed candidate this search measured.
 */
export const TIMING_LIMITATIONS: readonly string[] = [
  "The selected duration is the smallest confirmed duration among the candidates this search measured. It is not a proof that every shorter duration fails, or that an untested duration also reproduces the failure.",
  "Response-delay races are not treated as monotonic. A miss at one duration does not decide durations that were not replayed.",
  "Confirmation replays are fresh probe executions. Cached step-minimization results are not timing confirmations, and one scenario's candidate cache is not reused for a different delay.",
  "One kept delay step is tuned. Kept scenarios with several delay steps are skipped.",
  "A shorter delay replaces the verified scenario only after a new baseline, single-deletion minimization, and five fresh verification replays all reproduce the original failure signature.",
];

export const DEFAULT_TIMING_RESOLUTION_MS = 250;
export const DEFAULT_TIMING_MAX_REPLAYS = 36;
export const DEFAULT_TIMING_MAX_WALL_CLOCK_MS = 180_000;
export const DEFAULT_TIMING_MAX_COARSE = 4;
export const DEFAULT_TIMING_MAX_FINE = 4;

export type TimingSearchConfig = {
  resolutionMs: number;
  maxReplayExecutions: number;
  maxWallClockMs: number;
  confirmRuns?: number;
  maxCoarseCandidates?: number;
  maxFineCandidates?: number;
};

export type ResolvedTimingConfig = {
  resolutionMs: number;
  maxReplayExecutions: number;
  maxWallClockMs: number;
  confirmRuns: number;
  maxCoarseCandidates: number;
  maxFineCandidates: number;
};

export type TimingSearchStatus =
  | "completed"
  | "budget-exhausted"
  | "runner-error"
  | "skipped-multiple-delays"
  | "skipped-no-delay"
  | "skipped-non-integer-duration"
  | "skipped-step-minimization";

export type TimingPromotion = "improved" | "no-improvement" | "unstable" | "not-verified" | "not-attempted";

export type TimingCandidateClassification =
  | "confirmed"
  | "pass"
  | "other"
  | "timeout"
  | "error"
  | "unstable"
  | "incomplete";

export type TimingSampleClass = "pass" | "target" | "other" | "error" | "timeout";

export type TimingCandidate = {
  durationMs: number;
  phase: "coarse" | "fine";
  classification: TimingCandidateClassification;
  replayIds: number[];
  samples: Array<{ replayId: number; classification: TimingSampleClass }>;
};

export type TimingReplay = {
  id: number;
  phase: "timing";
  durationMs: number;
  stepIds: string[];
  outcome: ExecutionOutcome;
};

export type TimingDelayStep = {
  id: string;
  method: DelayedMethod;
  urlIncludes: string;
  originalMs: number;
  selectedMs?: number;
  finalMs?: number;
};

export type DurationOptimization = {
  requested: true;
  searchStatus: TimingSearchStatus;
  promotion: TimingPromotion;
  retainedOriginal: boolean;
  timingImproved: boolean;
  fullyVerified: boolean;
  exportedScenario: "original" | "tuned";
  limitations: string[];
  claim: string;
  /** Present when several kept delay steps made the search refuse to tune. */
  skippedDelayStepIds?: string[];
  delayStep?: TimingDelayStep;
  plannedDurations: { coarse: number[]; fine: number[] };
  notStartedDurations: number[];
  candidates: TimingCandidate[];
  replays: TimingReplay[];
  additionalRemovedStepIds: string[];
  budget: {
    maxReplayExecutions: number;
    replayExecutions: number;
    maxWallClockMs: number;
    elapsedMs: number;
    exhausted: boolean;
    exhaustedReason?: BudgetExhaustedReason;
    resolutionMs: number;
    confirmRuns: number;
    maxCoarseCandidates: number;
    maxFineCandidates: number;
  };
  stage1: MinimizeReport;
  stage3?: MinimizeReport;
  totals: {
    replayExecutions: number;
    stage1Replays: number;
    timingReplays: number;
    stage3Replays: number;
  };
};

export type DelaySelection =
  | { status: "selected"; stepId: string; method: DelayedMethod; urlIncludes: string; durationMs: number }
  | { status: "multiple"; stepIds: string[] }
  | { status: "non-integer"; stepId: string; durationMs: number }
  | { status: "none" };

export function assertPositiveDurationMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ScenarioError(`${label} must be a positive integer number of milliseconds`);
  }
}

export function resolveTimingConfig(config: TimingSearchConfig, confirmRunsDefault: number): ResolvedTimingConfig {
  assertPositiveDurationMs(config.resolutionMs, "timing resolution");
  assertPositiveDurationMs(config.maxReplayExecutions, "timing maxReplayExecutions");
  assertPositiveDurationMs(config.maxWallClockMs, "timing maxWallClockMs");
  const confirmRuns = config.confirmRuns ?? confirmRunsDefault;
  if (!Number.isSafeInteger(confirmRuns) || confirmRuns < 2) {
    throw new ScenarioError("timing confirmRuns must be an integer greater than or equal to 2");
  }
  const maxCoarseCandidates = config.maxCoarseCandidates ?? DEFAULT_TIMING_MAX_COARSE;
  const maxFineCandidates = config.maxFineCandidates ?? DEFAULT_TIMING_MAX_FINE;
  if (!Number.isSafeInteger(maxCoarseCandidates) || maxCoarseCandidates < 1) {
    throw new ScenarioError("timing maxCoarseCandidates must be a positive integer");
  }
  if (!Number.isSafeInteger(maxFineCandidates) || maxFineCandidates < 1) {
    throw new ScenarioError("timing maxFineCandidates must be a positive integer");
  }
  return {
    resolutionMs: config.resolutionMs,
    maxReplayExecutions: config.maxReplayExecutions,
    maxWallClockMs: config.maxWallClockMs,
    confirmRuns,
    maxCoarseCandidates,
    maxFineCandidates,
  };
}

export function cloneScenario(scenario: Scenario): Scenario {
  return {
    id: scenario.id,
    target: { ...scenario.target },
    reset: cloneReset(scenario.reset),
    steps: scenario.steps.map(cloneStep),
    oracle: cloneOracle(scenario.oracle),
    budget: { ...scenario.budget },
  };
}

/** Keeps `keptStepIds` in scenario order, including their dependencies. The input scenario is not modified. */
export function scenarioKeepingSteps(scenario: Scenario, keptStepIds: readonly string[]): Scenario {
  const ordered = orderIds(scenario.steps, keptStepIds);
  const missing = findMissingDependencies(scenario.steps, ordered);
  if (missing.length > 0) {
    const detail = missing.map((item) => `${item.stepId} needs ${item.dependsOn}`).join(", ");
    throw new ScenarioError(`kept steps are missing dependencies: ${detail}`);
  }
  const cloned = cloneScenario(scenario);
  const byId = new Map(cloned.steps.map((step) => [step.id, step]));
  return {
    ...cloned,
    steps: ordered.map((id) => {
      const step = byId.get(id);
      if (step === undefined) {
        throw new ScenarioError(`unknown step in subset: ${id}`);
      }
      return step;
    }),
  };
}

/**
 * Returns a new scenario whose one delay step uses `durationMs`.
 * `durationMs` must be a positive integer and must not exceed that step's current duration.
 */
export function scenarioWithDelay(scenario: Scenario, stepId: string, durationMs: number): Scenario {
  assertPositiveDurationMs(durationMs, `delay ${stepId}`);
  const cloned = cloneScenario(scenario);
  const index = cloned.steps.findIndex((step) => step.id === stepId);
  const step = cloned.steps[index];
  if (step === undefined || step.kind !== "delay") {
    throw new ScenarioError(`step ${stepId} is not a delay`);
  }
  if (!Number.isFinite(step.ms) || durationMs > step.ms) {
    throw new ScenarioError(`delay ${stepId} cannot increase from ${step.ms}ms to ${durationMs}ms`);
  }
  const steps = cloned.steps.slice();
  steps[index] = { ...step, dependsOn: [...step.dependsOn], ms: durationMs };
  return { ...cloned, steps };
}

/** Chooses the single kept delay step. Several kept delays are reported and not optimized. */
export function selectTunableDelay(scenario: Scenario, keptStepIds: readonly string[]): DelaySelection {
  const kept = new Set(keptStepIds);
  for (const id of keptStepIds) {
    if (!scenario.steps.some((step) => step.id === id)) {
      throw new ScenarioError(`kept step ${id} is not in the scenario`);
    }
  }
  const delays = scenario.steps.filter((step): step is Extract<Step, { kind: "delay" }> => step.kind === "delay" && kept.has(step.id));
  if (delays.length === 0) {
    return { status: "none" };
  }
  if (delays.length > 1) {
    return { status: "multiple", stepIds: delays.map((step) => step.id) };
  }
  const delay = delays[0];
  if (delay === undefined) {
    return { status: "none" };
  }
  if (!Number.isSafeInteger(delay.ms) || delay.ms < 1) {
    return { status: "non-integer", stepId: delay.id, durationMs: delay.ms };
  }
  return {
    status: "selected",
    stepId: delay.id,
    method: delay.method,
    urlIncludes: delay.urlIncludes,
    durationMs: delay.ms,
  };
}

/**
 * Coarse durations strictly below `originalMs`, longest first.
 * The step grows by `resolutionMs` until the grid has at most `maxCount` points.
 */
export function planCoarseDurations(originalMs: number, resolutionMs: number, maxCount: number): number[] {
  assertPositiveDurationMs(originalMs, "original delay");
  assertPositiveDurationMs(resolutionMs, "timing resolution");
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) {
    throw new ScenarioError("maxCoarseCandidates must be a positive integer");
  }
  if (resolutionMs >= originalMs) {
    return [];
  }
  let step = resolutionMs;
  let values = durationsBelow(originalMs, step);
  while (values.length > maxCount) {
    const next = step + resolutionMs;
    if (!Number.isSafeInteger(next) || next >= originalMs) {
      return values.slice(0, maxCount);
    }
    step = next;
    values = durationsBelow(originalMs, step);
  }
  return values;
}

/**
 * Finer positive durations strictly between the best confirmed sample and the nearest
 * measured miss below it. Already measured durations are omitted. This does not fill
 * that gap with an assumption; callers still have to replay whatever this returns.
 */
export function planFineDurations(input: {
  originalMs: number;
  resolutionMs: number;
  maxCount: number;
  measured: readonly { durationMs: number; confirmed: boolean }[];
}): number[] {
  assertPositiveDurationMs(input.originalMs, "original delay");
  assertPositiveDurationMs(input.resolutionMs, "timing resolution");
  if (!Number.isSafeInteger(input.maxCount) || input.maxCount < 1) {
    throw new ScenarioError("maxFineCandidates must be a positive integer");
  }
  const confirmed = input.measured.filter((item) => item.confirmed).map((item) => item.durationMs);
  const best = confirmed.reduce<number | undefined>((shortest, duration) => {
    return shortest === undefined || duration < shortest ? duration : shortest;
  }, undefined);
  if (best === undefined || best <= 1) {
    return [];
  }
  const lowerMisses = input.measured
    .filter((item) => !item.confirmed && item.durationMs < best)
    .map((item) => item.durationMs);
  const floor = lowerMisses.reduce((highest, duration) => Math.max(highest, duration), 0);
  const seen = new Set(input.measured.map((item) => item.durationMs));
  const eligible: number[] = [];
  for (let duration = floor + input.resolutionMs; duration < best && duration < input.originalMs; duration += input.resolutionMs) {
    if (!Number.isSafeInteger(duration) || duration < 1 || seen.has(duration)) {
      continue;
    }
    eligible.push(duration);
  }
  return takeSpread(eligible, input.maxCount);
}

export function delayMilliseconds(scenario: Scenario, stepId: string): number | undefined {
  const step = scenario.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined || step.kind !== "delay" || !Number.isSafeInteger(step.ms)) {
    return undefined;
  }
  return step.ms;
}

export function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function durationsBelow(originalMs: number, step: number): number[] {
  const values: number[] = [];
  for (let duration = originalMs - step; duration >= 1; duration -= step) {
    if (!Number.isSafeInteger(duration)) {
      break;
    }
    values.push(duration);
  }
  return values;
}

function takeSpread(values: readonly number[], maxCount: number): number[] {
  if (values.length <= maxCount) {
    return [...values];
  }
  const first = values[0];
  if (maxCount === 1) {
    return first === undefined ? [] : [first];
  }
  const picked: number[] = [];
  for (let index = 0; index < maxCount; index += 1) {
    const at = Math.round((index * (values.length - 1)) / (maxCount - 1));
    const value = values[at];
    if (value !== undefined && !picked.includes(value)) {
      picked.push(value);
    }
  }
  return picked;
}

function cloneReset(reset: ResetSpec): ResetSpec {
  return {
    method: reset.method,
    path: reset.path,
    ...(reset.verify !== undefined
      ? { verify: { kind: reset.verify.kind, method: reset.verify.method, path: reset.verify.path } }
      : {}),
  };
}

function cloneOracle(oracle: Oracle): Oracle {
  if (oracle.id === "record-count") {
    return {
      id: "record-count",
      request: { method: oracle.request.method, path: oracle.request.path },
      match: { field: oracle.match.field, value: oracle.match.value },
      expect: oracle.expect,
    };
  }
  return { id: "dom-text", selector: oracle.selector, expect: oracle.expect };
}

function cloneStep(step: Step): Step {
  switch (step.kind) {
    case "goto":
      return { id: step.id, kind: "goto", path: step.path, dependsOn: [...step.dependsOn] };
    case "fill":
      return { id: step.id, kind: "fill", selector: step.selector, value: step.value, dependsOn: [...step.dependsOn] };
    case "click":
      return { id: step.id, kind: "click", selector: step.selector, dependsOn: [...step.dependsOn] };
    case "wait":
      return { id: step.id, kind: "wait", ms: step.ms, dependsOn: [...step.dependsOn] };
    case "delay":
      return {
        id: step.id,
        kind: "delay",
        urlIncludes: step.urlIncludes,
        method: step.method,
        ms: step.ms,
        dependsOn: [...step.dependsOn],
      };
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

export function failureMatches(outcome: ExecutionOutcome, signature: TargetSignature): boolean {
  return outcome.status === "fail" && signaturesEqual(outcome.signature, signature);
}

export function isResetFailure(outcome: ExecutionOutcome): boolean {
  return outcome.status === "error" && outcome.signature !== undefined && isResetSignature(outcome.signature);
}

function isResetSignature(signature: Signature): boolean {
  return signature.oracleId === "runner" && signature.code === "RESET_FAILED";
}
