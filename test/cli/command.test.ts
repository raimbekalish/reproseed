import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import vm from "node:vm";

import { EXIT } from "../../src/cli/errors.ts";
import { exitCodeForStatus } from "../../src/cli/format.ts";
import { main } from "../../src/cli/main.ts";
import type { MinimizeRunner } from "../../src/cli/run.ts";
import type { MinimizeReport, MinimizeStatus, Scenario } from "../../src/core/types.ts";
import { optimizeVerifiedDuration } from "../../src/runner/minimize-duration.ts";
import { CORE_IDS, outcomeForDuplicateSubmit } from "../fixture.ts";
import { verifiedMinimizeReport } from "../export/verified-report.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/duplicate-submit/scenario.json", import.meta.url));

describe("minimize command", () => {
  it("maps minimization statuses onto exit codes", () => {
    assert.equal(exitCodeForStatus("verified-one-minimal"), EXIT.verified);
    assert.equal(exitCodeForStatus("unstable"), EXIT.unstable);
    assert.equal(exitCodeForStatus("flaky-baseline"), EXIT.unstable);
    assert.equal(exitCodeForStatus("no-reproducible-failure"), EXIT.unstable);
    assert.equal(exitCodeForStatus("budget-exhausted"), EXIT.budget);
  });

  it("writes a report and spec from a verified result without printing the reset credential", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-command-"));
    try {
      let minimized = 0;
      const result = await run(directory, token, {
        minimize: async (input) => {
          minimized += 1;
          assert.equal(input.scenario.target.resetAuthorization, token);
          const report = verifiedMinimizeReport(input.scenario, CORE_IDS);
          report.claim = `${report.claim} ${token}`;
          return report;
        },
      });
      assert.equal(minimized, 1);
      assert.equal(result.code, EXIT.verified);
      assert.equal(result.stdout.includes(token), false);
      assert.equal(result.stderr.includes(token), false);
      assert.match(result.stdout, /Status: verified-one-minimal/);
      assert.match(result.stdout, /Original steps: 9/);
      assert.match(result.stdout, /Kept steps: 6/);
      assert.match(result.stdout, /Removed steps: preview, note, decoy-wait/);
      assert.match(result.stdout, /verify: 5/);
      assert.match(result.stdout, /\[redacted\]/);
      assert.match(result.stdout, /not a proof of the globally shortest reproduction/);
      assert.equal(result.stdout.includes("Timing optimization"), false);
      const report = await readFile(join(directory, "artifacts/report.json"), "utf8");
      const spec = await readFile(join(directory, "artifacts/minimized.spec.ts"), "utf8");
      assert.equal(report.includes(token), false);
      assert.equal(report.includes("resetAuthorization"), false);
      assert.equal(spec.includes(token), false);
      assert.equal(spec.includes("http://127.0.0.1:4010"), false);
      assert.match(spec, /expect\(actual\)\.toBe\(1\)/);
      assert.equal(spec.includes("minimize("), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not write a spec for an unstable or budget-exhausted result", async () => {
    const token = randomBytes(16).toString("hex");
    for (const status of ["unstable", "budget-exhausted"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "reproseed-status-"));
      try {
        const spec = join(directory, "artifacts/minimized.spec.ts");
        await writeFile(join(directory, "old-spec.ts"), "leave me");
        const result = await run(directory, token, {
          args: ["--spec", "old-spec.ts", "--force"],
          minimize: async () => plainReport(status, `no claim ${token}`),
        });
        assert.equal(result.code, status === "budget-exhausted" ? EXIT.budget : EXIT.unstable);
        assert.match(result.stdout, new RegExp(`Status: ${status}`));
        assert.match(result.stdout, /Test: not written/);
        assert.match(result.stdout, /Regression test was not written/);
        assert.equal(result.stdout.includes(token), false);
        assert.equal(await readFile(join(directory, "old-spec.ts"), "utf8"), "leave me");
        await assert.rejects(readFile(spec, "utf8"));
        const report = await readFile(join(directory, "artifacts/report.json"), "utf8");
        assert.equal(report.includes(token), false);
        assert.match(report, /\[redacted\]/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("refuses a verified-looking spec when export or the report shape fails", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-export-"));
    try {
      const inconsistent = await run(directory, token, {
        args: ["--report", "bad/report.json", "--spec", "bad/spec.ts"],
        minimize: async () => plainReport("verified-one-minimal", "not really"),
      });
      assert.equal(inconsistent.code, EXIT.internal);
      assert.match(inconsistent.stderr, /five final replays/);
      await assert.rejects(readFile(join(directory, "bad/spec.ts"), "utf8"));
      await assert.rejects(readFile(join(directory, "bad/report.json"), "utf8"));

      const refused = await run(directory, token, {
        args: ["--report", "refused/report.json", "--spec", "refused/spec.ts"],
        minimize: async (input) => {
          const report = verifiedMinimizeReport(input.scenario, CORE_IDS);
          const replay = report.replays.find((item) => item.phase === "verify");
          assert.ok(replay);
          replay.outcome = { status: "pass", durationMs: 1 };
          return report;
        },
      });
      assert.equal(refused.code, EXIT.internal);
      assert.match(refused.stderr, /verification did not reproduce/);
      assert.match(refused.stdout, /Test: not written/);
      await assert.rejects(readFile(join(directory, "refused/spec.ts"), "utf8"));
      const report = await readFile(join(directory, "refused/report.json"), "utf8");
      assert.equal(report.includes(token), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops before minimization when the output path or target is unsafe", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-paths-"));
    const nested = join(directory, "work");
    await writeFile(join(directory, "parent"), "not a directory");
    try {
      let calls = 0;
      const minimize: MinimizeRunner = async () => {
        calls += 1;
        throw new Error("minimizer should not run");
      };
      const outside = await run(nested, token, {
        args: ["--report", "../report.json"],
        minimize,
        preflight: async () => {
          throw new Error("target should not be reset");
        },
      });
      assert.equal(outside.code, EXIT.usage);
      assert.match(outside.stderr, /inside the current directory/);
      const blocked = await run(directory, token, {
        args: ["--report", "parent/report.json"],
        minimize,
      });
      assert.equal(blocked.code, EXIT.usage);
      assert.match(blocked.stderr, /not a directory/);
      const existing = join(directory, "artifacts/report.json");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(directory, "artifacts"), { recursive: true });
      await writeFile(existing, "keep");
      const overwrite = await run(directory, token, { minimize });
      assert.equal(overwrite.code, EXIT.usage);
      assert.match(overwrite.stderr, /pass --force/);
      assert.equal(await readFile(existing, "utf8"), "keep");
      const unsafe = await run(directory, token, {
        env: { REPROSEED_ORIGIN: "http://example.com" },
        minimize,
      });
      assert.equal(unsafe.code, EXIT.usage);
      assert.match(unsafe.stderr, /non-loopback/);
      assert.equal(calls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exports a tuned delay when timing verification succeeds and redacts the reset credential", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-tune-"));
    try {
      const result = await run(directory, token, {
        args: ["--tune-delays", "--timing-resolution", "500", "--timing-max-replays", "40", "--timing-max-ms", "60000"],
        minimize: async (input) => {
          assert.equal(input.tuneDelays?.resolutionMs, 500);
          assert.equal(input.tuneDelays?.maxReplayExecutions, 40);
          const stage1 = verifiedMinimizeReport(input.scenario, CORE_IDS);
          return optimizeVerifiedDuration({
            scenario: input.scenario,
            stage1,
            config: input.tuneDelays ?? { resolutionMs: 500, maxReplayExecutions: 40, maxWallClockMs: 60_000 },
            now: () => 0,
            probeFor: (variant) => async (ids) => {
              const ms = delayMs(variant);
              if (ms !== 500 && ms < 2000) {
                return { status: "pass", durationMs: 1 };
              }
              return outcomeForDuplicateSubmit(ids);
            },
          });
        },
      });
      assert.equal(result.code, EXIT.verified, result.stderr);
      assert.match(result.stdout, /Timing optimization: requested/);
      assert.match(result.stdout, /Timing improved: yes/);
      assert.match(result.stdout, /Original delay: 2000ms \(slow\)/);
      assert.match(result.stdout, /Selected delay: 500ms/);
      assert.match(result.stdout, /Final delay: 500ms/);
      assert.match(result.stdout, /Tuned result fully verified: yes/);
      assert.match(result.stdout, /Original verified result retained: no/);
      assert.equal(result.stdout.includes(token), false);
      const spec = await readFile(join(directory, "artifacts/minimized.spec.ts"), "utf8");
      assert.equal(embeddedDelayMs(spec), 500);
      assert.equal(spec.includes(token), false);
      const report = await readFile(join(directory, "artifacts/report.json"), "utf8");
      assert.equal(report.includes(token), false);
      assert.equal(report.includes("resetAuthorization"), false);
      assert.match(report, /"selectedMs": 500/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the verified scenario when a shorter delay is not confirmed", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-tune-fallback-"));
    try {
      const result = await run(directory, token, {
        args: ["--tune-delays", "--timing-resolution", "500"],
        minimize: async (input) => {
          const stage1 = verifiedMinimizeReport(input.scenario, CORE_IDS);
          stage1.claim = `${stage1.claim} ${token}`;
          return optimizeVerifiedDuration({
            scenario: input.scenario,
            stage1,
            config: input.tuneDelays ?? { resolutionMs: 500, maxReplayExecutions: 36, maxWallClockMs: 180_000 },
            now: () => 0,
            probeFor: () => async () => ({
              status: "error",
              durationMs: 1,
              error: `reset refused for ${token}`,
              signature: { oracleId: "runner", code: "RUNNER_ERROR", facts: { message: `reset refused for ${token}` } },
            }),
          });
        },
      });
      assert.equal(result.code, EXIT.verified, result.stderr);
      assert.match(result.stdout, /Timing improved: no/);
      assert.match(result.stdout, /Original verified result retained: yes/);
      assert.match(result.stdout, /\[redacted\]/);
      assert.equal(result.stdout.includes(token), false);
      const spec = await readFile(join(directory, "artifacts/minimized.spec.ts"), "utf8");
      assert.equal(embeddedDelayMs(spec), 2000);
      const report = await readFile(join(directory, "artifacts/report.json"), "utf8");
      assert.equal(report.includes(token), false);
      assert.match(report, /\[redacted\]/);
      assert.match(report, /"originalMs": 2000/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function run(
  cwd: string,
  token: string,
  options: {
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
    minimize?: MinimizeRunner;
    preflight?: () => Promise<void>;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(["minimize", EXAMPLE, ...(options.args ?? [])], {
    cwd,
    env: {
      REPROSEED_ORIGIN: "http://127.0.0.1:4010",
      REPROSEED_APP_ID: "duplicate-submit",
      REPROSEED_RESET_AUTHORIZATION: token,
      ...options.env,
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    preflight: options.preflight ?? (async () => undefined),
    ...(options.minimize !== undefined ? { minimize: options.minimize } : {}),
  });
  return { code, stdout, stderr };
}

function delayMs(scenario: Scenario): number {
  const step = scenario.steps.find((candidate) => candidate.kind === "delay");
  if (step === undefined || step.kind !== "delay") {
    throw new Error("scenario has no delay step");
  }
  return step.ms;
}

function embeddedDelayMs(source: string): number {
  const marker = "const scenario = ";
  const start = source.indexOf(marker);
  const expressionStart = start + marker.length;
  const end = source.indexOf(" as ExportedScenario;", expressionStart);
  const value = vm.runInNewContext(source.slice(expressionStart, end), { JSON }) as {
    steps: Array<{ kind: string; ms?: number }>;
  };
  const delay = value.steps.find((step) => step.kind === "delay");
  if (delay?.ms === undefined) {
    throw new Error("exported spec has no delay");
  }
  return delay.ms;
}

function plainReport(status: MinimizeStatus, claim: string): MinimizeReport {
  return {
    status,
    claim,
    limitations: ["sampled"],
    inputStepIds: ["open", "preview", "email", "note", "decoy-wait", "slow", "submit-1", "gap", "submit-2"],
    keptStepIds: ["open"],
    counts: {
      replayExecutions: 0,
      candidateEvaluations: 0,
      cacheHits: 0,
      baselineReplays: 0,
      searchReplays: 0,
      verifyReplays: 0,
    },
    budget: {
      maxReplayExecutions: 60,
      replayExecutions: 0,
      maxWallClockMs: 300_000,
      elapsedMs: 15,
      exhausted: status === "budget-exhausted",
      ...(status === "budget-exhausted" ? { exhaustedReason: "replay-executions" as const } : {}),
    },
    replays: [],
    evaluations: [],
    singleDeletion: [],
  };
}
