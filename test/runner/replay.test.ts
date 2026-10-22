import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";

import { fetchRecords, resetAndConfirmEmpty } from "../../examples/duplicate-submit/harness.ts";
import { startDemoServer, type DemoServer } from "../../examples/duplicate-submit/server.ts";
import type { Budget, ExecutionOutcome, Scenario, Step } from "../../src/core/types.ts";
import { startReplayRuntime, type ReplayRuntime } from "../../src/runner/replay.ts";

const APP_ID = "duplicate-submit";
const REPETITIONS = 5;
const RESPONSE_DELAY_MS = 2_000;

describe("playwright scenario replay", { concurrency: false }, () => {
  before(async () => {
    resetAuthorization = randomBytes(16).toString("hex");
    demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization });
    runtime = startReplayRuntime();
  });

  after(async () => {
    await runtime?.close();
    await demo?.close();
  });

  it("scenario A: an 800ms gap during a 2000ms response delay creates two records", { timeout: 180_000 }, async () => {
    const active = requireActive();
    for (let iteration = 1; iteration <= REPETITIONS; iteration += 1) {
      const email = `delay-${iteration}@example.com`;
      const outcome = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, RESPONSE_DELAY_MS))(stepIds(true));
      assertDuplicate(outcome, email);
      const records = await fetchRecords(active.demo.origin);
      assert.equal(records.length, 2, `iteration ${iteration} leaked records`);
      assert.ok(
        records.every((record) => Date.now() - record.createdAt >= 1_200),
        `iteration ${iteration} released the response before the server had been ahead by the delay: ${records
          .map((record) => Date.now() - record.createdAt)
          .join(",")}`,
      );
    }
  });

  it("scenario B: the same sequence without response latency creates one record", { timeout: 180_000 }, async () => {
    const active = requireActive();
    for (let iteration = 1; iteration <= REPETITIONS; iteration += 1) {
      const email = `fast-${iteration}@example.com`;
      const outcome = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, undefined))(stepIds(false));
      assertPass(outcome);
      assert.equal((await fetchRecords(active.demo.origin)).length, 1, `iteration ${iteration} record count`);
    }
  });

  it("scenario C: two submits 100ms apart create one record while the response is delayed", { timeout: 180_000 }, async () => {
    const active = requireActive();
    for (let iteration = 1; iteration <= REPETITIONS; iteration += 1) {
      const email = `rapid-${iteration}@example.com`;
      const outcome = await active.runtime.probeFor(doubleSubmitScenario(active, email, 100, RESPONSE_DELAY_MS))(stepIds(true));
      assertPass(outcome);
      assert.equal((await fetchRecords(active.demo.origin)).length, 1, `iteration ${iteration} record count`);
    }
  });

  it("isolates consecutive replays of the failing and passing sequences", { timeout: 60_000 }, async () => {
    const active = requireActive();
    const email = "isolated@example.com";
    const duplicate = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, RESPONSE_DELAY_MS))(stepIds(true));
    assertDuplicate(duplicate, email);
    const control = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, undefined))(stepIds(false));
    assertPass(control);
    assert.equal((await fetchRecords(active.demo.origin)).length, 1);
    const again = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, RESPONSE_DELAY_MS))(stepIds(true));
    assertDuplicate(again, email);
    assert.equal((await fetchRecords(active.demo.origin)).length, 2);
  });

  it("reports an oracle mismatch when the count is below the expectation", { timeout: 30_000 }, async () => {
    const active = requireActive();
    const email = "mismatch@example.com";
    const steps: Step[] = [
      { id: "open", kind: "goto", path: "/", dependsOn: [] },
      { id: "email", kind: "fill", selector: "#email", value: email, dependsOn: ["open"] },
      { id: "submit-1", kind: "click", selector: "#submit", dependsOn: ["open", "email"] },
    ];
    const outcome = await active.runtime.probeFor(buildScenario(active, email, steps, 2))(steps.map((step) => step.id));
    assert.equal(outcome.status, "fail", JSON.stringify(outcome));
    if (outcome.status !== "fail" || outcome.signature.oracleId !== "record-count") {
      return;
    }
    assert.equal(outcome.signature.code, "COUNT_MISMATCH");
    assert.equal(outcome.signature.facts.actual, 1);
    assert.equal(outcome.signature.facts.expect, 2);
  });

  it("refuses a bad reset and leaves existing records in place", { timeout: 30_000 }, async () => {
    const active = requireActive();
    await resetAndConfirmEmpty({
      origin: active.demo.origin,
      expectedAppId: APP_ID,
      resetAuthorization: active.resetAuthorization,
    });
    await seed(active.demo.origin, "kept@example.com");
    const wrongToken = await active.runtime.probeFor(
      buildScenario(active, "kept@example.com", [openStep()], 1, { resetAuthorization: "not-the-runtime-token" }),
    )(["open"]);
    assertRunner(wrongToken, "RESET_FAILED", /reset failed/);
    const wrongApp = await active.runtime.probeFor(
      buildScenario(active, "kept@example.com", [openStep()], 1, { appId: "other-app" }),
    )(["open"]);
    assertRunner(wrongApp, "RESET_FAILED", /identity does not match/);
    const missingToken = await active.runtime.probeFor(
      buildScenario(active, "kept@example.com", [openStep()], 1, { resetAuthorization: " " }),
    )(["open"]);
    assertRunner(missingToken, "RUNNER_ERROR", /resetAuthorization is required/);
    const missingDependency = await active.runtime.probeFor(doubleSubmitScenario(active, "kept@example.com", 800, undefined))([
      "submit-1",
    ]);
    assertRunner(missingDependency, "RUNNER_ERROR", /missing dependencies/);
    assert.deepEqual(
      (await fetchRecords(active.demo.origin)).map((record) => record.email),
      ["kept@example.com"],
    );
  });

  it("times out a stuck replay, closes its context, and leaves the next replay usable", { timeout: 30_000 }, async () => {
    const active = requireActive();
    const started = Date.now();
    const outcome = await active.runtime.probeFor(
      buildScenario(
        active,
        "timeout@example.com",
        [openStep(), { id: "gap", kind: "wait", ms: 30_000, dependsOn: [] }],
        0,
        { attemptTimeoutMs: 800 },
      ),
    )(["open", "gap"]);
    assertRunner(outcome, "TIMEOUT", /timed out/);
    assert.ok(Date.now() - started < 8_000, `timeout took ${Date.now() - started}ms`);
    assert.equal(active.runtime.currentBrowser()?.contexts().length ?? 0, 0);
    const email = "after-timeout@example.com";
    const next = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, undefined))(stepIds(false));
    assertPass(next);
  });

  it("cleans up after an invalid action and still accepts the next replay", { timeout: 30_000 }, async () => {
    const active = requireActive();
    const outcome = await active.runtime.probeFor(
      buildScenario(
        active,
        "missing@example.com",
        [openStep(), { id: "missing", kind: "click", selector: "#does-not-exist", dependsOn: ["open"] }],
        1,
        { attemptTimeoutMs: 1_000 },
      ),
    )(["open", "missing"]);
    assert.notEqual(outcome.status, "fail", JSON.stringify(outcome));
    assert.notEqual(outcome.status, "pass", JSON.stringify(outcome));
    if (outcome.status === "error" || outcome.status === "timeout") {
      assert.equal(outcome.signature?.oracleId, "runner");
    }
    assert.equal(active.runtime.currentBrowser()?.contexts().length ?? 0, 0);
    const email = "after-invalid@example.com";
    assertPass(await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, undefined))(stepIds(false)));
  });

  it("does not follow a cross-origin navigation redirect", { timeout: 30_000 }, async () => {
    const active = requireActive();
    const hits: string[] = [];
    const trap = createServer((request, response) => {
      hits.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<p>trapped</p>");
    });
    const trapOrigin = await listen(trap);
    const token = randomBytes(16).toString("hex");
    const app = createServer((request, response) => {
      handleRedirectApp(request, response, trapOrigin, token);
    });
    const origin = await listen(app);
    try {
      const steps: Step[] = [openStep()];
      const outcome = await active.runtime.probeFor({
        ...buildScenario(active, "redirect@example.com", steps, 1, { attemptTimeoutMs: 8_000 }),
        target: { origin, appId: APP_ID, resetAuthorization: token },
      })(["open"]);
      assertRunner(outcome, "RUNNER_ERROR");
      assert.deepEqual(hits, []);
    } finally {
      await closeServer(app);
      await closeServer(trap);
    }
  });

  it("relaunches the browser after it is closed and after it is killed mid-replay", { timeout: 40_000 }, async () => {
    const active = requireActive();
    const email = "relaunch@example.com";
    assertPass(await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, undefined))(stepIds(false)));
    const first = active.runtime.currentBrowser();
    assert.ok(first?.isConnected());
    await first?.close();
    const relaunched = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, undefined))(stepIds(false));
    assertPass(relaunched);
    assert.equal(active.runtime.currentBrowser()?.isConnected(), true);

    const pending = active.runtime.probeFor(
      buildScenario(
        active,
        "crash@example.com",
        [openStep(), { id: "gap", kind: "wait", ms: 30_000, dependsOn: [] }],
        0,
        { attemptTimeoutMs: 15_000 },
      ),
    )(["open", "gap"]);
    await waitUntil(() => active.runtime.currentBrowser()?.isConnected() === true, 10_000, "browser launch");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const browser = active.runtime.currentBrowser();
    if (browser === undefined || !browser.isConnected()) {
      throw new Error("browser was not connected before the crash");
    }
    const session = await browser.newBrowserCDPSession();
    void session.send("Browser.crash").catch(() => undefined);
    const crashed = await pending;
    assertRunner(crashed, "RUNNER_ERROR", /browser closed/);
    const recovered = await active.runtime.probeFor(doubleSubmitScenario(active, email, 800, undefined))(stepIds(false));
    assertPass(recovered);
  });
});

