import assert from "node:assert/strict";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { fetchRecords } from "../../examples/duplicate-submit/harness.ts";
import { startDemoServer, type DemoPage } from "../../examples/duplicate-submit/server.ts";
import { EXIT } from "../../src/cli/errors.ts";
import type { SanitizedMinimizeArtifact } from "../../src/runner/report.ts";
import { CORE_IDS, TARGET_SIGNATURE } from "../fixture.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const NODE_MODULES = join(REPO, "node_modules");
const EXAMPLE = join(REPO, "examples/duplicate-submit/scenario.json");
const PLAYWRIGHT = join(NODE_MODULES, "@playwright/test/cli.js");
const APP_ID = "duplicate-submit";
const VERSION = (JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as { version: string }).version;

describe("built reproseed cli", { concurrency: false }, () => {
  let root = "";
  let cli = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "reproseed-pkg-"));
    const staged = await stagePackage(root);
    cli = staged;
  });

  after(async () => {
    if (root !== "") {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("answers --help and --version from a relocated build", async () => {
    const work = await mkdtemp(join(tmpdir(), "reproseed-help-"));
    try {
      const copiedRuntime = await readFile(join(root, "pkg/dist/export/runtime-config.ts"), "utf8");
      const sourceRuntime = await readFile(join(REPO, "src/export/runtime-config.ts"), "utf8");
      assert.equal(copiedRuntime, sourceRuntime);
      await assert.rejects(access(join(root, "pkg/src/cli.ts")));
      const help = await runCli(cli, ["--help"], { cwd: work, env: baseEnv(), timeout: 30_000 });
      assert.equal(help.code, EXIT.verified, help.stderr);
      assert.match(help.stdout, /does not target production websites/);
      const minimizeHelp = await runCli(cli, ["minimize", "--help"], { cwd: work, env: baseEnv(), timeout: 30_000 });
      assert.equal(minimizeHelp.code, EXIT.verified, minimizeHelp.stderr);
      assert.match(minimizeHelp.stdout, /REPROSEED_RESET_AUTHORIZATION/);
      assert.match(minimizeHelp.stdout, /Exit codes:/);
      const version = await runCli(cli, ["--version"], { cwd: work, env: baseEnv(), timeout: 30_000 });
      assert.equal(version.code, EXIT.verified, version.stderr);
      assert.equal(version.stdout, `${VERSION}\n`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("rejects invalid arguments, JSON, environment, targets, and output paths", async () => {
    const token = randomBytes(16).toString("hex");
    const work = await mkdtemp(join(tmpdir(), "reproseed-usage-"));
    try {
      const unknown = await runCli(cli, ["publish"], { cwd: work, env: baseEnv(), timeout: 30_000 });
      assert.equal(unknown.code, EXIT.usage);
      assert.match(unknown.stderr, /unknown command/);

      await writeFile(join(work, "broken.json"), "{");
      const broken = await runCli(cli, ["minimize", "broken.json"], {
        cwd: work,
        env: targetEnv("http://127.0.0.1:9", token),
        timeout: 30_000,
        token,
      });
      assert.equal(broken.code, EXIT.usage);
      assert.match(broken.stderr, /not valid JSON/);
      assert.equal(broken.stderr.includes(token), false);

      const missing = await runCli(cli, ["minimize", EXAMPLE], { cwd: work, env: baseEnv(), timeout: 30_000 });
      assert.equal(missing.code, EXIT.usage);
      assert.match(missing.stderr, /REPROSEED_RESET_AUTHORIZATION is required/);

      const unsafe = await runCli(cli, ["minimize", EXAMPLE], {
        cwd: work,
        env: targetEnv("http://example.com", token),
        timeout: 30_000,
        token,
      });
      assert.equal(unsafe.code, EXIT.usage);
      assert.match(unsafe.stderr, /non-loopback/);
      assert.equal(unsafe.stdout.includes(token), false);
      assert.equal(unsafe.stderr.includes(token), false);

      const secretFile = JSON.parse(await readFile(EXAMPLE, "utf8")) as { target: { resetAuthorization?: string } };
      secretFile.target.resetAuthorization = token;
      await writeFile(join(work, "secret.json"), JSON.stringify(secretFile));
      const secret = await runCli(cli, ["minimize", "secret.json"], {
        cwd: work,
        env: targetEnv("http://127.0.0.1:9", token),
        timeout: 30_000,
        token,
      });
      assert.equal(secret.code, EXIT.usage);
      assert.match(secret.stderr, /must not contain resetAuthorization/);
      assert.equal(secret.stderr.includes(token), false);

      const outside = await runCli(cli, ["minimize", EXAMPLE, "--report", "../outside.json"], {
        cwd: work,
        env: targetEnv("http://127.0.0.1:9", token),
        timeout: 30_000,
        token,
      });
      assert.equal(outside.code, EXIT.usage);
      assert.match(outside.stderr, /inside the current directory/);

      await mkdir(join(work, "real"));
      await symlink(join(work, "real"), join(work, "linked"));
      const linked = await runCli(cli, ["minimize", EXAMPLE, "--report", "linked/report.json"], {
        cwd: work,
        env: targetEnv("http://127.0.0.1:9", token),
        timeout: 30_000,
        token,
      });
      assert.equal(linked.code, EXIT.usage);
      assert.match(linked.stderr, /symlink/);

      await mkdir(join(work, "artifacts"));
      await writeFile(join(work, "artifacts/report.json"), "keep");
      const exists = await runCli(cli, ["minimize", EXAMPLE], {
        cwd: work,
        env: targetEnv("http://127.0.0.1:9", token),
        timeout: 30_000,
        token,
      });
      assert.equal(exists.code, EXIT.usage);
      assert.match(exists.stderr, /--force/);
      assert.equal(await readFile(join(work, "artifacts/report.json"), "utf8"), "keep");

      const locked = join(work, "locked");
      await mkdir(locked);
      await chmod(locked, 0o555);
      const unwritable = await runCli(cli, ["minimize", EXAMPLE, "--report", "locked/report.json", "--spec", "locked/spec.ts"], {
        cwd: work,
        env: targetEnv("http://127.0.0.1:9", token),
        timeout: 30_000,
        token,
      });
      assert.equal(unwritable.code, EXIT.usage);
      assert.match(unwritable.stderr, /cannot write/);
      await assert.rejects(access(join(locked, "report.json")));
      await chmod(locked, 0o755);
    } finally {
      await chmod(join(work, "locked"), 0o755).catch(() => undefined);
      await rm(work, { recursive: true, force: true });
    }
  });

  it("refuses an unauthorized reset before launching a browser", async () => {
    const serverToken = randomBytes(16).toString("hex");
    const cliToken = randomBytes(16).toString("hex");
    const before = await browserPids();
    const demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization: serverToken });
    const work = await mkdtemp(join(tmpdir(), "reproseed-reset-"));
    try {
      const result = await runCli(cli, ["minimize", EXAMPLE], {
        cwd: work,
        env: targetEnv(demo.origin, cliToken),
        timeout: 30_000,
        token: cliToken,
      });
      assert.equal(result.code, EXIT.usage, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /reset failed/);
      assert.equal(result.stdout.includes(cliToken), false);
      assert.equal(result.stderr.includes(cliToken), false);
      assert.equal(result.stderr.includes(serverToken), false);
      await assert.rejects(access(join(work, "artifacts/report.json")));
      await assert.rejects(access(join(work, "artifacts/minimized.spec.ts")));
    } finally {
      await demo.close();
      await rm(work, { recursive: true, force: true });
    }
    assert.deepEqual(await waitForBrowsers(before), []);
  });

  it("exits when the replay budget is exhausted and does not write a spec", async () => {
    const token = randomBytes(16).toString("hex");
    const before = await browserPids();
    const demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const work = await mkdtemp(join(tmpdir(), "reproseed-budget-"));
    try {
      const scenario = JSON.parse(await readFile(EXAMPLE, "utf8")) as { budget: { maxReplayExecutions: number } };
      scenario.budget.maxReplayExecutions = 0;
      await writeFile(join(work, "budget.json"), JSON.stringify(scenario));
      const result = await runCli(cli, ["minimize", "budget.json"], {
        cwd: work,
        env: targetEnv(demo.origin, token),
        timeout: 30_000,
        token,
      });
      assert.equal(result.code, EXIT.budget, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Status: budget-exhausted/);
      assert.match(result.stdout, /Replay executions: 0/);
      assert.match(result.stdout, /Test: not written/);
      assert.equal(result.stdout.includes(token), false);
      assert.equal(result.stderr.includes(token), false);
      const report = await readFile(join(work, "artifacts/report.json"), "utf8");
      assert.equal(report.includes(token), false);
      assert.equal(report.includes("resetAuthorization"), false);
      const artifact = JSON.parse(report) as SanitizedMinimizeArtifact;
      assert.equal(artifact.report.status, "budget-exhausted");
      assert.equal(artifact.report.counts.replayExecutions, 0);
      await assert.rejects(access(join(work, "artifacts/minimized.spec.ts")));
    } finally {
      await demo.close();
      await rm(work, { recursive: true, force: true });
    }
    assert.deepEqual(await waitForBrowsers(before), []);
  });

  it("exits when the scenario does not reproduce a failure", async () => {
    const token = randomBytes(16).toString("hex");
    const before = await browserPids();
    const demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const work = await mkdtemp(join(tmpdir(), "reproseed-pass-"));
    try {
      await writeFile(join(work, "passing.json"), JSON.stringify(passingScenario()));
      const result = await runCli(cli, ["minimize", "passing.json"], {
        cwd: work,
        env: targetEnv(demo.origin, token),
        timeout: 120_000,
        token,
      });
      assert.equal(result.code, EXIT.unstable, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Status: no-reproducible-failure/);
      assert.match(result.stdout, /Regression test was not written/);
      assert.equal(result.stdout.includes(token), false);
      const reportText = await readFile(join(work, "artifacts/report.json"), "utf8");
      assert.equal(reportText.includes(token), false);
      const artifact = JSON.parse(reportText) as SanitizedMinimizeArtifact;
      assert.equal(artifact.report.counts.replayExecutions, 2);
      assert.equal(artifact.report.counts.verifyReplays, 0);
      for (const replay of artifact.report.replays) {
        assert.equal(replay.outcome.status, "pass", JSON.stringify(replay.outcome));
      }
      await assert.rejects(access(join(work, "artifacts/minimized.spec.ts")));
    } finally {
      await demo.close();
      await rm(work, { recursive: true, force: true });
    }
    assert.deepEqual(await waitForBrowsers(before), []);
  });

  it("minimizes the duplicate-submit scenario and checks the exported test both ways", { timeout: 720_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const before = await browserPids();
    const demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const work = await mkdtemp(join(tmpdir(), "reproseed-e2e-"));
    let leaked: number[] = [];
    try {
      await symlink(NODE_MODULES, join(work, "node_modules"));
      const result = await runCli(
        cli,
        ["minimize", EXAMPLE, "--report", "artifacts/report.json", "--spec", "artifacts/minimized.spec.ts"],
        { cwd: work, env: targetEnv(demo.origin, token), timeout: 540_000, token },
      );
      assert.equal(result.code, EXIT.verified, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout.includes(token), false, "stdout contained the reset credential");
      assert.equal(result.stderr.includes(token), false, "stderr contained the reset credential");
      assert.match(result.stdout, /Status: verified-one-minimal/);
      assert.match(result.stdout, /Original steps: 9/);
      assert.match(result.stdout, /Kept steps: 6/);
      assert.match(result.stdout, /Removed steps: preview, note, decoy-wait/);
      assert.match(result.stdout, /Failure: DUPLICATE \(email=a@example.com, actual=2, expect=1\)/);
      assert.match(result.stdout, /verify: 5/);
      assert.match(result.stdout, /not a proof of the globally shortest reproduction/);
      assert.equal(/guaranteed/i.test(result.stdout), false);
      console.log(result.stdout);

      const specPath = join(work, "artifacts/minimized.spec.ts");
      const reportText = await readFile(join(work, "artifacts/report.json"), "utf8");
      const spec = await readFile(specPath, "utf8");
      assert.equal(reportText.includes(token), false);
      assert.equal(reportText.includes("resetAuthorization"), false);
      assert.equal(spec.includes(token), false);
      assert.equal(spec.includes(demo.origin), false);
      assert.equal(spec.includes("minimize("), false);
      assert.equal(spec.includes("#note"), false);
      assert.equal(spec.includes("#preview"), false);
      assert.match(spec, /expect\(actual\)\.toBe\(1\)/);
      assert.equal(spec.includes("expect(actual).toBe(2)"), false);
      assert.deepEqual(embeddedStepIds(spec), [...CORE_IDS]);

      const artifact = JSON.parse(reportText) as SanitizedMinimizeArtifact;
      assert.equal(artifact.scenario.steps.length, 9);
      assert.deepEqual(artifact.report.keptStepIds, [...CORE_IDS]);
      assert.deepEqual(artifact.report.baselineSignature, TARGET_SIGNATURE);
      assert.equal(artifact.report.counts.baselineReplays, 3);
      assert.equal(artifact.report.counts.verifyReplays, 5);
      assert.ok(artifact.report.counts.searchReplays > 0);
      assert.ok(artifact.report.counts.cacheHits > 0);
      assert.ok(artifact.report.counts.replayExecutions <= 60);
      assert.equal(artifact.report.budget.exhausted, false);
      const verify = artifact.report.replays.filter((replay) => replay.phase === "verify");
      assert.equal(verify.length, 5);
      assert.equal(new Set(verify.map((replay) => replay.id)).size, 5);
      for (const replay of verify) {
        assert.deepEqual(replay.stepIds, [...CORE_IDS]);
        assert.equal(replay.outcome.status, "fail");
        if (replay.outcome.status === "fail") {
          assert.deepEqual(replay.outcome.signature, TARGET_SIGNATURE);
        }
      }
      console.log(
        JSON.stringify(
          {
            kept: artifact.report.keptStepIds,
            removed: artifact.report.inputStepIds.filter((id) => !artifact.report.keptStepIds.includes(id)),
            counts: artifact.report.counts,
            elapsedMs: artifact.report.budget.elapsedMs,
          },
          null,
          2,
        ),
      );

      await writePlaywrightConfig(work);
      const red = await runAgainst(work, "buggy", token);
      assert.equal(await readFile(specPath, "utf8"), spec, "RED rewrote the spec");
      assert.equal(red.code, 1, red.output);
      assert.match(red.output, /Expected:\s*1/);
      assert.match(red.output, /Received:\s*2/);
      assert.match(red.output, /1 failed/);
      assert.equal(red.output.includes(token), false);
      assert.equal(red.postCount, 2);
      assert.equal(red.records.length, 2);

      const green = await runAgainst(work, "fixed-pending", token);
      assert.equal(await readFile(specPath, "utf8"), spec, "GREEN rewrote the spec");
      assert.equal(green.code, 0, green.output);
      assert.match(green.output, /1 passed/);
      assert.equal(/1 failed/.test(green.output), false);
      assert.equal(green.output.includes(token), false);
      assert.equal(green.postCount, 1);
      assert.equal(green.records.length, 1);
      console.log(`RED exit ${red.code}; GREEN exit ${green.code}`);
    } finally {
      await demo.close();
      leaked = await waitForBrowsers(before);
      for (const pid of leaked) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The process already exited.
        }
      }
      await rm(work, { recursive: true, force: true });
    }
    assert.deepEqual(leaked, []);
  });
});

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEBUG;
  delete env.REPROSEED_ORIGIN;
  delete env.REPROSEED_APP_ID;
  delete env.REPROSEED_RESET_AUTHORIZATION;
  return env;
}

