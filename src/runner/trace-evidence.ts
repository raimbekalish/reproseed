import { unlink } from "node:fs/promises";

import { isTargetSignature, signaturesEqual } from "../core/signature.ts";
import type { ExecutionOutcome, TargetSignature } from "../core/types.ts";
import { errorMessage } from "./timing.ts";

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

/**
 * Waits for one Playwright `tracing.stop` call.
 * The budget marks the save as failed, but the same promise is still awaited
 * before this function returns. Playwright does not accept a cancellation
 * signal, so a late zip is deleted after that call settles instead of being
 * abandoned on disk.
 */
export async function settleTraceSave(input: {
  stop: () => Promise<void>;
  path: string;
  budgetMs: number;
}): Promise<{ saved: boolean; error?: string }> {
  const save = Promise.resolve()
    .then(() => input.stop())
    .then(
      () => ({ kind: "saved" }) as const,
      (error: unknown) => ({ kind: "failed", error: errorMessage(error) }) as const,
    );
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), input.budgetMs);
  });
  const winner = await Promise.race([save, budget]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (winner.kind === "saved") {
    return { saved: true };
  }
  const late = winner.kind === "timeout" ? await save : winner;
  const removed = await removeTraceFile(input.path);
  const detail =
    winner.kind === "timeout"
      ? `trace save timed out (${late.kind === "saved" ? "trace save finished after the cleanup budget" : late.error})`
      : winner.error;
  if (removed !== undefined) {
    return { saved: false, error: `${detail}; temporary trace remains at ${input.path}: ${removed}` };
  }
  return { saved: false, error: detail };
}

async function removeTraceFile(path: string): Promise<string | undefined> {
  try {
    await unlink(path);
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    return errorMessage(error);
  }
}

export function formatTraceEvidence(
  evidence: TraceEvidence,
  tracePath: string,
  options?: { priorTraceRemains?: boolean },
): string {
  const lines = [`Trace evidence: ${evidence.status}`, evidence.detail];
  if (evidence.status === "failed") {
    lines.push("The minimization report and regression test were left in place.");
    if (options?.priorTraceRemains === true) {
      lines.push(
        `The trace at ${tracePath} was left unchanged from an earlier run. It may be stale and is not verified evidence for this run.`,
      );
    } else {
      lines.push("The requested trace file was not written.");
    }
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
