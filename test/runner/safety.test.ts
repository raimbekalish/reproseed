import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { ExecutionOutcome, Scenario, Step } from "../../src/core/types.ts";
import { recordCountOutcome } from "../../src/runner/oracle.ts";
import { startReplayRuntime, type ReplayRuntime } from "../../src/runner/replay.ts";
import { resolveAuthorizedUrl } from "../../src/runner/safety.ts";

describe("replay safety", () => {
  it("keeps the minimizer free of Playwright", () => {
    const directory = fileURLToPath(new URL("../../src/core/", import.meta.url));
    const files = readdirSync(directory).filter((file) => file.endsWith(".ts"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = readFileSync(`${directory}/${file}`, "utf8");
      assert.doesNotMatch(source, /from ["']playwright["']/, file);
    }
  });

  it("classifies record counts without calling them the wrong failure", () => {
    assert.equal(recordCountOutcome({ email: "a@example.com", actual: 1, expect: 1, durationMs: 4 }).status, "pass");
    const duplicate = recordCountOutcome({ email: "a@example.com", actual: 2, expect: 1, durationMs: 4 });
    const mismatch = recordCountOutcome({ email: "a@example.com", actual: 0, expect: 1, durationMs: 4 });
    const aboveZero = recordCountOutcome({ email: "a@example.com", actual: 1, expect: 0, durationMs: 4 });
    assert.equal(duplicate.status, "fail");
    assert.equal(mismatch.status, "fail");
    assert.equal(aboveZero.status, "fail");
    if (duplicate.status !== "fail" || mismatch.status !== "fail" || aboveZero.status !== "fail") {
      return;
    }
    assert.equal(duplicate.signature.code, "DUPLICATE");
    assert.equal(mismatch.signature.code, "COUNT_MISMATCH");
    assert.equal(aboveZero.signature.code, "DUPLICATE");
  });

  it("refuses paths that leave the authorized origin", () => {
    const origin = "http://127.0.0.1:4010";
    assert.equal(resolveAuthorizedUrl(origin, "/api/records").href, "http://127.0.0.1:4010/api/records");
    for (const path of ["https://example.com/", "//example.com/x", "/\\evil", "javascript:alert(1)", "not-absolute"]) {
      assert.throws(() => resolveAuthorizedUrl(origin, path), /authorized origin/, path);
    }
  });

  it("rejects unsafe targets and invalid subsets before reset or browser launch", async () => {
    let fetches = 0;
    let launches = 0;
    const runtime = startReplayRuntime({
      fetchImpl: async () => {
        fetches += 1;
        throw new Error("fetch should not run");
      },
      launchBrowser: async () => {
        launches += 1;
        throw new Error("browser should not launch");
      },
    });
    try {
      const cases: Array<{ scenario: Scenario; ids: string[]; pattern: RegExp }> = [
        { scenario: scenario("http://example.com"), ids: ["open"], pattern: /non-loopback/ },
        { scenario: scenario("https://127.0.0.1:4010"), ids: ["open"], pattern: /non-http/ },
        { scenario: scenario("http://user:pass@127.0.0.1:4010"), ids: ["open"], pattern: /credentials/ },
        { scenario: scenario("http://127.0.0.1:4010/admin"), ids: ["open"], pattern: /must be an origin/ },
        { scenario: scenarioWith({ appId: " " }), ids: ["open"], pattern: /appId is required/ },
        { scenario: scenarioWith({ resetAuthorization: " " }), ids: ["open"], pattern: /resetAuthorization is required/ },
        {
          scenario: scenarioWith({ steps: [goto("https://example.com/")] }),
          ids: ["open"],
          pattern: /authorized origin/,
        },
        { scenario: scenario("http://127.0.0.1:4010"), ids: ["submit-1"], pattern: /missing dependencies/ },
        { scenario: scenario("http://127.0.0.1:4010"), ids: ["missing"], pattern: /unknown step/ },
        { scenario: scenario("http://127.0.0.1:4010"), ids: ["open", "open"], pattern: /duplicate step/ },
      ];
      for (const testCase of cases) {
        const outcome = await runtime.probeFor(testCase.scenario)(testCase.ids);
        assertRunner(outcome, "RUNNER_ERROR", testCase.pattern);
      }
      assert.equal(fetches, 0);
      assert.equal(launches, 0);
    } finally {
      await runtime.close();
    }
  });

  it("does not follow a reset redirect to another origin", async () => {
    const hits: string[] = [];
    const trap = createServer((request, response) => {
      hits.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("trapped");
    });
    const trapOrigin = await listen(trap);
    const app = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/__reproseed/identity") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ appId: "duplicate-submit" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/__reproseed/reset") {
        response.writeHead(302, { location: `${trapOrigin}/stolen` });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const origin = await listen(app);
    let launches = 0;
    const runtime = guardedRuntime(() => {
      launches += 1;
    });
    try {
      const outcome = await runtime.probeFor(scenario(origin))(["open"]);
      assertRunner(outcome, "RESET_FAILED", /redirect/i);
      assert.equal(launches, 0);
      assert.deepEqual(hits, []);
    } finally {
      await runtime.close();
      await closeServer(app);
      await closeServer(trap);
    }
  });
});

function guardedRuntime(onLaunch: () => void): ReplayRuntime {
  return startReplayRuntime({
    launchBrowser: async () => {
      onLaunch();
      throw new Error("browser should not launch");
    },
  });
}

function scenario(origin: string): Scenario {
  return scenarioWith({ origin });
}

function scenarioWith(overrides: {
  origin?: string;
  appId?: string;
  resetAuthorization?: string;
  steps?: Step[];
}): Scenario {
  return {
    id: "duplicate-submit",
    target: {
      origin: overrides.origin ?? "http://127.0.0.1:4010",
      appId: overrides.appId ?? "duplicate-submit",
      resetAuthorization: overrides.resetAuthorization ?? "token",
    },
    reset: { method: "POST", path: "/__reproseed/reset" },
    steps: overrides.steps ?? [
      goto("/"),
      { id: "email", kind: "fill", selector: "#email", value: "a@example.com", dependsOn: ["open"] },
      { id: "submit-1", kind: "click", selector: "#submit", dependsOn: ["open", "email"] },
    ],
    oracle: {
      id: "record-count",
      request: { method: "GET", path: "/api/records" },
      match: { field: "email", value: "a@example.com" },
      expect: 1,
    },
    budget: {
      maxReplayExecutions: 10,
      maxWallClockMs: 30_000,
      attemptTimeoutMs: 5_000,
      baselineRuns: 2,
      reductionConfirmRuns: 2,
      verifyRuns: 5,
    },
  };
}

function goto(path: string): Step {
  return { id: "open", kind: "goto", path, dependsOn: [] };
}

function assertRunner(outcome: ExecutionOutcome, code: "RUNNER_ERROR" | "RESET_FAILED", pattern: RegExp): void {
  assert.equal(outcome.status, "error", JSON.stringify(outcome));
  if (outcome.status !== "error") {
    return;
  }
  assert.equal(outcome.signature?.oracleId, "runner", JSON.stringify(outcome));
  if (outcome.signature?.oracleId !== "runner") {
    return;
  }
  assert.equal(outcome.signature.code, code, outcome.signature.facts.message);
  assert.match(outcome.signature.facts.message, pattern);
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
