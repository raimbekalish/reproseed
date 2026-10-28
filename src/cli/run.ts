import { lstat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { cleanStateVerify } from "../core/clean-state.ts";
import type { DurationOptimization, TimingSearchConfig } from "../core/duration.ts";
import type { ExecutionOutcome, MinimizeReport, MinimizeStatus, Scenario, TargetSignature } from "../core/types.ts";
import { exportPlaywrightTest } from "../export/playwright.ts";
import { minimizeWithBrowser } from "../runner/minimize-browser.ts";
import { isDurationTunedResult, type DurationTunedResult } from "../runner/minimize-duration.ts";
import { prepareReplay } from "../runner/plan.ts";
import { sanitizeArtifact } from "../runner/report.ts";
import { replayIsolated } from "../runner/replay.ts";
import { resetAndConfirmEmpty, ResetFailed } from "../runner/reset.ts";
import { ReplayTimeout } from "../runner/timing.ts";
import {
  classifyTraceEvidence,
  formatSkippedTrace,
  formatTraceEvidence,
  type TraceEvidence,
} from "../runner/trace-evidence.ts";
import { CliError, EXIT, isNodeError } from "./errors.ts";
import { formatSummary } from "./format.ts";
import {
  assertCanReplace,
  ensureOutputDirectory,
  publishExistingFile,
  resolveOutputPath,
  writePublishedFile,
} from "./outputs.ts";
import { redactSecrets } from "./redact.ts";
import { loadScenarioFile } from "./scenario-file.ts";

const STATUSES = new Set<MinimizeStatus>([
  "verified-one-minimal",
  "unstable",
  "budget-exhausted",
  "flaky-baseline",
  "no-reproducible-failure",
]);

export type MinimizeRunner = (input: {
  scenario: Scenario;
  tuneDelays?: TimingSearchConfig;
}) => Promise<MinimizeReport | DurationTunedResult>;
export type TargetPreflight = (scenario: Scenario) => Promise<void>;
export type TraceCapture = (input: {
  scenario: Scenario;
  stepIds: readonly string[];
  tracePath: string;
}) => Promise<{ outcome: ExecutionOutcome; traceSaved: boolean; traceError?: string }>;

export type MinimizeCommand = {
  scenarioPath: string;
  reportPath: string;
  specPath: string;
  tracePath?: string;
  force: boolean;
  tuneDelays?: TimingSearchConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  minimize?: MinimizeRunner;
  preflight?: TargetPreflight;
  captureTrace?: TraceCapture;
};

/**
 * Loads the scenario, checks the local target, minimizes with Chromium, then writes artifacts.
 * The Playwright spec is generated only from a verified report from this same run.
 */
export async function runMinimizeCommand(input: MinimizeCommand): Promise<number> {
  const scenario = await loadScenarioFile(input.scenarioPath, input.cwd, input.env);
  const secret = scenario.target.resetAuthorization;
  const stdout = (text: string): void => input.stdout(redactSecrets(text, [secret]));
  const stderr = (text: string): void => input.stderr(redactSecrets(text, [secret]));

  try {
    prepareReplay(scenario, scenario.steps.map((step) => step.id));
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "scenario cannot be replayed", EXIT.usage);
  }

  const reportPath = await resolveOutputPath(input.cwd, input.reportPath, "report");
  const specPath = await resolveOutputPath(input.cwd, input.specPath, "spec");
  const tracePath =
    input.tracePath === undefined ? undefined : await resolveOutputPath(input.cwd, input.tracePath, "trace");
  const scenarioPath = resolve(input.cwd, input.scenarioPath);
  if (scenarioPath === reportPath || scenarioPath === specPath || (tracePath !== undefined && scenarioPath === tracePath)) {
    throw new CliError("output path must not replace the scenario file", EXIT.usage);
  }
  if (tracePath !== undefined && (tracePath === reportPath || tracePath === specPath)) {
    throw new CliError("trace path must not replace the report or spec", EXIT.usage);
  }
  await assertCanReplace(reportPath, input.force);
  await assertCanReplace(specPath, input.force);
  if (tracePath !== undefined) {
    await assertCanReplace(tracePath, input.force);
  }
  await ensureOutputDirectory(reportPath);
  await ensureOutputDirectory(specPath);
  if (tracePath !== undefined) {
    await ensureOutputDirectory(tracePath);
  }

  stderr(`Checking ${scenario.target.origin} for app ${scenario.target.appId}.\n`);
  await (input.preflight ?? preflightTarget)(scenario);

  stderr(`Minimizing ${scenario.steps.length} steps. This runs in Chromium and can take several minutes.\n`);
  if (input.tuneDelays !== undefined) {
    stderr(
      `Delay tuning is on. Resolution ${input.tuneDelays.resolutionMs}ms, at most ${input.tuneDelays.maxReplayExecutions} timing replays and ${input.tuneDelays.maxWallClockMs}ms.\n`,
    );
  }
  let report: MinimizeReport;
  let exportScenario = scenario;
  let optimization: DurationOptimization | undefined;
  try {
    const result = await (input.minimize ?? defaultMinimize)({
      scenario,
      ...(input.tuneDelays !== undefined ? { tuneDelays: input.tuneDelays } : {}),
    });
    if (isDurationTunedResult(result)) {
      report = result.report;
      exportScenario = result.scenario;
      optimization = result.optimization;
    } else {
      report = result;
    }
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "minimizer failed", EXIT.internal);
  }
  if (input.tuneDelays !== undefined && optimization === undefined) {
    throw new CliError("delay tuning did not return a timing report", EXIT.internal);
  }

  assertReportShape(report);
  if (optimization !== undefined) {
    assertOptimization(optimization, report);
  }
  const verified = report.status === "verified-one-minimal";
  let specSource: string | undefined;
  let exportFailure: unknown;
  if (verified) {
    try {
      specSource = exportPlaywrightTest(exportScenario, report);
      assertClean(specSource, exportScenario, "regression test");
    } catch (error) {
      exportFailure = error;
      specSource = undefined;
    }
  }

  const artifact = sanitizeArtifact(exportScenario, report, optimization);
  const reportText = `${JSON.stringify(artifact, null, 2)}\n`;
  assertClean(reportText, scenario, "report");
  await writePublishedFile(reportPath, reportText, input.force);

  if (exportFailure !== undefined) {
    stdout(formatSummary({ report, reportPath, specPath: undefined, ...(optimization !== undefined ? { optimization } : {}) }));
    if (tracePath !== undefined) {
      stderr(formatSkippedTrace("the regression test was not written."));
    }
    throw new CliError(
      exportFailure instanceof Error ? exportFailure.message : "regression test could not be generated",
      EXIT.internal,
    );
  }
  if (specSource !== undefined) {
    try {
      await writePublishedFile(specPath, specSource, input.force);
    } catch (error) {
      stdout(formatSummary({ report, reportPath, specPath: undefined, ...(optimization !== undefined ? { optimization } : {}) }));
      if (tracePath !== undefined) {
        stderr(formatSkippedTrace("the regression test was not written."));
      }
      if (error instanceof CliError) {
        throw error;
      }
      throw new CliError(error instanceof Error ? error.message : "regression test could not be written", EXIT.internal);
    }
  }

  stdout(formatSummary({ report, reportPath, specPath: specSource !== undefined ? specPath : undefined, ...(optimization !== undefined ? { optimization } : {}) }));
  if (!verified && input.force) {
    stderr("Existing spec was not replaced because minimization did not verify.\n");
  }
  if (tracePath !== undefined) {
    if (!verified || specSource === undefined) {
      stderr(formatSkippedTrace("this run did not write a verified regression test."));
    } else {
      await recordTraceEvidence({
        scenario: exportScenario,
        report,
        tracePath,
        force: input.force,
        stdout,
        stderr,
        capture: input.captureTrace ?? defaultCapture,
      });
    }
  }
  return exitCodeForVerified(report.status, specSource !== undefined);
}

