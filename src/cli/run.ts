import { resolve } from "node:path";

import { cleanStateVerify } from "../core/clean-state.ts";
import type { MinimizeReport, MinimizeStatus, Scenario } from "../core/types.ts";
import { exportPlaywrightTest } from "../export/playwright.ts";
import { minimizeWithBrowser } from "../runner/minimize-browser.ts";
import { prepareReplay } from "../runner/plan.ts";
import { sanitizeArtifact } from "../runner/report.ts";
import { resetAndConfirmEmpty, ResetFailed } from "../runner/reset.ts";
import { ReplayTimeout } from "../runner/timing.ts";
import { CliError, EXIT } from "./errors.ts";
import { formatSummary } from "./format.ts";
import { assertCanReplace, ensureOutputDirectory, resolveOutputPath, writePublishedFile } from "./outputs.ts";
import { redactSecrets } from "./redact.ts";
import { loadScenarioFile } from "./scenario-file.ts";

const STATUSES = new Set<MinimizeStatus>([
  "verified-one-minimal",
  "unstable",
  "budget-exhausted",
  "flaky-baseline",
  "no-reproducible-failure",
]);

export type MinimizeRunner = (input: { scenario: Scenario }) => Promise<MinimizeReport>;
export type TargetPreflight = (scenario: Scenario) => Promise<void>;

export type MinimizeCommand = {
  scenarioPath: string;
  reportPath: string;
  specPath: string;
  force: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  minimize?: MinimizeRunner;
  preflight?: TargetPreflight;
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
  const scenarioPath = resolve(input.cwd, input.scenarioPath);
  if (scenarioPath === reportPath || scenarioPath === specPath) {
    throw new CliError("output path must not replace the scenario file", EXIT.usage);
  }
  await assertCanReplace(reportPath, input.force);
  await assertCanReplace(specPath, input.force);
  await ensureOutputDirectory(reportPath);
  await ensureOutputDirectory(specPath);

  stderr(`Checking ${scenario.target.origin} for app ${scenario.target.appId}.\n`);
  await (input.preflight ?? preflightTarget)(scenario);

  stderr(`Minimizing ${scenario.steps.length} steps. This runs in Chromium and can take several minutes.\n`);
  let report: MinimizeReport;
  try {
    report = await (input.minimize ?? defaultMinimize)({ scenario });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "minimizer failed", EXIT.internal);
  }

  assertReportShape(report);
  const verified = report.status === "verified-one-minimal";
  let specSource: string | undefined;
  let exportFailure: unknown;
  if (verified) {
    try {
      specSource = exportPlaywrightTest(scenario, report);
      assertClean(specSource, scenario, "regression test");
    } catch (error) {
      exportFailure = error;
      specSource = undefined;
    }
  }

  const artifact = sanitizeArtifact(scenario, report);
  const reportText = `${JSON.stringify(artifact, null, 2)}\n`;
  assertClean(reportText, scenario, "report");
  await writePublishedFile(reportPath, reportText, input.force);

  if (exportFailure !== undefined) {
    stdout(formatSummary({ report, reportPath, specPath: undefined }));
    throw new CliError(
      exportFailure instanceof Error ? exportFailure.message : "regression test could not be generated",
      EXIT.internal,
    );
  }
  if (specSource !== undefined) {
    try {
      await writePublishedFile(specPath, specSource, input.force);
    } catch (error) {
      stdout(formatSummary({ report, reportPath, specPath: undefined }));
      if (error instanceof CliError) {
        throw error;
      }
      throw new CliError(error instanceof Error ? error.message : "regression test could not be written", EXIT.internal);
    }
  }

  stdout(formatSummary({ report, reportPath, specPath: specSource !== undefined ? specPath : undefined }));
  if (!verified && input.force) {
    stderr("Existing spec was not replaced because minimization did not verify.\n");
  }
  return exitCodeForVerified(report.status, specSource !== undefined);
}

async function defaultMinimize(input: { scenario: Scenario }): Promise<MinimizeReport> {
  return minimizeWithBrowser({ scenario: input.scenario });
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
