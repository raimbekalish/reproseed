import type {
  DuplicateSignature,
  ExecutionOutcome,
  Signature,
  TargetSignature,
} from "./types.ts";

export type ConfirmedClass = "pass" | "target" | "other" | "error" | "timeout";

export function isDuplicateSignature(value: Signature): value is DuplicateSignature {
  return value.oracleId === "record-count";
}

export function isTargetSignature(value: Signature): value is TargetSignature {
  return value.oracleId === "record-count" || value.oracleId === "dom-text";
}

export function signaturesEqual(left: Signature, right: Signature): boolean {
  if (left.oracleId !== right.oracleId || left.code !== right.code) {
    return false;
  }
  if (left.oracleId === "record-count" && right.oracleId === "record-count") {
    return (
      left.facts.email === right.facts.email &&
      left.facts.actual === right.facts.actual &&
      left.facts.expect === right.facts.expect
    );
  }
  if (left.oracleId === "dom-text" && right.oracleId === "dom-text") {
    return (
      left.facts.selector === right.facts.selector &&
      left.facts.expect === right.facts.expect &&
      left.facts.actual === right.facts.actual
    );
  }
  if (left.oracleId === "runner" && right.oracleId === "runner") {
    return left.facts.message === right.facts.message;
  }
  return false;
}

export function runnerError(durationMs: number, message: string): ExecutionOutcome {
  return {
    status: "error",
    durationMs,
    error: message,
    signature: {
      oracleId: "runner",
      code: "RUNNER_ERROR",
      facts: { message },
    },
  };
}

function finiteDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function isSignature(value: Signature | undefined): value is Signature {
  if (value === undefined) {
    return false;
  }
  if (value.oracleId === "record-count") {
    return (
      (value.code === "DUPLICATE" || value.code === "COUNT_MISMATCH") &&
      typeof value.facts.email === "string" &&
      Number.isFinite(value.facts.actual) &&
      Number.isFinite(value.facts.expect)
    );
  }
  if (value.oracleId === "dom-text") {
    return (
      value.code === "DOM_MISMATCH" &&
      typeof value.facts.selector === "string" &&
      value.facts.selector.trim() !== "" &&
      typeof value.facts.expect === "string" &&
      typeof value.facts.actual === "string"
    );
  }
  return (
    (value.code === "TIMEOUT" || value.code === "RUNNER_ERROR" || value.code === "RESET_FAILED") &&
    typeof value.facts.message === "string"
  );
}

/** Turns a missing or unusable probe payload into a runner error. */
export function normalizeOutcome(input: ExecutionOutcome): ExecutionOutcome {
  const durationMs = finiteDuration(input.durationMs);
  if (input.status === "pass") {
    return { status: "pass", durationMs };
  }
  if (input.status === "fail") {
    if (!isSignature(input.signature)) {
      return runnerError(durationMs, "Probe returned a failure without a usable signature");
    }
    return { status: "fail", durationMs, signature: input.signature };
  }
  if (input.status === "timeout") {
    const signature = isSignature(input.signature)
      ? input.signature
      : {
          oracleId: "runner" as const,
          code: "TIMEOUT" as const,
          facts: { message: input.error ?? "attempt timed out" },
        };
    return input.error === undefined
      ? { status: "timeout", durationMs, signature }
      : { status: "timeout", durationMs, signature, error: input.error };
  }
  if (input.status === "error") {
    const signature = isSignature(input.signature)
      ? input.signature
      : {
          oracleId: "runner" as const,
          code: "RUNNER_ERROR" as const,
          facts: { message: input.error ?? "runner error" },
        };
    return input.error === undefined
      ? { status: "error", durationMs, signature }
      : { status: "error", durationMs, signature, error: input.error };
  }
  return runnerError(durationMs, "Probe returned an unknown status");
}

/**
 * Agreement is about the outcome class, not timings.
 * Two timeouts agree even when their messages differ. Two failures agree only
 * when their signatures are equal. A timeout never agrees with a failure.
 */
export function outcomesAgree(left: ExecutionOutcome, right: ExecutionOutcome): boolean {
  if (left.status !== right.status) {
    return false;
  }
  if (left.status === "pass" && right.status === "pass") {
    return true;
  }
  if ((left.status === "timeout" && right.status === "timeout") || (left.status === "error" && right.status === "error")) {
    return true;
  }
  if (left.status === "fail" && right.status === "fail") {
    return signaturesEqual(left.signature, right.signature);
  }
  return false;
}

export function outcomeSignature(outcome: ExecutionOutcome): Signature | undefined {
  if (outcome.status === "pass") {
    return undefined;
  }
  return outcome.signature;
}

/** Timeouts and runner errors are never the target, even if a signature happens to match. */
export function classifyOutcome(outcome: ExecutionOutcome, baseline: TargetSignature): ConfirmedClass {
  switch (outcome.status) {
    case "pass":
      return "pass";
    case "timeout":
      return "timeout";
    case "error":
      return "error";
    case "fail":
      return isTargetSignature(outcome.signature) && signaturesEqual(outcome.signature, baseline) ? "target" : "other";
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function oracleFailureSignature(outcome: ExecutionOutcome): TargetSignature | undefined {
  if (outcome.status !== "fail" || !isTargetSignature(outcome.signature)) {
    return undefined;
  }
  return outcome.signature;
}
