import {
  copyJson,
  delayMilliseconds,
  failureMatches,
  isResetFailure,
  planCoarseDurations,
  planFineDurations,
  resolveTimingConfig,
  scenarioKeepingSteps,
  scenarioWithDelay,
  selectTunableDelay,
  TIMING_LIMITATIONS,
  type DurationOptimization,
  type ResolvedTimingConfig,
  type TimingCandidate,
  type TimingCandidateClassification,
  type TimingDelayStep,
  type TimingPromotion,
  type TimingReplay,
  type TimingSampleClass,
  type TimingSearchConfig,
  type TimingSearchStatus,
} from "../core/duration.ts";
import { minimize } from "../core/minimize.ts";
import { classifyOutcome, normalizeOutcome, outcomesAgree, runnerError, signaturesEqual } from "../core/signature.ts";
import {
  ScenarioError,
  type BudgetExhaustedReason,
  type ExecutionOutcome,
  type MinimizeReport,
  type Probe,
  type Scenario,
  type TargetSignature,
} from "../core/types.ts";

export type DurationTunedResult = {
  kind: "duration-tuned";
  /** Scenario whose step parameters match `report` for export. */
  scenario: Scenario;
  /** Verified report to export, or the original step-minimization report when tuning is not kept. */
  report: MinimizeReport;
  optimization: DurationOptimization;
};

export function isDurationTunedResult(value: unknown): value is DurationTunedResult {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "duration-tuned";
}

/**
 * After a verified step minimization, measures shorter delays for the one kept delay step.
 * Each candidate is an immutable scenario and a probe closed over that scenario.
 * The original scenario and the stage-1 report are not modified.
 * A tuned scenario is returned only when renewed minimization and five fresh
 * verification replays reproduce the original failure. Otherwise stage 1 is kept.
 */
