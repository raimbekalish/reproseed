import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../../src/cli/args.ts";
import { EXIT } from "../../src/cli/errors.ts";
import { main } from "../../src/cli/main.ts";

const VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
  version: string;
}).version;

describe("cli arguments", () => {
  it("prints help and version without reading a scenario", async () => {
    const help = await capture(["--help"]);
    assert.equal(help.code, EXIT.verified);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /reproseed minimize/);
    assert.match(help.stdout, /does not target production websites/);

    const minimizeHelp = await capture(["minimize", "--help"]);
    assert.equal(minimizeHelp.code, EXIT.verified);
    assert.equal(minimizeHelp.stderr, "");
    assert.match(minimizeHelp.stdout, /REPROSEED_RESET_AUTHORIZATION/);
    assert.match(minimizeHelp.stdout, /REPROSEED_ORIGIN/);
    assert.match(minimizeHelp.stdout, /REPROSEED_APP_ID/);
    assert.match(minimizeHelp.stdout, /\$\(command\)/);
    assert.match(minimizeHelp.stdout, /pass --force to replace it|unless --force is set/);
    assert.match(minimizeHelp.stdout, new RegExp(`\\n\\s*${EXIT.verified}\\s+Verified`));
    assert.match(minimizeHelp.stdout, new RegExp(`\\n\\s*${EXIT.usage}\\s+Invalid`));
    assert.match(minimizeHelp.stdout, new RegExp(`\\n\\s*${EXIT.unstable}\\s+No reproducible`));
    assert.match(minimizeHelp.stdout, new RegExp(`\\n\\s*${EXIT.budget}\\s+The replay`));
    assert.match(minimizeHelp.stdout, new RegExp(`\\n\\s*${EXIT.internal}\\s+The runner`));
    assert.match(minimizeHelp.stdout, /not a global proof/);
    assert.match(minimizeHelp.stdout, /not a minimization failure/);
    assert.match(minimizeHelp.stdout, /--tune-delays/);
    assert.match(minimizeHelp.stdout, /--timing-resolution/);
    assert.match(minimizeHelp.stdout, /250/);
    assert.match(minimizeHelp.stdout, /not treated as monotonic/);

    const version = await capture(["--version"]);
    assert.equal(version.code, EXIT.verified);
    assert.equal(version.stdout, `${VERSION}\n`);
    assert.equal(version.stderr, "");
  });

  it("rejects incomplete and unknown usage", async () => {
    const missing = await capture([]);
    assert.equal(missing.code, EXIT.usage);
    assert.match(missing.stderr, /command is required/);

    const unknown = await capture(["publish"]);
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.stderr, /unknown command publish/);

    const noFile = await capture(["minimize"]);
    assert.equal(noFile.code, EXIT.usage);
    assert.match(noFile.stderr, /scenario file is required/);

    const extra = await capture(["minimize", "one.json", "two.json"]);
    assert.equal(extra.code, EXIT.usage);
    assert.match(extra.stderr, /only one scenario file/);

    const option = await capture(["minimize", "one.json", "--json"]);
    assert.equal(option.code, EXIT.usage);
    assert.match(option.stderr, /unknown option --json/);

    const version = await capture(["minimize", "--version"]);
    assert.equal(version.code, EXIT.usage);
    assert.match(version.stderr, /--version does not take other arguments/);

    const parsed = parseArgs(["minimize", "--report=out/report.json", "scenario.json", "--spec", "out/spec.ts", "--force"]);
    assert.deepEqual(parsed, {
      kind: "minimize",
      scenarioPath: "scenario.json",
      reportPath: "out/report.json",
      specPath: "out/spec.ts",
      force: true,
    });

    const tuned = parseArgs([
      "minimize",
      "scenario.json",
      "--tune-delays",
      "--timing-resolution",
      "100",
      "--timing-max-replays=12",
      "--timing-max-ms",
      "5000",
    ]);
    assert.deepEqual(tuned, {
      kind: "minimize",
      scenarioPath: "scenario.json",
      reportPath: "artifacts/report.json",
      specPath: "artifacts/minimized.spec.ts",
      force: false,
      tuneDelays: { resolutionMs: 100, maxReplayExecutions: 12, maxWallClockMs: 5000 },
    });

    const resolutionOnly = await capture(["minimize", "scenario.json", "--timing-resolution", "100"]);
    assert.equal(resolutionOnly.code, EXIT.usage);
    assert.match(resolutionOnly.stderr, /require --tune-delays/);

    const badResolution = await capture(["minimize", "scenario.json", "--tune-delays", "--timing-resolution", "0"]);
    assert.equal(badResolution.code, EXIT.usage);
    assert.match(badResolution.stderr, /positive integer/);
  });
});

async function capture(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env: {},
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
