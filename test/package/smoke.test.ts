import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const VERSION = (JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as { version: string }).version;

const COPYRIGHT = "Copyright (c) 2026 Raimbek Alish";

const REQUIRED = [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli.js",
  "package/dist/export/runtime-config.ts",
  "package/dist/export/delay-match.ts",
  "package/dist/export/dom-text.ts",
  "package/examples/duplicate-submit/scenario.json",
  "package/examples/stale-search/scenario.json",
] as const;

const FORBIDDEN_NAME =
  /(^|\/)\.env($|\.)|\/artifacts\/|playwright-output|test-results|report\.json|minimized\.spec|\.pem$|id_rsa|credentials\.json/i;

const COPIED_ASSETS = [
  ["package/dist/export/runtime-config.ts", "src/export/runtime-config.ts"],
  ["package/dist/export/delay-match.ts", "src/runner/delay-match.ts"],
  ["package/dist/export/dom-text.ts", "src/runner/dom-text.ts"],
] as const;

describe("npm package smoke", () => {
  it("packs, installs, and runs the CLI outside the source checkout", { timeout: 300_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "reproseed-pack-"));
    try {
      const packed = await run("npm", ["pack", "--json", "--pack-destination", root], REPO, 180_000);
      assert.equal(packed.code, 0, packed.stderr);
      const jsonStart = packed.stdout.indexOf("[");
      assert.notEqual(jsonStart, -1, packed.stdout);
      const summary = JSON.parse(packed.stdout.slice(jsonStart)) as Array<{ filename: string }>;
      const filename = summary[0]?.filename;
      assert.equal(filename, `reproseed-${VERSION}.tgz`);
      const tarball = join(root, filename);
      const names = tarNames(await run("tar", ["-tzf", tarball], root, 30_000));
      assertPackEntries(names);
      const listing = (await run("tar", ["-tvzf", tarball], root, 30_000)).stdout;
      assert.equal(ownerExecutable(modeOf(listing, "package/dist/cli.js")), true, listing);
      const cli = await tarFile(tarball, "package/dist/cli.js");
      assert.equal(cli.startsWith("#!/usr/bin/env node\n"), true);
      const manifest = JSON.parse(await tarFile(tarball, "package/package.json")) as {
        name?: string;
        private?: boolean;
        version?: string;
        license?: string;
        bin?: { reproseed?: string };
      };
      assert.equal(manifest.name, "reproseed");
      assert.equal(Object.hasOwn(manifest, "private"), false);
      assert.equal(manifest.version, VERSION);
      assert.equal(manifest.license, "MIT");
      assert.equal(manifest.bin?.reproseed, "./dist/cli.js");
      const license = await tarFile(tarball, "package/LICENSE");
      assert.equal(license, await readFile(join(REPO, "LICENSE"), "utf8"));
      assert.equal(license.startsWith(`MIT License\n\n${COPYRIGHT}\n`), true);
      for (const name of names) {
        assert.equal(FORBIDDEN_NAME.test(name), false, name);
      }
      for (const [packedPath, sourcePath] of COPIED_ASSETS) {
        assert.equal(await tarFile(tarball, packedPath), await readFile(join(REPO, sourcePath), "utf8"));
      }
      for (const scenario of ["package/examples/duplicate-submit/scenario.json", "package/examples/stale-search/scenario.json"]) {
        assert.equal((await tarFile(tarball, scenario)).includes("resetAuthorization"), false, scenario);
      }

      const work = join(root, "app");
      await mkdir(work, { recursive: true });
      const init = await run("npm", ["init", "-y"], work, 30_000);
      assert.equal(init.code, 0, init.stderr);
      const installed = await run("npm", ["install", "--no-fund", "--no-audit", tarball], work, 180_000);
      assert.equal(installed.code, 0, `${installed.stdout}\n${installed.stderr}`);

      const pkgRoot = join(work, "node_modules/reproseed");
      await assert.rejects(access(join(pkgRoot, "src")));
      await assert.rejects(access(join(work, "src")));
      const versionFile = fileURLToPath(new URL("../../package.json", pathToFileURL(join(pkgRoot, "dist/cli/main.js"))));
      assert.equal(relative(pkgRoot, versionFile), "package.json");
      assert.equal(relative(REPO, pkgRoot).startsWith(".."), true);
      const cliStat = await stat(join(pkgRoot, "dist/cli.js"));
      assert.equal((cliStat.mode & 0o111) !== 0, true);
      const bin = join(work, "node_modules/.bin/reproseed");
      const binStat = await stat(bin);
      assert.equal((binStat.mode & 0o111) !== 0, true);

      const help = await run(bin, ["--help"], work, 30_000, cleanEnv());
      assert.equal(help.code, 0, help.stderr);
      assert.match(help.stdout, /does not target production websites/);
      assert.match(help.stdout, /loopback/);
      const version = await run(process.execPath, [join(pkgRoot, "dist/cli.js"), "--version"], work, 30_000, cleanEnv());
      assert.equal(version.code, 0, version.stderr);
      assert.equal(version.stdout, `${VERSION}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function assertPackEntries(names: readonly string[]): void {
  for (const required of REQUIRED) {
    assert.equal(names.includes(required), true, `missing ${required}`);
  }
  for (const name of names) {
    assert.equal(name.includes(".."), false, name);
    assert.equal(allowed(name), true, name);
  }
}

function allowed(name: string): boolean {
  if ((REQUIRED as readonly string[]).includes(name)) {
    return true;
  }
  return name.startsWith("package/dist/") && name.endsWith(".js");
}

function tarNames(result: { code: number; stdout: string; stderr: string }): string[] {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.endsWith("/"));
}

function modeOf(listing: string, name: string): string {
  const line = listing.split("\n").find((entry) => entry.trimEnd().endsWith(name));
  assert.ok(line, name);
  const mode = line.trim().split(/\s+/)[0];
  assert.ok(mode, line);
  return mode;
}

function ownerExecutable(mode: string): boolean {
  return mode.length >= 4 && mode[3] === "x";
}

async function tarFile(tarball: string, name: string): Promise<string> {
  const result = await run("tar", ["-xOf", tarball, name], tmpdir(), 30_000);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  if (process.env.SYSTEMROOT !== undefined) {
    env.SYSTEMROOT = process.env.SYSTEMROOT;
  }
  return env;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, env, timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });
}
