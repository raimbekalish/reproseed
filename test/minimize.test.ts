import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MINIMIZE_LIMITATIONS, VERIFIED_ONE_MINIMAL_CLAIM, minimize } from "../src/core/minimize.ts";
import type { Budget, ExecutionOutcome, Scenario, Step } from "../src/core/types.ts";
import {
  CORE_IDS,
  duplicateSignature,
  duplicateSubmitScenario,
  outcomeForDuplicateSubmit,
  recordingProbe,
  sameIds,
} from "./fixture.ts";

function withSteps(steps: Step[], overrides: Partial<Budget> = {}): Scenario {
  return { ...duplicateSubmitScenario(overrides), id: "synthetic", steps };
}

function failTarget(): ExecutionOutcome {
  return { status: "fail", durationMs: 1, signature: duplicateSignature() };
}

describe("minimize", () => {
  it("treats Note as removable in the synthetic duplicate-submit predicate", () => {
    const withNote = outcomeForDuplicateSubmit([...CORE_IDS, "note", "preview", "decoy-wait"]);
    const withoutNote = outcomeForDuplicateSubmit([...CORE_IDS]);
    assert.equal(withNote.status, "fail");
    assert.equal(withoutNote.status, "fail");
    if (withNote.status === "fail" && withoutNote.status === "fail") {
      assert.deepEqual(withNote.signature, withoutNote.signature);
      assert.equal(withNote.signature.oracleId, "record-count");
      if (withNote.signature.oracleId === "record-count") {
        assert.equal(withNote.signature.facts.actual, 2);
      }
    }
    const withoutGap = outcomeForDuplicateSubmit(CORE_IDS.filter((id) => id !== "gap"));
    assert.equal(withoutGap.status, "fail");
    if (withoutGap.status === "fail") {
      assert.equal(withoutGap.signature.oracleId, "record-count");
      if (withoutGap.signature.oracleId === "record-count") {
        assert.equal(withoutGap.signature.facts.actual, 3);
      }
    }
  });

  it("removes decoys and Note, then verifies a 1-minimal duplicate-submit failure", async () => {
    const scenario = duplicateSubmitScenario();
    const recorded = recordingProbe(async (ids) => outcomeForDuplicateSubmit(ids));
    const report = await minimize({ scenario, probe: recorded.probe });

    assert.equal(report.status, "verified-one-minimal");
    assert.equal(report.claim, VERIFIED_ONE_MINIMAL_CLAIM);
    assert.equal(report.claim.includes("guaranteed"), false);
    assert.deepEqual(report.limitations, [...MINIMIZE_LIMITATIONS]);
    assert.equal(report.keptStepIds.includes("note"), false);
    assert.equal(report.keptStepIds.includes("preview"), false);
    assert.equal(report.keptStepIds.includes("decoy-wait"), false);
    assert.deepEqual(report.keptStepIds, [...CORE_IDS]);
    assert.equal(report.baselineSignature?.facts.actual, 2);
    assert.deepEqual(report.inputStepIds, scenario.steps.map((step) => step.id));

    assert.equal(report.counts.baselineReplays, scenario.budget.baselineRuns);
    assert.equal(report.counts.verifyReplays, 5);
    assert.equal(
      report.counts.replayExecutions,
      report.counts.baselineReplays + report.counts.searchReplays + report.counts.verifyReplays,
    );
    assert.equal(recorded.calls.length, report.counts.replayExecutions);
    assert.equal(report.replays.length, report.counts.replayExecutions);
    assert.ok(report.counts.cacheHits > 0);
    assert.ok(report.counts.candidateEvaluations > report.counts.cacheHits);
    assert.equal(report.budget.exhausted, false);

    const fullCalls = recorded.calls.filter((ids) => sameIds(ids, report.inputStepIds));
    assert.equal(fullCalls.length, scenario.budget.baselineRuns);
    const keptSearch = report.replays.filter(
      (replay) => replay.phase === "search" && sameIds(replay.stepIds, report.keptStepIds),
    );
    const keptVerify = report.replays.filter((replay) => replay.phase === "verify");
    assert.equal(keptVerify.length, 5);
    assert.ok(keptVerify.every((replay) => sameIds(replay.stepIds, report.keptStepIds)));
    assert.ok(keptVerify.every((replay) => replay.outcome.status === "fail"));
    const keptCalls = recorded.calls.filter((ids) => sameIds(ids, report.keptStepIds));
    assert.equal(keptCalls.length, keptSearch.length + keptVerify.length);

    const scenarioIds = report.inputStepIds;
    for (const call of recorded.calls) {
      let cursor = 0;
      for (const id of call) {
        const found = scenarioIds.indexOf(id, cursor);
        assert.notEqual(found, -1, id);
        cursor = found + 1;
      }
      if (call.includes("email") || call.includes("preview")) {
        assert.ok(call.includes("open"));
      }
      if (call.includes("submit-1") || call.includes("submit-2")) {
        assert.ok(call.includes("open"));
        assert.ok(call.includes("email"));
      }
    }

    const lastRound = Math.max(...report.singleDeletion.map((entry) => entry.round));
    const last = report.singleDeletion.filter((entry) => entry.round === lastRound);
    assert.deepEqual(
      last.map((entry) => entry.removedId),
      report.keptStepIds,
    );
    for (const entry of last) {
      assert.notEqual(entry.candidateClass, "target");
      if (entry.removedId === "open" || entry.removedId === "email") {
        assert.equal(entry.candidateClass, "invalid");
        assert.equal(entry.source, "invalid");
        assert.equal(entry.replayExecutionIds.length, 0);
        assert.equal(
          recorded.calls.some((ids) => sameIds(ids, entry.stepIds)),
          false,
        );
      } else {
        assert.equal(entry.source, "cache");
      }
    }
    const gap = last.find((entry) => entry.removedId === "gap");
    assert.equal(gap?.candidateClass, "other");
    assert.equal(gap?.signature?.oracleId, "record-count");
    if (gap?.signature?.oracleId === "record-count") {
      assert.equal(gap.signature.facts.actual, 3);
    }
  });

  it("runs baseline and final verification even when they share a step list", async () => {
    const scenario = withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }]);
    const recorded = recordingProbe(async (ids) => (sameIds(ids, ["bug"]) ? failTarget() : { status: "pass", durationMs: 1 }));
    const report = await minimize({ scenario, probe: recorded.probe });
    const bugCalls = recorded.calls.filter((ids) => sameIds(ids, ["bug"]));

    assert.equal(report.status, "verified-one-minimal");
    assert.deepEqual(report.keptStepIds, ["bug"]);
    assert.equal(bugCalls.length, scenario.budget.baselineRuns + scenario.budget.verifyRuns);
    assert.equal(report.counts.baselineReplays, scenario.budget.baselineRuns);
    assert.equal(report.counts.verifyReplays, 5);
    assert.equal(report.replays.filter((replay) => replay.phase === "verify").length, 5);
  });

  it("does not claim minimality when independent verification disagrees", async () => {
    const scenario = withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], { baselineRuns: 2 });
    let seen = 0;
    const recorded = recordingProbe(async (ids) => {
      if (!sameIds(ids, ["bug"])) {
        return { status: "pass", durationMs: 1 };
      }
      seen += 1;
      if (seen > scenario.budget.baselineRuns) {
        return { status: "pass", durationMs: 1 };
      }
      return failTarget();
    });
    const report = await minimize({ scenario, probe: recorded.probe });

    assert.equal(report.status, "unstable");
    assert.match(report.claim, /Independent verification/);
    assert.equal(report.replays.filter((replay) => replay.phase === "verify").length, 5);
    assert.equal(seen, scenario.budget.baselineRuns + 5);
    assert.deepEqual(report.keptStepIds, ["bug"]);
    assert.equal(report.claim.includes("1-minimal under single deletion"), false);
  });

  it("stops when the baseline is flaky and does not search", async () => {
    const scenario = duplicateSubmitScenario({ baselineRuns: 3 });
    let seen = 0;
    const recorded = recordingProbe(async () => {
      seen += 1;
      if (seen === 2) {
        return { status: "pass", durationMs: 1 };
      }
      return failTarget();
    });
    const report = await minimize({ scenario, probe: recorded.probe });

    assert.equal(report.status, "flaky-baseline");
    assert.equal(report.baselineSignature, undefined);
    assert.deepEqual(report.keptStepIds, []);
    assert.equal(recorded.calls.length, 3);
    assert.equal(report.counts.candidateEvaluations, 0);
    assert.equal(report.counts.cacheHits, 0);
    assert.equal(report.counts.searchReplays, 0);
    assert.equal(report.counts.verifyReplays, 0);
    assert.match(report.claim, /Minimization did not run/);
  });

  it("reports no reproducible failure when every baseline run passes or times out", async () => {
    const passing = await minimize({
      scenario: withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], { baselineRuns: 2 }),
      probe: async () => ({ status: "pass", durationMs: 1 }),
    });
    assert.equal(passing.status, "no-reproducible-failure");
    assert.deepEqual(passing.keptStepIds, []);
    assert.equal(passing.counts.replayExecutions, 2);

    const timedOut = await minimize({
      scenario: withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], { baselineRuns: 2 }),
      probe: async () => ({ status: "timeout", durationMs: 4, error: "attempt timed out" }),
    });
    assert.equal(timedOut.status, "no-reproducible-failure");
    assert.equal(timedOut.counts.verifyReplays, 0);

    const crashed = await minimize({
      scenario: withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], { baselineRuns: 2 }),
      probe: async () => {
        throw new Error("browser crashed");
      },
    });
    assert.equal(crashed.status, "no-reproducible-failure");
    assert.equal(crashed.replays[0]?.outcome.status, "error");
    assert.equal(crashed.replays[0]?.outcome.status === "error" ? crashed.replays[0].outcome.error : undefined, "browser crashed");
  });

  it("treats disagreeing failure signatures as a flaky baseline", async () => {
    let seen = 0;
    const report = await minimize({
      scenario: withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], { baselineRuns: 2 }),
      probe: async () => {
        seen += 1;
        return { status: "fail", durationMs: 1, signature: duplicateSignature(seen) };
      },
    });
    assert.equal(report.status, "flaky-baseline");
    assert.equal(report.counts.searchReplays, 0);
    assert.equal(seen, 2);
  });

  it("stops on the execution budget before claiming a result", async () => {
    const duringBaseline = await minimize({
      scenario: withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], {
        baselineRuns: 3,
        maxReplayExecutions: 2,
      }),
      probe: async () => failTarget(),
    });
    assert.equal(duringBaseline.status, "budget-exhausted");
    assert.equal(duringBaseline.budget.exhaustedReason, "replay-executions");
    assert.equal(duringBaseline.counts.replayExecutions, 2);
    assert.deepEqual(duringBaseline.keptStepIds, []);
    assert.equal(duringBaseline.counts.verifyReplays, 0);

    const beforeProof = await minimize({
      scenario: withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], {
        baselineRuns: 2,
        maxReplayExecutions: 2,
      }),
      probe: async () => failTarget(),
    });
    assert.equal(beforeProof.status, "budget-exhausted");
    assert.equal(beforeProof.budget.exhaustedReason, "replay-executions");
    assert.deepEqual(beforeProof.keptStepIds, ["bug"]);
    assert.equal(beforeProof.counts.verifyReplays, 0);
    assert.equal(beforeProof.singleDeletion[0]?.candidateClass, "inconclusive");
    assert.equal(beforeProof.singleDeletion[0]?.replayExecutionIds.length, 0);
    assert.notEqual(beforeProof.status, "verified-one-minimal");
  });

  it("stops on the wall-clock budget", async () => {
    let time = 0;
    const report = await minimize({
      scenario: withSteps([{ id: "bug", kind: "click", selector: "#bug", dependsOn: [] }], {
        baselineRuns: 2,
        maxReplayExecutions: 50,
        maxWallClockMs: 1_000,
      }),
      now: () => time,
      probe: async () => {
        time += 1_000;
        return failTarget();
      },
    });
    assert.equal(report.status, "budget-exhausted");
    assert.equal(report.budget.exhaustedReason, "wall-clock");
    assert.equal(report.counts.replayExecutions, 1);
    assert.equal(report.counts.candidateEvaluations, 0);
    assert.equal(report.budget.elapsedMs, 1_000);
  });

  it("does not cache an inconclusive candidate and will not verify it as minimal", async () => {
    const steps: Step[] = [
      { id: "keep", kind: "click", selector: "#keep", dependsOn: [] },
      { id: "drop", kind: "click", selector: "#drop", dependsOn: [] },
    ];
    const scenario = withSteps(steps, { baselineRuns: 2 });
    let keepCalls = 0;
    const recorded = recordingProbe(async (ids) => {
      if (sameIds(ids, ["keep", "drop"])) {
        return failTarget();
      }
      if (sameIds(ids, ["keep"])) {
        keepCalls += 1;
        if (keepCalls % 2 === 1) {
          return failTarget();
        }
        return { status: "pass", durationMs: 1 };
      }
      return { status: "pass", durationMs: 1 };
    });
    const report = await minimize({ scenario, probe: recorded.probe });
    const keepEvaluations = report.evaluations.filter((evaluation) => sameIds(evaluation.stepIds, ["keep"]));
    const keepProbeCalls = recorded.calls.filter((ids) => sameIds(ids, ["keep"]));

    assert.equal(report.status, "unstable");
    assert.match(report.claim, /Single-deletion did not prove minimality/);
    assert.equal(report.counts.verifyReplays, 0);
    assert.ok(keepEvaluations.length >= 2);
    assert.ok(keepEvaluations.every((evaluation) => evaluation.source === "inconclusive"));
    assert.ok(keepEvaluations.every((evaluation) => evaluation.candidateClass === "inconclusive"));
    assert.equal(keepProbeCalls.length, keepEvaluations.length * scenario.budget.reductionConfirmRuns);
    assert.ok(report.evaluations.some((evaluation) => sameIds(evaluation.stepIds, ["drop"]) && evaluation.source === "cache"));
    assert.equal(
      report.replays.filter((replay) => replay.phase === "baseline" && sameIds(replay.stepIds, ["keep", "drop"])).length,
      scenario.budget.baselineRuns,
    );
  });

  it("keeps a step when removing it times out or throws, and does not call that the target", async () => {
    const steps: Step[] = [
      { id: "a", kind: "click", selector: "#a", dependsOn: [] },
      { id: "b", kind: "click", selector: "#b", dependsOn: [] },
    ];
    const timedOut = await minimize({
      scenario: withSteps(steps, { baselineRuns: 2 }),
      probe: async (ids) => {
        if (sameIds(ids, ["a", "b"])) {
          return failTarget();
        }
        if (sameIds(ids, ["a"])) {
          return { status: "timeout", durationMs: 9, error: "attempt timed out" };
        }
        return { status: "pass", durationMs: 1 };
      },
    });
    assert.equal(timedOut.status, "verified-one-minimal");
    assert.deepEqual(timedOut.keptStepIds, ["a", "b"]);
    const removedA = timedOut.singleDeletion.find((entry) => entry.removedId === "b");
    assert.equal(removedA?.stepIds.includes("a"), true);
    assert.equal(removedA?.candidateClass, "timeout");
    assert.notEqual(removedA?.candidateClass, "target");

    const thrown = await minimize({
      scenario: withSteps(steps, { baselineRuns: 2 }),
      probe: async (ids) => {
        if (sameIds(ids, ["a"])) {
          throw new Error("browser crashed");
        }
        if (sameIds(ids, ["a", "b"])) {
          return failTarget();
        }
        return { status: "pass", durationMs: 1 };
      },
    });
    assert.equal(thrown.status, "verified-one-minimal");
    const crashed = thrown.singleDeletion.find((entry) => entry.removedId === "b");
    assert.equal(crashed?.candidateClass, "error");
    assert.ok(
      thrown.replays.some((replay) => replay.outcome.status === "error" && replay.outcome.error === "browser crashed"),
    );
  });

  it("refuses to reset a scenario that has no target identity", async () => {
    const recorded = recordingProbe(async () => failTarget());
    const missingApp = duplicateSubmitScenario();
    missingApp.target = { ...missingApp.target, appId: " " };
    await assert.rejects(() => minimize({ scenario: missingApp, probe: recorded.probe }), /target\.appId is required/);

    const missingAuth = duplicateSubmitScenario();
    missingAuth.target = { ...missingAuth.target, resetAuthorization: " " };
    await assert.rejects(
      () => minimize({ scenario: missingAuth, probe: recorded.probe }),
      /target\.resetAuthorization is required/,
    );
    assert.equal(recorded.calls.length, 0);

    await assert.rejects(
      () =>
        minimize({
          scenario: duplicateSubmitScenario({ verifyRuns: 1 }),
          probe: recorded.probe,
        }),
      /verifyRuns must be 5/,
    );
    assert.equal(recorded.calls.length, 0);
  });
});
