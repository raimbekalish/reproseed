import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  collectDoctorChecks,
  DOCTOR_CHECK_IDS,
  doctorExitCode,
  formatDoctorReport,
  type DoctorCheck,
} from "../src/cli/doctor.ts";
import { EXIT } from "../src/cli/errors.ts";
import { describeChromiumInstallation } from "../src/runner/session.ts";
import type { FetchLike } from "../src/runner/reset.ts";
import { starterScenario } from "../src/cli/starter.ts";

const TOKEN = "doctor-test-token-value";

describe("doctor checks", () => {
  it("passes readable checks and leaves reset unverified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-doctor-"));
    const calls: Array<{ method: string; url: string; redirect: string | undefined }> = [];
    try {
      const scenario = join(directory, "scenario.json");
      await writeFile(scenario, JSON.stringify(starterScenario("record-count")));
      const checks = await collectDoctorChecks({
        scenarioPath: scenario,
        cwd: directory,
        env: targetEnv(),
        stdout: () => undefined,
        fetchImpl: mockFetch(calls, {
          "/": () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
          "/__reproseed/identity": () => json(200, { appId: "replace-with-your-app-id", secret: TOKEN }),
          "/api/items": () => json(200, []),
        }),
        inspectChromium: () => ({ ready: true, detail: "Playwright's downloaded Chromium is installed. Doctor did not launch a browser." }),
      });
      assert.deepEqual(checks.map((item) => item.id), [...DOCTOR_CHECK_IDS]);
      assert.equal(doctorExitCode(checks), EXIT.verified);
      const report = formatDoctorReport(checks);
      assert.equal(report.includes(TOKEN), false);
      assert.match(report, /Doctor does not send POST \/__reproseed\/reset/);
      assert.match(report, /Doctor does not launch a browser/);
      assert.match(report, /not verified without a reset/);
      assert.equal(status(checks, "reset-accepted"), "not-verified");
      assert.equal(status(checks, "clean-state-after-reset"), "not-verified");
      assert.equal(status(checks, "clean-state-endpoint"), "pass");
      assert.match(detail(checks, "target-identity"), /replace-with-your-app-id/);
      assert.equal(detail(checks, "target-identity").includes(TOKEN), false);
      assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "GET"]);
      assert.equal(calls.every((call) => call.redirect === "error"), true);
      assert.equal(calls.some((call) => call.url.includes("/__reproseed/reset")), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not contact a non-loopback origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-doctor-remote-"));
    let fetches = 0;
    try {
      const scenario = join(directory, "scenario.json");
      const body = starterScenario("record-count") as { target: { origin: string } };
      body.target.origin = "http://example.com";
      await writeFile(scenario, JSON.stringify(body));
      const checks = await collectDoctorChecks({
        scenarioPath: scenario,
        cwd: directory,
        env: targetEnv({ REPROSEED_ORIGIN: "http://example.com" }),
        stdout: () => undefined,
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("fetch should not run");
        },
        inspectChromium: readyChromium,
      });
      assert.equal(fetches, 0);
      assert.equal(status(checks, "loopback-origin"), "fail");
      assert.match(detail(checks, "loopback-origin"), /non-loopback/);
      assert.match(detail(checks, "target-available"), /did not contact/);
      assert.equal(doctorExitCode(checks), EXIT.usage);
      assert.equal(formatDoctorReport(checks).includes(TOKEN), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a down target, an identity mismatch, and a missing browser without resetting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-doctor-down-"));
    try {
      const scenario = join(directory, "scenario.json");
      await writeFile(scenario, JSON.stringify(starterScenario("dom-text")));
      const down = await collectDoctorChecks({
        scenarioPath: scenario,
        cwd: directory,
        env: targetEnv(),
        stdout: () => undefined,
        fetchImpl: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        inspectChromium: readyChromium,
      });
      assert.equal(status(down, "target-available"), "fail");
      assert.match(detail(down, "target-available"), /Could not connect/);
      assert.equal(status(down, "target-identity"), "skipped");
      assert.equal(status(down, "reset-accepted"), "not-verified");
      assert.equal(doctorExitCode(down), EXIT.usage);

      const mismatchCalls: Array<{ method: string; url: string; redirect: string | undefined }> = [];
      const mismatch = await collectDoctorChecks({
        scenarioPath: scenario,
        cwd: directory,
        env: targetEnv(),
        stdout: () => undefined,
        fetchImpl: mockFetch(mismatchCalls, {
          "/": () => new Response("ok", { status: 200 }),
          "/__reproseed/identity": () => json(200, { appId: "other-app" }),
          "/api/events": () => json(200, [{ id: "1" }]),
        }),
        inspectChromium: () => ({
          ready: false,
          detail: "Playwright's downloaded Chromium is not installed. Install it with npx playwright install --with-deps --no-shell chromium. Doctor did not launch a browser.",
        }),
      });
      assert.equal(status(mismatch, "target-identity"), "fail");
      assert.match(detail(mismatch, "target-identity"), /other-app/);
      assert.match(detail(mismatch, "clean-state-endpoint"), /1 item/);
      assert.equal(status(mismatch, "chromium"), "fail");
      assert.match(detail(mismatch, "chromium"), /did not launch a browser/);
      assert.equal(mismatchCalls.some((call) => call.method === "POST"), false);
      assert.equal(mismatchCalls.some((call) => call.url.includes("/__reproseed/reset")), false);
      assert.equal(doctorExitCode(mismatch), EXIT.usage);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a scenario that embeds the reset credential and does not print it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reproseed-doctor-secret-"));
    let fetches = 0;
    try {
      const scenario = join(directory, "scenario.json");
      const body = starterScenario("record-count") as { steps: Array<{ value?: string }> };
      const email = body.steps.find((step) => step.value === "a@example.com");
      assert.ok(email);
      email.value = TOKEN;
      await writeFile(scenario, JSON.stringify(body));
      const checks = await collectDoctorChecks({
        scenarioPath: scenario,
        cwd: directory,
        env: targetEnv(),
        stdout: () => undefined,
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("fetch should not run");
        },
        inspectChromium: readyChromium,
      });
      assert.equal(fetches, 0);
      assert.equal(status(checks, "environment"), "fail");
      assert.match(detail(checks, "environment"), /reset authorization/);
      assert.equal(formatDoctorReport(checks).includes(TOKEN), false);
      assert.equal(doctorExitCode(checks), EXIT.usage);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks the Chromium install path without launching a browser", () => {
    const missing = describeChromiumInstallation({
      executablePath: () => "/cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
      exists: () => false,
      fallback: () => undefined,
    });
    assert.equal(missing.ready, false);
    assert.match(missing.detail, /npx playwright install --with-deps --no-shell chromium/);
    assert.match(missing.detail, /did not launch a browser/);

    const shell = describeChromiumInstallation({
      executablePath: () => "/cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell",
      exists: () => true,
      fallback: () => undefined,
    });
    assert.equal(shell.ready, false);
    assert.match(shell.detail, /not Playwright's downloaded Chromium/);

    const ready = describeChromiumInstallation({
      executablePath: () => "/cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell",
      exists: (path) => path.includes("chromium-1248/"),
      fallback: () => "/cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    });
    assert.equal(ready.ready, true);
    assert.match(ready.detail, /did not launch a browser/);

    const actual = describeChromiumInstallation();
    assert.match(actual.detail, /did not launch a browser/);
  });
});

function status(checks: readonly DoctorCheck[], id: DoctorCheck["id"]): string {
  const found = checks.find((item) => item.id === id);
  assert.ok(found, id);
  return found.status;
}

function detail(checks: readonly DoctorCheck[], id: DoctorCheck["id"]): string {
  const found = checks.find((item) => item.id === id);
  assert.ok(found, id);
  return found.detail;
}

function targetEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    REPROSEED_ORIGIN: "http://127.0.0.1:3000",
    REPROSEED_APP_ID: "replace-with-your-app-id",
    REPROSEED_RESET_AUTHORIZATION: TOKEN,
    ...overrides,
  };
}

function readyChromium(): { ready: true; detail: string } {
  return { ready: true, detail: "Playwright's downloaded Chromium is installed. Doctor did not launch a browser." };
}

function json(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  calls: Array<{ method: string; url: string; redirect: string | undefined }>,
  routes: Record<string, () => Response>,
): FetchLike {
  return async (input, init) => {
    const url = input instanceof URL ? input.href : String(input);
    assert.equal(init?.headers, undefined);
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      redirect: init?.redirect,
    });
    const handler = routes[new URL(url).pathname];
    assert.ok(handler, url);
    return handler();
  };
}
