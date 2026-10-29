import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "../../src/cli/scenario-file.ts";
import type { ExecutionOutcome, Scenario, Step } from "../../src/core/types.ts";
import { installMatchedResponseDelay, installOriginGuard } from "../../src/runner/faults.ts";
import { startReplayRuntime } from "../../src/runner/replay.ts";
import { launchChromium } from "../../src/runner/session.ts";
import { startSearchServer, type SearchServer } from "../../examples/stale-search/server.ts";

const APP_ID = "stale-search";
const DELAY_GAP_MS = 500;
const DELAY_CEILING_MS = 4_000;

type DelayReading = {
  elapsed: number;
  getHits: number;
  postHits: number;
};
const SCENARIO = fileURLToPath(new URL("../../examples/stale-search/scenario.json", import.meta.url));
const STALE_SIGNATURE = {
  oracleId: "dom-text" as const,
  code: "DOM_MISMATCH" as const,
  facts: {
    selector: "#results",
    expect: "Results for beta",
    actual: "Results for alpha (outdated)",
  },
};

describe("stale search replay", { concurrency: false }, () => {
  it("reproduces DOM_MISMATCH and passes without the GET delay", { timeout: 180_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const demo = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const runtime = startReplayRuntime();
    try {
      const scenario = await loadSearchScenario(demo, token);
      const ids = scenario.steps.map((step) => step.id);
      for (let iteration = 1; iteration <= 3; iteration += 1) {
        const failed = await runtime.probeFor(scenario)(ids);
        assert.equal(failed.status, "fail", `iteration ${iteration} ${JSON.stringify(failed)}`);
        if (failed.status === "fail") {
          assert.deepEqual(failed.signature, STALE_SIGNATURE);
        }
      }
      const withoutDelay = ids.filter((id) => id !== "slow-alpha");
      for (let iteration = 1; iteration <= 5; iteration += 1) {
        const passed = await runtime.probeFor(scenario)(withoutDelay);
        assert.equal(passed.status, "pass", `control ${iteration} ${JSON.stringify(passed)}`);
      }
    } finally {
      await runtime.close();
      await demo.close();
    }
  });

  it("handles invalid selectors, missing elements, timeouts, unsafe URLs, and unauthorized resets", { timeout: 180_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const demo = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const runtime = startReplayRuntime();
    try {
      const scenario = await loadSearchScenario(demo, token);
      const open = scenario.steps.find((step) => step.id === "open");
      assert.ok(open);

      const missing = await runtime.probeFor(withOracle(scenario, "#missing", [open]))([open.id]);
      assertRunner(missing, "RUNNER_ERROR", /matched no element/);

      const multiple = await runtime.probeFor(withOracle(scenario, "button", [open]))([open.id]);
      assertRunner(multiple, "RUNNER_ERROR", /matched 2 elements/);

      const invalid = await runtime.probeFor(withOracle(scenario, "[", [open]))([open.id]);
      assertRunner(invalid, "RUNNER_ERROR", /invalid/);
      assert.notEqual(invalid.status === "fail" && invalid.signature.code, "DOM_MISMATCH");

      const badClick: Step = { id: "bad-click", kind: "click", selector: "[", dependsOn: ["open"] };
      const clicked = await runtime.probeFor(replaceSteps(scenario, [open, badClick]))([open.id, badClick.id]);
      assertRunner(clicked, "RUNNER_ERROR", /selector|syntax|unknown/i);
      if (clicked.status === "fail") {
        assert.notEqual(clicked.signature.code, "DOM_MISMATCH");
      }

      const slow: Step = { id: "too-slow", kind: "wait", ms: 20_000, dependsOn: [] };
      const timedOut = await runtime.probeFor(replaceSteps(scenario, [open, slow], 4_000))([open.id, slow.id]);
      assert.equal(timedOut.status, "timeout", JSON.stringify(timedOut));

      const unsafe = replaceSteps(scenario, [{ id: "open", kind: "goto", path: "https://example.com/phish", dependsOn: [] }]);
      const refused = await runtime.probeFor(unsafe)(["open"]);
      assertRunner(refused, "RUNNER_ERROR", /authorized origin/);

      const relative = replaceSteps(scenario, [{ id: "open", kind: "goto", path: "//evil.example/phish", dependsOn: [] }]);
      const protocolRelative = await runtime.probeFor(relative)(["open"]);
      assertRunner(protocolRelative, "RUNNER_ERROR", /authorized origin/);

      let launches = 0;
      const unauthorized = startReplayRuntime({
        launchBrowser: async () => {
          launches += 1;
          throw new Error("browser should not launch");
        },
      });
      try {
        const wrong = await loadSearchScenario(demo, token);
        wrong.target = { ...wrong.target, resetAuthorization: randomBytes(16).toString("hex") };
        const outcome = await unauthorized.probeFor(wrong)(["open"]);
        assertRunner(outcome, "RESET_FAILED", /reset failed/);
        assert.equal(launches, 0);
      } finally {
        await unauthorized.close();
      }
    } finally {
      await runtime.close();
      await demo.close();
    }
  });

  it("does not let GET and POST response delays interfere", { timeout: 60_000 }, async () => {
    const demo = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: randomBytes(16).toString("hex") });
    const browser = await launchChromium();
    try {
      const context = await browser.newContext();
      await installOriginGuard(context, demo.origin);
      let getHits = 0;
      let postHits = 0;
      const getDelay = await installMatchedResponseDelay(context, {
        origin: demo.origin,
        urlIncludes: "/api/search?q=alpha",
        method: "GET",
        ms: 700,
        onDelayed: () => {
          getHits += 1;
        },
      });
      const postDelay = await installMatchedResponseDelay(context, {
        origin: demo.origin,
        urlIncludes: "/api/post-probe",
        method: "POST",
        ms: 700,
        onDelayed: () => {
          postHits += 1;
        },
      });
      const page = await context.newPage();
      const sample = async (path: string, method: "GET" | "POST", body?: string): Promise<DelayReading> => {
        const before = { getHits, postHits };
        const elapsed = await page.evaluate(
          async (request: { path: string; method: string; body?: string }) => {
            const started = performance.now();
            const response = await fetch(request.path, {
              method: request.method,
              ...(request.body !== undefined
                ? { headers: { "content-type": "application/json" }, body: request.body }
                : {}),
            });
            await response.text();
            return performance.now() - started;
          },
          { path, method, body },
        );
        return { elapsed, getHits: getHits - before.getHits, postHits: postHits - before.postHits };
      };
      const navigationStarted = Date.now();
      await page.goto(demo.origin, { waitUntil: "domcontentloaded" });
      const navigationMs = Date.now() - navigationStarted;
      assert.equal(getHits, 0, `page navigation matched the GET delay after ${navigationMs}ms`);
      assert.equal(postHits, 0, `page navigation matched the POST delay after ${navigationMs}ms`);

      const identity = await sample("/__reproseed/identity", "GET");
      const home = await sample("/", "GET");
      const beta = await sample("/api/search?q=beta", "GET");
      const history = await sample("/api/search-history", "GET");
      const alphabet = await sample("/api/search?q=alphabet", "GET");
      for (const [label, reading] of [
        ["identity", identity],
        ["home", home],
        ["beta", beta],
        ["history", history],
        ["alphabet", alphabet],
      ] as const) {
        assertUntouched(label, reading);
      }
      const undelayed = Math.max(identity.elapsed, home.elapsed, beta.elapsed, history.elapsed, alphabet.elapsed);
      const alpha = await sample("/api/search?q=alpha", "GET");
      const post = await sample("/api/post-probe", "POST", JSON.stringify({ email: "a@example.com", note: "n" }));
      assertDelayed("alpha", alpha, "GET", undelayed);
      assertDelayed("post", post, "POST", undelayed);

      const parallelBefore = { getHits, postHits };
      const parallel = await page.evaluate(async () => {
        const timed = async (path: string): Promise<number> => {
          const started = performance.now();
          const response = await fetch(path);
          await response.text();
          return performance.now() - started;
        };
        const [betaMs, alphaMs] = await Promise.all([timed("/api/search?q=beta"), timed("/api/search?q=alpha")]);
        return { betaMs, alphaMs };
      });
      assert.equal(getHits - parallelBefore.getHits, 1, `parallel GET delay hits, beta ${parallel.betaMs}ms alpha ${parallel.alphaMs}ms`);
      assert.equal(postHits - parallelBefore.postHits, 0, "parallel searches matched the POST delay");
      assert.ok(
        parallel.alphaMs >= parallel.betaMs + DELAY_GAP_MS,
        `parallel alpha ${parallel.alphaMs}ms was not ${DELAY_GAP_MS}ms slower than beta ${parallel.betaMs}ms`,
      );
      assert.ok(parallel.alphaMs < DELAY_CEILING_MS, `parallel alpha took ${parallel.alphaMs}ms`);

      const disposeStarted = Date.now();
      await getDelay.dispose();
      await postDelay.dispose();
      assert.ok(Date.now() - disposeStarted < 2_500, "delay cleanup hung");
      await context.close();
    } finally {
      await browser.close();
      await demo.close();
    }
  });
});

