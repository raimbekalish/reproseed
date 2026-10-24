import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startDemoServer, type DemoServer } from "../../examples/duplicate-submit/server.ts";
import { findMissingDependencies } from "../../src/core/dependencies.ts";
import { VERIFIED_ONE_MINIMAL_CLAIM } from "../../src/core/minimize.ts";
import type { ExecutionOutcome, Scenario } from "../../src/core/types.ts";
import { minimizeWithBrowser } from "../../src/runner/minimize-browser.ts";
import type { SanitizedMinimizeArtifact } from "../../src/runner/report.ts";
import type { FetchLike } from "../../src/runner/reset.ts";
import { launchChromium } from "../../src/runner/session.ts";
import { CORE_IDS, TARGET_SIGNATURE, duplicateSubmitScenario, sameIds } from "../fixture.ts";

const APP_ID = "duplicate-submit";
const REPORT_PATH = fileURLToPath(new URL("../../artifacts/report.json", import.meta.url));

describe("browser failure reduction", { concurrency: false }, () => {
  it("removes unnecessary duplicate-submit steps and keeps the DUPLICATE signature", { timeout: 600_000 }, async () => {
    const resetAuthorization = randomBytes(16).toString("hex");
    const demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization });
    const observed = observeFetch(fetch);
    let launches = 0;
    try {
      const scenario = liveScenario(demo, resetAuthorization);
      const delayMs = delayStepMs(scenario);
      assert.equal(scenario.steps.length, 9);
      assert.equal(scenario.budget.verifyRuns, 5);
      assert.equal(scenario.budget.maxReplayExecutions, 60);
      for (const step of scenario.steps) {
        if (step.id === "submit-1" || step.id === "submit-2") {
          assert.deepEqual(step.dependsOn, ["open", "email"]);
        }
      }

      const report = await minimizeWithBrowser({
        scenario,
        reportPath: REPORT_PATH,
        fetchImpl: observed.fetchImpl,
        launchBrowser: () => {
          launches += 1;
          return launchChromium();
        },
      });

      assert.equal(
        report.status,
        "verified-one-minimal",
        JSON.stringify({ status: report.status, claim: report.claim, kept: report.keptStepIds, counts: report.counts, budget: report.budget }),
      );
      assert.equal(report.claim, VERIFIED_ONE_MINIMAL_CLAIM);
      assert.equal(report.claim.includes("guaranteed"), false);
      assert.deepEqual(report.baselineSignature, TARGET_SIGNATURE);
      for (const removed of ["note", "preview", "decoy-wait"]) {
        assert.equal(report.keptStepIds.includes(removed), false, removed);
      }
      assert.deepEqual(report.keptStepIds, [...CORE_IDS]);
      assert.deepEqual(report.inputStepIds, scenario.steps.map((step) => step.id));
      assert.ok(report.keptStepIds.length < report.inputStepIds.length);

      assert.equal(report.counts.baselineReplays, scenario.budget.baselineRuns);
      assert.equal(report.counts.verifyReplays, 5);
      assert.equal(
        report.counts.replayExecutions,
        report.counts.baselineReplays + report.counts.searchReplays + report.counts.verifyReplays,
      );
      assert.ok(report.counts.searchReplays > 0);
      assert.ok(report.counts.cacheHits > 0);
      assert.ok(report.counts.replayExecutions <= scenario.budget.maxReplayExecutions);
      assert.equal(report.budget.exhausted, false);
      assert.ok(report.budget.elapsedMs < scenario.budget.maxWallClockMs + scenario.budget.attemptTimeoutMs);
      assert.equal(report.evaluations.some((evaluation) => sameIds(evaluation.stepIds, report.inputStepIds)), false);

      const baseline = report.replays.filter((replay) => replay.phase === "baseline");
      const verify = report.replays.filter((replay) => replay.phase === "verify");
      assert.equal(baseline.length, scenario.budget.baselineRuns);
      assert.deepEqual(
        baseline.map((replay) => replay.id),
        baseline.map((_, index) => index + 1),
      );
      assert.equal(verify.length, 5);
      const firstVerify = verify[0];
      assert.ok(firstVerify);
      const keptSearch = report.replays.filter(
        (replay) => replay.phase === "search" && sameIds(replay.stepIds, report.keptStepIds),
      );
      assert.ok(keptSearch.length >= scenario.budget.reductionConfirmRuns);
      assert.ok(keptSearch.every((replay) => replay.id < firstVerify.id));

      for (const replay of baseline) {
        assert.ok(sameIds(replay.stepIds, report.inputStepIds));
        assertExactDuplicate(replay.outcome, delayMs);
      }
      for (const replay of verify) {
        assert.ok(sameIds(replay.stepIds, report.keptStepIds));
        assertExactDuplicate(replay.outcome, delayMs);
      }
      for (const evaluation of report.evaluations) {
        if (evaluation.candidateClass === "target") {
          assert.deepEqual(evaluation.signature, TARGET_SIGNATURE);
          if (evaluation.source === "executed") {
            assert.equal(evaluation.replayExecutionIds.length, scenario.budget.reductionConfirmRuns);
          }
        }
        if (evaluation.candidateClass === "invalid") {
          assert.equal(evaluation.source, "invalid");
          assert.equal(evaluation.replayExecutionIds.length, 0);
        }
      }

      for (const replay of report.replays) {
        assert.equal(findMissingDependencies(scenario.steps, replay.stepIds).length, 0, replay.stepIds.join(","));
        let cursor = 0;
        for (const id of replay.stepIds) {
          const found = report.inputStepIds.indexOf(id, cursor);
          assert.notEqual(found, -1, id);
          cursor = found + 1;
        }
      }
      for (const removedId of ["open", "email"]) {
        const evidence = report.singleDeletion.filter((entry) => entry.removedId === removedId);
        assert.ok(evidence.length > 0, removedId);
        for (const entry of evidence) {
          assert.equal(entry.candidateClass, "invalid");
          assert.equal(entry.source, "invalid");
          assert.equal(entry.replayExecutionIds.length, 0);
        }
      }
      const lastRound = Math.max(...report.singleDeletion.map((entry) => entry.round));
      const last = report.singleDeletion.filter((entry) => entry.round === lastRound);
      assert.deepEqual(
        last.map((entry) => entry.removedId),
        report.keptStepIds,
      );
      for (const entry of last) {
        assert.notEqual(entry.candidateClass, "target", `${entry.removedId} ${entry.candidateClass}`);
      }

      const cycles = replayCycles(observed.events, TARGET_SIGNATURE.facts.email);
      assert.equal(cycles.length, report.replays.length);
      assert.ok(launches >= 1);
      for (let index = 0; index < cycles.length; index += 1) {
        const cycle = cycles[index];
        const replay = report.replays[index];
        assert.ok(cycle);
        assert.ok(replay);
        assert.equal(cycle.appId, APP_ID);
        assert.equal(cycle.resetAuthorization, resetAuthorization);
        assert.equal(cycle.confirmTotal, 0);
        assert.ok(cycle.confirmAt <= cycle.oracleAt);
        assert.equal(scenario.oracle.id, "record-count");
        if (scenario.oracle.id === "record-count") {
          assertOracleAgrees(replay.outcome, cycle.oracleMatched, scenario.oracle.expect);
        }
        if (isExactDuplicate(replay.outcome)) {
          assert.ok(replay.outcome.durationMs >= delayMs - 100, `replay ${replay.id} duration ${replay.outcome.durationMs}`);
          assert.ok(
            cycle.oracleAt - cycle.confirmAt >= delayMs - 100,
            `replay ${replay.id} oracle was read ${cycle.oracleAt - cycle.confirmAt}ms after reset`,
          );
        }
      }

      const text = await readFile(REPORT_PATH, "utf8");
      assert.equal(text.includes(resetAuthorization), false);
      assert.equal(text.includes("resetAuthorization"), false);
      const artifact = JSON.parse(text) as SanitizedMinimizeArtifact;
      assert.deepEqual(artifact.report.keptStepIds, report.keptStepIds);
      assert.deepEqual(artifact.report.baselineSignature, TARGET_SIGNATURE);
      assert.equal(artifact.report.counts.verifyReplays, 5);
      assert.equal(artifact.report.counts.replayExecutions, report.counts.replayExecutions);
      assert.deepEqual(artifact.scenario.target, { origin: demo.origin, appId: APP_ID });
      assert.equal(artifact.scenario.steps.length, 9);
      assert.equal(artifact.scenario.steps.some((step) => step.kind === "delay"), true);
    } finally {
      await demo.close();
    }
  });
});

