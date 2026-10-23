import { assertBudget, replayBlockReason } from "./budget.ts";
import { assertScenario, findMissingDependencies, orderIds } from "./dependencies.ts";
import {
  classifyOutcome,
  normalizeOutcome,
  oracleFailureSignature,
  outcomeSignature,
  outcomesAgree,
  runnerError,
  type ConfirmedClass,
} from "./signature.ts";
import {
  ScenarioError,
  type BudgetExhaustedReason,
  type CandidateClass,
  type CandidateEvaluation,
  type TargetSignature,
  type EvaluationSource,
  type ExecutionOutcome,
  type MinimizeInput,
  type MinimizeReport,
  type MinimizeStatus,
  type Probe,
  type ReplayExecution,
  type ReplayPhase,
  type Scenario,
  type Signature,
  type SingleDeletionEvidence,
} from "./types.ts";

export const VERIFIED_ONE_MINIMAL_CLAIM =
  "1-minimal under single deletion of this ordered scenario, given the recorded probes. This is not a proof of the globally shortest reproduction.";

export const MINIMIZE_LIMITATIONS: readonly string[] = [
  "verified-one-minimal means each single deletion of the kept steps failed to reproduce the baseline signature in the recorded probes. It is not a proof of the globally shortest reproduction.",
  "Reproducibility is sampled by the baseline runs, the reduction confirmation runs, and five independent verification runs. A rarer flake can still exist.",
  "The search removes ordered steps. It does not try new orders or smaller fault durations.",
  "Delta debugging can stop early when an extra step hides the failure. The single-deletion evidence is the minimality check this phase records.",
  "Timeouts, runner errors, dependency-invalid subsets, and different failure signatures are not the target failure. A step kept because removing it errors has not been shown to cause the original bug.",
  "The candidate cache stores only unanimous candidate outcomes. Baseline and final verification always execute and never read or write that cache.",
];

type UnstableReason = "verification" | "single-deletion";

type CacheEntry = {
  candidateClass: ConfirmedClass;
  replayExecutionIds: number[];
  signature?: Signature;
};

type EvalResult = {
  stepIds: string[];
  candidateClass: CandidateClass;
  source: EvaluationSource;
  replayExecutionIds: number[];
  budgetStop: boolean;
  signature?: Signature;
};

/**
 * Delta-debugs an ordered scenario through an injected probe.
 * Baseline and the five-run verification bypass the candidate cache.
 */
export async function minimize(input: MinimizeInput): Promise<MinimizeReport> {
  assertScenario(input.scenario);
  assertBudget(input.scenario.budget);
  const search = new Search(input);
  const baseline = await search.runBaseline();
  if (baseline !== "ready") {
    return search.report(baseline);
  }

  let current = await search.ddmin(search.inputStepIds, 2);
  if (!search.exhausted) {
    search.kept = [...current];
  }

  let proven = false;
  let unstableReason: UnstableReason | undefined;
  let rounds = 0;
  while (!search.exhausted && unstableReason === undefined && !proven) {
    rounds += 1;
    if (rounds > search.inputStepIds.length + 1) {
      throw new ScenarioError("minimality search exceeded its round limit");
    }
    const round = await search.proveSingleDeletion(current);
    if (search.exhausted) {
      break;
    }
    if (round.smaller !== undefined) {
      if (round.smaller.length >= current.length) {
        throw new ScenarioError("single deletion did not shrink the candidate");
      }
      current = await search.ddmin(round.smaller, 2);
      if (!search.exhausted) {
        search.kept = [...current];
      }
      continue;
    }
    if (round.inconclusive) {
      unstableReason = "single-deletion";
      search.kept = [...current];
      break;
    }
    proven = true;
    search.kept = [...current];
  }

  if (search.exhausted) {
    return search.report("budget-exhausted");
  }
  if (!proven || unstableReason === "single-deletion") {
    return search.report("unstable", "single-deletion");
  }

  const verified = await search.verify(current);
  if (search.exhausted) {
    return search.report("budget-exhausted");
  }
  if (!verified) {
    return search.report("unstable", "verification");
  }
  return search.report("verified-one-minimal");
}

