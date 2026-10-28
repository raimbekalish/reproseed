import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import vm from "node:vm";

import { EXIT } from "../../src/cli/errors.ts";
import { exitCodeForStatus } from "../../src/cli/format.ts";
import { main } from "../../src/cli/main.ts";
import type { MinimizeRunner, TraceCapture } from "../../src/cli/run.ts";
import type { MinimizeReport, MinimizeStatus, Scenario } from "../../src/core/types.ts";
import { optimizeVerifiedDuration } from "../../src/runner/minimize-duration.ts";
import { CORE_IDS, duplicateSignature, outcomeForDuplicateSubmit } from "../fixture.ts";
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
      assert.equal(result.stdout.includes("Trace evidence"), false);
      assert.deepEqual((await readdir(join(directory, "artifacts"))).sort(), ["minimized.spec.ts", "report.json"]);
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

  it("rejects an unsafe or colliding trace path before reset or minimization", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-path-"));
    try {
      const blocked = await run(directory, token, {
        args: ["--trace", "../repro.zip"],
        ...guards(),
      });
      assert.equal(blocked.code, EXIT.usage);
      assert.match(blocked.stderr, /must stay inside the current directory/);

      const extension = await run(directory, token, {
        args: ["--trace", "repro.txt"],
        ...guards(),
      });
      assert.equal(extension.code, EXIT.usage);
      assert.match(extension.stderr, /trace path must end in \.zip/);

      await mkdir(join(directory, "artifacts"), { recursive: true });
      await writeFile(join(directory, "artifacts/repro.zip"), "keep-zip");
      await writeFile(join(directory, "artifacts/report.json"), "keep-report");
      const exists = await run(directory, token, {
        args: ["--trace", "artifacts/repro.zip"],
        ...guards(),
      });
      assert.equal(exists.code, EXIT.usage);
      assert.match(exists.stderr, /refusing to overwrite/);
      assert.equal(await readFile(join(directory, "artifacts/repro.zip"), "utf8"), "keep-zip");
      assert.equal(await readFile(join(directory, "artifacts/report.json"), "utf8"), "keep-report");

      await writeFile(join(directory, "real.zip"), "keep-real");
      await symlink("real.zip", join(directory, "link.zip"));
      const linked = await run(directory, token, {
        args: ["--trace", "link.zip"],
        ...guards(),
      });
      assert.equal(linked.code, EXIT.usage);
      assert.match(linked.stderr, /symlink/);
      assert.equal(await readFile(join(directory, "real.zip"), "utf8"), "keep-real");

      const reportCollision = await run(directory, token, {
        args: ["--trace", "artifacts/report.json"],
        ...guards(),
      });
      assert.equal(reportCollision.code, EXIT.usage);
      assert.match(reportCollision.stderr, /trace path must end in \.zip/);
      assert.equal(await readFile(join(directory, "artifacts/report.json"), "utf8"), "keep-report");

      const scenarioZip = join(directory, "scenario.zip");
      await copyFile(EXAMPLE, scenarioZip);
      const before = await readFile(scenarioZip, "utf8");
      const collision = await run(directory, token, {
        scenario: "scenario.zip",
        args: ["--trace", "scenario.zip"],
        ...guards(),
      });
      assert.equal(collision.code, EXIT.usage);
      assert.match(collision.stderr, /scenario file must end in \.json/);
      assert.equal(await readFile(scenarioZip, "utf8"), before);
      assert.equal(blocked.stdout.includes(token), false);
      assert.equal(blocked.stderr.includes(token), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a verified trace for the kept steps and leaves replay counts unchanged", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-ok-"));
    try {
      let captured = 0;
      const result = await run(directory, token, {
        args: ["--trace", "artifacts/repro.zip"],
        minimize: async (input) => verifiedMinimizeReport(input.scenario, CORE_IDS),
        captureTrace: async ({ scenario, stepIds, tracePath }) => {
          captured += 1;
          assert.equal(scenario.target.resetAuthorization, token);
          assert.deepEqual(stepIds, [...CORE_IDS]);
          await writeFile(tracePath, "trace-bytes");
          return { outcome: outcomeForDuplicateSubmit(stepIds), traceSaved: true };
        },
      });
      assert.equal(result.code, EXIT.verified, result.stderr);
      assert.equal(captured, 1);
      assert.match(result.stdout, /verify: 5/);
      assert.match(result.stdout, /Trace evidence: verified/);
      assert.match(result.stdout, /omitted from the replay counts/);
      assert.equal(result.stdout.includes("Trace evidence: not-reproduced"), false);
      assert.equal(result.stdout.includes(token), false);
      assert.equal(result.stderr.includes(token), false);
      assert.equal(await readFile(join(directory, "artifacts/repro.zip"), "utf8"), "trace-bytes");
      const report = JSON.parse(await readFile(join(directory, "artifacts/report.json"), "utf8")) as {
        report: { counts: { replayExecutions: number; baselineReplays: number; searchReplays: number; verifyReplays: number } };
      };
      assert.equal(report.report.counts.verifyReplays, 5);
      assert.equal(
        report.report.counts.replayExecutions,
        report.report.counts.baselineReplays + report.report.counts.searchReplays + report.report.counts.verifyReplays,
      );
      assert.match(result.stdout, new RegExp(`Replay executions: ${report.report.counts.replayExecutions}`));
      const names = await readdir(join(directory, "artifacts"));
      assert.deepEqual(names.filter((name) => name.startsWith(".reproseed-trace-")), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not label a changed evidence signature as verified", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-miss-"));
    try {
      const result = await run(directory, token, {
        args: ["--trace", "artifacts/repro.zip"],
        minimize: async (input) => verifiedMinimizeReport(input.scenario, CORE_IDS),
        captureTrace: async ({ tracePath }) => {
          await writeFile(tracePath, "different-signature");
          return {
            outcome: { status: "fail", durationMs: 3, signature: duplicateSignature(9) },
            traceSaved: true,
          };
        },
      });
      assert.equal(result.code, EXIT.verified, result.stderr);
      assert.match(result.stdout, /Trace evidence: not-reproduced/);
      assert.match(result.stderr, /not-reproduced/);
      assert.equal(result.stdout.includes("Trace evidence: verified"), false);
      assert.equal(await readFile(join(directory, "artifacts/repro.zip"), "utf8"), "different-signature");
      const report = await readFile(join(directory, "artifacts/report.json"), "utf8");
      const spec = await readFile(join(directory, "artifacts/minimized.spec.ts"), "utf8");
      assert.equal(report.includes("not-reproduced"), false);
      assert.equal(spec.includes("not-reproduced"), false);
      assert.match(spec, /expect\(actual\)\.toBe\(1\)/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves the report, spec, and existing trace in place when capture fails", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-fail-"));
    try {
      const baseline = await run(directory, token, {
        minimize: async (input) => verifiedMinimizeReport(input.scenario, CORE_IDS),
      });
      assert.equal(baseline.code, EXIT.verified, baseline.stderr);
      const report = await readFile(join(directory, "artifacts/report.json"), "utf8");
      const spec = await readFile(join(directory, "artifacts/minimized.spec.ts"), "utf8");
      await writeFile(join(directory, "artifacts/repro.zip"), "previous-trace");
      const failed = await run(directory, token, {
        args: ["--force", "--trace", "artifacts/repro.zip"],
        minimize: async (input) => verifiedMinimizeReport(input.scenario, CORE_IDS),
        captureTrace: async () => {
          throw new Error(`capture blew up ${token}`);
        },
      });
      assert.equal(failed.code, EXIT.verified, failed.stderr);
      assert.match(failed.stderr, /Trace evidence: failed/);
      assert.match(failed.stderr, /\[redacted\]/);
      assert.equal(failed.stderr.includes(token), false);
      assert.equal(failed.stdout.includes(token), false);
      assert.equal(failed.stdout.includes("Trace evidence: verified"), false);
      assert.equal(await readFile(join(directory, "artifacts/report.json"), "utf8"), report);
      assert.equal(await readFile(join(directory, "artifacts/minimized.spec.ts"), "utf8"), spec);
      assert.equal(await readFile(join(directory, "artifacts/repro.zip"), "utf8"), "previous-trace");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not record verified trace evidence for an unverified minimization", async () => {
    const token = randomBytes(16).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "reproseed-trace-skip-"));
    try {
      let captured = 0;
      const result = await run(directory, token, {
        args: ["--trace", "artifacts/repro.zip"],
        minimize: async () => plainReport("unstable", `unstable ${token}`),
        captureTrace: async () => {
          captured += 1;
          return { outcome: { status: "pass", durationMs: 1 }, traceSaved: true };
        },
      });
      assert.equal(result.code, EXIT.unstable);
      assert.equal(captured, 0);
      assert.match(result.stderr, /Trace evidence was skipped/);
      assert.equal(result.stdout.includes("Trace evidence: verified"), false);
      assert.equal(result.stdout.includes(token), false);
      await assert.rejects(readFile(join(directory, "artifacts/repro.zip"), "utf8"));
      const report = await readFile(join(directory, "artifacts/report.json"), "utf8");
      assert.equal(report.includes(token), false);
      await assert.rejects(readFile(join(directory, "artifacts/minimized.spec.ts"), "utf8"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("traces the delay from the exported scenario", async () => {
    const token = randomBytes(16).toString("hex");
    const tunedDirectory = await mkdtemp(join(tmpdir(), "reproseed-trace-tuned-"));
    const keptDirectory = await mkdtemp(join(tmpdir(), "reproseed-trace-kept-"));
    try {
      let tunedDelay = 0;
      const tuned = await run(tunedDirectory, token, {
        args: ["--tune-delays", "--timing-resolution", "500", "--trace", "artifacts/repro.zip"],
        minimize: async (input) => {
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
        captureTrace: async ({ scenario, tracePath }) => {
          tunedDelay = delayMs(scenario);
          await writeFile(tracePath, "tuned-trace");
          return { outcome: outcomeForDuplicateSubmit(CORE_IDS), traceSaved: true };
        },
      });
      assert.equal(tuned.code, EXIT.verified, tuned.stderr);
      assert.equal(tunedDelay, 500);
      assert.match(tuned.stdout, /Trace evidence: verified/);
      assert.equal(embeddedDelayMs(await readFile(join(tunedDirectory, "artifacts/minimized.spec.ts"), "utf8")), 500);
      assert.equal(await readFile(join(tunedDirectory, "artifacts/repro.zip"), "utf8"), "tuned-trace");

      let keptDelay = 0;
      const kept = await run(keptDirectory, token, {
        args: ["--tune-delays", "--timing-resolution", "500", "--trace", "artifacts/repro.zip"],
        minimize: async (input) => {
          const stage1 = verifiedMinimizeReport(input.scenario, CORE_IDS);
          return optimizeVerifiedDuration({
            scenario: input.scenario,
            stage1,
            config: input.tuneDelays ?? { resolutionMs: 500, maxReplayExecutions: 36, maxWallClockMs: 180_000 },
            now: () => 0,
            probeFor: () => async () => ({
              status: "error",
              durationMs: 1,
              error: "timing probe missed",
              signature: { oracleId: "runner", code: "RUNNER_ERROR", facts: { message: "timing probe missed" } },
            }),
          });
        },
        captureTrace: async ({ scenario, tracePath }) => {
          keptDelay = delayMs(scenario);
          await writeFile(tracePath, "kept-trace");
          return { outcome: outcomeForDuplicateSubmit(CORE_IDS), traceSaved: true };
        },
      });
      assert.equal(kept.code, EXIT.verified, kept.stderr);
      assert.equal(keptDelay, 2000);
      assert.equal(embeddedDelayMs(await readFile(join(keptDirectory, "artifacts/minimized.spec.ts"), "utf8")), 2000);
    } finally {
      await rm(tunedDirectory, { recursive: true, force: true });
      await rm(keptDirectory, { recursive: true, force: true });
    }
  });
});

async function run(
  cwd: string,
  token: string,
  options: {
    args?: readonly string[];
    scenario?: string;
    env?: NodeJS.ProcessEnv;
    minimize?: MinimizeRunner;
    preflight?: () => Promise<void>;
    captureTrace?: TraceCapture;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(["minimize", options.scenario ?? EXAMPLE, ...(options.args ?? [])], {
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
    ...(options.captureTrace !== undefined ? { captureTrace: options.captureTrace } : {}),
  });
  return { code, stdout, stderr };
}

function guards(): { preflight: () => Promise<void>; minimize: MinimizeRunner } {
  return {
    preflight: async () => {
      throw new Error("preflight ran");
    },
    minimize: async () => {
      throw new Error("minimize ran");
    },
  };
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
