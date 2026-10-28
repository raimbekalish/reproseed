import { isTargetSignature, signaturesEqual } from "../core/signature.ts";
import type { ExecutionOutcome, TargetSignature } from "../core/types.ts";

/**
 * Passed to BrowserContext.tracing.start for the one evidence replay.
 * `sources` stays off so the zip does not embed local source files.
 * The title is fixed and never carries the reset credential or form values.
 */
export const TRACE_START_OPTIONS = {
  screenshots: true,
  snapshots: true,
  sources: false,
  title: "ReproSeed evidence",
} as const;

export type TraceEvidenceStatus = "verified" | "not-reproduced" | "failed";

export type TraceEvidence = {
  status: TraceEvidenceStatus;
  detail: string;
};

/**
 * A saved trace is verified only when this extra replay failed with the same
 * target signature the minimization already verified. A pass, a different
 * target failure, or a runner failure is not verified evidence.
 */
export function classifyTraceEvidence(input: {
  target: TargetSignature | undefined;
  outcome: ExecutionOutcome;
  traceSaved: boolean;
}): TraceEvidence {
  if (!input.traceSaved) {
    const reason = input.outcome.status === "error" || input.outcome.status === "timeout" ? input.outcome.error : undefined;
    return {
      status: "failed",
      detail: reason === undefined || reason === "" ? "the trace file was not saved" : reason,
    };
  }
  if (input.outcome.status === "error" || input.outcome.status === "timeout") {
    const reason = input.outcome.error;
    return {
      status: "failed",
      detail: reason === undefined || reason === "" ? input.outcome.status : reason,
    };
  }
  if (input.target === undefined) {
    return { status: "failed", detail: "the verified report has no target signature" };
  }
  if (input.outcome.status === "pass") {
    return { status: "not-reproduced", detail: "the extra replay passed the oracle" };
  }
  if (isTargetSignature(input.outcome.signature) && signaturesEqual(input.outcome.signature, input.target)) {
    return { status: "verified", detail: "the extra replay reproduced the verified failure" };
  }
  return { status: "not-reproduced", detail: "the extra replay failed with a different signature" };
}

export function formatTraceEvidence(evidence: TraceEvidence, tracePath: string): string {
  const lines = [`Trace evidence: ${evidence.status}`, evidence.detail];
  if (evidence.status === "failed") {
    lines.push("The minimization report and regression test were left in place. The requested trace file was not written.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Trace: ${tracePath}`);
  if (evidence.status === "verified") {
    lines.push("This replay is separate from the five verification replays and is omitted from the replay counts.");
    lines.push(`Open it with: npx playwright show-trace ${tracePath}`);
  } else {
    lines.push("This file is not verified evidence of the minimized failure.");
  }
  return `${lines.join("\n")}\n`;
}

export function formatSkippedTrace(reason: string): string {
  return `Trace evidence was skipped because ${reason} No trace file was written.\n`;
}