class Search {
  readonly scenario: Scenario;
  readonly inputStepIds: string[];
  readonly probe: Probe;
  readonly clock: () => number;
  readonly startedAtMs: number;
  readonly replays: ReplayExecution[] = [];
  readonly evaluations: CandidateEvaluation[] = [];
  readonly singleDeletion: SingleDeletionEvidence[] = [];
  private readonly cache = new Map<string, CacheEntry>();

  kept: string[] = [];
  cacheHits = 0;
  exhausted = false;
  exhaustedReason: BudgetExhaustedReason | undefined;
  baselineSignature: TargetSignature | undefined;
  private deletionRound = 0;

  constructor(input: MinimizeInput) {
    this.scenario = input.scenario;
    this.inputStepIds = input.scenario.steps.map((step) => step.id);
    this.probe = input.probe;
    this.clock = input.now ?? Date.now;
    this.startedAtMs = this.readClock();
  }

  async runBaseline(): Promise<"ready" | "budget-exhausted" | "flaky-baseline" | "no-reproducible-failure"> {
    const samples: ReplayExecution[] = [];
    for (let index = 0; index < this.scenario.budget.baselineRuns; index += 1) {
      const execution = await this.runReplay(this.inputStepIds, "baseline");
      if (execution === null) {
        return "budget-exhausted";
      }
      samples.push(execution);
    }
    const decision = decideBaseline(samples);
    if (decision.kind === "flaky") {
      return "flaky-baseline";
    }
    if (decision.kind === "none") {
      return "no-reproducible-failure";
    }
    this.baselineSignature = decision.signature;
    this.kept = [...this.inputStepIds];
    return "ready";
  }

  async ddmin(current: readonly string[], parts: number): Promise<string[]> {
    if (this.exhausted) {
      return [...this.kept];
    }
    if (current.length <= 1) {
      return [...current];
    }

    const chunks = splitIds(current, parts);
    for (const chunk of chunks) {
      const result = await this.evaluate(chunk, "search");
      if (result.budgetStop) {
        return [...this.kept];
      }
      if (result.candidateClass === "target") {
        return this.ddmin(result.stepIds, 2);
      }
    }

    for (const chunk of chunks) {
      const remove = new Set(chunk);
      const complement = current.filter((id) => !remove.has(id));
      const result = await this.evaluate(complement, "search");
      if (result.budgetStop) {
        return [...this.kept];
      }
      if (result.candidateClass === "target") {
        return this.ddmin(result.stepIds, Math.max(parts - 1, 2));
      }
    }

    if (parts < current.length) {
      return this.ddmin(current, Math.min(current.length, parts * 2));
    }
    return [...current];
  }

  async proveSingleDeletion(current: readonly string[]): Promise<{ smaller?: string[]; inconclusive: boolean }> {
    this.deletionRound += 1;
    const round = this.deletionRound;
    let smaller: string[] | undefined;
    let inconclusive = false;

    for (const removedId of current) {
      const subset = current.filter((id) => id !== removedId);
      const result = await this.evaluate(subset, "single-deletion");
      this.singleDeletion.push({
        round,
        removedId,
        stepIds: result.stepIds,
        candidateClass: result.candidateClass,
        source: result.source,
        replayExecutionIds: [...result.replayExecutionIds],
        ...(result.signature !== undefined ? { signature: result.signature } : {}),
      });
      if (result.budgetStop) {
        return smaller === undefined ? { inconclusive } : { inconclusive, smaller };
      }
      if (result.candidateClass === "target") {
        if (smaller === undefined || result.stepIds.length < smaller.length) {
          smaller = result.stepIds;
        }
      } else if (result.candidateClass === "inconclusive") {
        inconclusive = true;
      }
    }

    return smaller === undefined ? { inconclusive } : { inconclusive, smaller };
  }

  /** Five fresh executions. Does not read or write the candidate cache. */
  async verify(stepIds: readonly string[]): Promise<boolean> {
    const baseline = this.requireBaseline();
    let stable = true;
    for (let index = 0; index < this.scenario.budget.verifyRuns; index += 1) {
      const execution = await this.runReplay(stepIds, "verify");
      if (execution === null) {
        return false;
      }
      if (classifyOutcome(execution.outcome, baseline) !== "target") {
        stable = false;
      }
    }
    return stable;
  }