function targetEnv(origin: string, token: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    REPROSEED_ORIGIN: origin,
    REPROSEED_APP_ID: APP_ID,
    REPROSEED_RESET_AUTHORIZATION: token,
  };
}

function passingScenario(): unknown {
  return {
    id: "passing-open",
    target: { appId: APP_ID },
    reset: { method: "POST", path: "/__reproseed/reset" },
    steps: [
      { id: "open", kind: "goto", path: "/", dependsOn: [] },
      { id: "pause", kind: "wait", ms: 20, dependsOn: [] },
    ],
    oracle: {
      id: "record-count",
      request: { method: "GET", path: "/api/records" },
      match: { field: "email", value: "a@example.com" },
      expect: 0,
    },
    budget: {
      maxReplayExecutions: 10,
      maxWallClockMs: 60_000,
      attemptTimeoutMs: 15_000,
      baselineRuns: 2,
      reductionConfirmRuns: 2,
      verifyRuns: 5,
    },
  };
}

async function stagePackage(root: string): Promise<string> {
  const built = join(REPO, "dist/cli.js");
  try {
    await access(built);
    await access(join(REPO, "dist/export/runtime-config.ts"));
  } catch {
    throw new Error("dist/cli.js is missing; run npm run build before the CLI end-to-end test");
  }
  const pkg = join(root, "pkg");
  await mkdir(pkg, { recursive: true });
  await cp(join(REPO, "dist"), join(pkg, "dist"), { recursive: true });
  await cp(join(REPO, "package.json"), join(pkg, "package.json"));
  await symlink(NODE_MODULES, join(pkg, "node_modules"));
  return join(pkg, "dist/cli.js");
}

