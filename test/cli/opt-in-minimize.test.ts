import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { startOptInServer } from "../../examples/opt-in-ticket/server.ts";
import { EXIT } from "../../src/cli/errors.ts";
import type { SanitizedMinimizeArtifact } from "../../src/runner/report.ts";
import { useInstalledPlaywrightBrowsers } from "../../src/runner/session.ts";
import {
  browserSnapshot,
  finishBrowserCleanup,
  leakedProcessNote,
  stopDirectChild,
  type BrowserLeakSplit,
} from "../process-snapshot.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCENARIO = join(REPO, "examples/opt-in-ticket/scenario.json");
const PLAYWRIGHT = join(REPO, "node_modules/@playwright/test/cli.js");
const APP_ID = "opt-in-ticket";

describe("opt-in ticket through the built CLI", { concurrency: false }, () => {
  it("diagnoses, minimizes, and runs the same spec red then green", { timeout: 600_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const root = await mkdtemp(join(tmpdir(), "reproseed-opt-in-"));
    const work = join(root, "work");
    await mkdir(work, { recursive: true });
    const cli = await stagePackage(root);
    const server = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const before = await browserSnapshot();
    let leaks: BrowserLeakSplit = { owned: [], suspected: [] };
    try {
      const filed = await fetch(`${server.origin}/api/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com", note: "stay" }),
      });
      assert.equal(filed.status, 201);
      const env = targetEnv(server.origin, token);
      const doctor = await runCli(cli, ["doctor", SCENARIO], { cwd: work, env, timeout: 30_000 });
      assert.equal(doctor.code, EXIT.verified, `${doctor.stdout}\n${doctor.stderr}`);
      assert.match(doctor.stdout, /Doctor does not send POST \/__reproseed\/reset/);
      assert.match(doctor.stdout, /did not launch a browser/);
      assert.match(doctor.stdout, /not-verified\s+reset-accepted/);
      assert.match(doctor.stdout, /JSON array with 1 item/);
      assert.match(doctor.stdout, /record-count shape/);
      assert.equal(doctor.stdout.includes(token), false);
      assert.equal(doctor.stderr.includes(token), false);
      const afterDoctor = (await (await fetch(`${server.origin}/api/tickets`)).json()) as unknown[];
      assert.equal(afterDoctor.length, 1);

      const minimized = await runCli(
        cli,
        ["minimize", SCENARIO, "--report", "artifacts/report.json", "--spec", "artifacts/ticket.spec.ts"],
        { cwd: work, env, timeout: 300_000 },
      );
      assert.equal(minimized.code, EXIT.verified, `${minimized.stdout}\n${minimized.stderr}`);
      assert.match(minimized.stdout, /Status: verified-one-minimal/);
      assert.match(minimized.stdout, /verify: 5/);
      assert.equal(minimized.stdout.includes(token), false);
      assert.equal(minimized.stderr.includes(token), false);
      const reportText = await readFile(join(work, "artifacts/report.json"), "utf8");
      const spec = await readFile(join(work, "artifacts/ticket.spec.ts"), "utf8");
      assert.equal(reportText.includes(token), false);
      assert.equal(reportText.includes("resetAuthorization"), false);
      assert.equal(spec.includes(token), false);
      assert.equal(spec.includes(server.origin), false);
      assert.match(spec, /toBe\(1\)/);
      assert.equal(spec.includes("toBe(2)"), false);
      assert.match(spec, /\/api\/tickets/);
      const artifact = JSON.parse(reportText) as SanitizedMinimizeArtifact;
      assert.equal(artifact.report.status, "verified-one-minimal");
      assert.equal(artifact.report.counts.verifyReplays, 5);
      assert.equal(artifact.report.baselineSignature?.code, "DUPLICATE");
      assert.deepEqual(artifact.report.keptStepIds, ["open", "email", "slow-file", "file-1", "gap", "file-2"]);
      assert.equal(artifact.report.keptStepIds.includes("decoy-note"), false);
      console.log(
        JSON.stringify({
          kept: artifact.report.keptStepIds,
          counts: artifact.report.counts,
          elapsedMs: artifact.report.budget.elapsedMs,
        }),
      );

      await symlink(join(REPO, "node_modules"), join(work, "node_modules"));
      await writeFile(
        join(work, "playwright.ticket.config.ts"),
        `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ${JSON.stringify(join(work, "artifacts"))},
  testMatch: "ticket.spec.ts",
  respectGitIgnore: false,
  outputDir: ${JSON.stringify(join(work, "playwright-output"))},
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "line",
  use: { headless: true, channel: "chromium", trace: "off", video: "off", screenshot: "off" },
});
`,
      );
      const red = await runPlaywright(work, env);
      assert.equal(red.code, 1, red.output);
      assert.match(red.output, /Expected:\s*1/);
      assert.match(red.output, /Received:\s*2/);
      assert.equal(red.output.includes(token), false);
      const records = (await (await fetch(`${server.origin}/api/tickets`)).json()) as Array<{ email?: string }>;
      assert.deepEqual(
        records.map((record) => record.email),
        ["person@example.com", "person@example.com"],
      );

      const fixed = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token, page: "fixed" });
      try {
        const green = await runPlaywright(work, targetEnv(fixed.origin, token));
        assert.equal(green.code, 0, green.output);
        assert.equal(green.output.includes(token), false);
        assert.equal(await readFile(join(work, "artifacts/ticket.spec.ts"), "utf8"), spec);
        const fixedRecords = (await (await fetch(`${fixed.origin}/api/tickets`)).json()) as Array<{ email?: string }>;
        assert.deepEqual(
          fixedRecords.map((record) => record.email),
          ["person@example.com"],
        );
        console.log(JSON.stringify({ red: { code: red.code, received: 2 }, green: { code: green.code, received: fixedRecords.length } }));
      } finally {
        await fixed.close();
      }
    } finally {
      await server.close();
      leaks = await finishBrowserCleanup(before);
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(leaks.owned, [], await leakedProcessNote(leaks.owned));
  });

  it("minimizes when reset verification and the oracle use different endpoints", { timeout: 600_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const root = await mkdtemp(join(tmpdir(), "reproseed-split-"));
    const work = join(root, "work");
    await mkdir(work, { recursive: true });
    const cli = await stagePackage(root);
    const server = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const before = await browserSnapshot();
    let leaks: BrowserLeakSplit = { owned: [], suspected: [] };
    try {
      const filed = await fetch(`${server.origin}/api/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com", note: "stay" }),
      });
      assert.equal(filed.status, 201);
      assert.equal(server.audits().some((audit) => "email" in audit), false);
      const scenario = JSON.parse(await readFile(SCENARIO, "utf8")) as { reset: { verify: { path: string } } };
      scenario.reset.verify.path = "/api/reset-history";
      const scenarioPath = join(work, "scenario.json");
      await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
      const env = targetEnv(server.origin, token);
      const seeded = server.requests().length;
      const doctor = await runCli(cli, ["doctor", scenarioPath], { cwd: work, env, timeout: 30_000 });
      assert.equal(doctor.code, EXIT.verified, `${doctor.stdout}\n${doctor.stderr}`);
      assert.match(doctor.stdout, /pass\s+clean-state-endpoint\s+GET \/api\/reset-history/);
      assert.match(doctor.stdout, /any JSON array items/);
      assert.match(doctor.stdout, /pass\s+oracle-endpoint\s+GET \/api\/tickets/);
      assert.match(doctor.stdout, /record-count shape/);
      assert.equal(doctor.stdout.includes(token), false);
      const doctorHits = server.requests().slice(seeded);
      assert.equal(doctorHits.includes("POST /__reproseed/reset"), false);
      assert.equal(doctorHits.filter((hit) => hit === "GET /api/reset-history").length, 1);
      assert.equal(doctorHits.filter((hit) => hit === "GET /api/tickets").length, 1);
      assert.equal((await (await fetch(`${server.origin}/api/tickets`)).json() as unknown[]).length, 1);

      const minimized = await runCli(
        cli,
        ["minimize", scenarioPath, "--report", "artifacts/report.json", "--spec", "artifacts/split.spec.ts"],
        { cwd: work, env, timeout: 300_000 },
      );
      assert.equal(minimized.code, EXIT.verified, `${minimized.stdout}\n${minimized.stderr}`);
      assert.match(minimized.stdout, /Status: verified-one-minimal/);
      assert.match(minimized.stdout, /verify: 5/);
      assert.equal(minimized.stdout.includes(token), false);
      assert.equal(minimized.stderr.includes(token), false);
      const reportText = await readFile(join(work, "artifacts/report.json"), "utf8");
      const spec = await readFile(join(work, "artifacts/split.spec.ts"), "utf8");
      assert.equal(reportText.includes(token), false);
      assert.equal(spec.includes(token), false);
      assert.match(spec, /\/api\/reset-history/);
      assert.match(spec, /\/api\/tickets/);
      assert.match(spec, /toBe\(1\)/);
      const artifact = JSON.parse(reportText) as SanitizedMinimizeArtifact;
      assert.equal(artifact.report.status, "verified-one-minimal");
      assert.equal(artifact.report.counts.verifyReplays, 5);
      assert.deepEqual(artifact.report.keptStepIds, ["open", "email", "slow-file", "file-1", "gap", "file-2"]);
      const minimizeHits = server.requests().slice(seeded + doctorHits.length);
      assert.equal(minimizeHits.includes("POST /__reproseed/reset"), true);
      assert.equal(minimizeHits.includes("GET /api/reset-history"), true);
      assert.equal(minimizeHits.includes("GET /api/tickets"), true);
      console.log(
        JSON.stringify({
          doctorGets: { history: 1, tickets: 1, resetPosts: 0 },
          kept: artifact.report.keptStepIds,
          verifyReplays: artifact.report.counts.verifyReplays,
        }),
      );
    } finally {
      await server.close();
      leaks = await finishBrowserCleanup(before);
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(leaks.owned, [], await leakedProcessNote(leaks.owned));
  });
});