  report(status: MinimizeStatus, unstableReason?: UnstableReason): MinimizeReport {
    const counts = this.counts();
    return {
      status,
      claim: claimFor(status, unstableReason),
      limitations: [...MINIMIZE_LIMITATIONS],
      inputStepIds: [...this.inputStepIds],
      keptStepIds: [...this.kept],
      ...(this.baselineSignature !== undefined ? { baselineSignature: this.baselineSignature } : {}),
      counts,
      budget: {
        maxReplayExecutions: this.scenario.budget.maxReplayExecutions,
        replayExecutions: counts.replayExecutions,
        maxWallClockMs: this.scenario.budget.maxWallClockMs,
        elapsedMs: this.readClock() - this.startedAtMs,
        exhausted: this.exhausted,
        ...(this.exhaustedReason !== undefined ? { exhaustedReason: this.exhaustedReason } : {}),
      },
      replays: this.replays.map((replay) => ({ ...replay, stepIds: [...replay.stepIds] })),
      evaluations: this.evaluations.map(copyEvaluation),
      singleDeletion: this.singleDeletion.map(copyDeletion),
    };
  }

  private async evaluate(stepIds: readonly string[], phase: "search" | "single-deletion"): Promise<EvalResult> {
    const ordered = orderIds(this.scenario.steps, stepIds);
    if (findMissingDependencies(this.scenario.steps, ordered).length > 0) {
      const result: EvalResult = {
        stepIds: ordered,
        candidateClass: "invalid",
        source: "invalid",
        replayExecutionIds: [],
        budgetStop: false,
      };
      this.recordEvaluation(phase, result);
      return result;
    }

    const key = ordered.join("\0");
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cacheHits += 1;
      const result: EvalResult = {
        stepIds: ordered,
        candidateClass: cached.candidateClass,
        source: "cache",
        replayExecutionIds: [...cached.replayExecutionIds],
        budgetStop: false,
        ...(cached.signature !== undefined ? { signature: cached.signature } : {}),
      };
      this.recordEvaluation(phase, result);
      return result;
    }

    const samples: ReplayExecution[] = [];
    for (let index = 0; index < this.scenario.budget.reductionConfirmRuns; index += 1) {
      const execution = await this.runReplay(ordered, "search");
      if (execution === null) {
        const result: EvalResult = {
          stepIds: ordered,
          candidateClass: "inconclusive",
          source: "inconclusive",
          replayExecutionIds: samples.map((sample) => sample.id),
          budgetStop: true,
        };
        this.recordEvaluation(phase, result);
        return result;
      }
      const previous = samples[0];
      if (previous !== undefined && !outcomesAgree(previous.outcome, execution.outcome)) {
        samples.push(execution);
        const result: EvalResult = {
          stepIds: ordered,
          candidateClass: "inconclusive",
          source: "inconclusive",
          replayExecutionIds: samples.map((sample) => sample.id),
          budgetStop: false,
        };
        this.recordEvaluation(phase, result);
        return result;
      }
      samples.push(execution);
    }

