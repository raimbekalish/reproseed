import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { startDemoServer, type DemoPage } from "../../examples/duplicate-submit/server.ts";
import { startSearchServer, type SearchPage } from "../../examples/stale-search/server.ts";
import { loadScenarioFile } from "../../src/cli/scenario-file.ts";
import {
  DEFAULT_TIMING_MAX_REPLAYS,
  DEFAULT_TIMING_MAX_WALL_CLOCK_MS,
  DEFAULT_TIMING_RESOLUTION_MS,
  type DurationOptimization,
} from "../../src/core/duration.ts";
import { signaturesEqual } from "../../src/core/signature.ts";
import type { Scenario, TargetSignature } from "../../src/core/types.ts";
import { writePlaywrightTest } from "../../src/export/playwright.ts";
import { minimizeWithBrowser } from "../../src/runner/minimize-browser.ts";
import { useInstalledPlaywrightBrowsers } from "../../src/runner/session.ts";
import type { FetchLike } from "../../src/runner/reset.ts";
import { browserProcessNote, browserSnapshot, finishBrowserCleanup, leakedProcessNote, stopDirectChild } from "../process-snapshot.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DUPLICATE_SCENARIO = fileURLToPath(new URL("../../examples/duplicate-submit/scenario.json", import.meta.url));
const STALE_SCENARIO = fileURLToPath(new URL("../../examples/stale-search/scenario.json", import.meta.url));
const DUPLICATE_SPEC = fileURLToPath(new URL("../../artifacts/tuned-duplicate.spec.ts", import.meta.url));
const STALE_SPEC = fileURLToPath(new URL("../../artifacts/tuned-stale.spec.ts", import.meta.url));
const DUPLICATE_REPORT = fileURLToPath(new URL("../../artifacts/tuned-duplicate-report.json", import.meta.url));
const STALE_REPORT = fileURLToPath(new URL("../../artifacts/tuned-stale-report.json", import.meta.url));
const DUPLICATE_CONFIG = fileURLToPath(new URL("./playwright.tuned-duplicate.config.ts", import.meta.url));
const STALE_CONFIG = fileURLToPath(new URL("./playwright.tuned-stale.config.ts", import.meta.url));
const PLAYWRIGHT = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));

const TUNE = {
  resolutionMs: DEFAULT_TIMING_RESOLUTION_MS,
  maxReplayExecutions: DEFAULT_TIMING_MAX_REPLAYS,
  maxWallClockMs: DEFAULT_TIMING_MAX_WALL_CLOCK_MS,
};

/**
 * The default 250ms grid includes 50ms for an 800ms search delay. Two samples can
 * still show the stale overwrite, and renewed minimization can then find no failure
 * because the runner spends longer than 50ms between the searches. The tuner keeps
 * the original scenario in that case. This live check uses a 400ms grid so the
 * measured candidate stays long enough to reproduce on a GitHub-hosted runner.
 */
const STALE_TIMING_RESOLUTION_MS = 400;