function runCli(
  cliPath: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; token?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.token !== undefined) {
    assert.equal(
      args.some((arg) => arg.includes(options.token ?? "")),
      false,
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let leakedArgument = false;
    child.once("spawn", () => {
      leakedArgument = processArgsInclude(child, options.token);
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (leakedArgument) {
        reject(new Error("reset credential was visible in the process arguments"));
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8"),
      });
    });
  });
}

function processArgsInclude(child: ChildProcess, token: string | undefined): boolean {
  if (token === undefined || token.length < 8 || child.pid === undefined) {
    return false;
  }
  try {
    const listed = execFileSync("ps", ["-p", String(child.pid), "-o", "args="], { encoding: "utf8" });
    return listed.includes(token);
  } catch {
    return false;
  }
}

async function writePlaywrightConfig(work: string): Promise<void> {
  await writeFile(
    join(work, "playwright.config.ts"),
    `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ${JSON.stringify(join(work, "artifacts"))},
  testMatch: "minimized.spec.ts",
  respectGitIgnore: false,
  outputDir: ${JSON.stringify(join(work, "playwright-output"))},
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "line",
  use: { headless: true, trace: "off", video: "off", screenshot: "off" },
});
`,
  );
}

type RunEvidence = {
  code: number;
  output: string;
  postCount: number;
  records: Array<{ email: string }>;
};

