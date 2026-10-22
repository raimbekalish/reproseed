import type { ExecutionOutcome } from "../core/types.ts";

/** Actual count above the oracle expectation is the duplicate-submit failure. Any other mismatch is not. */
export function recordCountOutcome(input: {
  email: string;
  actual: number;
  expect: number;
  durationMs: number;
}): ExecutionOutcome {
  if (input.actual === input.expect) {
    return { status: "pass", durationMs: input.durationMs };
  }
  const code = input.actual > input.expect ? "DUPLICATE" : "COUNT_MISMATCH";
  return {
    status: "fail",
    durationMs: input.durationMs,
    signature: {
      oracleId: "record-count",
      code,
      facts: {
        email: input.email,
        actual: input.actual,
        expect: input.expect,
      },
    },
  };
}
