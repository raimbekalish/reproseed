import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyOutcome, signaturesEqual } from "../src/core/signature.ts";
import { duplicateSignature } from "./fixture.ts";

describe("signatures", () => {
  it("matches duplicate failures only when the facts match", () => {
    const baseline = duplicateSignature(2);
    assert.equal(signaturesEqual(baseline, duplicateSignature(2)), true);
    assert.equal(signaturesEqual(baseline, duplicateSignature(3)), false);
    assert.equal(
      signaturesEqual(baseline, {
        oracleId: "record-count",
        code: "COUNT_MISMATCH",
        facts: { email: "a@example.com", actual: 2, expect: 1 },
      }),
      false,
    );
    assert.equal(
      signaturesEqual(baseline, {
        oracleId: "runner",
        code: "TIMEOUT",
        facts: { message: "attempt timed out" },
      }),
      false,
    );
  });

  it("rejects a different signature, a timeout, and a runner error as the target", () => {
    const baseline = duplicateSignature(2);
    assert.equal(
      classifyOutcome({ status: "fail", durationMs: 1, signature: duplicateSignature(2) }, baseline),
      "target",
    );
    assert.equal(
      classifyOutcome({ status: "fail", durationMs: 1, signature: duplicateSignature(3) }, baseline),
      "other",
    );
    assert.equal(classifyOutcome({ status: "timeout", durationMs: 1, error: "slow" }, baseline), "timeout");
    assert.equal(
      classifyOutcome(
        {
          status: "error",
          durationMs: 1,
          error: "crashed",
          signature: { oracleId: "runner", code: "RUNNER_ERROR", facts: { message: "crashed" } },
        },
        baseline,
      ),
      "error",
    );
    assert.equal(classifyOutcome({ status: "pass", durationMs: 1 }, baseline), "pass");
  });
});
