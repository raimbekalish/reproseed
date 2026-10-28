import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { get as httpGet, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { startOptInServer } from "../../examples/opt-in-ticket/server.ts";
import { EXIT } from "../../src/cli/errors.ts";
import type { SanitizedMinimizeArtifact } from "../../src/runner/report.ts";
import { useInstalledPlaywrightBrowsers } from "../../src/runner/session.ts";
import { browserPids, leakedProcessNote } from "../process-snapshot.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const APP_ID = "opt-in-ticket";
const TRACE_LISTING = `
import sys, zipfile
archive = zipfile.ZipFile(sys.argv[1])
print("\\n".join(archive.namelist()))
print("---TRACE---")
for name in archive.namelist():
    if name.endswith(".trace") or name.endswith(".network"):
        print(archive.read(name).decode("utf-8", "replace"))
`;

describe("fresh consumer install", { concurrency: false }, () => {
  it("runs the packed CLI without the source checkout", { timeout: 600_000 }, async () => {
    const token = randomBytes(16).toString("hex");
    const root = await mkdtemp(join(tmpdir(), "reproseed-consumer-"));
    assert.equal(relative(REPO, root).startsWith(".."), true);
    const work = join(root, "app");
    await mkdir(work);
    const server = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const before = await browserPids();
    let leaked: number[] = [];
    let fixed: Awaited<ReturnType<typeof startOptInServer>> | undefined;
    try {
      const tarball = await pack(root);
      await npm(["init", "-y"], work);
      await npm(["install", "--no-fund", "--no-audit", tarball], work);
      const installed = await realpath(join(work, "node_modules/reproseed"));
      const cli = join(work, "node_modules/.bin/reproseed");
      const cliFile = await realpath(join(installed, "dist/cli.js"));
      assert.equal(relative(REPO, await realpath(cli)).startsWith(".."), true);
      assert.equal(relative(REPO, cliFile).startsWith(".."), true);
      assert.equal(cliFile.startsWith(installed), true);
      const packed = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      assert.equal(packed.dependencies?.playwright, "1.64.1");
      assert.equal(packed.dependencies?.["@playwright/test"], undefined);
      await access(join(installed, "docs/integrate-your-app.md"));
      await access(join(installed, "docs/trace-evidence.md"));
      await assertMissing(join(installed, "src"));
      await assertMissing(join(work, "node_modules/@playwright/test"));
      const playwrightCli = join(work, "node_modules/playwright/cli.js");
      await access(playwrightCli);

      const version = await run(cli, ["--version"], work, cleanEnv());
      assert.equal(version.code, 0, version.output);
      assert.match(version.output, /0\.1\.0/);
      const help = await run(cli, ["--help"], work, cleanEnv());
      assert.equal(help.code, 0, help.output);
      assert.match(help.output, /doctor/);
      assert.match(help.output, /--trace/);
      const init = await run(cli, ["init", "starter.json"], work, cleanEnv());
      assert.equal(init.code, 0, init.output);
      const starter = JSON.parse(await readFile(join(work, "starter.json"), "utf8")) as { id?: string };
      assert.equal(typeof starter.id, "string");

      const scenario = await readFile(join(REPO, "examples/opt-in-ticket/scenario.json"), "utf8");
      const scenarioPath = join(work, "scenario.json");
      await writeFile(scenarioPath, scenario);
      const env = targetEnv(server.origin, token);
      const doctor = await run(cli, ["doctor", scenarioPath], work, env);
      assert.equal(doctor.code, EXIT.verified, doctor.output);
      assert.match(doctor.output, /not-verified\s+reset-accepted/);
      assert.equal(doctor.output.includes(token), false);

      const minimized = await run(
        cli,
        ["minimize", scenarioPath, "--report", "artifacts/report.json", "--spec", "artifacts/ticket.spec.ts", "--trace", "artifacts/repro.zip"],
        work,
        env,
        300_000,
      );
      assert.equal(minimized.code, EXIT.verified, minimized.output);
      assert.match(minimized.output, /Status: verified-one-minimal/);
      assert.match(minimized.output, /verify: 5/);
      assert.match(minimized.output, /Trace evidence: verified/);
      assert.match(minimized.output, /npx playwright show-trace \S+artifacts\/repro\.zip/);
      assert.equal(minimized.output.includes(token), false);
      const reportText = await readFile(join(work, "artifacts/report.json"), "utf8");
      const spec = await readFile(join(work, "artifacts/ticket.spec.ts"), "utf8");
      assert.equal(reportText.includes(token), false);
      assert.equal(spec.includes(token), false);
      assert.match(spec, /from "@playwright\/test"/);
      assert.match(spec, /toBe\(1\)/);
      const artifact = JSON.parse(reportText) as SanitizedMinimizeArtifact;
      assert.equal(artifact.report.status, "verified-one-minimal");
      assert.equal(artifact.report.counts.verifyReplays, 5);
      const zipPath = join(work, "artifacts/repro.zip");
      const zip = await readFile(zipPath);
      assert.equal(zip.subarray(0, 2).toString(), "PK");
      assert.equal(zip.includes(Buffer.from(token)), false);
      const listed = spawnSync("python3", ["-c", TRACE_LISTING, zipPath], { encoding: "utf8" });
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /ReproSeed evidence/);
      assert.equal(listed.stdout.includes(token), false);
      await openTraceViewer(playwrightCli, zipPath);

      await npm(["install", "--save-dev", "@playwright/test@1.64.1"], work);
      await access(join(work, "node_modules/@playwright/test/cli.js"));
      await writeFile(
        join(work, "playwright.config.ts"),
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
      const red = await run(
        join(work, "node_modules/@playwright/test/cli.js"),
        ["test", "--config", "playwright.config.ts", "--retries=0", "--workers=1"],
        work,
        env,
        90_000,
      );
      assert.equal(red.code, 1, red.output);
      assert.match(red.output, /Expected:\s*1/);
      assert.match(red.output, /Received:\s*2/);
      assert.equal(red.output.includes(token), false);

      fixed = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token, page: "fixed" });
      const green = await run(
        join(work, "node_modules/@playwright/test/cli.js"),
        ["test", "--config", "playwright.config.ts", "--retries=0", "--workers=1"],
        work,
        targetEnv(fixed.origin, token),
        90_000,
      );
      assert.equal(green.code, 0, green.output);
      assert.equal(await readFile(join(work, "artifacts/ticket.spec.ts"), "utf8"), spec);
      assert.equal(green.output.includes(token), false);
    } finally {
      await server.close();
      await fixed?.close();
      leaked = await waitForBrowsers(before);
      for (const pid of leaked) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The process already exited.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(leaked, [], await leakedProcessNote(leaked));
  });
});

