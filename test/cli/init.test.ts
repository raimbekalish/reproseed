import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseArgs } from "../../src/cli/args.ts";
import { EXIT } from "../../src/cli/errors.ts";
import { main } from "../../src/cli/main.ts";
import { loadScenarioFile } from "../../src/cli/scenario-file.ts";
import { STARTER_ORIGIN } from "../../src/cli/starter.ts";

const TOKEN = "init-test-token-value";

describe("init command", () => {
  it("writes a schema-valid scenario and refuses to replace it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-init-"));
    try {
      const created = await run(directory, ["init", "--oracle", "record-count"]);
      assert.equal(created.code, EXIT.verified, created.stderr);
      assert.match(created.stdout, /Wrote scenario.json/);
      assert.match(created.stdout, /replace-with-your-app-id/);
      assert.match(created.stdout, /opt in/);
      assert.equal(created.stdout.includes(TOKEN), false);
      assert.equal(created.stderr.includes(TOKEN), false);
      const text = await readFile(join(directory, "scenario.json"), "utf8");
      assert.equal(text.includes(TOKEN), false);
      assert.equal(text.includes("resetAuthorization"), false);
      assert.match(text, /http:\/\/127\.0\.0\.1:3000/);
      const scenario = await loadScenarioFile(join(directory, "scenario.json"), directory, {
        REPROSEED_ORIGIN: STARTER_ORIGIN,
        REPROSEED_APP_ID: "replace-with-your-app-id",
        REPROSEED_RESET_AUTHORIZATION: TOKEN,
      });
      assert.equal(scenario.oracle.id, "record-count");
      assert.equal(scenario.target.resetAuthorization, TOKEN);

      const kept = await run(directory, ["init"]);
      assert.equal(kept.code, EXIT.usage);
      assert.match(kept.stderr, /pass --force/);
      assert.equal(await readFile(join(directory, "scenario.json"), "utf8"), text);

      const replaced = await run(directory, ["init", "scenario.json", "--oracle=dom-text", "--force"]);
      assert.equal(replaced.code, EXIT.verified, replaced.stderr);
      const dom = await loadScenarioFile(join(directory, "scenario.json"), directory, {
        REPROSEED_ORIGIN: STARTER_ORIGIN,
        REPROSEED_APP_ID: "replace-with-your-app-id",
        REPROSEED_RESET_AUTHORIZATION: TOKEN,
      });
      assert.equal(dom.oracle.id, "dom-text");
      assert.equal((await readFile(join(directory, "scenario.json"), "utf8")).includes(TOKEN), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an output path outside the directory or through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-init-path-"));
    const outside = await mkdtemp(join(tmpdir(), "reproseed-init-out-"));
    try {
      const escaped = await run(directory, ["init", "../scenario.json"]);
      assert.equal(escaped.code, EXIT.usage);
      assert.match(escaped.stderr, /inside the current directory/);

      await writeFile(join(outside, "target.json"), "keep");
      await symlink(join(outside, "target.json"), join(directory, "linked.json"));
      const linked = await run(directory, ["init", "linked.json", "--force"]);
      assert.equal(linked.code, EXIT.usage);
      assert.match(linked.stderr, /symlink/);
      assert.equal(await readFile(join(outside, "target.json"), "utf8"), "keep");

      const oracle = await run(directory, ["init", "--oracle", "shell"]);
      assert.equal(oracle.code, EXIT.usage);
      assert.match(oracle.stderr, /record-count or dom-text/);
      assert.deepEqual(parseArgs(["init", "--oracle=dom-text", "nested/app.json"]), {
        kind: "init",
        scenarioPath: "nested/app.json",
        oracle: "dom-text",
        force: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("prints help without creating a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-init-help-"));
    try {
      const help = await run(directory, ["init", "--help"]);
      assert.equal(help.code, EXIT.verified);
      assert.match(help.stdout, /does not contain a reset credential/);
      assert.match(help.stdout, /127\.0\.0\.1:3000/);
      await assert.rejects(readFile(join(directory, "scenario.json"), "utf8"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function run(cwd: string, argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env: { REPROSEED_RESET_AUTHORIZATION: TOKEN, REPROSEED_ORIGIN: "http://example.com" },
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