type Active = { demo: DemoServer; runtime: ReplayRuntime; resetAuthorization: string };

function requireActive(): Active {
  if (demo === undefined || runtime === undefined) {
    throw new Error("replay runtime was not started");
  }
  return { demo, runtime, resetAuthorization };
}

let demo: DemoServer | undefined;
let runtime: ReplayRuntime | undefined;
let resetAuthorization = "";

function doubleSubmitScenario(active: Active, email: string, gapMs: number, delayMs: number | undefined): Scenario {
  return buildScenario(active, email, doubleSubmitSteps(email, gapMs, delayMs), 1);
}

function doubleSubmitSteps(email: string, gapMs: number, delayMs: number | undefined): Step[] {
  const steps: Step[] = [
    openStep(),
    { id: "email", kind: "fill", selector: "#email", value: email, dependsOn: ["open"] },
    { id: "note", kind: "fill", selector: "#note", value: "hello", dependsOn: ["open"] },
    { id: "preview", kind: "click", selector: "#preview", dependsOn: ["open"] },
  ];
  if (delayMs !== undefined) {
    steps.push({
      id: "slow",
      kind: "delay",
      urlIncludes: "/api/records",
      method: "POST",
      ms: delayMs,
      dependsOn: [],
    });
  }
  steps.push(
    { id: "submit-1", kind: "click", selector: "#submit", dependsOn: ["open", "email"] },
    { id: "gap", kind: "wait", ms: gapMs, dependsOn: [] },
    { id: "submit-2", kind: "click", selector: "#submit", dependsOn: ["open", "email"] },
  );
  return steps;
}

