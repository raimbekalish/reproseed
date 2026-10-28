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
      assert.equal(status(checks, "oracle-endpoint"), "skipped");
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
      assert.equal(status(down, "clean-state-endpoint"), "skipped");
      assert.equal(status(down, "oracle-endpoint"), "skipped");
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
      assert.equal(status(mismatch, "clean-state-endpoint"), "pass");
      assert.match(detail(mismatch, "clean-state-endpoint"), /1 item/);
      assert.doesNotMatch(detail(mismatch, "clean-state-endpoint"), /record-count shape|cannot read/);
      assert.equal(status(mismatch, "oracle-endpoint"), "pass");
      assert.match(detail(mismatch, "oracle-endpoint"), /did not request a record list/);
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

  it("accepts an empty record list and a valid non-empty list without printing values", async () => {
    const empty = await diagnose(starterScenario("record-count"), readyRoutes("/api/items", []));
    assert.equal(status(empty.checks, "clean-state-endpoint"), "pass");
    assert.equal(status(empty.checks, "oracle-endpoint"), "pass");
    assert.match(detail(empty.checks, "clean-state-endpoint"), /JSON array with 0 items/);
    assert.match(detail(empty.checks, "oracle-endpoint"), /JSON array with 0 items/);
    assert.match(detail(empty.checks, "oracle-endpoint"), /accepts an empty list/);
    assert.doesNotMatch(detail(empty.checks, "clean-state-endpoint"), /record-count shape|cannot read/);
    assert.equal(empty.calls.filter((path) => path === "/api/items").length, 1);
    assert.equal(empty.report.includes(TOKEN), false);

    const listed = await diagnose(
      starterScenario("record-count"),
      readyRoutes("/api/items", [{ id: TOKEN, email: TOKEN, note: TOKEN, createdAt: 1, secret: TOKEN }]),
    );
    assert.equal(status(listed.checks, "clean-state-endpoint"), "pass");
    assert.equal(status(listed.checks, "oracle-endpoint"), "pass");
    assert.match(detail(listed.checks, "clean-state-endpoint"), /JSON array with 1 item/);
    assert.doesNotMatch(detail(listed.checks, "clean-state-endpoint"), /record-count shape|cannot read/);
    assert.match(detail(listed.checks, "oracle-endpoint"), /record-count shape/);
    assert.match(detail(listed.checks, "oracle-endpoint"), /same GET as reset verification/);
    assert.equal(listed.report.includes(TOKEN), false);
    assert.deepEqual(listed.calls, ["/", "/__reproseed/identity", "/api/items"]);
    assert.deepEqual(listed.methods, ["GET", "GET", "GET"]);
    assert.equal(listed.redirects.every((redirect) => redirect === "error"), true);
    assert.equal(listed.calls.some((path) => path.includes("/__reproseed/reset")), false);
  });

  it("rejects malformed oracle records without failing reset verification", async () => {
    const missing = await diagnose(starterScenario("record-count"), readyRoutes("/api/items", [{ id: TOKEN }]));
    assert.equal(status(missing.checks, "clean-state-endpoint"), "pass");
    assert.doesNotMatch(detail(missing.checks, "clean-state-endpoint"), /cannot read|missing email/);
    assert.equal(status(missing.checks, "oracle-endpoint"), "fail");
    assert.match(detail(missing.checks, "oracle-endpoint"), /record-count oracle cannot read/);
    assert.match(detail(missing.checks, "oracle-endpoint"), /item 0: missing email, note, createdAt/);
    assert.match(detail(missing.checks, "oracle-endpoint"), /Record values are not printed/);
    assert.equal(missing.report.includes(TOKEN), false);
    assert.equal(doctorExitCode(missing.checks), EXIT.usage);

    const wrong = await diagnose(
      starterScenario("record-count"),
      readyRoutes("/api/items", [{ id: 1, email: false, note: null, createdAt: TOKEN }]),
    );
    assert.equal(status(wrong.checks, "clean-state-endpoint"), "pass");
    assert.equal(status(wrong.checks, "oracle-endpoint"), "fail");
    assert.match(detail(wrong.checks, "oracle-endpoint"), /item 0: wrong type for id, email, note, createdAt/);
    assert.equal(wrong.report.includes(TOKEN), false);

    const mixed = await diagnose(
      starterScenario("record-count"),
      readyRoutes("/api/items", [
        { id: "rec-1", email: TOKEN, note: TOKEN, createdAt: 1 },
        "not-a-record",
        { note: 1 },
      ]),
    );
    assert.equal(status(mixed.checks, "clean-state-endpoint"), "pass");
    assert.equal(status(mixed.checks, "oracle-endpoint"), "fail");
    assert.match(detail(mixed.checks, "oracle-endpoint"), /item 1 is not a record object/);
    assert.match(detail(mixed.checks, "oracle-endpoint"), /item 2: missing id, email, createdAt; wrong type for note/);
    assert.doesNotMatch(detail(mixed.checks, "oracle-endpoint"), /item 0/);
    assert.equal(mixed.report.includes(TOKEN), false);
    assert.equal(mixed.report.includes("not-a-record"), false);
    assert.equal(mixed.methods.every((method) => method === "GET"), true);
  });

  it("accepts non-record reset history and checks a separate oracle list", async () => {
    const body = starterScenario("record-count") as {
      reset: { verify: { path: string } };
      oracle: { request: { path: string } };
    };
    body.reset.verify.path = "/api/reset-history";
    body.oracle.request.path = "/api/tickets";
    const accepted = await diagnose(body, {
      "/": () => new Response("<html></html>", { status: 200 }),
      "/__reproseed/identity": () => json(200, { appId: "replace-with-your-app-id" }),
      "/api/reset-history": () => json(200, [{ event: TOKEN, at: 1 }]),
      "/api/tickets": () => json(200, [{ id: "rec-1", email: "a@example.com", note: "n", createdAt: 1 }]),
    });
    assert.equal(status(accepted.checks, "clean-state-endpoint"), "pass");
    assert.match(detail(accepted.checks, "clean-state-endpoint"), /GET \/api\/reset-history/);
    assert.match(detail(accepted.checks, "clean-state-endpoint"), /any JSON array items/);
    assert.doesNotMatch(detail(accepted.checks, "clean-state-endpoint"), /cannot read|record-count shape/);
    assert.equal(status(accepted.checks, "oracle-endpoint"), "pass");
    assert.match(detail(accepted.checks, "oracle-endpoint"), /GET \/api\/tickets/);
    assert.match(detail(accepted.checks, "oracle-endpoint"), /record-count shape/);
    assert.match(detail(accepted.checks, "oracle-endpoint"), /not reset verification/);
    assert.equal(doctorExitCode(accepted.checks), EXIT.verified);
    assert.equal(accepted.report.includes(TOKEN), false);
    assert.deepEqual(accepted.calls, ["/", "/__reproseed/identity", "/api/reset-history", "/api/tickets"]);
    assert.deepEqual(accepted.methods, ["GET", "GET", "GET", "GET"]);
    assert.equal(accepted.redirects.every((redirect) => redirect === "error"), true);

    const malformed = await diagnose(body, {
      "/": () => new Response("<html></html>", { status: 200 }),
      "/__reproseed/identity": () => json(200, { appId: "replace-with-your-app-id" }),
      "/api/reset-history": () => json(200, [{ event: "kept", at: 1 }]),
      "/api/tickets": () => json(200, [{ id: TOKEN }]),
    });
    assert.equal(status(malformed.checks, "clean-state-endpoint"), "pass");
    assert.match(detail(malformed.checks, "clean-state-endpoint"), /GET \/api\/reset-history/);
    assert.doesNotMatch(detail(malformed.checks, "clean-state-endpoint"), /cannot read|missing email/);
    assert.equal(status(malformed.checks, "oracle-endpoint"), "fail");
    assert.match(detail(malformed.checks, "oracle-endpoint"), /GET \/api\/tickets/);
    assert.match(detail(malformed.checks, "oracle-endpoint"), /item 0: missing email, note, createdAt/);
    assert.doesNotMatch(detail(malformed.checks, "oracle-endpoint"), /reset-history/);
    assert.equal(malformed.report.includes(TOKEN), false);
    assert.equal(doctorExitCode(malformed.checks), EXIT.usage);
    assert.equal(malformed.methods.some((method) => method === "POST"), false);
  });

  it("does not apply the record shape to a dom-text array", async () => {
    const checked = await diagnose(starterScenario("dom-text"), readyRoutes("/api/events", [{ id: TOKEN, label: "event" }]));
    assert.equal(status(checked.checks, "clean-state-endpoint"), "pass");
    assert.match(detail(checked.checks, "clean-state-endpoint"), /JSON array with 1 item/);
    assert.doesNotMatch(detail(checked.checks, "clean-state-endpoint"), /record-count shape|cannot read|missing /);
    assert.equal(status(checked.checks, "oracle-endpoint"), "pass");
    assert.match(detail(checked.checks, "oracle-endpoint"), /did not request a record list/);
    assert.deepEqual(checked.calls, ["/", "/__reproseed/identity", "/api/events"]);
    assert.equal(checked.report.includes(TOKEN), false);
  });

  it("distinguishes a successful page, a missing route, a server failure, and a redirect", async () => {
    const success = await diagnose(starterScenario("record-count"), readyRoutes("/api/items", []));
    assert.equal(status(success.checks, "target-available"), "pass");
    assert.match(detail(success.checks, "target-available"), /GET \/ on http:\/\/127\.0\.0\.1:3000 returned status 200/);
    assert.doesNotMatch(detail(success.checks, "target-available"), /server failure|missing|redirect/);

    const missing = await diagnose(starterScenario("record-count"), {
      ...readyRoutes("/api/items", []),
      "/": () => new Response("missing", { status: 404 }),
    });
    assert.equal(status(missing.checks, "target-available"), "fail");
    assert.match(detail(missing.checks, "target-available"), /returned status 404/);
    assert.match(detail(missing.checks, "target-available"), /navigation path is missing/);
    assert.equal(status(missing.checks, "target-identity"), "pass");

    const failure = await diagnose(starterScenario("record-count"), {
      ...readyRoutes("/api/items", []),
      "/": () => json(500, { error: TOKEN }),
    });
    assert.equal(status(failure.checks, "target-available"), "fail");
    assert.match(detail(failure.checks, "target-available"), /returned status 500/);
    assert.match(detail(failure.checks, "target-available"), /server failure/);
    assert.equal(status(failure.checks, "target-identity"), "pass");
    assert.equal(failure.report.includes(TOKEN), false);
    assert.deepEqual(failure.calls, ["/", "/__reproseed/identity", "/api/items"]);

    const redirect = await diagnose(starterScenario("record-count"), {
      ...readyRoutes("/api/items", []),
      "/": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000/next" } }),
    });
    assert.equal(status(redirect.checks, "target-available"), "fail");
    assert.match(detail(redirect.checks, "target-available"), /GET \/ on http:\/\/127\.0\.0\.1:3000 was a redirect/);
    assert.match(detail(redirect.checks, "target-available"), /did not follow it/);
    assert.equal(status(redirect.checks, "target-identity"), "pass");
    assert.equal(redirect.report.includes(TOKEN), false);
  });

  it("checks the scenario goto path and does not require GET /", async () => {
    const body = starterScenario("record-count") as { steps: Array<{ id: string; path?: string }> };
    const open = body.steps.find((step) => step.id === "open");
    assert.ok(open);
    open.path = "/desk";
    const checked = await diagnose(body, {
      "/desk": () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      "/__reproseed/identity": () => json(200, { appId: "replace-with-your-app-id" }),
      "/api/items": () => json(200, []),
    });
    assert.equal(status(checked.checks, "target-available"), "pass");
    assert.match(detail(checked.checks, "target-available"), /GET \/desk on http:\/\/127\.0\.0\.1:3000 returned status 200/);
    assert.deepEqual(checked.calls, ["/desk", "/__reproseed/identity", "/api/items"]);
    assert.equal(doctorExitCode(checked.checks), EXIT.verified);
  });

  it("uses GET / only when the scenario has no goto step", async () => {
    const body = starterScenario("record-count") as { steps: unknown[] };
    body.steps = [{ id: "pause", kind: "wait", ms: 1, dependsOn: [] }];
    const failure = await diagnose(body, {
      ...readyRoutes("/api/items", []),
      "/": () => new Response("down", { status: 500 }),
    });
    assert.equal(status(failure.checks, "target-available"), "fail");
    assert.match(detail(failure.checks, "target-available"), /returned status 500/);
    assert.match(detail(failure.checks, "target-available"), /server failure/);
    assert.match(detail(failure.checks, "target-available"), /no goto step/);
    assert.equal(failure.report.includes(TOKEN), false);
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

async function diagnose(
  body: unknown,
  routes: Record<string, () => Response>,
): Promise<{ checks: DoctorCheck[]; calls: string[]; methods: string[]; redirects: Array<string | undefined>; report: string }> {
  const directory = await mkdtemp(join(tmpdir(), "reproseed-doctor-case-"));
  const calls: Array<{ method: string; url: string; redirect: string | undefined }> = [];
  try {
    const scenario = join(directory, "scenario.json");
    await writeFile(scenario, JSON.stringify(body));
    const checks = await collectDoctorChecks({
      scenarioPath: scenario,
      cwd: directory,
      env: targetEnv(),
      stdout: () => undefined,
      fetchImpl: mockFetch(calls, routes),
      inspectChromium: readyChromium,
    });
    return {
      checks,
      calls: calls.map((call) => new URL(call.url).pathname),
      methods: calls.map((call) => call.method),
      redirects: calls.map((call) => call.redirect),
      report: formatDoctorReport(checks),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function readyRoutes(cleanPath: string, items: unknown): Record<string, () => Response> {
  return {
    "/": () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    "/__reproseed/identity": () => json(200, { appId: "replace-with-your-app-id" }),
    [cleanPath]: () => json(200, items),
  };
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
