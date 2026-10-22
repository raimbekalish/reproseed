/**
 * Scenario and report contracts for the minimizer.
 * The runner in src/runner consumes these types. This module stays free of Playwright.
 * See docs/future-phase-corrections.md.
 */

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

/**
 * Loopback is not authorization. A future runner must observe `appId` on the
 * process it is about to reset and present `resetAuthorization`.
 */
export type TargetApp = {
  origin: string;
  appId: string;
  resetAuthorization: string;
};

export type ResetSpec = {
  method: "POST";
  path: "/__reproseed/reset";
};

export type RecordCountOracle = {
  id: "record-count";
  request: { method: "GET"; path: string };
  match: { field: "email"; value: string };
  expect: number;
};

type StepBase = {
  id: string;
  dependsOn: string[];
};

export type GotoStep = StepBase & { kind: "goto"; path: string };
export type FillStep = StepBase & { kind: "fill"; selector: string; value: string };
export type ClickStep = StepBase & { kind: "click"; selector: string };
export type WaitStep = StepBase & { kind: "wait"; ms: number };

/**
 * Delay the browser-visible response.
 * Future runner: `route.fetch()`, wait, `route.fulfill({ response })`.
 * Waiting before `route.continue()` delays request dispatch instead.
 */
export type DelayStep = StepBase & {
  kind: "delay";
  urlIncludes: string;
  method: "POST";
  ms: number;
};

export type Step = GotoStep | FillStep | ClickStep | WaitStep | DelayStep;

/**
 * `attemptTimeoutMs` is the runner's per-replay limit.
 * The minimizer enforces `maxReplayExecutions` and `maxWallClockMs`.
 * `verifyRuns` is fixed at 5. Baseline and reduction confirmation require at least 2 runs.
 */
export type Budget = {
  maxReplayExecutions: number;
  maxWallClockMs: number;
  attemptTimeoutMs: number;
  baselineRuns: number;
  reductionConfirmRuns: number;
  verifyRuns: number;
};

export type Scenario = {
  id: string;
  target: TargetApp;
  reset: ResetSpec;
  steps: Step[];
  oracle: RecordCountOracle;
  budget: Budget;
};

export type DuplicateSignature = {
  oracleId: "record-count";
  code: "DUPLICATE" | "COUNT_MISMATCH";
  facts: {
    email: string;
    actual: number;
    expect: number;
  };
};

export type RunnerFailureSignature = {
  oracleId: "runner";
  code: "TIMEOUT" | "RUNNER_ERROR" | "RESET_FAILED";
  facts: {
    message: string;
  };
};

export type Signature = DuplicateSignature | RunnerFailureSignature;

export type ExecutionOutcome =
  | { status: "pass"; durationMs: number }
  | { status: "fail"; durationMs: number; signature: Signature }
  | { status: "timeout"; durationMs: number; error?: string; signature?: Signature }
  | { status: "error"; durationMs: number; error?: string; signature?: Signature };

/** One injected attempt against a step subsequence. The minimizer supplies the ids in scenario order. */
export type Probe = (stepIds: readonly string[]) => Promise<ExecutionOutcome>;

export type ReplayPhase = "baseline" | "search" | "verify";

export type ReplayExecution = {
  id: number;
  phase: ReplayPhase;
  stepIds: string[];
  outcome: ExecutionOutcome;
};

export type CandidateClass =
  | "pass"
  | "target"
  | "other"
  | "invalid"
  | "error"
  | "timeout"
  | "inconclusive";

export type EvaluationSource = "cache" | "invalid" | "executed" | "inconclusive";

/** One decision about a subset. This is not the same thing as a replay execution. */
export type CandidateEvaluation = {
  stepIds: string[];
  phase: "search" | "single-deletion";
  source: EvaluationSource;
  candidateClass: CandidateClass;
  replayExecutionIds: number[];
  signature?: Signature;
};

export type SingleDeletionEvidence = {
  round: number;
  removedId: string;
  stepIds: string[];
  candidateClass: CandidateClass;
  source: EvaluationSource;
  replayExecutionIds: number[];
  signature?: Signature;
};

export type MinimizeStatus =
  | "verified-one-minimal"
  | "unstable"
  | "budget-exhausted"
  | "flaky-baseline"
  | "no-reproducible-failure";

export type BudgetExhaustedReason = "replay-executions" | "wall-clock";

export type MinimizeReport = {
  status: MinimizeStatus;
  claim: string;
  limitations: string[];
  inputStepIds: string[];
  keptStepIds: string[];
  baselineSignature?: DuplicateSignature;
  counts: {
    replayExecutions: number;
    candidateEvaluations: number;
    cacheHits: number;
    baselineReplays: number;
    searchReplays: number;
    verifyReplays: number;
  };
  budget: {
    maxReplayExecutions: number;
    replayExecutions: number;
    maxWallClockMs: number;
    elapsedMs: number;
    exhausted: boolean;
    exhaustedReason?: BudgetExhaustedReason;
  };
  replays: ReplayExecution[];
  evaluations: CandidateEvaluation[];
  singleDeletion: SingleDeletionEvidence[];
};

export type MinimizeInput = {
  scenario: Scenario;
  probe: Probe;
  now?: () => number;
};