async function pack(root: string): Promise<string> {
  const packed = await command("npm", ["pack", "--json", "--pack-destination", root], REPO, 120_000);
  assert.equal(packed.code, 0, packed.output);
  const start = packed.output.indexOf("[");
  const end = packed.output.lastIndexOf("]");
  const rows = JSON.parse(packed.output.slice(start, end + 1)) as Array<{ filename: string }>;
  const filename = rows[0]?.filename;
  if (filename === undefined) {
    throw new Error(`npm pack did not name a tarball\n${packed.output}`);
  }
  return join(root, filename);
}

function npm(args: readonly string[], cwd: string): Promise<void> {
  return command("npm", args, cwd, 180_000).then((result) => {
    if (result.code !== 0) {
      throw new Error(`npm ${args.join(" ")} failed\n${result.output}`);
    }
  });
}

function command(
  bin: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
): Promise<{ code: number; output: string }> {
  return run(bin, args, cwd, cleanEnv(), timeout);
}

function run(
  bin: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 30_000,
): Promise<{ code: number; output: string }> {
  const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
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

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_PATH;
  delete env.REPROSEED_ORIGIN;
  delete env.REPROSEED_APP_ID;
  delete env.REPROSEED_RESET_AUTHORIZATION;
  return env;
}

function targetEnv(origin: string, token: string): NodeJS.ProcessEnv {
  const env = cleanEnv();
  env.REPROSEED_ORIGIN = origin;
  env.REPROSEED_APP_ID = APP_ID;
  env.REPROSEED_RESET_AUTHORIZATION = token;
  useInstalledPlaywrightBrowsers(env);
  return env;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

async function openTraceViewer(playwrightCli: string, zipPath: string): Promise<void> {
  const child = spawn(process.execPath, [playwrightCli, "show-trace", zipPath, "--host", "127.0.0.1", "--port", "0"], {
    env: { ...cleanEnv(), PWTEST_UNDER_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`trace viewer did not listen\n${output}`));
        }
      }, 20_000);
      const finish = (handler: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        handler();
      };
      const onData = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
        const match = output.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/);
        const listening = match?.[1];
        if (listening !== undefined) {
          finish(() => resolve(listening));
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", (code) => {
        finish(() => reject(new Error(`trace viewer exited ${code ?? "unknown"}\n${output}`)));
      });
    });
    const root = await httpRequest(url);
    assert.equal(root.status, 302, root.body.toString("utf8"));
    const location = root.headers.location;
    if (typeof location !== "string") {
      throw new Error("trace viewer did not redirect");
    }
    const pageUrl = new URL(location, url);
    assert.match(pageUrl.pathname, /index\.html$/);
    const trace = pageUrl.searchParams.get("trace") ?? "";
    const page = await httpRequest(pageUrl.toString());
    assert.equal(page.status, 200);
    assert.match(page.body.toString("utf8"), /html/i);
    const fileUrl = new URL("/trace/file", url);
    fileUrl.searchParams.set("path", traceFilePath(trace));
    const file = await httpRequest(fileUrl.toString());
    assert.equal(file.status, 200, file.body.subarray(0, 180).toString("utf8"));
    assert.equal(file.body.subarray(0, 2).toString(), "PK");
  } finally {
    stopChild(child);
  }
}

function traceFilePath(trace: string): string {
  if (trace.startsWith("file?path=")) {
    const path = new URL(trace, "http://127.0.0.1").searchParams.get("path");
    if (path === null || path === "") {
      throw new Error("trace viewer omitted the trace path");
    }
    return path;
  }
  if (trace.startsWith("file:")) {
    return fileURLToPath(trace);
  }
  throw new Error(`unexpected trace location ${trace}`);
}

function httpRequest(target: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(target, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on("error", reject);
  });
}

function stopChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 1) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitForBrowsers(before: Set<number>): Promise<number[]> {
  let leaked: number[] = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const after = await browserPids();
    leaked = [...after].filter((pid) => !before.has(pid));
    if (leaked.length === 0) {
      return [];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return leaked;
}
