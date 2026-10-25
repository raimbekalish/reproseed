import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  planCoarseDurations,
  planFineDurations,
  scenarioKeepingSteps,
  scenarioWithDelay,
  selectTunableDelay,
} from "../src/core/duration.ts";
import { signaturesEqual } from "../src/core/signature.ts";
import type { ExecutionOutcome, Probe, Scenario } from "../src/core/types.ts";
import { formatSummary } from "../src/cli/format.ts";
import { optimizeVerifiedDuration } from "../src/runner/minimize-duration.ts";
import { sanitizeArtifact } from "../src/runner/report.ts";
import { verifiedMinimizeReport } from "./export/verified-report.ts";
import { CORE_IDS, duplicateSubmitScenario, outcomeForDuplicateSubmit, TARGET_SIGNATURE } from "./fixture.ts";

const CONFIG = {
  resolutionMs: 500,
  maxReplayExecutions: 80,
  maxWallClockMs: 100_000,
  confirmRuns: 2,
  maxCoarseCandidates: 4,
  maxFineCandidates: 4,
};

describe("delay duration search", () => {
  it("builds a scenario variant without mutating the original delay", () => {
    const scenario = duplicateSubmitScenario();
    const before = JSON.stringify(scenario);
    const kept = scenarioKeepingSteps(scenario, CORE_IDS);
    const variant = scenarioWithDelay(kept, "slow", 500);
    const copied = variant.steps.find((step) => step.id === "submit-1");
    assert.equal(copied?.kind, "click");
    if (copied?.kind === "click") {
      copied.dependsOn.push("mutated");
    }
    const delay = variant.steps.find((step) => step.id === "slow");
    assert.equal(delay?.kind, "delay");
    if (delay?.kind === "delay") {
      delay.ms = 1;
    }
    assert.equal(JSON.stringify(scenario), before);
    assert.equal(delayOf(scenario), 2000);
    assert.deepEqual(scenarioKeepingSteps(scenario, CORE_IDS).steps.map((step) => step.id), [...CORE_IDS]);
    const fresh = scenarioWithDelay(scenario, "slow", 500);
    const submit = fresh.steps.find((step) => step.id === "submit-1");
    assert.equal(submit?.kind, "click");
    if (submit?.kind === "click") {
      assert.deepEqual(submit.dependsOn, ["open", "email"]);
    }
    assert.equal(delayOf(fresh), 500);
    assert.notEqual(fresh.steps, scenario.steps);
  });

  it("rejects durations that are not positive integers or that increase the delay", () => {
    const scenario = duplicateSubmitScenario();
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => scenarioWithDelay(scenario, "slow", value), /positive integer/);
    }
    assert.throws(() => scenarioWithDelay(scenario, "slow", 2001), /cannot increase/);
    assert.throws(() => scenarioWithDelay(scenario, "open", 10), /not a delay/);
    assert.throws(() => planCoarseDurations(2000, 0, 4), /positive integer/);
  });

  it("plans coarse and fine durations without assuming monotonic races", () => {
    assert.deepEqual(planCoarseDurations(2000, 250, 4), [1500, 1000, 500]);
    assert.deepEqual(planCoarseDurations(800, 250, 4), [550, 300, 50]);
    assert.deepEqual(planCoarseDurations(800, 800, 4), []);
    assert.deepEqual(planCoarseDurations(5, 2, 4), [3, 1]);
    for (const duration of planCoarseDurations(2000, 100, 4)) {
      assert.equal(Number.isSafeInteger(duration), true);
      assert.ok(duration >= 1);
      assert.ok(duration < 2000);
    }
    assert.deepEqual(
      planFineDurations({
        originalMs: 2000,
        resolutionMs: 250,
        maxCount: 4,
        measured: [
          { durationMs: 1500, confirmed: true },
          { durationMs: 1000, confirmed: false },
          { durationMs: 500, confirmed: false },
        ],
      }),
      [1250],
    );
    const below = planFineDurations({
      originalMs: 2000,
      resolutionMs: 100,
      maxCount: 4,
      measured: [{ durationMs: 1000, confirmed: true }],
    });
    assert.equal(below.length, 4);
    assert.equal(below[0], 100);
    assert.equal(below[below.length - 1], 900);
    assert.deepEqual(
      planFineDurations({
        originalMs: 2000,
        resolutionMs: 500,
        maxCount: 4,
        measured: [
          { durationMs: 1500, confirmed: false },
          { durationMs: 1000, confirmed: false },
          { durationMs: 500, confirmed: true },
        ],
      }),
      [],
    );
  });

  it("selects a shorter confirmed duration even when a longer candidate misses", async () => {
    const scenario = duplicateSubmitScenario();
    const before = JSON.stringify(scenario);
    const stage1 = verifiedMinimizeReport(scenario, CORE_IDS);
    const stage1Json = JSON.stringify(stage1);
    const variants: Scenario[] = [];
    const calls: Array<{ ms: number; ids: string[] }> = [];
    const result = await optimizeVerifiedDuration({
      scenario,
      stage1,
      config: CONFIG,
      now: () => 0,
      probeFor: (variant) => {
        variants.push(variant);
        const ms = delayOf(variant);
        const probe: Probe = async (ids) => {
          calls.push({ ms: delayOf(variant), ids: [...ids] });
          if (ms === 500) {
            return outcomeForDuplicateSubmit(ids);
          }
          return { status: "pass", durationMs: 1 };
        };
        return probe;
      },
    });
    stage1.status = "unstable";
    assert.equal(JSON.stringify(scenario), before);
    assert.equal(delayOf(scenario), 2000);
    assert.equal(JSON.stringify(result.optimization.stage1), stage1Json);
    assert.equal(result.optimization.promotion, "improved");
    assert.equal(result.optimization.timingImproved, true);
    assert.equal(result.optimization.fullyVerified, true);
    assert.equal(result.optimization.retainedOriginal, false);
    assert.equal(result.optimization.delayStep?.selectedMs, 500);
    assert.equal(result.optimization.delayStep?.finalMs, 500);
    assert.equal(delayOf(result.scenario), 500);
    assert.equal(delayOf(variants[0] ?? scenario), 1500);
    assert.equal(delayOf(variants[1] ?? scenario), 1000);
    assert.notEqual(variants[0], variants[1]);
    assert.deepEqual(
      calls.slice(0, 6).map((call) => call.ms),
      [1500, 1500, 1000, 1000, 500, 500],
    );
    const confirmed = result.optimization.candidates.find((candidate) => candidate.durationMs === 500);
    assert.equal(confirmed?.classification, "confirmed");
    assert.equal(confirmed?.replayIds.length, 2);
    assert.equal(new Set(confirmed?.replayIds).size, 2);
    assert.equal(result.optimization.candidates.find((candidate) => candidate.durationMs === 1500)?.classification, "pass");
    const stage3 = result.optimization.stage3;
    assert.ok(stage3);
    assert.equal(stage3?.status, "verified-one-minimal");
    assert.equal(result.report, stage3);
    assert.notEqual(result.report, result.optimization.stage1);
    const verify = stage3?.replays.filter((replay) => replay.phase === "verify") ?? [];
    assert.equal(verify.length, 5);
    assert.equal(new Set(verify.map((replay) => replay.id)).size, 5);
    for (const replay of verify) {
      assert.equal(replay.outcome.status, "fail");
      if (replay.outcome.status === "fail") {
        assert.equal(signaturesEqual(replay.outcome.signature, TARGET_SIGNATURE), true);
      }
    }
    const lastRound = Math.max(...(stage3?.singleDeletion.map((entry) => entry.round) ?? [0]));
    const last = stage3?.singleDeletion.filter((entry) => entry.round === lastRound) ?? [];
    assert.equal(last.length, stage3?.keptStepIds.length);
    assert.equal(last.some((entry) => entry.candidateClass === "target"), false);
    assert.equal(
      result.optimization.totals.replayExecutions,
      result.optimization.stage1.replays.length + result.optimization.replays.length + (stage3?.replays.length ?? 0),
    );
    assert.equal(calls.length, result.optimization.replays.length + (stage3?.replays.length ?? 0));
    assert.equal(result.optimization.budget.replayExecutions, result.optimization.replays.length);
    assert.equal(result.optimization.replays.every((replay) => replay.phase === "timing"), true);
  });

  it("refines between a miss and a longer confirmation", async () => {
    const scenario = duplicateSubmitScenario();
    const result = await optimizeVerifiedDuration({
      scenario,
      stage1: verifiedMinimizeReport(scenario, CORE_IDS),
      config: { ...CONFIG, resolutionMs: 250 },
      now: () => 0,
      probeFor: (variant) => async (ids) => {
        return delayOf(variant) >= 750 ? outcomeForDuplicateSubmit(ids) : { status: "pass", durationMs: 1 };
      },
    });
    assert.equal(result.optimization.delayStep?.selectedMs, 750);
    assert.equal(result.optimization.candidates.some((candidate) => candidate.durationMs === 750 && candidate.phase === "fine"), true);
    assert.equal(result.optimization.candidates.some((candidate) => candidate.durationMs === 500 && candidate.classification === "pass"), true);
    assert.equal(result.optimization.fullyVerified, true);
    assert.equal(delayOf(result.scenario), 750);
  });

  it("does not treat a timeout, a thrown probe, or a reset failure as the target", async () => {
    const scenario = duplicateSubmitScenario();
    const stage1 = verifiedMinimizeReport(scenario, CORE_IDS);
    const timeout = await optimizeVerifiedDuration({
      scenario,
      stage1,
      config: CONFIG,
      now: () => 0,
      probeFor: () => async () => timeoutOutcome(),
    });
    assert.equal(timeout.optimization.candidates.every((candidate) => candidate.classification === "timeout"), true);
    assert.equal(timeout.optimization.promotion, "no-improvement");
    assert.equal(timeout.optimization.retainedOriginal, true);
    assert.equal(timeout.optimization.stage3, undefined);
    assert.equal(timeout.report, timeout.optimization.stage1);

    const thrown = await optimizeVerifiedDuration({
      scenario,
      stage1,
      config: CONFIG,
      now: () => 0,
      probeFor: () => async () => {
        throw new Error("probe exploded");
      },
    });
    assert.equal(thrown.optimization.candidates.every((candidate) => candidate.classification === "error"), true);
    assert.equal(thrown.optimization.searchStatus, "completed");

    const reset = await optimizeVerifiedDuration({
      scenario,
      stage1,
      config: CONFIG,
      now: () => 0,
      probeFor: () => async () => resetOutcome(),
    });
    assert.equal(reset.optimization.searchStatus, "runner-error");
    assert.equal(reset.optimization.candidates.length, 1);
    assert.equal(reset.optimization.candidates[0]?.classification, "error");
    assert.deepEqual(reset.optimization.notStartedDurations, [1000, 500]);
    assert.equal(reset.optimization.retainedOriginal, true);
    assert.equal(reset.report.status, "verified-one-minimal");
  });

  it("stops when the timing budget is exhausted and does not promote a partial confirmation", async () => {
    const scenario = duplicateSubmitScenario();
    const stage1 = verifiedMinimizeReport(scenario, CORE_IDS);
    let calls = 0;
    const byCount = await optimizeVerifiedDuration({
      scenario,
      stage1,
      config: { ...CONFIG, maxReplayExecutions: 1 },
      now: () => 0,
      probeFor: () => async () => {
        calls += 1;
        return outcomeForDuplicateSubmit(CORE_IDS);
      },
    });
    assert.equal(calls, 1);
    assert.equal(byCount.optimization.searchStatus, "budget-exhausted");
    assert.equal(byCount.optimization.budget.exhaustedReason, "replay-executions");
    assert.equal(byCount.optimization.candidates[0]?.classification, "incomplete");
    assert.equal(byCount.optimization.delayStep?.selectedMs, undefined);
    assert.equal(byCount.optimization.stage3, undefined);
    assert.equal(byCount.optimization.retainedOriginal, true);
    assert.ok(byCount.optimization.notStartedDurations.length > 0);

    let nowMs = 0;
    const byClock = await optimizeVerifiedDuration({
      scenario,
      stage1,
      config: { ...CONFIG, maxWallClockMs: 10 },
      now: () => nowMs,
      probeFor: () => async () => {
        nowMs = 50;
        return outcomeForDuplicateSubmit(CORE_IDS);
      },
    });
    assert.equal(byClock.optimization.searchStatus, "budget-exhausted");
    assert.equal(byClock.optimization.budget.exhaustedReason, "wall-clock");
    assert.equal(byClock.optimization.fullyVerified, false);
  });

  it("keeps the verified scenario when every shorter candidate passes", async () => {
    const scenario = duplicateSubmitScenario();
    const result = await optimizeVerifiedDuration({
      scenario,
      stage1: verifiedMinimizeReport(scenario, CORE_IDS),
      config: CONFIG,
      now: () => 0,
      probeFor: () => async () => ({ status: "pass", durationMs: 1 }),
    });
    assert.equal(result.optimization.promotion, "no-improvement");
    assert.equal(result.optimization.searchStatus, "completed");
    assert.equal(result.optimization.retainedOriginal, true);
    assert.equal(result.optimization.timingImproved, false);
    assert.equal(delayOf(result.scenario), 2000);
    assert.equal(result.optimization.replays.length, 6);
  });

  it("does not promote an unstable candidate", async () => {
    const scenario = duplicateSubmitScenario();
    const seen = new Map<number, number>();
    const result = await optimizeVerifiedDuration({
      scenario,
      stage1: verifiedMinimizeReport(scenario, CORE_IDS),
      config: CONFIG,
      now: () => 0,
      probeFor: (variant) => async () => {
        const ms = delayOf(variant);
        const count = (seen.get(ms) ?? 0) + 1;
        seen.set(ms, count);
        if (ms === 1500 && count === 1) {
          return outcomeForDuplicateSubmit(CORE_IDS);
        }
        return { status: "pass", durationMs: 1 };
      },
    });
    assert.equal(result.optimization.candidates.find((candidate) => candidate.durationMs === 1500)?.classification, "unstable");
    assert.equal(seen.get(1500), 2);
    assert.equal(result.optimization.promotion, "unstable");
    assert.equal(result.optimization.stage3, undefined);
    assert.equal(result.optimization.retainedOriginal, true);
  });

  it("skips several delay steps and a non-integer delay instead of pretending they were tuned", async () => {
    const several = duplicateSubmitScenario();
    several.steps = [
      ...several.steps,
      { id: "slow-2", kind: "delay", urlIncludes: "/api/other", method: "GET", ms: 400, dependsOn: [] },
    ];
    let calls = 0;
    const multiple = await optimizeVerifiedDuration({
      scenario: several,
      stage1: verifiedMinimizeReport(several, [...CORE_IDS, "slow-2"]),
      config: CONFIG,
      now: () => 0,
      probeFor: () => async () => {
        calls += 1;
        return outcomeForDuplicateSubmit(CORE_IDS);
      },
    });
    assert.equal(calls, 0);
    assert.equal(multiple.optimization.searchStatus, "skipped-multiple-delays");
    assert.deepEqual(multiple.optimization.skippedDelayStepIds, ["slow", "slow-2"]);
    assert.equal(multiple.optimization.retainedOriginal, true);

    const fractional = duplicateSubmitScenario();
    const slow = fractional.steps.find((step) => step.id === "slow");
    assert.equal(slow?.kind, "delay");
    if (slow?.kind === "delay") {
      slow.ms = 2000.5;
    }
    const skipped = await optimizeVerifiedDuration({
      scenario: fractional,
      stage1: verifiedMinimizeReport(fractional, CORE_IDS),
      config: CONFIG,
      now: () => 0,
      probeFor: () => async () => {
        calls += 1;
        return outcomeForDuplicateSubmit(CORE_IDS);
      },
    });
    assert.equal(calls, 0);
    assert.equal(skipped.optimization.searchStatus, "skipped-non-integer-duration");
    assert.equal(selectTunableDelay(fractional, CORE_IDS).status, "non-integer");

    const noDelay = await optimizeVerifiedDuration({
      scenario: duplicateSubmitScenario(),
      stage1: verifiedMinimizeReport(duplicateSubmitScenario(), ["open", "email", "submit-1", "submit-2"]),
      config: CONFIG,
      now: () => 0,
      probeFor: () => async () => {
        throw new Error("should not replay");
      },
    });
    assert.equal(noDelay.optimization.searchStatus, "skipped-no-delay");
  });

  it("falls back when renewed minimization does not reproduce the original signature", async () => {
    const scenario = duplicateSubmitScenario();
    const stage1 = verifiedMinimizeReport(scenario, CORE_IDS);
    let atSelected = 0;
    const result = await optimizeVerifiedDuration({
      scenario,
      stage1,
      config: CONFIG,
      now: () => 0,
      probeFor: (variant) => async (ids) => {
        const ms = delayOf(variant);
        if (ms !== 500) {
          return { status: "pass", durationMs: 1 };
        }
        atSelected += 1;
        if (atSelected <= 2) {
          return outcomeForDuplicateSubmit(ids);
        }
        return { status: "pass", durationMs: 1 };
      },
    });
    assert.equal(result.optimization.promotion, "not-verified");
    assert.ok(result.optimization.stage3);
    assert.notEqual(result.optimization.stage3?.status, "verified-one-minimal");
    assert.equal(result.report, result.optimization.stage1);
    assert.equal(result.optimization.retainedOriginal, true);
    assert.equal(result.optimization.fullyVerified, false);
    assert.equal(delayOf(result.scenario), 2000);
    assert.equal(
      result.optimization.totals.replayExecutions,
      result.optimization.totals.stage1Replays + result.optimization.totals.timingReplays + result.optimization.totals.stage3Replays,
    );
    assert.ok(result.optimization.totals.stage3Replays > 0);
    assert.equal(result.optimization.totals.stage3Replays, result.optimization.stage3?.replays.length);
  });

  it("redacts reset credentials inside timing outcomes and leaves the default summary unchanged", () => {
    const token = "local-demo-token-9f3a";
    const scenario = duplicateSubmitScenario();
    scenario.target = { ...scenario.target, resetAuthorization: token };
    const stage1 = verifiedMinimizeReport(scenario, CORE_IDS);
    const report = stage1;
    const plain = formatSummary({ report, reportPath: "artifacts/report.json", specPath: "artifacts/minimized.spec.ts" });
    assert.equal(plain.includes("Timing optimization"), false);
    assert.match(plain, /Replay executions: 8\n {2}baseline: 3\n {2}search: 0\n {2}verify: 5\n/);
    const leaked: ExecutionOutcome = {
      status: "error",
      durationMs: 4,
      error: `reset refused for ${token}`,
      signature: { oracleId: "runner", code: "RUNNER_ERROR", facts: { message: `reset refused for ${token}` } },
    };
    const artifact = sanitizeArtifact(scenario, report, {
      requested: true,
      searchStatus: "completed",
      promotion: "no-improvement",
      retainedOriginal: true,
      timingImproved: false,
      fullyVerified: false,
      exportedScenario: "original",
      limitations: [],
      claim: `unchanged ${token}`,
      plannedDurations: { coarse: [], fine: [] },
      notStartedDurations: [],
      candidates: [],
      replays: [{ id: 1, phase: "timing", durationMs: 500, stepIds: ["slow"], outcome: leaked }],
      additionalRemovedStepIds: [],
      budget: {
        maxReplayExecutions: 36,
        replayExecutions: 1,
        maxWallClockMs: 180_000,
        elapsedMs: 10,
        exhausted: false,
        resolutionMs: 250,
        confirmRuns: 2,
        maxCoarseCandidates: 4,
        maxFineCandidates: 4,
      },
      stage1,
      totals: { replayExecutions: stage1.replays.length + 1, stage1Replays: stage1.replays.length, timingReplays: 1, stage3Replays: 0 },
    });
    const text = JSON.stringify(artifact);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes("resetAuthorization"), false);
    assert.match(text, /reset refused for \[redacted\]/);
  });
});

function delayOf(scenario: Scenario): number {
  const step = scenario.steps.find((candidate) => candidate.id === "slow");
  assert.equal(step?.kind, "delay");
  if (step?.kind !== "delay") {
    throw new Error("slow step was not a delay");
  }
  return step.ms;
}

function timeoutOutcome(): ExecutionOutcome {
  return { status: "timeout", durationMs: 5, error: "attempt timed out" };
}

function resetOutcome(): ExecutionOutcome {
  return {
    status: "error",
    durationMs: 1,
    error: "reset failed",
    signature: { oracleId: "runner", code: "RESET_FAILED", facts: { message: "reset failed" } },
  };
}
