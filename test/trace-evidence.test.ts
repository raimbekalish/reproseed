import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ExecutionOutcome } from "../src/core/types.ts";
import {
  TRACE_START_OPTIONS,
  classifyTraceEvidence,
  formatSkippedTrace,
  formatTraceEvidence,
  settleTraceSave,
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
    assert.equal(text.includes("show-trace"), false);
    const prior = formatTraceEvidence(runner, "artifacts/repro.zip", { priorTraceRemains: true });
    assert.match(prior, /left unchanged from an earlier run/);
    assert.match(prior, /may be stale/);
    assert.match(prior, /not verified evidence for this run/);
    assert.equal(prior.includes("Trace evidence: verified"), false);
    assert.equal(prior.includes("show-trace"), false);
    assert.equal(prior.includes("was not written"), false);
    assert.equal(formatSkippedTrace("this run did not write a verified regression test.").includes("verified evidence"), false);
  });

  it("deletes a trace zip that arrives after the save budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-late-"));
    const path = join(directory, "late.zip");
    try {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let wrote = false;
      let returned = false;
      const pending = settleTraceSave({
        path,
        budgetMs: 15,
        stop: async () => {
          await gate;
          await writeFile(path, token);
          wrote = true;
        },
      }).then((result) => {
        returned = true;
        return result;
      });
      await delay(80);
      assert.equal(wrote, false);
      assert.equal(returned, false);
      release();
      const result = await pending;
      assert.equal(returned, true);
      assert.equal(wrote, true);
      assert.equal(result.saved, false);
      assert.match(result.error ?? "", /trace save timed out/);
      assert.match(result.error ?? "", /finished after the cleanup budget/);
      assert.equal((result.error ?? "").includes(token), false);
      await assert.rejects(readFile(path));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deletes a partial zip when trace save rejects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-reject-"));
    const path = join(directory, "partial.zip");
    try {
      const result = await settleTraceSave({
        path,
        budgetMs: 1_000,
        stop: async () => {
          await writeFile(path, token);
          throw new Error("trace save rejected");
        },
      });
      assert.equal(result.saved, false);
      assert.match(result.error ?? "", /trace save rejected/);
      assert.equal((result.error ?? "").includes(token), false);
      await assert.rejects(readFile(path));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a zip when trace save finishes within the budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-kept-zip-"));
    const path = join(directory, "kept.zip");
    try {
      const result = await settleTraceSave({
        path,
        budgetMs: 1_000,
        stop: async () => {
          await writeFile(path, "trace-bytes");
        },
      });
      assert.deepEqual(result, { saved: true });
      assert.equal(await readFile(path, "utf8"), "trace-bytes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function failure(signature: typeof TARGET_SIGNATURE): ExecutionOutcome {
  return { status: "fail", durationMs: 5, signature };
}