describe("verified delay reduction in chromium", { concurrency: false }, () => {
  it("tunes the duplicate-submit POST delay and exports that duration", { timeout: 1_200_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const before = await browserSnapshot();
    const demo = await startDemoServer({ port: 0, appId: "duplicate-submit", resetAuthorization: token });
    const observed = observeFetch(fetch);
    try {
      const scenario = await loadScenarioFile(DUPLICATE_SCENARIO, REPO, {
        REPROSEED_ORIGIN: demo.origin,
        REPROSEED_APP_ID: "duplicate-submit",
        REPROSEED_RESET_AUTHORIZATION: token,
      });
      const beforeSteps = JSON.stringify(scenario.steps);
      const result = await minimizeWithBrowser({
        scenario,
        reportPath: DUPLICATE_REPORT,
        fetchImpl: observed.fetchImpl,
        tuneDelays: TUNE,
      });
      assert.equal(JSON.stringify(scenario.steps), beforeSteps);
      assert.equal(delayMs(scenario, "slow"), 2000);
      const optimization = result.optimization;
      logOptimization("duplicate-submit", optimization);
      assertMeasuredTiming(optimization, 2000, "POST");
      assertCleanResets(observed.events, optimization.totals.replayExecutions, "/api/records", token, "duplicate-submit");
      assert.equal(optimization.timingImproved, true, JSON.stringify(candidateDump(optimization)));
      assertPromoted(optimization, result.report.baselineSignature);
      assert.equal(delayMs(result.scenario, "slow"), optimization.delayStep?.finalMs);
      await writePlaywrightTest(DUPLICATE_SPEC, result.scenario, result.report);
      const source = await readFile(DUPLICATE_SPEC, "utf8");
      assert.equal(source.includes(token), false);
      assert.equal(source.includes(demo.origin), false);
      assert.equal(embeddedDelayMs(source), optimization.delayStep?.finalMs);
      assert.notEqual(embeddedDelayMs(source), 2000);
      assert.match(source, /expect\(actual\)\.toBe\(1\)/);
      const reportText = await readFile(DUPLICATE_REPORT, "utf8");
      assert.equal(reportText.includes(token), false);
      assert.equal(reportText.includes("resetAuthorization"), false);

      const red = await runDuplicate("buggy", token);
      assert.equal(red.code, 1, red.output);
      assert.match(red.output, /Expected:\s*1/);
      assert.match(red.output, /Received:\s*2/);
      assert.equal(red.output.includes(token), false);
      assert.equal(red.postCount, 2);
      const green = await runDuplicate("fixed-pending", token);
      assert.equal(green.code, 0, green.output);
      assert.match(green.output, /1 passed/);
      assert.equal(green.output.includes(token), false);
      assert.equal(green.postCount, 1);
      console.log(`duplicate-submit RED ${red.code} GREEN ${green.code} delay ${optimization.delayStep?.finalMs}`);
    } finally {
      await demo.close();
    }
    const leaks = await finishBrowserCleanup(before);
    assert.deepEqual(leaks.owned, [], await leakedProcessNote(leaks.owned));
  });

  it("tunes the stale-search GET delay and exports that duration", { timeout: 1_200_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const before = await browserSnapshot();
    const demo = await startSearchServer({ port: 0, appId: "stale-search", resetAuthorization: token });
    const observed = observeFetch(fetch);
    try {
      const scenario = await loadScenarioFile(STALE_SCENARIO, REPO, {
        REPROSEED_ORIGIN: demo.origin,
        REPROSEED_APP_ID: "stale-search",
        REPROSEED_RESET_AUTHORIZATION: token,
      });
      const beforeSteps = JSON.stringify(scenario.steps);
      const result = await minimizeWithBrowser({
        scenario,
        reportPath: STALE_REPORT,
        fetchImpl: observed.fetchImpl,
        tuneDelays: { ...TUNE, resolutionMs: STALE_TIMING_RESOLUTION_MS },
      });
      assert.equal(JSON.stringify(scenario.steps), beforeSteps);
      assert.equal(delayMs(scenario, "slow-alpha"), 800);
      const optimization = result.optimization;
      logOptimization("stale-search", optimization);
      assertMeasuredTiming(optimization, 800, "GET");
      assertCleanResets(observed.events, optimization.totals.replayExecutions, "/api/search-history", token, "stale-search");
      assert.equal(optimization.timingImproved, true, JSON.stringify(candidateDump(optimization)));
      assertPromoted(optimization, result.report.baselineSignature);
      assert.equal(optimization.delayStep?.finalMs, STALE_TIMING_RESOLUTION_MS);
      assert.equal(delayMs(result.scenario, "slow-alpha"), optimization.delayStep?.finalMs);
      await writePlaywrightTest(STALE_SPEC, result.scenario, result.report);
      const source = await readFile(STALE_SPEC, "utf8");
      assert.equal(source.includes(token), false);
      assert.equal(source.includes(demo.origin), false);
      assert.equal(embeddedDelayMs(source), optimization.delayStep?.finalMs);
      assert.notEqual(embeddedDelayMs(source), 800);
      assert.match(source, /Results for beta/);
      const reportText = await readFile(STALE_REPORT, "utf8");
      assert.equal(reportText.includes(token), false);
      assert.equal(reportText.includes("resetAuthorization"), false);

      const red = await runStale("buggy", token);
      assert.equal(red.code, 1, red.output);
      assert.match(red.output, /Expected:\s*"Results for beta"/);
      assert.match(red.output, /Received:\s*"Results for alpha \(outdated\)"/);
      assert.equal(red.output.includes(token), false);
      const green = await runStale("fixed-generation", token);
      assert.equal(green.code, 0, green.output);
      assert.match(green.output, /1 passed/);
      assert.equal(green.output.includes(token), false);
      console.log(`stale-search RED ${red.code} GREEN ${green.code} delay ${optimization.delayStep?.finalMs}`);
    } finally {
      await demo.close();
    }
    const leaks = await finishBrowserCleanup(before);
    assert.deepEqual(leaks.owned, [], await leakedProcessNote(leaks.owned));
  });
});

