import { assertBudget } from "../core/budget.ts";
import { cleanStateVerify } from "../core/clean-state.ts";
import { assertScenario, findMissingDependencies, orderIds } from "../core/dependencies.ts";
import { signaturesEqual } from "../core/signature.ts";
import type { DuplicateSignature, DomMismatchSignature, ExecutionOutcome, MinimizeReport, Scenario, Signature, Step } from "../core/types.ts";
import { normalizeDomText } from "../runner/dom-text.ts";
import { ExportError } from "./export-error.ts";
import { authorizedUrl, assertLoopbackHttpOrigin } from "./runtime-config.ts";

export type VerifiedExport = {
  steps: Step[];
  expectCount: number;
  timeoutMs: number;
};

/**
 * A regression spec is exported only from a verified 1-minimal report whose five
 * final runs reproduced one known oracle failure. The kept steps come from the
 * original scenario, in scenario order. The spec asserts the intended result,
 * not the observed failure.
 */
export function selectVerifiedExport(scenario: Scenario, report: MinimizeReport): VerifiedExport {
  try {
    assertScenario(scenario);
    assertBudget(scenario.budget);
  } catch (error) {
    throw new ExportError(error instanceof Error ? error.message : String(error));
  }

  let origin: string;
  try {
    origin = assertLoopbackHttpOrigin(scenario.target.origin);
  } catch (error) {
    throw new ExportError(error instanceof Error ? error.message : String(error));
  }

  if (report === null || typeof report !== "object") {
    throw new ExportError("minimize report is incomplete");
  }
  if (report.status !== "verified-one-minimal") {
    throw new ExportError(`refusing to export a regression test from ${String(report.status)}`);
  }
  if (report.budget === undefined || report.counts === undefined) {
    throw new ExportError("minimize report is incomplete");
  }
  if (report.budget.exhausted) {
    throw new ExportError("refusing to export a regression test from an exhausted budget");
  }
  if (!Array.isArray(report.replays) || !Array.isArray(report.inputStepIds) || !Array.isArray(report.keptStepIds)) {
    throw new ExportError("minimize report is incomplete");
  }
  if (report.keptStepIds.length === 0) {
    throw new ExportError("verified report did not keep any steps");
  }

  const signature = requireBaseline(scenario, report);
  const inputIds = scenario.steps.map((step) => step.id);
  if (!sameIds(report.inputStepIds, inputIds)) {
    throw new ExportError("report input steps do not match the scenario");
  }
  assertIndependentReplays(report.replays);

  const baselineReplays = report.replays.filter((replay) => replay.phase === "baseline");
  if (baselineReplays.length < 2 || baselineReplays.length !== scenario.budget.baselineRuns) {
    throw new ExportError("baseline failure is not known");
  }
  for (const replay of baselineReplays) {
    if (!Array.isArray(replay.stepIds) || !sameIds(replay.stepIds, inputIds) || !failedWith(replay.outcome, signature)) {
      throw new ExportError("baseline failure is not known");
    }
  }

  let ordered: string[];
  try {
    ordered = orderIds(scenario.steps, report.keptStepIds);
  } catch (error) {
    throw new ExportError(error instanceof Error ? error.message : String(error));
  }
  if (!sameIds(ordered, report.keptStepIds)) {
    throw new ExportError("kept steps are not in scenario order");
  }
  const missing = findMissingDependencies(scenario.steps, ordered);
  if (missing.length > 0) {
    const detail = missing.map((item) => `${item.stepId} needs ${item.dependsOn}`).join(", ");
    throw new ExportError(`kept steps are missing dependencies: ${detail}`);
  }

  const verifyReplays = report.replays.filter((replay) => replay.phase === "verify");
  if (verifyReplays.length !== 5 || report.counts.verifyReplays !== 5) {
    throw new ExportError("five independent final verification executions are required");
  }
  for (const replay of verifyReplays) {
    if (!Array.isArray(replay.stepIds) || !sameIds(replay.stepIds, ordered)) {
      throw new ExportError("verification did not execute the kept steps");
    }
    if (!failedWith(replay.outcome, signature)) {
      throw new ExportError("verification did not reproduce the baseline failure");
    }
  }

  const steps = ordered.map((id) => {
    const step = scenario.steps.find((candidate) => candidate.id === id);
    if (step === undefined) {
      throw new ExportError(`unknown step in subset: ${id}`);
    }
    return step;
  });
  assertSupportedSteps(origin, scenario, steps);
  return {
    steps,
    expectCount: scenario.oracle.id === "record-count" ? scenario.oracle.expect : 0,
    timeoutMs: testTimeoutMs(scenario, steps),
  };
}

function requireBaseline(scenario: Scenario, report: MinimizeReport): Signature {
  if (scenario.oracle.id === "dom-text") {
    return requireDomBaseline(scenario, report);
  }
  return requireRecordBaseline(scenario, report);
}

