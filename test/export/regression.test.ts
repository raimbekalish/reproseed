import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fetchRecords } from "../../examples/duplicate-submit/harness.ts";
import { startDemoServer, type DemoPage, type DemoServer } from "../../examples/duplicate-submit/server.ts";
import { writePlaywrightTest } from "../../src/export/playwright.ts";
import { CORE_IDS, duplicateSubmitScenario } from "../fixture.ts";
import { verifiedMinimizeReport } from "./verified-report.ts";

const APP_ID = "duplicate-submit";
const SPEC_PATH = fileURLToPath(new URL("../../artifacts/minimized.spec.ts", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("./playwright.config.ts", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("verified playwright regression", { concurrency: false }, () => {
  it("fails on the buggy demo with two records and passes on the pending-submit fix", { timeout: 300_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const scenario = duplicateSubmitScenario();
    scenario.target = {
      origin: "http://127.0.0.1:4010",
      appId: APP_ID,
      resetAuthorization: token,
    };
    await writePlaywrightTest(SPEC_PATH, scenario, verifiedMinimizeReport(scenario, CORE_IDS));
    const source = await readFile(SPEC_PATH, "utf8");
    assert.match(source, /expect\(actual\)\.toBe\(1\)/);
    assert.equal(source.includes("expect(actual).toBe(2)"), false);
    assert.equal(source.includes(token), false);
    assert.equal(source.includes("http://127.0.0.1:4010"), false);
    assert.equal(source.includes("minimize("), false);

    for (const iteration of [1, 2]) {
      const red = await runAgainst("buggy", token);
      assert.equal(await readFile(SPEC_PATH, "utf8"), source, `RED ${iteration} rewrote the spec`);
      assert.equal(red.code, 1, `RED ${iteration} exit ${red.code}\n${red.output}`);
      assert.match(red.output, /expect\(received\)\.toBe\(expected\)/, `RED ${iteration}\n${red.output}`);
      assert.match(red.output, /Expected:\s*1/, `RED ${iteration}\n${red.output}`);
      assert.match(red.output, /Received:\s*2/, `RED ${iteration}\n${red.output}`);
      assert.match(red.output, /1 failed/, `RED ${iteration}\n${red.output}`);
      assert.equal(red.output.includes(token), false, `RED ${iteration} printed the reset token`);
      assert.equal(/Test timeout/i.test(red.output), false, red.output);
      assert.equal(/waiting for locator/i.test(red.output), false, red.output);
      assert.equal(/reset failed/i.test(red.output), false, red.output);
      assert.equal(/identity does not match/i.test(red.output), false, red.output);
      assert.equal(/browserType\.launch/i.test(red.output), false, red.output);
      assert.equal(red.postCount, 2, `RED ${iteration} posts ${red.postCount}`);
      assert.equal(red.records.length, 2, `RED ${iteration} records ${red.records.length}`);
      assert.deepEqual(
        red.records.map((record) => record.email),
        ["a@example.com", "a@example.com"],
      );
      const first = red.records[0];
      const second = red.records[1];
      assert.ok(first && second);
      assert.ok(second.createdAt - first.createdAt >= 500, `RED ${iteration} posts were not separated by the kept wait`);
    }

    assert.equal(await readFile(SPEC_PATH, "utf8"), source);

    for (const iteration of [1, 2]) {
      const green = await runAgainst("fixed-pending", token);
      assert.equal(await readFile(SPEC_PATH, "utf8"), source, `GREEN ${iteration} rewrote the spec`);
      assert.equal(green.code, 0, `GREEN ${iteration} exit ${green.code}\n${green.output}`);
      assert.match(green.output, /1 passed/, `GREEN ${iteration}\n${green.output}`);
      assert.equal(/1 failed/.test(green.output), false, green.output);
      assert.equal(/Received:\s*2/.test(green.output), false, green.output);
      assert.equal(green.output.includes(token), false, `GREEN ${iteration} printed the reset token`);
      assert.equal(green.postCount, 1, `GREEN ${iteration} posts ${green.postCount}`);
      assert.equal(green.records.length, 1);
      assert.equal(green.records[0]?.email, "a@example.com");
    }

    const loopback = await runAgainst("buggy", token, { origin: "http://example.com" });
    assert.notEqual(loopback.code, 0, loopback.output);
    assert.match(loopback.output, /loopback/, loopback.output);
    assert.equal(/Received:\s*2/.test(loopback.output), false, loopback.output);
    assert.equal(loopback.postCount, 0);
    assert.equal(loopback.records.length, 0);
    assert.equal(await readFile(SPEC_PATH, "utf8"), source);
  });
});

type RunEvidence = {
  code: number;
  output: string;
  postCount: number;
  records: Array<{ email: string; createdAt: number }>;
};

async function runAgainst(
  page: DemoPage,
  token: string,
  override?: { origin: string },
): Promise<RunEvidence> {
  const demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization: token, page });
  try {
    const result = await runPlaywright(playwrightEnv(demo, token, override?.origin));
    const records = await fetchRecords(demo.origin);
    return {
      code: result.code,
      output: result.output,
      postCount: demo.postCount(),
      records: records.map((record) => ({ email: record.email, createdAt: record.createdAt })),
    };
  } finally {
    await demo.close();
  }
}

function playwrightEnv(demo: DemoServer, token: string, origin = demo.origin): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEBUG;
  env.REPROSEED_ORIGIN = origin;
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
