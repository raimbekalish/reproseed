import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExecutionOutcome } from "../src/core/types.ts";
import {
  TRACE_START_OPTIONS,
  classifyTraceEvidence,
  formatSkippedTrace,
  formatTraceEvidence,
} from "../src/runner/trace-evidence.ts";
import { TARGET_SIGNATURE, duplicateSignature } from "./fixture.ts";

const token = "reset-credential-value";

describe("trace evidence", () => {
  it("uses a fixed tracing title and leaves sources out", () => {
    assert.deepEqual(TRACE_START_OPTIONS, {
      screenshots: true,
      snapshots: true,
      sources: false,
      title: "ReproSeed evidence",
    });
    assert.equal(JSON.stringify(TRACE_START_OPTIONS).includes(token), false);
    assert.equal(JSON.stringify(TRACE_START_OPTIONS).includes("authorization"), false);
  });

  it("labels a saved matching failure as verified evidence", () => {
    const evidence = classifyTraceEvidence({
      target: TARGET_SIGNATURE,
      outcome: failure(TARGET_SIGNATURE),
      traceSaved: true,
    });
    assert.equal(evidence.status, "verified");
    const text = formatTraceEvidence(evidence, "artifacts/repro.zip");
    assert.match(text, /Trace evidence: verified/);
    assert.match(text, /separate from the five verification replays/);
    assert.match(text, /npx playwright show-trace artifacts\/repro\.zip/);
    assert.equal(text.includes(token), false);
  });

  it("does not label a changed signature or a passing replay as verified", () => {
    const changed = classifyTraceEvidence({
      target: TARGET_SIGNATURE,
      outcome: failure(duplicateSignature(3)),
      traceSaved: true,
    });
    assert.equal(changed.status, "not-reproduced");
    const passed = classifyTraceEvidence({
      target: TARGET_SIGNATURE,
      outcome: { status: "pass", durationMs: 4 },
      traceSaved: true,
    });
    assert.equal(passed.status, "not-reproduced");
    const text = formatTraceEvidence(changed, "artifacts/repro.zip");
    assert.match(text, /not verified evidence/);
    assert.equal(text.includes("Trace evidence: verified"), false);
  });

  it("treats a runner failure or a missing zip as a failed capture", () => {
    const runner = classifyTraceEvidence({
      target: TARGET_SIGNATURE,
      outcome: {
        status: "error",
        durationMs: 2,
        error: `reset refused for ${token}`,
        signature: {
          oracleId: "runner",
          code: "RESET_FAILED",
          facts: { message: `reset refused for ${token}` },
        },
      },
      traceSaved: true,
    });
    assert.equal(runner.status, "failed");
    const missing = classifyTraceEvidence({
      target: TARGET_SIGNATURE,
      outcome: failure(TARGET_SIGNATURE),
      traceSaved: false,
    });
    assert.equal(missing.status, "failed");
    const text = formatTraceEvidence(runner, "artifacts/repro.zip");
    assert.match(text, /left in place/);
    assert.match(text, /was not written/);
    assert.equal(formatSkippedTrace("this run did not write a verified regression test.").includes("verified evidence"), false);
  });
});

function failure(signature: typeof TARGET_SIGNATURE): ExecutionOutcome {
  return { status: "fail", durationMs: 5, signature };
}
