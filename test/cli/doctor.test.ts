import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseArgs } from "../../src/cli/args.ts";
import { EXIT } from "../../src/cli/errors.ts";
import { main } from "../../src/cli/main.ts";
import { starterScenario } from "../../src/cli/starter.ts";
import type { FetchLike } from "../../src/runner/reset.ts";

const TOKEN = "cli-doctor-token-value";

describe("doctor command", () => {
  it("prints help and rejects incomplete usage", async () => {
    const help = await capture(["doctor", "--help"], {});
    assert.equal(help.code, EXIT.verified);
    assert.match(help.stdout, /does not send POST \/__reproseed\/reset/);
    assert.match(help.stdout, /does not launch a browser/);
    assert.match(help.stdout, /not verified/);
    assert.match(help.stdout, new RegExp(`\\n\\s*${EXIT.verified}\\s+Every required`));
    assert.match(help.stdout, new RegExp(`\\n\\s*${EXIT.usage}\\s+Invalid`));
    assert.equal(help.stdout.includes(TOKEN), false);

    const missing = await capture(["doctor"], {});
    assert.equal(missing.code, EXIT.usage);
    assert.match(missing.stderr, /scenario file is required/);

    const extra = await capture(["doctor", "one.json", "two.json"], {});
    assert.equal(extra.code, EXIT.usage);
    assert.match(extra.stderr, /only one scenario file/);
    assert.deepEqual(parseArgs(["doctor", "scenario.json"]), { kind: "doctor", scenarioPath: "scenario.json" });
  });

  it("does not print the credential and does not reset a mocked target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-doctor-cli-"));
    const calls: string[] = [];
    try {
      await writeFile(join(directory, "scenario.json"), `${JSON.stringify(starterScenario("record-count"), null, 2)}\n`);
      const result = await capture(["doctor", "scenario.json"], targetEnv(), directory, recordingFetch(calls));
      assert.equal(result.code, EXIT.verified, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout.includes(TOKEN), false);
      assert.equal(result.stderr.includes(TOKEN), false);
      assert.match(result.stdout, /No check failed/);
      assert.match(result.stdout, /not-verified\s+reset-accepted/);
      assert.match(result.stdout, /not-verified\s+clean-state-after-reset/);
      assert.deepEqual(calls, ["GET", "GET", "GET"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips the network when the scenario cannot be read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-doctor-missing-"));
    let fetches = 0;
    try {
      const fetchImpl: FetchLike = async () => {
        fetches += 1;
        throw new Error("fetch should not run");
      };
      const result = await capture(["doctor", "missing.json"], targetEnv(), directory, fetchImpl);
      assert.equal(result.code, EXIT.usage);
      assert.match(result.stdout, /fail\s+scenario-file/);
      assert.match(result.stdout, /was not found/);
      assert.match(result.stdout, /did not contact/);
      assert.equal(fetches, 0);
      assert.equal(result.stdout.includes(TOKEN), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function targetEnv(): NodeJS.ProcessEnv {
  return {
    REPROSEED_ORIGIN: "http://127.0.0.1:3000",
    REPROSEED_APP_ID: "replace-with-your-app-id",
    REPROSEED_RESET_AUTHORIZATION: TOKEN,
  };
}

function recordingFetch(calls: string[]): FetchLike {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(method);
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname === "/") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/__reproseed/identity") {
      return Response.json({ appId: "replace-with-your-app-id" });
    }
    if (url.pathname === "/api/items") {
      return Response.json([{ id: "kept", email: "a@example.com", note: "", createdAt: 1 }]);
    }
    return new Response("missing", { status: 404 });
  };
}

async function capture(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = tmpdir(),
  fetchImpl?: FetchLike,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env,
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...(fetchImpl !== undefined ? { doctorFetch: fetchImpl } : {}),
    doctorChromium: () => ({
      ready: true,
      detail: "Playwright's downloaded Chromium is installed. Doctor did not launch a browser.",
    }),
  });
  return { code, stdout, stderr };
}