    const first = samples[0];
    if (first === undefined) {
      throw new ScenarioError("confirmation finished without a replay");
    }
    const candidateClass = classifyOutcome(first.outcome, this.requireBaseline());
    const signature = outcomeSignature(first.outcome);
    const replayExecutionIds = samples.map((sample) => sample.id);
    this.cache.set(key, {
      candidateClass,
      replayExecutionIds,
      ...(signature !== undefined ? { signature } : {}),
    });
    if (candidateClass === "target") {
      this.replaceKeptIfSmaller(ordered);
    }
    const result: EvalResult = {
      stepIds: ordered,
      candidateClass,
      source: "executed",
      replayExecutionIds,
      budgetStop: false,
      ...(signature !== undefined ? { signature } : {}),
    };
    this.recordEvaluation(phase, result);
    return result;
  }

  /** Baseline and verify call this directly and do not touch the cache. */
  private async runReplay(stepIds: readonly string[], phase: ReplayPhase): Promise<ReplayExecution | null> {
    const block = replayBlockReason(
      this.scenario.budget,
      { startedAtMs: this.startedAtMs, replayExecutions: this.replays.length },
      this.readClock(),
    );
    if (block !== undefined) {
      this.exhausted = true;
      this.exhaustedReason = block;
      return null;
    }

    let outcome: ExecutionOutcome;
    try {
      outcome = normalizeOutcome(await this.probe([...stepIds]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = runnerError(0, message);
    }

    const execution: ReplayExecution = {
      id: this.replays.length + 1,
      phase,
      stepIds: [...stepIds],
      outcome,
    };
    this.replays.push(execution);
    return execution;
  }

  private replaceKeptIfSmaller(stepIds: readonly string[]): void {
    if (stepIds.length < this.kept.length) {
      this.kept = [...stepIds];
    }
  }

  private requireBaseline(): TargetSignature {
    if (this.baselineSignature === undefined) {
      throw new ScenarioError("candidate evaluation started before a baseline signature existed");
    }
    return this.baselineSignature;
  }

  private recordEvaluation(phase: "search" | "single-deletion", result: EvalResult): void {
    this.evaluations.push({
      stepIds: [...result.stepIds],
      phase,
      source: result.source,
      candidateClass: result.candidateClass,
      replayExecutionIds: [...result.replayExecutionIds],
      ...(result.signature !== undefined ? { signature: result.signature } : {}),
    });
  }

  private counts(): MinimizeReport["counts"] {
    let baselineReplays = 0;
    let searchReplays = 0;
    let verifyReplays = 0;
    for (const replay of this.replays) {
      if (replay.phase === "baseline") {
        baselineReplays += 1;
      } else if (replay.phase === "search") {
        searchReplays += 1;
      } else {
        verifyReplays += 1;
      }
    }
    return {
      replayExecutions: this.replays.length,
      candidateEvaluations: this.evaluations.length,
      cacheHits: this.cacheHits,
      baselineReplays,
      searchReplays,
      verifyReplays,
    };
  }

  private readClock(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      throw new ScenarioError("clock returned a non-finite time");
    }
    return now;
  }
}

function decideBaseline(
  samples: readonly ReplayExecution[],
): { kind: "target"; signature: TargetSignature } | { kind: "flaky" } | { kind: "none" } {
  const first = samples[0];
  if (first === undefined) {
    return { kind: "none" };
  }
  const unanimous = samples.every((sample) => outcomesAgree(first.outcome, sample.outcome));
  if (!unanimous) {
    return { kind: "flaky" };
  }
  const signature = oracleFailureSignature(first.outcome);
  if (signature === undefined) {
    return { kind: "none" };
  }
  return { kind: "target", signature };
}

function splitIds(ids: readonly string[], parts: number): string[][] {
  const count = Math.min(Math.max(parts, 1), ids.length);
  const base = Math.floor(ids.length / count);
  const extra = ids.length % count;
  const chunks: string[][] = [];
  let index = 0;
  for (let part = 0; part < count; part += 1) {
    const size = base + (part < extra ? 1 : 0);
    chunks.push(ids.slice(index, index + size));
    index += size;
  }
  return chunks;
}

function claimFor(status: MinimizeStatus, unstableReason: UnstableReason | undefined): string {
  switch (status) {
    case "verified-one-minimal":
      return VERIFIED_ONE_MINIMAL_CLAIM;
    case "unstable":
      return unstableReason === "verification"
        ? "Independent verification did not reproduce the baseline signature on all five runs. No minimality claim is made."
        : "Single-deletion did not prove minimality. No minimality claim is made.";
    case "budget-exhausted":
      return "The execution budget ended before a verified 1-minimal result. No minimality claim is made.";
    case "flaky-baseline":
      return "The full scenario did not fail reproducibly. Minimization did not run.";
    case "no-reproducible-failure":
      return "The full scenario did not produce a stable target failure. Minimization did not run.";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function copyEvaluation(evaluation: CandidateEvaluation): CandidateEvaluation {
  return {
    ...evaluation,
    stepIds: [...evaluation.stepIds],
    replayExecutionIds: [...evaluation.replayExecutionIds],
  };
}

function copyDeletion(evidence: SingleDeletionEvidence): SingleDeletionEvidence {
  return {
    ...evidence,
    stepIds: [...evidence.stepIds],
    replayExecutionIds: [...evidence.replayExecutionIds],
  };
}