async function runAgainst(work: string, page: DemoPage, token: string): Promise<RunEvidence> {
  const demo = await startDemoServer({ port: 0, appId: APP_ID, resetAuthorization: token, page });
  try {
    const result = await runPlaywright(work, targetEnv(demo.origin, token));
    const records = await fetchRecords(demo.origin);
    return {
      code: result.code,
      output: result.output,
      postCount: demo.postCount(),
      records: records.map((record) => ({ email: record.email })),
    };
  } finally {
    await demo.close();
  }
}

function runPlaywright(work: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PLAYWRIGHT, "test", "--config", "playwright.config.ts", "--retries=0", "--workers=1"], {
      cwd: work,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

function embeddedStepIds(source: string): string[] {
  const marker = "const scenario = ";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const expressionStart = start + marker.length;
  const end = source.indexOf(" as ExportedScenario;", expressionStart);
  assert.notEqual(end, -1);
  const value = vm.runInNewContext(source.slice(expressionStart, end), { JSON }) as { steps: Array<{ id: string }> };
  return value.steps.map((step) => step.id);
}

function browserPids(): Promise<Set<number>> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const pids = new Set<number>();
      for (const line of stdout.split("\n")) {
        if (!/chrome-headless-shell|ms-playwright/.test(line)) {
          continue;
        }
        const match = /^\s*(\d+)/.exec(line);
        if (match?.[1] !== undefined) {
          pids.add(Number(match[1]));
        }
      }
      resolve(pids);
    });
  });
}

async function waitForBrowsers(before: Set<number>): Promise<number[]> {
  let leaked: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const after = await browserPids();
    leaked = [...after].filter((pid) => !before.has(pid));
    if (leaked.length === 0) {
      return [];
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return leaked;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