function stageFailure(optimization: DurationOptimization): string {
  const outcome = optimization.stage1.replays[0]?.outcome;
  const detail = outcome?.status === "error" || outcome?.status === "timeout" ? outcome.error : undefined;
  return `${optimization.searchStatus}; stage 1 ${optimization.stage1.status}; ${detail ?? optimization.stage1.claim}`;
}

function assertMeasuredTiming(optimization: DurationOptimization, originalMs: number, method: "GET" | "POST"): void {
  assert.equal(optimization.requested, true);
  assert.equal(optimization.delayStep?.originalMs, originalMs, stageFailure(optimization));
  assert.equal(optimization.delayStep?.method, method);
  assert.ok(optimization.candidates.length > 0);
  assert.ok(optimization.replays.length > 0);
  for (const candidate of optimization.candidates) {
    assert.equal(Number.isSafeInteger(candidate.durationMs), true);
    assert.ok(candidate.durationMs >= 1);
    assert.ok(candidate.durationMs < originalMs);
    assert.equal(candidate.replayIds.length, candidate.samples.length);
    assert.ok(candidate.replayIds.length > 0);
  }
  assert.equal(optimization.budget.replayExecutions, optimization.replays.length);
  assert.equal(
    optimization.totals.replayExecutions,
    optimization.totals.stage1Replays + optimization.totals.timingReplays + optimization.totals.stage3Replays,
  );
  assert.equal(optimization.stage1.status, "verified-one-minimal");
  assert.equal(optimization.stage1.counts.verifyReplays, 5);
  const confirmed = optimization.candidates.filter((candidate) => candidate.classification === "confirmed");
  for (const candidate of confirmed) {
    assert.equal(candidate.replayIds.length >= 2, true);
    assert.equal(new Set(candidate.replayIds).size, candidate.replayIds.length);
    for (const replayId of candidate.replayIds) {
      const replay = optimization.replays.find((item) => item.id === replayId);
      assert.ok(replay);
      assert.equal(replay?.durationMs, candidate.durationMs);
      assert.equal(replay?.outcome.status, "fail");
      assert.ok(
        (replay?.outcome.durationMs ?? 0) >= candidate.durationMs,
        `replay ${replayId} lasted ${replay?.outcome.durationMs}ms for a ${candidate.durationMs}ms delay`,
      );
    }
  }
}

