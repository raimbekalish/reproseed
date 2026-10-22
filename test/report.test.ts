import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { MinimizeReport } from "../src/core/types.ts";
import { sanitizeArtifact, writeSanitizedReport } from "../src/runner/report.ts";
import { duplicateSubmitScenario } from "./fixture.ts";

describe("sanitized minimize report", () => {
  it("omits the reset credential and redacts it from nested outcome text", async () => {
    const token = "local-demo-token-9f3a";
    const scenario = duplicateSubmitScenario();
    scenario.target = { ...scenario.target, resetAuthorization: token };
    const leaked = `reset refused for ${token}`;
    const report = sampleReport(leaked);
    (report as MinimizeReport & { resetAuthorization?: string }).resetAuthorization = token;

    const artifact = sanitizeArtifact(scenario, report);
    const directory = await mkdtemp(join(tmpdir(), "reproseed-report-"));
    try {
      const path = join(directory, "nested", "report.json");
      await writeSanitizedReport(path, scenario, report);
      const text = await readFile(path, "utf8");
      assert.equal(text.includes(token), false);
      assert.equal(text.includes("resetAuthorization"), false);
      const written = JSON.parse(text) as { scenario: { target: Record<string, string> }; report: MinimizeReport };
      assert.deepEqual(written.scenario.target, { origin: scenario.target.origin, appId: scenario.target.appId });
      assert.equal(written.report.status, report.status);
      assert.deepEqual(written.report.keptStepIds, []);
      const outcome = written.report.replays[0]?.outcome;
      assert.equal(outcome?.status, "error");
      if (outcome?.status === "error" && outcome.signature?.oracleId === "runner") {
        assert.equal(outcome.error, "reset refused for [redacted]");
        assert.equal(outcome.signature.facts.message, "reset refused for [redacted]");
      }
      assert.equal(JSON.stringify(artifact).includes(token), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("connects the browser probe to minimize without a fixed step list", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/runner/minimize-browser.ts", import.meta.url)), "utf8");
    assert.match(source, /startReplayRuntime\(/);
    assert.match(source, /probeFor\(input\.scenario\)/);
    assert.match(source, /minimize\(\{/);
    assert.doesNotMatch(source, /keptStepIds\s*[:=]/);
    assert.doesNotMatch(source, /verified-one-minimal/);
    assert.doesNotMatch(source, /submit-1/);
    assert.doesNotMatch(source, /decoy-wait/);
    assert.doesNotMatch(source, /DUPLICATE/);
  });
});

function sampleReport(message: string): MinimizeReport {
  return {
    status: "no-reproducible-failure",
    claim: "The full scenario did not produce a stable target failure. Minimization did not run.",
    limitations: [],
    inputStepIds: ["open"],
    keptStepIds: [],
    counts: {
      replayExecutions: 1,
      candidateEvaluations: 0,
      cacheHits: 0,
      baselineReplays: 1,
      searchReplays: 0,
      verifyReplays: 0,
    },
    budget: {
      maxReplayExecutions: 60,
      replayExecutions: 1,
      maxWallClockMs: 1_000,
      elapsedMs: 1,
      exhausted: false,
    },
    replays: [
      {
        id: 1,
        phase: "baseline",
        stepIds: ["open"],
        outcome: {
          status: "error",
          durationMs: 1,
          error: message,
          signature: {
            oracleId: "runner",
            code: "RUNNER_ERROR",
            facts: { message },
          },
        },
      },
    ],
    evaluations: [],
    singleDeletion: [],
  };
}
