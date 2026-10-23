import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { startSearchServer } from "../../examples/stale-search/server.ts";
import { loadScenarioFile } from "../../src/cli/scenario-file.ts";
import { findMissingDependencies } from "../../src/core/dependencies.ts";
import { VERIFIED_ONE_MINIMAL_CLAIM } from "../../src/core/minimize.ts";
import type { Scenario } from "../../src/core/types.ts";
import { minimizeWithBrowser } from "../../src/runner/minimize-browser.ts";
import type { SanitizedMinimizeArtifact } from "../../src/runner/report.ts";

const APP_ID = "stale-search";
const SCENARIO = fileURLToPath(new URL("../../examples/stale-search/scenario.json", import.meta.url));
const REPORT_PATH = fileURLToPath(new URL("../../artifacts/stale-report.json", import.meta.url));
const STALE_SIGNATURE = {
  oracleId: "dom-text" as const,
  code: "DOM_MISMATCH" as const,
  facts: {
    selector: "#results",
    expect: "Results for beta",
    actual: "Results for alpha (outdated)",
  },
};

describe("stale search minimization", { concurrency: false }, () => {
  it("removes an unnecessary action and preserves DOM_MISMATCH", { timeout: 600_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const demo = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    try {
      const scenario = await loadSearchScenario(demo.origin, token);
      const removable = ["note", "preview", "decoy-wait"];
      for (const id of removable) {
        assert.ok(scenario.steps.some((step) => step.id === id));
      }
      const report = await minimizeWithBrowser({ scenario, reportPath: REPORT_PATH });
      console.log(
        JSON.stringify(
          {
            status: report.status,
            kept: report.keptStepIds,
            removed: report.inputStepIds.filter((id) => !report.keptStepIds.includes(id)),
            counts: report.counts,
            elapsedMs: report.budget.elapsedMs,
          },
          null,
          2,
        ),
      );
      assert.equal(
        report.status,
        "verified-one-minimal",
        JSON.stringify({ status: report.status, claim: report.claim, kept: report.keptStepIds, counts: report.counts }),
      );
      assert.equal(report.claim, VERIFIED_ONE_MINIMAL_CLAIM);
      assert.deepEqual(report.baselineSignature, STALE_SIGNATURE);
      assert.ok(report.keptStepIds.length < report.inputStepIds.length);
      const removed = report.inputStepIds.filter((id) => !report.keptStepIds.includes(id));
      assert.ok(
        removable.some((id) => removed.includes(id)),
        `removed nothing unnecessary: ${removed.join(", ")}`,
      );
      const keptDelay = scenario.steps.find((step) => report.keptStepIds.includes(step.id) && step.kind === "delay");
      assert.equal(keptDelay?.kind, "delay");
      if (keptDelay?.kind === "delay") {
        assert.equal(keptDelay.method, "GET");
      }
      assert.equal(report.counts.baselineReplays, scenario.budget.baselineRuns);
      assert.equal(report.counts.verifyReplays, 5);
      assert.ok(report.counts.cacheHits > 0);
      assert.ok(report.counts.replayExecutions <= scenario.budget.maxReplayExecutions);
      assert.equal(report.budget.exhausted, false);
      const verify = report.replays.filter((replay) => replay.phase === "verify");
      assert.equal(verify.length, 5);
      assert.equal(new Set(verify.map((replay) => replay.id)).size, 5);
      for (const replay of verify) {
        assert.deepEqual(replay.stepIds, report.keptStepIds);
        assert.equal(replay.outcome.status, "fail");
        if (replay.outcome.status === "fail") {
          assert.deepEqual(replay.outcome.signature, STALE_SIGNATURE);
        }
        assert.equal(findMissingDependencies(scenario.steps, replay.stepIds).length, 0);
      }

      const text = await readFile(REPORT_PATH, "utf8");
      assert.equal(text.includes(token), false);
      assert.equal(text.includes("resetAuthorization"), false);
      const artifact = JSON.parse(text) as SanitizedMinimizeArtifact;
      assert.equal(artifact.scenario.oracle.id, "dom-text");
      assert.deepEqual(artifact.report.baselineSignature, STALE_SIGNATURE);
      assert.equal(artifact.report.counts.verifyReplays, 5);
    } finally {
      await demo.close();
    }
  });
});

function loadSearchScenario(origin: string, token: string): Promise<Scenario> {
  return loadScenarioFile(SCENARIO, fileURLToPath(new URL("../..", import.meta.url)), {
    REPROSEED_ORIGIN: origin,
    REPROSEED_APP_ID: APP_ID,
    REPROSEED_RESET_AUTHORIZATION: token,
  });
}
