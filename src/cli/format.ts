import type { MinimizeReport, MinimizeStatus } from "../core/types.ts";
import { EXIT, type ExitCode } from "./errors.ts";

export function exitCodeForStatus(status: MinimizeStatus): ExitCode {
  switch (status) {
    case "verified-one-minimal":
      return EXIT.verified;
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

export function formatSummary(input: {
  report: MinimizeReport;
  reportPath: string;
  specPath: string | undefined;
}): string {
  const removed = input.report.inputStepIds.filter((id) => !input.report.keptStepIds.includes(id));
  const signature = input.report.baselineSignature;
  const failure =
    signature === undefined
      ? "none"
      : `${signature.code} (email=${signature.facts.email}, actual=${signature.facts.actual}, expect=${signature.facts.expect})`;
  const lines = [
    `Status: ${input.report.status}`,
    `Result: ${input.report.claim}`,
    `Original steps: ${input.report.inputStepIds.length}`,
    `Kept steps: ${input.report.keptStepIds.length}`,
    `Removed steps: ${removed.length === 0 ? "none" : removed.join(", ")}`,
    `Failure: ${failure}`,
    `Replay executions: ${input.report.counts.replayExecutions}`,
    `  baseline: ${input.report.counts.baselineReplays}`,
    `  search: ${input.report.counts.searchReplays}`,
    `  verify: ${input.report.counts.verifyReplays}`,
    `Candidate evaluations: ${input.report.counts.candidateEvaluations}`,
    `Cache hits: ${input.report.counts.cacheHits}`,
    `Elapsed: ${input.report.budget.elapsedMs}ms`,
    `Report: ${input.reportPath}`,
    `Test: ${input.specPath ?? "not written"}`,
  ];
  if (input.specPath !== undefined) {
    lines.push("The regression test asserts the intended record count. This command does not run it.");
  } else {
    lines.push("Regression test was not written.");
  }
  return `${lines.join("\n")}\n`;
}