type FetchEvent = {
  method: string;
  pathname: string;
  appId?: string;
  authorization?: string;
  status: number;
  body: unknown;
  at: number;
};

type ReplayCycle = {
  appId: string;
  resetAuthorization: string;
  confirmAt: number;
  confirmTotal: number;
  oracleAt: number;
  oracleMatched: number;
};

function liveScenario(demo: DemoServer, resetAuthorization: string): Scenario {
  const scenario = duplicateSubmitScenario({
    maxReplayExecutions: 60,
    maxWallClockMs: 300_000,
    attemptTimeoutMs: 20_000,
    baselineRuns: 3,
    reductionConfirmRuns: 2,
    verifyRuns: 5,
  });
  scenario.target = {
    origin: demo.origin,
    appId: APP_ID,
    resetAuthorization,
  };
  return scenario;
}

function delayStepMs(scenario: Scenario): number {
  const delay = scenario.steps.find((step) => step.id === "slow");
  assert.ok(delay);
  assert.equal(delay.kind, "delay");
  if (delay.kind !== "delay") {
    throw new Error("slow step was not a delay");
  }
  assert.equal(delay.ms, 2_000);
  const gap = scenario.steps.find((step) => step.id === "gap");
  assert.ok(gap);
  assert.equal(gap.kind, "wait");
  if (gap.kind === "wait") {
    assert.equal(gap.ms, 800);
  }
  return delay.ms;
}

