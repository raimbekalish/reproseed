import type { ExecutionOutcome } from "../core/types.ts";
import { domTextsMatch, normalizeDomText } from "./dom-text.ts";

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

/**
 * DOM_MISMATCH keeps the selector and both normalized strings.
 * Equal normalized text is a pass. Any other actual string is a distinct failure.
 */
export function domTextOutcome(input: {
  selector: string;
  actual: string;
  expect: string;
  durationMs: number;
}): ExecutionOutcome {
  const actual = normalizeDomText(input.actual);
  const expect = normalizeDomText(input.expect);
  if (domTextsMatch(actual, expect)) {
    return { status: "pass", durationMs: input.durationMs };
  }
  return {
    status: "fail",
    durationMs: input.durationMs,
    signature: {
      oracleId: "dom-text",
      code: "DOM_MISMATCH",
      facts: {
        selector: input.selector,
        expect,
        actual,
      },
    },
  };
}