async function recordTraceEvidence(input: {
  scenario: Scenario;
  report: MinimizeReport;
  tracePath: string;
  force: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  capture: TraceCapture;
}): Promise<void> {
  const temp = join(dirname(input.tracePath), `.reproseed-trace-${process.pid}-${Date.now()}.zip`);
  try {
    const captured = await input.capture({
      scenario: input.scenario,
      stepIds: input.report.keptStepIds,
      tracePath: temp,
    });
    const evidence = classifyTraceEvidence({
      target: targetSignature(input.report),
      outcome: captured.outcome,
      traceSaved: captured.traceSaved,
    });
    if (evidence.status === "failed") {
      await reportFailedTrace(temp, input.tracePath, evidenceFromCapture(evidence, captured.traceError).detail, input.stderr);
      return;
    }
    await publishExistingFile(temp, input.tracePath, input.force);
    input.stdout(formatTraceEvidence(evidence, input.tracePath));
    if (evidence.status === "not-reproduced") {
      input.stderr(
        "Trace evidence: not-reproduced. The extra replay did not reproduce the verified failure. The minimization report and regression test were left unchanged.\n",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "trace capture failed";
    await reportFailedTrace(temp, input.tracePath, message, input.stderr);
  }
}

async function reportFailedTrace(
  temp: string,
  tracePath: string,
  detail: string,
  stderr: (text: string) => void,
): Promise<void> {
  if (temp !== tracePath) {
    await unlink(temp).catch(() => undefined);
  }
  stderr(formatTraceEvidence({ status: "failed", detail }, tracePath, { priorTraceRemains: await priorTraceRemains(tracePath) }));
}

async function priorTraceRemains(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch (error) {
    return !isNodeError(error, "ENOENT");
  }
}

function evidenceFromCapture(evidence: TraceEvidence, traceError: string | undefined): TraceEvidence {
  if (traceError === undefined || traceError === "" || evidence.detail.includes(traceError)) {
    return evidence;
  }
  return { status: "failed", detail: `${evidence.detail} (${traceError})` };
}

function targetSignature(report: MinimizeReport): TargetSignature | undefined {
  const signature = report.baselineSignature;
  if (signature === undefined) {
    return undefined;
  }
  if (signature.oracleId === "record-count" || signature.oracleId === "dom-text") {
    return signature;
  }
  return undefined;
}

async function defaultCapture(input: {
  scenario: Scenario;
  stepIds: readonly string[];
  tracePath: string;
}): Promise<{ outcome: ExecutionOutcome; traceSaved: boolean; traceError?: string }> {
  return replayIsolated({
    scenario: input.scenario,
    stepIds: input.stepIds,
    tracePath: input.tracePath,
  });
}

async function defaultMinimize(input: {
  scenario: Scenario;
  tuneDelays?: TimingSearchConfig;
}): Promise<MinimizeReport | DurationTunedResult> {
  if (input.tuneDelays === undefined) {
    return minimizeWithBrowser({ scenario: input.scenario });
  }
  return minimizeWithBrowser({ scenario: input.scenario, tuneDelays: input.tuneDelays });
}

async function preflightTarget(scenario: Scenario): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await resetAndConfirmEmpty({
      origin: scenario.target.origin,
      expectedAppId: scenario.target.appId,
      resetAuthorization: scenario.target.resetAuthorization,
      verify: cleanStateVerify(scenario.reset),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof ResetFailed || error instanceof ReplayTimeout) {
      throw new CliError(error.message, EXIT.usage);
    }
    throw new CliError(error instanceof Error ? error.message : "target check failed", EXIT.usage);
  } finally {
    clearTimeout(timer);
  }
}

function assertReportShape(report: MinimizeReport): void {
  if (!STATUSES.has(report.status)) {
    throw new CliError("minimizer returned an unknown status", EXIT.internal);
  }
  const counts = report.counts;
  if (
    counts === undefined ||
    !Array.isArray(report.replays) ||
    !Array.isArray(report.inputStepIds) ||
    !Array.isArray(report.keptStepIds) ||
    counts.replayExecutions !== counts.baselineReplays + counts.searchReplays + counts.verifyReplays ||
    report.replays.length !== counts.replayExecutions
  ) {
    throw new CliError("minimizer report counts do not match its replays", EXIT.internal);
  }
  const verify = report.replays.filter((replay) => replay.phase === "verify").length;
  if (verify !== counts.verifyReplays) {
    throw new CliError("minimizer verification count does not match its replays", EXIT.internal);
  }
  if (report.status === "verified-one-minimal" && counts.verifyReplays !== 5) {
    throw new CliError("verified result did not record five final replays", EXIT.internal);
  }
  if (!Number.isFinite(report.budget.elapsedMs) || report.budget.elapsedMs < 0) {
    throw new CliError("minimizer elapsed time is not usable", EXIT.internal);
  }
}

function assertOptimization(optimization: DurationOptimization, report: MinimizeReport): void {
  const stage3Replays = optimization.stage3?.replays.length ?? 0;
  if (
    optimization.totals.stage1Replays !== optimization.stage1.replays.length ||
    optimization.totals.timingReplays !== optimization.replays.length ||
    optimization.totals.stage3Replays !== stage3Replays ||
    optimization.totals.replayExecutions !== optimization.stage1.replays.length + optimization.replays.length + stage3Replays ||
    optimization.budget.replayExecutions !== optimization.replays.length
  ) {
    throw new CliError("timing report replay totals do not add up", EXIT.internal);
  }
  if (optimization.timingImproved !== optimization.fullyVerified || optimization.promotion === "improved" !== optimization.fullyVerified) {
    throw new CliError("timing verification flags disagree", EXIT.internal);
  }
  if (optimization.fullyVerified && optimization.retainedOriginal) {
    throw new CliError("timing fallback flags disagree", EXIT.internal);
  }
  if (optimization.fullyVerified) {
    if (
      optimization.exportedScenario !== "tuned" ||
      optimization.stage3 === undefined ||
      report.status !== "verified-one-minimal" ||
      !sameIds(report.keptStepIds, optimization.stage3.keptStepIds) ||
      report.counts.replayExecutions !== optimization.stage3.counts.replayExecutions
    ) {
      throw new CliError("tuned result does not match the renewed verification report", EXIT.internal);
    }
  } else if (optimization.exportedScenario !== "original" || !sameIds(report.inputStepIds, optimization.stage1.inputStepIds) || report.status !== optimization.stage1.status) {
    throw new CliError("retained report does not match the original step minimization", EXIT.internal);
  }
  if (!Number.isFinite(optimization.budget.elapsedMs) || optimization.budget.elapsedMs < 0) {
    throw new CliError("timing elapsed time is not usable", EXIT.internal);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function assertClean(contents: string, scenario: Scenario, label: string): void {
  const secret = scenario.target.resetAuthorization;
  if (secret.length >= 8 && contents.includes(secret)) {
    throw new CliError(`refusing to write the ${label} because it contains the reset authorization`, EXIT.internal);
  }
  if (label === "regression test" && contents.includes(scenario.target.origin)) {
    throw new CliError("refusing to write the regression test because it contains the origin", EXIT.internal);
  }
}

function exitCodeForVerified(status: MinimizeStatus, wroteSpec: boolean): number {
  if (status === "verified-one-minimal") {
    return wroteSpec ? EXIT.verified : EXIT.internal;
  }
  switch (status) {
    case "unstable":
    case "flaky-baseline":
    case "no-reproducible-failure":
      return EXIT.unstable;
    case "budget-exhausted":
      return EXIT.budget;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}