function stepIds(includeDelay: boolean): string[] {
  const ids = ["open", "email", "note", "preview"];
  if (includeDelay) {
    ids.push("slow");
  }
  ids.push("submit-1", "gap", "submit-2");
  return ids;
}

function openStep(): Step {
  return { id: "open", kind: "goto", path: "/", dependsOn: [] };
}

function buildScenario(
  active: Active,
  email: string,
  steps: Step[],
  expect: number,
  overrides: { appId?: string; resetAuthorization?: string; attemptTimeoutMs?: number } = {},
): Scenario {
  const budget: Budget = {
    maxReplayExecutions: 20,
    maxWallClockMs: 120_000,
    attemptTimeoutMs: overrides.attemptTimeoutMs ?? 20_000,
    baselineRuns: 2,
    reductionConfirmRuns: 2,
    verifyRuns: 5,
  };
  return {
    id: "duplicate-submit",
    target: {
      origin: active.demo.origin,
      appId: overrides.appId ?? APP_ID,
      resetAuthorization: overrides.resetAuthorization ?? active.resetAuthorization,
    },
    reset: { method: "POST", path: "/__reproseed/reset" },
    steps,
    oracle: {
      id: "record-count",
      request: { method: "GET", path: "/api/records" },
      match: { field: "email", value: email },
      expect,
    },
    budget,
  };
}

function assertDuplicate(outcome: ExecutionOutcome, email: string): void {
  assert.equal(outcome.status, "fail", JSON.stringify(outcome));
  if (outcome.status !== "fail" || outcome.signature.oracleId !== "record-count") {
    return;
  }
  assert.equal(outcome.signature.code, "DUPLICATE");
  assert.equal(outcome.signature.facts.actual, 2);
  assert.equal(outcome.signature.facts.expect, 1);
  assert.equal(outcome.signature.facts.email, email);
}

function assertPass(outcome: ExecutionOutcome): void {
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
}

function assertRunner(
  outcome: ExecutionOutcome,
  code: "TIMEOUT" | "RUNNER_ERROR" | "RESET_FAILED",
  pattern?: RegExp,
): void {
  assert.equal(outcome.status, code === "TIMEOUT" ? "timeout" : "error", JSON.stringify(outcome));
  if (outcome.status !== "error" && outcome.status !== "timeout") {
    return;
  }
  assert.equal(outcome.signature?.oracleId, "runner", JSON.stringify(outcome));
  if (outcome.signature?.oracleId !== "runner") {
    return;
  }
  assert.equal(outcome.signature.code, code, outcome.signature.facts.message);
  if (pattern !== undefined) {
    assert.match(outcome.signature.facts.message, pattern);
  }
}

async function seed(origin: string, email: string): Promise<void> {
  const response = await fetch(new URL("/api/records", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(response.status, 201);
}

function handleRedirectApp(request: IncomingMessage, response: ServerResponse, trapOrigin: string, token: string): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/__reproseed/identity") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ appId: APP_ID }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/__reproseed/reset") {
    const appHeader = request.headers["x-reproseed-app-id"];
    const authHeader = request.headers["x-reproseed-reset-authorization"];
    if (appHeader !== APP_ID || authHeader !== token) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "reset refused" }));
      return;
    }
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(302, { location: `${trapOrigin}/stolen` });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/records") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
    return;
  }
  response.writeHead(404);
  response.end();
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