function requireRecordBaseline(scenario: Scenario, report: MinimizeReport): DuplicateSignature {
  const signature = report.baselineSignature;
  if (
    signature === undefined ||
    signature.oracleId !== "record-count" ||
    (signature.code !== "DUPLICATE" && signature.code !== "COUNT_MISMATCH") ||
    signature.facts === undefined ||
    typeof signature.facts.email !== "string" ||
    typeof signature.facts.actual !== "number" ||
    typeof signature.facts.expect !== "number"
  ) {
    throw new ExportError("baseline failure is not known");
  }
  if (!Number.isFinite(signature.facts.actual) || !Number.isFinite(signature.facts.expect)) {
    throw new ExportError("baseline failure is not known");
  }
  if (scenario.oracle.id !== "record-count") {
    throw new ExportError("baseline failure does not match the scenario oracle");
  }
  if (signature.facts.email !== scenario.oracle.match.value || signature.facts.expect !== scenario.oracle.expect) {
    throw new ExportError("baseline failure does not match the scenario oracle");
  }
  if (signature.facts.actual === signature.facts.expect) {
    throw new ExportError("baseline failure does not differ from the intended record count");
  }
  const code = signature.facts.actual > signature.facts.expect ? "DUPLICATE" : "COUNT_MISMATCH";
  if (signature.code !== code) {
    throw new ExportError("baseline failure code does not match the observed count");
  }
  return signature;
}

function requireDomBaseline(scenario: Scenario, report: MinimizeReport): DomMismatchSignature {
  const signature = report.baselineSignature;
  if (
    signature === undefined ||
    signature.oracleId !== "dom-text" ||
    signature.code !== "DOM_MISMATCH" ||
    signature.facts === undefined ||
    typeof signature.facts.selector !== "string" ||
    typeof signature.facts.expect !== "string" ||
    typeof signature.facts.actual !== "string"
  ) {
    throw new ExportError("baseline failure is not known");
  }
  if (scenario.oracle.id !== "dom-text") {
    throw new ExportError("baseline failure does not match the scenario oracle");
  }
  if (signature.facts.selector !== scenario.oracle.selector || signature.facts.expect !== normalizeDomText(scenario.oracle.expect)) {
    throw new ExportError("baseline failure does not match the scenario oracle");
  }
  if (signature.facts.actual === signature.facts.expect) {
    throw new ExportError("baseline failure does not differ from the intended result text");
  }
  return signature;
}

function assertIndependentReplays(replays: MinimizeReport["replays"]): void {
  const seen = new Set<number>();
  for (const replay of replays) {
    if (replay === null || typeof replay !== "object" || !Number.isSafeInteger(replay.id) || replay.id <= 0 || seen.has(replay.id)) {
      throw new ExportError("replay executions are not independent");
    }
    seen.add(replay.id);
  }
}

function assertSupportedSteps(origin: string, scenario: Scenario, steps: readonly Step[]): void {
  if (scenario.oracle.id === "record-count") {
    assertStaysOnOrigin(origin, scenario.oracle.request.path, "oracle path");
  }
  assertStaysOnOrigin(origin, cleanStateVerify(scenario.reset).path, "clean-state path");
  assertStaysOnOrigin(origin, "/__reproseed/reset", "reset path");
  assertStaysOnOrigin(origin, "/__reproseed/identity", "identity path");
  for (const step of steps) {
    switch (step.kind) {
      case "goto":
        assertStaysOnOrigin(origin, step.path, step.id);
        break;
      case "fill":
      case "click":
      case "wait":
        break;
      case "delay":
        if (step.method !== "GET" && step.method !== "POST") {
          throw new ExportError(`unsupported delay method for ${step.id}`);
        }
        break;
      default: {
        const unsupported = step as { id?: string; kind?: string };
        throw new ExportError(`unsupported step ${unsupported.kind ?? unsupported.id ?? "unknown"}`);
      }
    }
  }
}

function assertStaysOnOrigin(origin: string, path: string, label: string): void {
  try {
    authorizedUrl(origin, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExportError(`${label} must stay on the authorized origin (${message})`);
  }
}

function testTimeoutMs(scenario: Scenario, steps: readonly Step[]): number {
  let activity = 0;
  for (const step of steps) {
    if (step.kind === "wait" || step.kind === "delay") {
      activity += step.ms;
    }
  }
  const timeout = Math.max(scenario.budget.attemptTimeoutMs, Math.ceil(activity) + 10_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new ExportError("scenario timeout cannot be represented as a Playwright test timeout");
  }
  return timeout;
}

function failedWith(outcome: ExecutionOutcome | undefined, signature: Signature): boolean {
  if (outcome === undefined || outcome.status !== "fail") {
    return false;
  }
  return signaturesEqual(outcome.signature, signature);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