async function stagePackage(root: string): Promise<string> {
  const built = join(REPO, "dist/cli.js");
  try {
    await access(built);
    await access(join(REPO, "dist/export/runtime-config.ts"));
  } catch {
    throw new Error("dist/cli.js is missing; run npm run build before the opt-in CLI test");
  }
  const pkg = join(root, "pkg");
  await mkdir(pkg, { recursive: true });
  await cp(join(REPO, "dist"), join(pkg, "dist"), { recursive: true });
  await cp(join(REPO, "package.json"), join(pkg, "package.json"));
  await symlink(join(REPO, "node_modules"), join(pkg, "node_modules"));
  return join(pkg, "dist/cli.js");
}

function targetEnv(origin: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REPROSEED_ORIGIN: origin,
    REPROSEED_APP_ID: APP_ID,
    REPROSEED_RESET_AUTHORIZATION: token,
  };
  useInstalledPlaywrightBrowsers(env);
  return env;
}

function runCli(
  cliPath: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      stopDirectChild(child);
    }, options.timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function runPlaywright(work: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  const child = spawn(process.execPath, [PLAYWRIGHT, "test", "--config", "playwright.ticket.config.ts", "--retries=0", "--workers=1"], {
    cwd: work,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => stopDirectChild(child), 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`;
      resolve({ code: code ?? 1, output: output.replace(/\u001b\[[0-9;]*m/g, "") });
    });
  });
}