async function loadSearchScenario(demo: SearchServer, token: string): Promise<Scenario> {
  return loadScenarioFile(SCENARIO, fileURLToPath(new URL("../..", import.meta.url)), {
    REPROSEED_ORIGIN: demo.origin,
    REPROSEED_APP_ID: APP_ID,
    REPROSEED_RESET_AUTHORIZATION: token,
  });
}

function replaceSteps(scenario: Scenario, steps: Step[], attemptTimeoutMs = scenario.budget.attemptTimeoutMs): Scenario {
  return {
    ...scenario,
    steps,
    budget: { ...scenario.budget, attemptTimeoutMs },
  };
}

function withOracle(scenario: Scenario, selector: string, steps: Step[]): Scenario {
  return {
    ...replaceSteps(scenario, steps),
    oracle: { id: "dom-text", selector, expect: "Results for beta" },
  };
}

function assertUntouched(label: string, reading: DelayReading): void {
  assert.equal(reading.getHits, 0, `${label} matched the GET delay after ${reading.elapsed}ms`);
  assert.equal(reading.postHits, 0, `${label} matched the POST delay after ${reading.elapsed}ms`);
}

function assertDelayed(label: string, reading: DelayReading, kind: "GET" | "POST", undelayedMs: number): void {
  assert.equal(reading.getHits, kind === "GET" ? 1 : 0, `${label} GET hits ${reading.getHits} in ${reading.elapsed}ms`);
  assert.equal(reading.postHits, kind === "POST" ? 1 : 0, `${label} POST hits ${reading.postHits} in ${reading.elapsed}ms`);
  const floor = undelayedMs + DELAY_GAP_MS;
  assert.ok(
    reading.elapsed >= floor,
    `${label} took ${reading.elapsed}ms; undelayed requests took up to ${undelayedMs}ms`,
  );
  assert.ok(reading.elapsed < DELAY_CEILING_MS, `${label} took ${reading.elapsed}ms`);
}

function assertRunner(outcome: ExecutionOutcome, code: "RUNNER_ERROR" | "RESET_FAILED", pattern: RegExp): void {
  assert.equal(outcome.status, "error", JSON.stringify(outcome));
  if (outcome.status !== "error" || outcome.signature?.oracleId !== "runner") {
    return;
  }
  assert.equal(outcome.signature.code, code, outcome.signature.facts.message);
  assert.match(outcome.signature.facts.message, pattern);
}
