import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyOutcome, signaturesEqual } from "../src/core/signature.ts";
import type { DomMismatchSignature } from "../src/core/types.ts";
import { duplicateSignature } from "./fixture.ts";

const DOM_ALPHA: DomMismatchSignature = {
  oracleId: "dom-text",
  code: "DOM_MISMATCH",
  facts: { selector: "#results", expect: "Results for beta", actual: "Results for alpha" },
};

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

  it("treats a different DOM result as a different failure", () => {
    const other: DomMismatchSignature = {
      oracleId: "dom-text",
      code: "DOM_MISMATCH",
      facts: { selector: "#results", expect: "Results for beta", actual: "Results for gamma" },
    };
    const moved: DomMismatchSignature = {
      oracleId: "dom-text",
      code: "DOM_MISMATCH",
      facts: { selector: "#status", expect: "Results for beta", actual: "Results for alpha" },
    };
    assert.equal(signaturesEqual(DOM_ALPHA, DOM_ALPHA), true);
    assert.equal(signaturesEqual(DOM_ALPHA, other), false);
    assert.equal(signaturesEqual(DOM_ALPHA, moved), false);
    assert.equal(signaturesEqual(DOM_ALPHA, duplicateSignature(2)), false);
    assert.equal(classifyOutcome({ status: "fail", durationMs: 1, signature: DOM_ALPHA }, DOM_ALPHA), "target");
    assert.equal(classifyOutcome({ status: "fail", durationMs: 1, signature: other }, DOM_ALPHA), "other");
    assert.equal(classifyOutcome({ status: "fail", durationMs: 1, signature: duplicateSignature(2) }, DOM_ALPHA), "other");
    assert.equal(classifyOutcome({ status: "timeout", durationMs: 1 }, DOM_ALPHA), "timeout");
    assert.equal(classifyOutcome({ status: "pass", durationMs: 1 }, DOM_ALPHA), "pass");
  });
});
