import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { startSearchServer, type SearchPage, type SearchServer } from "../../examples/stale-search/server.ts";
import { loadScenarioFile } from "../../src/cli/scenario-file.ts";
import { writePlaywrightTest } from "../../src/export/playwright.ts";
import { minimizeWithBrowser } from "../../src/runner/minimize-browser.ts";

const APP_ID = "stale-search";
const SCENARIO = fileURLToPath(new URL("../../examples/stale-search/scenario.json", import.meta.url));
const SPEC_PATH = fileURLToPath(new URL("../../artifacts/stale-search.spec.ts", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("./playwright.stale.config.ts", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("stale search regression", { concurrency: false }, () => {
  it("fails on stale alpha output and passes on the generation guard", { timeout: 600_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const demo = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    let source = "";
    try {
      const scenario = await loadScenarioFile(SCENARIO, REPO_ROOT, {
        REPROSEED_ORIGIN: demo.origin,
        REPROSEED_APP_ID: APP_ID,
        REPROSEED_RESET_AUTHORIZATION: token,
      });
      const report = await minimizeWithBrowser({ scenario });
      assert.equal(report.status, "verified-one-minimal", JSON.stringify(report.counts));
      assert.equal(report.counts.verifyReplays, 5);
      const removed = report.inputStepIds.filter((id) => !report.keptStepIds.includes(id));
      assert.ok(removed.length > 0, "minimizer kept every step");
      await writePlaywrightTest(SPEC_PATH, scenario, report);
      source = await readFile(SPEC_PATH, "utf8");
      assert.equal(source.includes(token), false);
      assert.equal(source.includes(demo.origin), false);
      assert.equal(source.includes("minimize("), false);
      assert.match(source, /stale result text/);
      assert.match(source, /Results for beta/);
      assert.equal(source.includes('toBe("Results for alpha")'), false);
      assert.match(source, /\/api\/search\?q=alpha/);
      assert.match(source, /GET/);
      assert.match(source, /\/api\/search-history/);
      assert.match(source, /json-array-empty/);
      assert.equal(source.includes('"/api/records"'), false);
      const keptIds = report.keptStepIds;
      for (const id of removed) {
        const step = scenario.steps.find((candidate) => candidate.id === id);
        if (step?.kind === "fill" && step.value === "unrelated") {
          assert.equal(source.includes("unrelated"), false);
        }
        if (step?.kind === "click" && step.selector === "#preview") {
          assert.equal(source.includes("#preview"), false);
        }
      }
      assert.ok(keptIds.includes("slow-alpha"));
    } finally {
      await demo.close();
    }

    for (const iteration of [1, 2]) {
      const red = await runAgainst("buggy", token);
      assert.equal(await readFile(SPEC_PATH, "utf8"), source, `RED ${iteration} rewrote the spec`);
      assert.equal(red.code, 1, `RED ${iteration}\n${red.output}`);
      assert.match(red.output, /Expected:\s*"Results for beta"/, `RED ${iteration}\n${red.output}`);
      assert.match(red.output, /Received:\s*"Results for alpha \(outdated\)"/, `RED ${iteration}\n${red.output}`);
      assert.match(red.output, /stale result text/, `RED ${iteration}\n${red.output}`);
      assert.match(red.output, /1 failed/, `RED ${iteration}\n${red.output}`);
      assert.equal(red.output.includes(token), false);
    }
    assert.equal(await readFile(SPEC_PATH, "utf8"), source);
    for (const iteration of [1, 2]) {
      const green = await runAgainst("fixed-generation", token);
      assert.equal(await readFile(SPEC_PATH, "utf8"), source, `GREEN ${iteration} rewrote the spec`);
      assert.equal(green.code, 0, `GREEN ${iteration}\n${green.output}`);
      assert.match(green.output, /1 passed/, `GREEN ${iteration}\n${green.output}`);
      assert.equal(/1 failed/.test(green.output), false, green.output);
      assert.equal(/Received:\s*"Results for alpha \(outdated\)"/.test(green.output), false, green.output);
      assert.equal(green.output.includes(token), false);
    }
  });
});

async function runAgainst(page: SearchPage, token: string): Promise<{ code: number; output: string }> {
  const demo = await startSearchServer({ port: 0, appId: APP_ID, resetAuthorization: token, page });
  try {
    return await runPlaywright(playwrightEnv(demo, token));
  } finally {
    await demo.close();
  }
}

function playwrightEnv(demo: SearchServer, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEBUG;
  env.REPROSEED_ORIGIN = demo.origin;
  env.REPROSEED_APP_ID = APP_ID;
  env.REPROSEED_RESET_AUTHORIZATION = token;
  return env;
}

function runPlaywright(env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, "test", "--config", CONFIG_PATH, "--retries=0", "--workers=1", "--reporter=line"],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: stripAnsi(Buffer.concat(chunks).toString("utf8")) });
    });
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