function observeFetch(inner: typeof fetch): { fetchImpl: FetchLike; events: FetchEvent[] } {
  const events: FetchEvent[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const response = await inner(input, init);
    const body = await readObservedBody(response.clone());
    const url = requestUrl(input);
    events.push({
      method: init?.method ?? "GET",
      pathname: url.pathname,
      appId: headerValue(init?.headers, "x-reproseed-app-id"),
      authorization: headerValue(init?.headers, "x-reproseed-reset-authorization"),
      status: response.status,
      body,
      at: Date.now(),
    });
    return response;
  };
  return { fetchImpl, events };
}

function replayCycles(events: readonly FetchEvent[], email: string): ReplayCycle[] {
  assert.equal(events.length % 4, 0, `unexpected runner requests: ${events.map((event) => event.pathname).join(",")}`);
  const cycles: ReplayCycle[] = [];
  for (let index = 0; index < events.length; index += 4) {
    const identity = events[index];
    const reset = events[index + 1];
    const confirm = events[index + 2];
    const oracle = events[index + 3];
    assert.ok(identity && reset && confirm && oracle);
    assert.equal(identity.method, "GET");
    assert.equal(identity.pathname, "/__reproseed/identity");
    assert.equal(identity.status, 200);
    assert.equal(identity.authorization, undefined);
    assert.equal(reset.method, "POST");
    assert.equal(reset.pathname, "/__reproseed/reset");
    assert.equal(reset.status, 204);
    assert.equal(confirm.method, "GET");
    assert.equal(confirm.pathname, "/api/records");
    assert.equal(confirm.status, 200);
    assert.equal(oracle.method, "GET");
    assert.equal(oracle.pathname, "/api/records");
    assert.equal(oracle.status, 200);
    assert.ok(identity.at <= reset.at && reset.at <= confirm.at && confirm.at <= oracle.at);
    const confirmed = countRecords(confirm.body, email);
    const counted = countRecords(oracle.body, email);
    assert.equal(confirmed.total, 0);
    cycles.push({
      appId: reset.appId ?? "",
      resetAuthorization: reset.authorization ?? "",
      confirmAt: confirm.at,
      confirmTotal: confirmed.total,
      oracleAt: oracle.at,
      oracleMatched: counted.matched,
    });
  }
  return cycles;
}

function countRecords(body: unknown, email: string): { total: number; matched: number } {
  assert.ok(Array.isArray(body), JSON.stringify(body));
  let matched = 0;
  for (const item of body) {
    if (typeof item === "object" && item !== null && "email" in item && item.email === email) {
      matched += 1;
    }
  }
  return { total: body.length, matched };
}

function assertOracleAgrees(outcome: ExecutionOutcome, matched: number, expectCount: number): void {
  if (outcome.status === "pass") {
    assert.equal(matched, expectCount, JSON.stringify(outcome));
    return;
  }
  assert.equal(outcome.status, "fail", JSON.stringify(outcome));
  if (outcome.status === "fail" && outcome.signature.oracleId === "record-count") {
    assert.equal(matched, outcome.signature.facts.actual);
    assert.equal(outcome.signature.facts.expect, expectCount);
  }
}

function isExactDuplicate(outcome: ExecutionOutcome): boolean {
  return (
    outcome.status === "fail" &&
    outcome.signature.oracleId === "record-count" &&
    outcome.signature.code === "DUPLICATE" &&
    outcome.signature.facts.actual === TARGET_SIGNATURE.facts.actual &&
    outcome.signature.facts.expect === TARGET_SIGNATURE.facts.expect &&
    outcome.signature.facts.email === TARGET_SIGNATURE.facts.email
  );
}

function assertExactDuplicate(outcome: ExecutionOutcome, delayMs: number): void {
  assert.equal(outcome.status, "fail", JSON.stringify(outcome));
  if (outcome.status !== "fail") {
    return;
  }
  assert.deepEqual(outcome.signature, TARGET_SIGNATURE);
  assert.ok(outcome.durationMs >= delayMs - 100, `duration ${outcome.durationMs}`);
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function headerValue(headers: NonNullable<RequestInit["headers"]> | undefined, name: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    const value = found?.[1];
    return typeof value === "string" ? value : undefined;
  }
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = match?.[1];
  return typeof value === "string" ? value : undefined;
}

async function readObservedBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}
