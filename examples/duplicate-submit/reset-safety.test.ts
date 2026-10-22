import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { assertLocalAuthorizedTarget, fetchRecords, resetAndConfirmEmpty, type FetchLike } from "./harness.ts";
import { startDemoServer } from "./server.ts";

describe("duplicate-submit reset safety", () => {
  it("refuses non-loopback, non-http, and unauthorized targets before any request", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(String(input));
      throw new Error("fetch should not run");
    };
    const cases = [
      { origin: "http://example.com", appId: "duplicate-submit", authorization: "token", pattern: /non-loopback/ },
      { origin: "https://127.0.0.1:4010", appId: "duplicate-submit", authorization: "token", pattern: /non-http/ },
      { origin: "http://user:pass@127.0.0.1:4010", appId: "duplicate-submit", authorization: "token", pattern: /credentials/ },
      { origin: "http://127.0.0.1:4010/admin", appId: "duplicate-submit", authorization: "token", pattern: /must be an origin/ },
      { origin: "http://127.0.0.1:4010", appId: " ", authorization: "token", pattern: /appId is required/ },
      { origin: "http://127.0.0.1:4010", appId: "duplicate-submit", authorization: " ", pattern: /resetAuthorization is required/ },
    ];
    for (const testCase of cases) {
      await assert.rejects(
        () =>
          resetAndConfirmEmpty({
            origin: testCase.origin,
            expectedAppId: testCase.appId,
            resetAuthorization: testCase.authorization,
            fetchImpl,
          }),
        testCase.pattern,
      );
    }
    assert.equal(calls.length, 0);
    assert.throws(() => assertLocalAuthorizedTarget("http://example.com", "duplicate-submit", "token"), /non-loopback/);
  });

  it("binds only to loopback and disables reset until identity and authorization are configured", async () => {
    await assert.rejects(() => startDemoServer({ host: "0.0.0.0", port: 0 }), /non-loopback/);
    await assert.rejects(() => startDemoServer({ host: "example.com", port: 0 }), /non-loopback/);

    const bare = await startDemoServer({ port: 0 });
    try {
      assert.match(bare.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal((await fetch(new URL("/__reproseed/identity", bare.origin))).status, 404);
      assert.equal((await fetch(new URL("/__reproseed/reset", bare.origin), { method: "POST" })).status, 404);
    } finally {
      await bare.close();
    }
  });

  it("rejects unauthorized reset requests and a mismatched app identity", async () => {
    const resetAuthorization = randomBytes(16).toString("hex");
    const appId = "duplicate-submit";
    const demo = await startDemoServer({ port: 0, appId, resetAuthorization });
    try {
      const created = await fetch(new URL("/api/records", demo.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "kept@example.com" }),
      });
      assert.equal(created.status, 201);

      const missingHeaders = await fetch(new URL("/__reproseed/reset", demo.origin), { method: "POST" });
      assert.equal(missingHeaders.status, 403);
      const wrongToken = await fetch(new URL("/__reproseed/reset", demo.origin), {
        method: "POST",
        headers: {
          "x-reproseed-app-id": appId,
          "x-reproseed-reset-authorization": "not-the-runtime-token",
        },
      });
      assert.equal(wrongToken.status, 403);
      const wrongApp = await fetch(new URL("/__reproseed/reset", demo.origin), {
        method: "POST",
        headers: {
          "x-reproseed-app-id": "other-app",
          "x-reproseed-reset-authorization": resetAuthorization,
        },
      });
      assert.equal(wrongApp.status, 403);
      assert.equal((await fetchRecords(demo.origin)).length, 1);

      await assert.rejects(
        () =>
          resetAndConfirmEmpty({
            origin: demo.origin,
            expectedAppId: "other-app",
            resetAuthorization,
          }),
        /identity does not match/,
      );
      assert.equal((await fetchRecords(demo.origin)).map((record) => record.email).join(","), "kept@example.com");

      await resetAndConfirmEmpty({
        origin: demo.origin,
        expectedAppId: appId,
        resetAuthorization,
      });
      assert.deepEqual(await fetchRecords(demo.origin), []);
    } finally {
      await demo.close();
    }
  });
});
