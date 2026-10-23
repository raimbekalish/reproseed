import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CliError, EXIT } from "../../src/cli/errors.ts";
import { loadScenarioFile } from "../../src/cli/scenario-file.ts";
import { duplicateSubmitSteps } from "../fixture.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/duplicate-submit/scenario.json", import.meta.url));
const STALE = fileURLToPath(new URL("../../examples/stale-search/scenario.json", import.meta.url));

describe("scenario file", () => {
  it("loads the duplicate-submit example and keeps the reset credential out of JSON", async () => {
    const token = randomBytes(16).toString("hex");
    const text = await readFile(EXAMPLE, "utf8");
    assert.equal(text.includes("resetAuthorization"), false);
    assert.equal(text.includes(token), false);
    const directory = await mkdtemp(join(tmpdir(), "reproseed-scenario-"));
    try {
      const scenario = await loadScenarioFile(EXAMPLE, directory, env(token));
      assert.equal(scenario.id, "duplicate-submit");
      assert.equal(scenario.target.origin, "http://127.0.0.1:4010");
      assert.equal(scenario.target.appId, "duplicate-submit");
      assert.equal(scenario.target.resetAuthorization, token);
      assert.deepEqual(scenario.steps, duplicateSubmitSteps());
      assert.equal(scenario.steps.length, 9);
      assert.deepEqual(scenario.budget, {
        maxReplayExecutions: 60,
        maxWallClockMs: 300_000,
        attemptTimeoutMs: 20_000,
        baselineRuns: 3,
        reductionConfirmRuns: 2,
        verifyRuns: 5,
      });
      const email = scenario.steps.find((step) => step.id === "email");
      assert.equal(email?.kind, "fill");
      if (email?.kind === "fill") {
        assert.equal(email.value, "a@example.com");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not expand shell or environment syntax", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-literal-"));
    const marker = join(directory, "pwned");
    try {
      const literal = `$(touch ${marker})`;
      const path = await writeScenario(directory, (scenario) => {
        const email = scenario.steps.find((step) => step.id === "email");
        assert.ok(email);
        email.value = literal;
        email.note = "${REPROSEED_RESET_AUTHORIZATION}";
      });
      await assert.rejects(loadScenarioFile(path, directory, env(token)), /unsupported field note/);
      const clean = await writeScenario(directory, (scenario) => {
        const email = scenario.steps.find((step) => step.id === "email");
        assert.ok(email);
        email.value = literal;
      }, "clean.json");
      const scenario = await loadScenarioFile(clean, directory, env(token));
      const email = scenario.steps.find((step) => step.id === "email");
      assert.equal(email?.kind, "fill");
      if (email?.kind === "fill") {
        assert.equal(email.value, literal);
        assert.equal(email.value.includes(token), false);
      }
      await assert.rejects(readFile(marker, "utf8"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON, unknown actions, bad dependencies, secrets, and unsafe targets", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-reject-"));
    try {
      await expectUsage(join(directory, "broken.json"), "{", env(token), /not valid JSON/);
      await expectUsage(
        await writeScenario(directory, (scenario) => {
          scenario.steps.push({ id: "run", kind: "shell", command: "true", dependsOn: [] });
        }, "shell.json"),
        undefined,
        env(token),
        /unknown step kind shell/,
      );
      await expectUsage(
        await writeScenario(directory, (scenario) => {
          const open = scenario.steps[0];
        assert.ok(open);
        open.dependsOn = ["missing"];
        }, "dependency.json"),
        undefined,
        env(token),
        /unknown step/,
      );
      await expectUsage(
        await writeScenario(directory, (scenario) => {
          scenario.target.resetAuthorization = token;
        }, "secret.json"),
        undefined,
        env(token),
        /must not contain resetAuthorization/,
      );
      await expectUsage(
        await writeScenario(directory, (scenario) => {
          const email = scenario.steps[2];
          assert.ok(email);
          email.value = token;
        }, "embedded.json"),
        undefined,
        env(token),
        /contains the reset authorization/,
      );
      const omitted = { ...env(token) };
      delete omitted.REPROSEED_RESET_AUTHORIZATION;
      await expectUsage(EXAMPLE, undefined, omitted, /REPROSEED_RESET_AUTHORIZATION is required/);
      await expectUsage(EXAMPLE, undefined, { ...env(token), REPROSEED_ORIGIN: "http://example.com" }, /non-loopback/);
      await expectUsage(
        STALE,
        undefined,
        { ...env(token), REPROSEED_APP_ID: "duplicate-submit", REPROSEED_ORIGIN: "http://127.0.0.1:4020" },
        /does not match target.appId/,
      );
      await expectUsage(EXAMPLE, undefined, { ...env(token), REPROSEED_APP_ID: "other-app" }, /does not match target.appId/);
      await expectUsage(
        await writeScenario(directory, (scenario) => {
          scenario.target.origin = "https://127.0.0.1:4010";
        }, "https.json"),
        undefined,
        env(token),
        /non-http/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads the stale-search example as a DOM-text scenario", async () => {
    const token = randomBytes(16).toString("hex");
    const text = await readFile(STALE, "utf8");
    assert.equal(text.includes("resetAuthorization"), false);
    assert.equal(text.includes("keptStepIds"), false);
    const scenario = await loadScenarioFile(STALE, tmpdir(), {
      REPROSEED_ORIGIN: "http://127.0.0.1:4020",
      REPROSEED_APP_ID: "stale-search",
      REPROSEED_RESET_AUTHORIZATION: token,
    });
    assert.equal(scenario.id, "stale-search");
    assert.equal(scenario.target.resetAuthorization, token);
    assert.equal(scenario.oracle.id, "dom-text");
    if (scenario.oracle.id === "dom-text") {
      assert.equal(scenario.oracle.selector, "#results");
      assert.equal(scenario.oracle.expect, "Results for beta");
    }
    const delay = scenario.steps.find((step) => step.id === "slow-alpha");
    assert.equal(delay?.kind, "delay");
    if (delay?.kind === "delay") {
      assert.equal(delay.method, "GET");
      assert.equal(delay.urlIncludes, "/api/search?q=alpha");
    }
    assert.ok(scenario.steps.length > 6);
  });
});

function env(token: string): NodeJS.ProcessEnv {
  return {
    REPROSEED_ORIGIN: "http://127.0.0.1:4010",
    REPROSEED_APP_ID: "duplicate-submit",
    REPROSEED_RESET_AUTHORIZATION: token,
  };
}

async function writeScenario(
  directory: string,
  mutate: (scenario: {
    target: { origin?: string; appId?: string; resetAuthorization?: string };
    steps: Array<{ id: string; kind: string; dependsOn: string[]; value?: string; command?: string; note?: string }>;
  }) => void,
  name = "scenario.json",
): Promise<string> {
  const scenario = JSON.parse(await readFile(EXAMPLE, "utf8")) as {
    target: { origin?: string; appId?: string; resetAuthorization?: string };
    steps: Array<{ id: string; kind: string; dependsOn: string[]; value?: string; command?: string; note?: string }>;
  };
  mutate(scenario);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(scenario));
  return path;
}

async function expectUsage(
  path: string,
  contents: string | undefined,
  environment: NodeJS.ProcessEnv,
  pattern: RegExp,
): Promise<void> {
  if (contents !== undefined) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  await assert.rejects(
    loadScenarioFile(path, tmpdir(), environment),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, EXIT.usage);
      assert.match(error.message, pattern);
      return true;
    },
  );
}