function assertPromoted(optimization: DurationOptimization, exportedSignature: TargetSignature | undefined): void {
  const stage3 = optimization.stage3;
  assert.ok(stage3);
  assert.equal(stage3?.status, "verified-one-minimal");
  assert.equal(optimization.fullyVerified, true);
  assert.equal(optimization.retainedOriginal, false);
  assert.equal(optimization.exportedScenario, "tuned");
  assert.ok(optimization.delayStep?.selectedMs !== undefined && optimization.delayStep.selectedMs < optimization.delayStep.originalMs);
  assert.equal(optimization.delayStep?.finalMs, optimization.delayStep?.selectedMs);
  assert.ok(stage3?.baselineSignature);
  assert.ok(optimization.stage1.baselineSignature);
  if (stage3?.baselineSignature && optimization.stage1.baselineSignature) {
    assert.equal(signaturesEqual(stage3.baselineSignature, optimization.stage1.baselineSignature), true);
  }
  assert.ok(exportedSignature);
  if (exportedSignature && optimization.stage1.baselineSignature) {
    assert.equal(signaturesEqual(exportedSignature, optimization.stage1.baselineSignature), true);
  }
  const verify = stage3?.replays.filter((replay) => replay.phase === "verify") ?? [];
  assert.equal(verify.length, 5);
  assert.equal(new Set(verify.map((replay) => replay.id)).size, 5);
  const stage1VerifyIds = new Set(optimization.stage1.replays.filter((replay) => replay.phase === "verify").map((replay) => replay.id));
  assert.equal(stage1VerifyIds.size, 5);
  for (const replay of verify) {
    assert.equal(replay.outcome.status, "fail");
    if (replay.outcome.status === "fail" && optimization.stage1.baselineSignature) {
      assert.equal(signaturesEqual(replay.outcome.signature, optimization.stage1.baselineSignature), true);
    }
    assert.ok(replay.outcome.durationMs >= (optimization.delayStep?.finalMs ?? 1));
  }
  const lastRound = Math.max(...(stage3?.singleDeletion.map((entry) => entry.round) ?? [0]));
  const last = stage3?.singleDeletion.filter((entry) => entry.round === lastRound) ?? [];
  assert.deepEqual(
    last.map((entry) => entry.removedId).sort(),
    [...(stage3?.keptStepIds ?? [])].sort(),
  );
  assert.equal(last.some((entry) => entry.candidateClass === "target"), false);
  assert.equal(optimization.totals.stage3Replays, stage3?.replays.length);
  assert.ok((stage3?.replays.length ?? 0) > 5);
}

function candidateDump(optimization: DurationOptimization): unknown {
  return {
    status: optimization.searchStatus,
    promotion: optimization.promotion,
    candidates: optimization.candidates.map((candidate) => ({
      ms: candidate.durationMs,
      phase: candidate.phase,
      classification: candidate.classification,
    })),
    notStarted: optimization.notStartedDurations,
    totals: optimization.totals,
    claim: optimization.claim,
  };
}

function logOptimization(example: string, optimization: DurationOptimization): void {
  console.log(
    JSON.stringify(
      {
        example,
        originalMs: optimization.delayStep?.originalMs,
        selectedMs: optimization.delayStep?.selectedMs,
        finalMs: optimization.delayStep?.finalMs,
        searchStatus: optimization.searchStatus,
        promotion: optimization.promotion,
        candidates: optimization.candidates.map((candidate) => ({
          ms: candidate.durationMs,
          phase: candidate.phase,
          classification: candidate.classification,
          samples: candidate.samples.map((sample) => sample.classification),
        })),
        notStarted: optimization.notStartedDurations,
        totals: optimization.totals,
        timingElapsedMs: optimization.budget.elapsedMs,
        stage1ElapsedMs: optimization.stage1.budget.elapsedMs,
        stage3ElapsedMs: optimization.stage3?.budget.elapsedMs,
        stage1Kept: optimization.stage1.keptStepIds,
        stage3Kept: optimization.stage3?.keptStepIds,
        additionalRemoved: optimization.additionalRemovedStepIds,
        stage1Verify: optimization.stage1.replays.filter((replay) => replay.phase === "verify").map((replay) => replay.outcome.status),
        stage3Verify: optimization.stage3?.replays.filter((replay) => replay.phase === "verify").map((replay) => replay.outcome.status),
      },
      null,
      2,
    ),
  );
}