export async function optimizeVerifiedDuration(input: {
  scenario: Scenario;
  stage1: MinimizeReport;
  config: TimingSearchConfig;
  probeFor: (scenario: Scenario) => Probe;
  now?: () => number;
}): Promise<DurationTunedResult> {
  const stage1 = copyJson(input.stage1);
  const config = resolveTimingConfig(input.config, input.scenario.budget.reductionConfirmRuns);
  try {
    return await runOptimization({ ...input, stage1 }, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return assemble({
      input,
      stage1,
      config,
      exportScenario: input.scenario,
      report: stage1,
      searchStatus: "runner-error",
      promotion: "not-attempted",
      claim: `Delay tuning stopped because ${message} The original step-minimization result is unchanged.`,
      planned: { coarse: [], fine: [] },
      notStarted: [],
      candidates: [],
      replays: [],
      elapsedMs: 0,
      exhausted: false,
      additionalRemovedStepIds: [],
    });
  }
}

async function runOptimization(
  input: {
    scenario: Scenario;
    stage1: MinimizeReport;
    probeFor: (scenario: Scenario) => Probe;
    now?: () => number;
  },
  config: ResolvedTimingConfig,
): Promise<DurationTunedResult> {
  const stage1 = input.stage1;
  if (stage1.status !== "verified-one-minimal" || stage1.baselineSignature === undefined) {
    return assemble({
      input,
      stage1,
      config,
      exportScenario: input.scenario,
      report: stage1,
      searchStatus: "skipped-step-minimization",
      promotion: "not-attempted",
      claim: `Delay tuning was requested after step minimization status ${stage1.status}. Timing search did not run.`,
      planned: { coarse: [], fine: [] },
      notStarted: [],
      candidates: [],
      replays: [],
      elapsedMs: 0,
      exhausted: false,
      additionalRemovedStepIds: [],
    });
  }

  const selection = selectTunableDelay(input.scenario, stage1.keptStepIds);
  if (selection.status === "none") {
    return skipped(input, stage1, config, "skipped-no-delay", "The verified steps do not include a delay. Delay tuning was not run. The original verified scenario is unchanged.");
  }
  if (selection.status === "multiple") {
    return assemble({
      input,
      stage1,
      config,
      exportScenario: input.scenario,
      report: stage1,
      searchStatus: "skipped-multiple-delays",
      promotion: "not-attempted",
      claim: `Kept steps include more than one delay (${selection.stepIds.join(", ")}). Those delays were not optimized together. The original verified scenario is unchanged.`,
      planned: { coarse: [], fine: [] },
      notStarted: [],
      candidates: [],
      replays: [],
      elapsedMs: 0,
      exhausted: false,
      additionalRemovedStepIds: [],
      skippedDelayStepIds: selection.stepIds,
    });
  }
  if (selection.status === "non-integer") {
    const step = input.scenario.steps.find((candidate) => candidate.id === selection.stepId);
    return assemble({
      input,
      stage1,
      config,
      exportScenario: input.scenario,
      report: stage1,
      searchStatus: "skipped-non-integer-duration",
      promotion: "not-attempted",
      claim: `Delay ${selection.stepId} is ${selection.durationMs}ms, which is not a positive integer. Delay tuning was not run. The original verified scenario is unchanged.`,
      ...(step !== undefined && step.kind === "delay"
        ? {
            delayStep: {
              id: step.id,
              method: step.method,
              urlIncludes: step.urlIncludes,
              originalMs: selection.durationMs,
            },
          }
        : {}),
      planned: { coarse: [], fine: [] },
      notStarted: [],
      candidates: [],
      replays: [],
      elapsedMs: 0,
      exhausted: false,
      additionalRemovedStepIds: [],
    });
  }

  const baseline = stage1.baselineSignature;
  const kept = scenarioKeepingSteps(input.scenario, stage1.keptStepIds);
  const coarse = planCoarseDurations(selection.durationMs, config.resolutionMs, config.maxCoarseCandidates);
  const clock = input.now ?? Date.now;
  const startedAt = readClock(clock);
  const replays: TimingReplay[] = [];
  const candidates: TimingCandidate[] = [];
  const notStarted: number[] = [];
  let exhausted = false;
  let exhaustedReason: BudgetExhaustedReason | undefined;
  let resetFailed = false;

  const block = (): BudgetExhaustedReason | undefined => {
    if (replays.length >= config.maxReplayExecutions) {
      return "replay-executions";
    }
    if (readClock(clock) - startedAt >= config.maxWallClockMs) {
      return "wall-clock";
    }
    return undefined;
  };

  const measureList = async (durations: readonly number[], phase: "coarse" | "fine"): Promise<void> => {
    for (const durationMs of durations) {
      if (resetFailed) {
        notStarted.push(durationMs);
        continue;
      }
      const reason = block();
      if (reason !== undefined) {
        exhausted = true;
        exhaustedReason = reason;
        notStarted.push(durationMs);
        continue;
      }
      const variant = scenarioWithDelay(kept, selection.stepId, durationMs);
      const probe = input.probeFor(variant);
      const stepIds = variant.steps.map((step) => step.id);
      const samples: Array<{ replayId: number; classification: TimingSampleClass; outcome: ExecutionOutcome }> = [];
      let budgetStopped = false;
      for (let index = 0; index < config.confirmRuns; index += 1) {
        const reasonNow = block();
        if (reasonNow !== undefined) {
          exhausted = true;
          exhaustedReason = reasonNow;
          budgetStopped = true;
          break;
        }
        const outcome = await executeProbe(probe, stepIds);
        const replay: TimingReplay = {
          id: replays.length + 1,
          phase: "timing",
          durationMs,
          stepIds: [...stepIds],
          outcome,
        };
        replays.push(replay);
        samples.push({
          replayId: replay.id,
          classification: classifyOutcome(outcome, baseline),
          outcome,
        });
        if (isResetFailure(outcome)) {
          resetFailed = true;
          break;
        }
        const previous = samples[0];
        if (previous !== undefined && !outcomesAgree(previous.outcome, outcome)) {
          break;
        }
      }
      candidates.push({
        durationMs,
        phase,
        classification: classifyCandidate(samples, config.confirmRuns, budgetStopped, resetFailed),
        replayIds: samples.map((sample) => sample.replayId),
        samples: samples.map((sample) => ({ replayId: sample.replayId, classification: sample.classification })),
      });
    }
  };

  await measureList(coarse, "coarse");
  const fine = resetFailed
    ? []
    : planFineDurations({
        originalMs: selection.durationMs,
        resolutionMs: config.resolutionMs,
        maxCount: config.maxFineCandidates,
        measured: candidates.map((candidate) => ({
          durationMs: candidate.durationMs,
          confirmed: candidate.classification === "confirmed",
        })),
      });
  const fineOrder = [...fine].reverse();
  if (!resetFailed) {
    await measureList(fineOrder, "fine");
  }
  const elapsedMs = Math.max(0, readClock(clock) - startedAt);
  const delayStep: TimingDelayStep = {
    id: selection.stepId,
    method: selection.method,
    urlIncludes: selection.urlIncludes,
    originalMs: selection.durationMs,
  };
  const planned = { coarse: [...coarse], fine: [...fine] };
  const confirmed = candidates.filter((candidate) => candidate.classification === "confirmed");
  const selected = confirmed.reduce<number | undefined>((shortest, candidate) => {
    return shortest === undefined || candidate.durationMs < shortest ? candidate.durationMs : shortest;
  }, undefined);

  if (resetFailed || selected === undefined) {
    const searchStatus: TimingSearchStatus = resetFailed ? "runner-error" : exhausted ? "budget-exhausted" : "completed";
    const promotion: TimingPromotion = resetFailed
      ? "not-attempted"
      : exhausted
        ? "not-attempted"
        : candidates.some((candidate) => candidate.classification === "unstable")
          ? "unstable"
          : "no-improvement";
    return assemble({
      input,
      stage1,
      config,
      exportScenario: input.scenario,
      report: stage1,
      searchStatus,
      promotion,
      claim: idleClaim(selection.durationMs, searchStatus, promotion),
      delayStep,
      planned,
      notStarted,
      candidates,
      replays,
      elapsedMs,
      exhausted,
      ...(exhaustedReason !== undefined ? { exhaustedReason } : {}),
      additionalRemovedStepIds: [],
    });
  }

  delayStep.selectedMs = selected;
  const tuned = scenarioWithDelay(kept, selection.stepId, selected);
  let stage3: MinimizeReport;
  try {
    stage3 = await minimize({
      scenario: tuned,
      probe: input.probeFor(tuned),
      now: clock,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return assemble({
      input,
      stage1,
      config,
      exportScenario: input.scenario,
      report: stage1,
      searchStatus: "runner-error",
      promotion: "not-verified",
      claim: `${selected}ms was confirmed among the measured candidates, but renewed minimization stopped because ${message} The original verified scenario is unchanged.`,
      delayStep,
      planned,
      notStarted,
      candidates,
      replays,
      elapsedMs,
      exhausted,
      ...(exhaustedReason !== undefined ? { exhaustedReason } : {}),
      additionalRemovedStepIds: [],
    });
  }
  const stage3Copy = copyJson(stage3);
  const finalMs = stage3Copy.keptStepIds.includes(selection.stepId) ? delayMilliseconds(tuned, selection.stepId) : undefined;
  const verified =
    failureSignatureHeld(stage3Copy, baseline) &&
    (finalMs === undefined || finalMs === selected) &&
    !resetFailed;
  if (!verified) {
    const promotion: TimingPromotion = stage3Copy.status === "unstable" ? "unstable" : "not-verified";
    return assemble({
      input,
      stage1,
      config,
      exportScenario: input.scenario,
      report: stage1,
      searchStatus: exhausted ? "budget-exhausted" : "completed",
      promotion,
      claim: `${selected}ms was confirmed among the measured candidates, but renewed minimization did not verify the original failure (${stage3Copy.status}). The original verified scenario is unchanged.`,
      delayStep,
      planned,
      notStarted,
      candidates,
      replays,
      elapsedMs,
      exhausted,
      ...(exhaustedReason !== undefined ? { exhaustedReason } : {}),
      additionalRemovedStepIds: [],
      stage3: stage3Copy,
    });
  }

  const additionalRemovedStepIds = stage3Copy.inputStepIds.filter((id) => !stage3Copy.keptStepIds.includes(id));
  if (finalMs !== undefined) {
    delayStep.finalMs = finalMs;
  }
  const untested = notStarted.length > 0 ? `${notStarted.length} planned durations were not replayed. ` : "";
  const removed =
    additionalRemovedStepIds.length > 0 ? ` Renewed minimization also removed ${additionalRemovedStepIds.join(", ")}.` : "";
  const finalText = finalMs === undefined ? "the delay step was removed by that minimization" : `${finalMs}ms`;
  return assemble({
    input,
    stage1,
    config,
    exportScenario: tuned,
    report: stage3Copy,
    searchStatus: exhausted ? "budget-exhausted" : "completed",
    promotion: "improved",
    claim: `Smallest confirmed duration among the measured candidates is ${selected}ms for ${selection.stepId}. ${untested}Renewed minimization verified ${finalText} with five fresh replays of the original failure.${removed} Untested durations are not claimed.`,
    delayStep,
    planned,
    notStarted,
    candidates,
    replays,
    elapsedMs,
    exhausted,
    ...(exhaustedReason !== undefined ? { exhaustedReason } : {}),
    additionalRemovedStepIds,
    stage3: stage3Copy,
  });
}

function idleClaim(originalMs: number, searchStatus: TimingSearchStatus, promotion: TimingPromotion): string {
  if (searchStatus === "runner-error") {
    return "A timing replay reported a reset failure. No tuned duration was verified. The original verified scenario is unchanged.";
  }
  if (searchStatus === "budget-exhausted") {
    return "The timing budget ended before a shorter duration was confirmed. The original verified scenario is unchanged.";
  }
  if (promotion === "unstable") {
    return "At least one timing candidate disagreed across fresh replays, and no shorter duration was confirmed. The original verified scenario is unchanged.";
  }
  return `No measured candidate shorter than ${originalMs}ms reproduced the original failure on every confirmation replay. The original verified scenario is unchanged.`;
}

function skipped(
  input: { scenario: Scenario },
  stage1: MinimizeReport,
  config: ResolvedTimingConfig,
  searchStatus: TimingSearchStatus,
  claim: string,
): DurationTunedResult {
  return assemble({
    input,
    stage1,
    config,
    exportScenario: input.scenario,
    report: stage1,
    searchStatus,
    promotion: "not-attempted",
    claim,
    planned: { coarse: [], fine: [] },
    notStarted: [],
    candidates: [],
    replays: [],
    elapsedMs: 0,
    exhausted: false,
    additionalRemovedStepIds: [],
  });
}

function assemble(input: {
  input: { scenario: Scenario };
  stage1: MinimizeReport;
  config: ResolvedTimingConfig;
  exportScenario: Scenario;
  report: MinimizeReport;
  searchStatus: TimingSearchStatus;
  promotion: TimingPromotion;
  claim: string;
  delayStep?: TimingDelayStep;
  planned: { coarse: number[]; fine: number[] };
  notStarted: number[];
  candidates: TimingCandidate[];
  replays: TimingReplay[];
  elapsedMs: number;
  exhausted: boolean;
  exhaustedReason?: BudgetExhaustedReason;
  additionalRemovedStepIds: string[];
  stage3?: MinimizeReport;
  skippedDelayStepIds?: string[];
}): DurationTunedResult {
  const stage3Replays = input.stage3?.replays.length ?? 0;
  const stage1Verified = input.stage1.status === "verified-one-minimal";
  const fullyVerified = input.promotion === "improved";
  const retainedOriginal = stage1Verified && !fullyVerified;
  return {
    kind: "duration-tuned",
    scenario: input.exportScenario,
    report: input.report,
    optimization: {
      requested: true,
      searchStatus: input.searchStatus,
      promotion: input.promotion,
      retainedOriginal,
      timingImproved: fullyVerified,
      fullyVerified,
      exportedScenario: fullyVerified ? "tuned" : "original",
      limitations: [...TIMING_LIMITATIONS],
      claim: input.claim,
      ...(input.skippedDelayStepIds !== undefined ? { skippedDelayStepIds: [...input.skippedDelayStepIds] } : {}),
      ...(input.delayStep !== undefined ? { delayStep: { ...input.delayStep } } : {}),
      plannedDurations: { coarse: [...input.planned.coarse], fine: [...input.planned.fine] },
      notStartedDurations: [...input.notStarted],
      candidates: input.candidates.map((candidate) => ({
        ...candidate,
        replayIds: [...candidate.replayIds],
        samples: candidate.samples.map((sample) => ({ ...sample })),
      })),
      replays: input.replays.map((replay) => ({ ...replay, stepIds: [...replay.stepIds] })),
      additionalRemovedStepIds: [...input.additionalRemovedStepIds],
      budget: {
        maxReplayExecutions: input.config.maxReplayExecutions,
        replayExecutions: input.replays.length,
        maxWallClockMs: input.config.maxWallClockMs,
        elapsedMs: input.elapsedMs,
        exhausted: input.exhausted,
        ...(input.exhaustedReason !== undefined ? { exhaustedReason: input.exhaustedReason } : {}),
        resolutionMs: input.config.resolutionMs,
        confirmRuns: input.config.confirmRuns,
        maxCoarseCandidates: input.config.maxCoarseCandidates,
        maxFineCandidates: input.config.maxFineCandidates,
      },
      stage1: input.stage1,
      ...(input.stage3 !== undefined ? { stage3: input.stage3 } : {}),
      totals: {
        replayExecutions: input.stage1.replays.length + input.replays.length + stage3Replays,
        stage1Replays: input.stage1.replays.length,
        timingReplays: input.replays.length,
        stage3Replays,
      },
    },
  };
}

function classifyCandidate(
  samples: readonly { classification: TimingSampleClass; outcome: ExecutionOutcome }[],
  confirmRuns: number,
  budgetStopped: boolean,
  resetFailed: boolean,
): TimingCandidateClassification {
  const first = samples[0];
  if (first === undefined) {
    return "incomplete";
  }
  const agreed = samples.every((sample) => outcomesAgree(first.outcome, sample.outcome));
  if (!agreed) {
    return "unstable";
  }
  if (first.classification === "target") {
    return samples.length >= confirmRuns ? "confirmed" : "incomplete";
  }
  if (samples.length >= confirmRuns || resetFailed) {
    return first.classification;
  }
  if (budgetStopped) {
    return "incomplete";
  }
  return "incomplete";
}

async function executeProbe(probe: Probe, stepIds: readonly string[]): Promise<ExecutionOutcome> {
  try {
    return normalizeOutcome(await probe([...stepIds]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return runnerError(0, message);
  }
}

function failureSignatureHeld(report: MinimizeReport, signature: TargetSignature): boolean {
  if (report.status !== "verified-one-minimal" || report.budget.exhausted) {
    return false;
  }
  if (report.baselineSignature === undefined || !signaturesEqual(report.baselineSignature, signature)) {
    return false;
  }
  const verify = report.replays.filter((replay) => replay.phase === "verify");
  if (verify.length !== 5 || report.counts.verifyReplays !== 5) {
    return false;
  }
  if (new Set(verify.map((replay) => replay.id)).size !== 5) {
    return false;
  }
  for (const replay of verify) {
    if (!sameIds(replay.stepIds, report.keptStepIds) || !failureMatches(replay.outcome, signature)) {
      return false;
    }
  }
  return singleDeletionHolds(report);
}

function singleDeletionHolds(report: MinimizeReport): boolean {
  if (report.keptStepIds.length === 0 || report.singleDeletion.length === 0) {
    return false;
  }
  const lastRound = report.singleDeletion.reduce((highest, entry) => Math.max(highest, entry.round), 0);
  const last = report.singleDeletion.filter((entry) => entry.round === lastRound);
  if (last.length !== report.keptStepIds.length) {
    return false;
  }
  const removed = new Set(last.map((entry) => entry.removedId));
  if (report.keptStepIds.some((id) => !removed.has(id))) {
    return false;
  }
  return last.every((entry) => entry.candidateClass !== "target");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function readClock(clock: () => number): number {
  const now = clock();
  if (!Number.isFinite(now)) {
    throw new ScenarioError("clock returned a non-finite time");
  }
  return now;
}
