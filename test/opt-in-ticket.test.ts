import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { startOptInServer } from "../examples/opt-in-ticket/server.ts";
import { collectDoctorChecks, doctorExitCode, formatDoctorReport } from "../src/cli/doctor.ts";
import { EXIT } from "../src/cli/errors.ts";
import { loadScenarioFile } from "../src/cli/scenario-file.ts";
import { isListedRecord, readRecordList, resetAndConfirmEmpty, type FetchLike } from "../src/runner/reset.ts";

const SCENARIO = fileURLToPath(new URL("../examples/opt-in-ticket/scenario.json", import.meta.url));
const SERVER = fileURLToPath(new URL("../examples/opt-in-ticket/server.ts", import.meta.url));
const APP_ID = "opt-in-ticket";

describe("opt-in ticket example", () => {
  it("leaves reset disabled until the application opts in", async () => {
    const closed = await startOptInServer({ port: 0 });
    try {
      assert.equal(closed.resetEnabled, false);
      assert.equal((await fetch(`${closed.origin}/__reproseed/identity`)).status, 404);
      const created = await postTicket(closed.origin, "person@example.com");
      assert.equal(created.status, 201);
      const reset = await fetch(`${closed.origin}/__reproseed/reset`, { method: "POST" });
      assert.equal(reset.status, 404);
      assert.equal((await tickets(closed.origin)).length, 1);
    } finally {
      await closed.close();
    }

    await assert.rejects(startOptInServer({ host: "example.com" }), /non-loopback/);
  });

  it("accepts only the configured credential and clears tickets on an authorized reset", async () => {
    const token = randomBytes(16).toString("hex");
    const server = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    try {
      assert.equal(server.resetEnabled, true);
      const identity = (await (await fetch(`${server.origin}/__reproseed/identity`)).json()) as { appId?: string };
      assert.equal(identity.appId, APP_ID);
      await postTicket(server.origin, "person@example.com");
      await postTicket(server.origin, "person@example.com");
      assert.equal((await tickets(server.origin)).length, 2);
      const wrong = await fetch(`${server.origin}/__reproseed/reset`, {
        method: "POST",
        headers: {
          "x-reproseed-app-id": APP_ID,
          "x-reproseed-reset-authorization": `${token}no`,
        },
      });
      assert.equal(wrong.status, 403);
      assert.equal((await tickets(server.origin)).length, 2);
      const right = await fetch(`${server.origin}/__reproseed/reset`, {
        method: "POST",
        headers: {
          "x-reproseed-app-id": APP_ID,
          "x-reproseed-reset-authorization": token,
        },
      });
      assert.equal(right.status, 204);
      assert.equal((await tickets(server.origin)).length, 0);
      assert.deepEqual(server.audits(), []);
      const scenario = await loadScenarioFile(SCENARIO, fileURLToPath(new URL("..", import.meta.url)), {
        REPROSEED_ORIGIN: server.origin,
        REPROSEED_APP_ID: APP_ID,
        REPROSEED_RESET_AUTHORIZATION: token,
      });
      assert.equal(scenario.reset.verify?.path, "/api/tickets");
      assert.equal(scenario.oracle.id, "record-count");
    } finally {
      await server.close();
    }
  });

  it("keeps reset history and ticket records on different endpoints", async () => {
    const token = randomBytes(16).toString("hex");
    const server = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    try {
      await postTicket(server.origin, "person@example.com");
      const history = server.audits();
      assert.equal(history.length, 1);
      assert.equal(isListedRecord(history[0]), false);
      const records = await readRecordList({ origin: server.origin, path: "/api/tickets" });
      assert.equal(records.length, 1);
      assert.equal(isListedRecord(records[0]), true);
      const paths: string[] = [];
      await resetAndConfirmEmpty({
        origin: server.origin,
        expectedAppId: APP_ID,
        resetAuthorization: token,
        verify: { kind: "json-array-empty", method: "GET", path: "/api/reset-history" },
        fetchImpl: async (input, init) => {
          const url = input instanceof URL ? input : new URL(String(input));
          paths.push(url.pathname);
          return fetch(input, init);
        },
      });
      assert.deepEqual(paths, ["/__reproseed/identity", "/__reproseed/reset", "/api/reset-history"]);
      assert.equal((await readRecordList({ origin: server.origin, path: "/api/tickets" })).length, 0);
      assert.deepEqual(server.audits(), []);
      assert.equal(JSON.stringify(server.requests()).includes(token), false);
    } finally {
      await server.close();
    }
  });

  it("keeps the buggy page as the default and isolates the fixed page", async () => {
    const token = randomBytes(16).toString("hex");
    const buggy = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const fixed = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token, page: "fixed" });
    try {
      const buggyPage = await (await fetch(`${buggy.origin}/`)).text();
      const fixedPage = await (await fetch(`${fixed.origin}/`)).text();
      assert.match(buggyPage, /GUARD_MS = 400/);
      assert.equal(buggyPage.includes("test-only fixed client"), false);
      assert.match(fixedPage, /test-only fixed client/);
      assert.equal(fixedPage.includes("GUARD_MS"), false);
      assert.equal(buggyPage.includes(token), false);
      assert.equal(fixedPage.includes(token), false);
      const refused = await fetch(`${fixed.origin}/__reproseed/reset`, {
        method: "POST",
        headers: {
          "x-reproseed-app-id": APP_ID,
          "x-reproseed-reset-authorization": `${token}no`,
        },
      });
      assert.equal(refused.status, 403);
      assert.equal((await tickets(fixed.origin)).length, 0);
      await postTicket(fixed.origin, "person@example.com");
      assert.equal((await tickets(fixed.origin)).length, 1);
      const accepted = await fetch(`${fixed.origin}/__reproseed/reset`, {
        method: "POST",
        headers: {
          "x-reproseed-app-id": APP_ID,
          "x-reproseed-reset-authorization": token,
        },
      });
      assert.equal(accepted.status, 204);
      assert.equal((await tickets(fixed.origin)).length, 0);
    } finally {
      await Promise.all([buggy.close(), fixed.close()]);
    }
    await assert.rejects(startOptInServer({ page: "other" as "fixed" }), /page must be buggy or fixed/);
  });

  it("is diagnosed without a reset and the process log omits the credential", async () => {
    const token = randomBytes(16).toString("hex");
    const server = await startOptInServer({ port: 0, appId: APP_ID, resetAuthorization: token });
    const calls: string[] = [];
    try {
      const created = await postTicket(server.origin, "person@example.com");
      assert.equal(created.status, 201);
      const checks = await collectDoctorChecks({
        scenarioPath: SCENARIO,
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          REPROSEED_ORIGIN: server.origin,
          REPROSEED_APP_ID: APP_ID,
          REPROSEED_RESET_AUTHORIZATION: token,
        },
        stdout: () => undefined,
        fetchImpl: recordingFetch(calls),
        inspectChromium: () => ({
          ready: true,
          detail: "Playwright's downloaded Chromium is installed. Doctor did not launch a browser.",
        }),
      });
      const report = formatDoctorReport(checks);
      assert.equal(doctorExitCode(checks), EXIT.verified, report);
      assert.equal(report.includes(token), false);
      assert.match(report, /not-verified\s+reset-accepted/);
      assert.match(report, /JSON array with 1 item/);
      assert.match(report, /record-count shape/);
      assert.equal(calls.includes("POST"), false);
      assert.equal((await tickets(server.origin)).length, 1);
    } finally {
      await server.close();
    }

    const childToken = randomBytes(16).toString("hex");
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: "0",
        REPROSEED_APP_ID: APP_ID,
        REPROSEED_RESET_AUTHORIZATION: childToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      output += chunk;
    });
    try {
      const line = await waitForLine(child, () => output, "reset is enabled for app opt-in-ticket");
      assert.match(line, /opt-in-ticket listening on http:\/\/127\.0\.0\.1:\d+/);
      assert.equal(output.includes(childToken), false);
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
});

async function postTicket(origin: string, email: string): Promise<Response> {
  return fetch(`${origin}/api/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, note: "hello" }),
  });
}

async function tickets(origin: string): Promise<unknown[]> {
  const response = await fetch(`${origin}/api/tickets`);
  const body: unknown = await response.json();
  assert.ok(Array.isArray(body));
  return body;
}

function recordingFetch(calls: string[]): FetchLike {
  return async (input, init) => {
    calls.push((init?.method ?? "GET").toUpperCase());
    return fetch(input, init);
  };
}

async function waitForLine(child: ReturnType<typeof spawn>, read: () => string, needle: string): Promise<string> {
  const started = Date.now();
  while (!read().includes(needle)) {
    if (child.exitCode !== null) {
      throw new Error(`opt-in server exited early\n${read()}`);
    }
    if (Date.now() - started > 10_000) {
      throw new Error(`opt-in server did not listen\n${read()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}