type FetchEvent = {
  method: string;
  pathname: string;
  appId?: string;
  authorization?: string;
  body: unknown;
};

function observeFetch(inner: typeof fetch): { fetchImpl: FetchLike; events: FetchEvent[] } {
  const events: FetchEvent[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const response = await inner(input, init);
    const text = await response.clone().text();
    let body: unknown;
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    const url = requestUrl(input);
    events.push({
      method: init?.method ?? "GET",
      pathname: url.pathname,
      appId: headerValue(init?.headers, "x-reproseed-app-id"),
      authorization: headerValue(init?.headers, "x-reproseed-reset-authorization"),
      body,
    });
    return response;
  };
  return { fetchImpl, events };
}

function assertCleanResets(
  events: readonly FetchEvent[],
  replays: number,
  confirmPath: string,
  token: string,
  appId: string,
): void {
  let resets = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.method !== "POST" || event.pathname !== "/__reproseed/reset") {
      continue;
    }
    resets += 1;
    const identity = events[index - 1];
    const confirm = events[index + 1];
    assert.equal(identity?.pathname, "/__reproseed/identity");
    assert.equal(event.appId, appId);
    assert.equal(event.authorization, token);
    assert.equal(confirm?.method, "GET");
    assert.equal(confirm?.pathname, confirmPath);
    assert.ok(Array.isArray(confirm?.body), JSON.stringify(confirm?.body));
    assert.equal((confirm?.body as unknown[]).length, 0);
  }
  assert.equal(resets, replays);
}

function delayMs(scenario: Scenario, id: string): number {
  const step = scenario.steps.find((candidate) => candidate.id === id);
  assert.equal(step?.kind, "delay");
  if (step?.kind !== "delay") {
    throw new Error(`${id} was not a delay`);
  }
  return step.ms;
}

function embeddedDelayMs(source: string): number {
  const marker = "const scenario = ";
  const start = source.indexOf(marker);
  const expressionStart = start + marker.length;
  const end = source.indexOf(" as ExportedScenario;", expressionStart);
  const value = vm.runInNewContext(source.slice(expressionStart, end), { JSON }) as {
    steps: Array<{ kind: string; ms?: number }>;
  };
  const delay = value.steps.find((step) => step.kind === "delay");
  if (delay?.ms === undefined) {
    throw new Error("exported spec has no delay");
  }
  return delay.ms;
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
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return typeof found?.[1] === "string" ? found[1] : undefined;
  }
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

async function runDuplicate(page: DemoPage, token: string): Promise<{ code: number; output: string; postCount: number }> {
  const demo = await startDemoServer({ port: 0, appId: "duplicate-submit", resetAuthorization: token, page });
  try {
    const result = await runPlaywright(DUPLICATE_CONFIG, demo.origin, "duplicate-submit", token);
    return { ...result, postCount: demo.postCount() };
  } finally {
    await demo.close();
  }
}

async function runStale(page: SearchPage, token: string): Promise<{ code: number; output: string }> {
  const demo = await startSearchServer({ port: 0, appId: "stale-search", resetAuthorization: token, page });
  try {
    return await runPlaywright(STALE_CONFIG, demo.origin, "stale-search", token);
  } finally {
    await demo.close();
  }
}

function runPlaywright(config: string, origin: string, appId: string, token: string): Promise<{ code: number; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEBUG;
  useInstalledPlaywrightBrowsers(env);
  env.REPROSEED_ORIGIN = origin;
  env.REPROSEED_APP_ID = appId;
  env.REPROSEED_RESET_AUTHORIZATION = token;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PLAYWRIGHT, "test", "--config", config, "--retries=0", "--workers=1", "--reporter=line"], {
      cwd: REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopDirectChild(child);
    }, 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = stripAnsi(Buffer.concat(chunks).toString("utf8"));
      if (!timedOut) {
        resolve({ code: code ?? 1, output });
        return;
      }
      void browserProcessNote().then((note) => {
        resolve({ code: code ?? 1, output: `${output}\n${note}\n` });
      });
    });
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
