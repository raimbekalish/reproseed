import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";

import { startDemoServer } from "../examples/duplicate-submit/server.ts";
import { startSearchServer } from "../examples/stale-search/server.ts";
import { cleanStateVerify, DEFAULT_CLEAN_STATE_PATH } from "../src/core/clean-state.ts";
import type { JsonArrayEmptyVerify } from "../src/core/types.ts";
import { sanitizeArtifact } from "../src/runner/report.ts";
import { resetAndConfirmEmpty, ResetFailed, type FetchLike } from "../src/runner/reset.ts";
import { duplicateSubmitScenario } from "./fixture.ts";
import { verifiedMinimizeReport } from "./export/verified-report.ts";

const SEARCH_VERIFY: JsonArrayEmptyVerify = {
  kind: "json-array-empty",
  method: "GET",
  path: "/api/search-history",
};

describe("declarative clean-state verification", () => {
  it("keeps omitted rules on GET /api/records and uses a declared search-history rule", async () => {
    const token = randomBytes(16).toString("hex");
    const duplicate = await startDemoServer({ port: 0, appId: "duplicate-submit", resetAuthorization: token });
    const search = await startSearchServer({ port: 0, appId: "stale-search", resetAuthorization: token });
    try {
      assert.equal((await fetch(new URL("/api/records", search.origin))).status, 404);
      assert.deepEqual(await readJson(new URL("/api/search-history", search.origin)), []);

      const duplicatePaths: string[] = [];
      await resetAndConfirmEmpty({
        origin: duplicate.origin,
        expectedAppId: "duplicate-submit",
        resetAuthorization: token,
        fetchImpl: observingFetch(duplicatePaths),
      });
      assert.deepEqual(duplicatePaths, ["/__reproseed/identity", "/__reproseed/reset", "/api/records"]);

      await fetch(new URL("/api/search?q=alpha", search.origin));
      assert.deepEqual(search.searches(), ["alpha"]);
      const wrong = await fetch(new URL("/__reproseed/reset", search.origin), {
        method: "POST",
        headers: {
          "x-reproseed-app-id": "stale-search",
          "x-reproseed-reset-authorization": "not-the-token",
        },
      });
      assert.equal(wrong.status, 403);
      assert.deepEqual(search.searches(), ["alpha"]);

      const searchPaths: string[] = [];
      await resetAndConfirmEmpty({
        origin: search.origin,
        expectedAppId: "stale-search",
        resetAuthorization: token,
        verify: SEARCH_VERIFY,
        fetchImpl: observingFetch(searchPaths),
      });
      assert.deepEqual(searchPaths, ["/__reproseed/identity", "/__reproseed/reset", "/api/search-history"]);
      assert.deepEqual(search.searches(), []);
      assert.deepEqual(await readJson(new URL("/api/search-history", search.origin)), []);

      const scenario = duplicateSubmitScenario();
      assert.equal(scenario.reset.verify, undefined);
      assert.equal(cleanStateVerify(scenario.reset).path, DEFAULT_CLEAN_STATE_PATH);
      const artifact = sanitizeArtifact(scenario, verifiedMinimizeReport(scenario, ["open"]));
      assert.deepEqual(artifact.scenario.reset.verify, {
        kind: "json-array-empty",
        method: "GET",
        path: "/api/records",
      });
      assert.equal(JSON.stringify(artifact).includes(scenario.target.resetAuthorization), false);
    } finally {
      await duplicate.close();
      await search.close();
    }
  });

  it("rejects nonempty state, malformed bodies, redirects, and unauthorized targets", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(String(input));
      throw new Error("fetch should not run");
    };
    await assert.rejects(
      () =>
        resetAndConfirmEmpty({
          origin: "http://example.com",
          expectedAppId: "duplicate-submit",
          resetAuthorization: "token",
          verify: SEARCH_VERIFY,
          fetchImpl,
        }),
      /non-loopback/,
    );
    await assert.rejects(
      () =>
        resetAndConfirmEmpty({
          origin: "http://127.0.0.1:4010",
          expectedAppId: "duplicate-submit",
          resetAuthorization: "token",
          verify: { kind: "json-array-empty", method: "GET", path: "//evil.example/state" },
          fetchImpl,
        }),
      /authorized origin/,
    );
    await assert.rejects(
      () =>
        resetAndConfirmEmpty({
          origin: "http://127.0.0.1:4010",
          expectedAppId: "duplicate-submit",
          resetAuthorization: "token",
          verify: { kind: "json-array-empty", method: "POST" as "GET", path: "/api/records" },
          fetchImpl,
        }),
      /json-array-empty/,
    );
    assert.equal(calls.length, 0);

    await expectCleanBody(["alpha"], /not empty/);
    await expectCleanBody({ items: [] }, /not a JSON array/);
    await expectCleanBody("[]", /not a JSON array/);
    await expectCleanBody(null, /not a JSON array/);
    await expectCleanBody(4, /not a JSON array/);
    await expectCleanText("not-json", /not JSON/);
    await expectCleanText("<html></html>", /not JSON/);
    await expectCleanBody([], /clean-state check failed \(500\)/, 500);
    await expectCleanBody([], undefined, 200);

    const redirected = scriptedCleanState(new Response(null, { status: 302, headers: { location: "http://evil.example/stolen" } }));
    await assert.rejects(() => resetWith(redirected.fetchImpl), /refused a redirect/);
    assert.deepEqual(redirected.paths, ["/__reproseed/identity", "/__reproseed/reset", "/api/state"]);

    const hits: string[] = [];
    const trap = createServer((request, response) => {
      hits.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("trapped");
    });
    const trapOrigin = await listen(trap);
    const app = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/__reproseed/identity") {
        sendJson(response, 200, { appId: "app" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/__reproseed/reset") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        response.writeHead(302, { location: `${trapOrigin}/stolen` });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const origin = await listen(app);
    try {
      await assert.rejects(
        () =>
          resetAndConfirmEmpty({
            origin,
            expectedAppId: "app",
            resetAuthorization: "token",
            verify: { kind: "json-array-empty", method: "GET", path: "/api/state" },
          }),
        (error: unknown) => error instanceof ResetFailed && /redirect/i.test(error.message),
      );
      assert.deepEqual(hits, []);
    } finally {
      await closeServer(app);
      await closeServer(trap);
    }
  });
});

async function expectCleanBody(body: unknown, pattern: RegExp | undefined, status = 200): Promise<void> {
  const scripted = scriptedCleanState(Response.json(body, { status }));
  if (pattern === undefined) {
    await resetWith(scripted.fetchImpl);
    return;
  }
  await assert.rejects(() => resetWith(scripted.fetchImpl), pattern);
}

async function expectCleanText(body: string, pattern: RegExp): Promise<void> {
  const scripted = scriptedCleanState(new Response(body, { status: 200, headers: { "content-type": "text/plain" } }));
  await assert.rejects(() => resetWith(scripted.fetchImpl), pattern);
}

function resetWith(fetchImpl: FetchLike): Promise<void> {
  return resetAndConfirmEmpty({
    origin: "http://127.0.0.1:4010",
    expectedAppId: "app",
    resetAuthorization: "token",
    verify: { kind: "json-array-empty", method: "GET", path: "/api/state" },
    fetchImpl,
  });
}

function scriptedCleanState(clean: Response): { fetchImpl: FetchLike; paths: string[] } {
  const paths: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/__reproseed/identity") {
      return Response.json({ appId: "app" });
    }
    if (url.pathname === "/__reproseed/reset") {
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-reproseed-reset-authorization"), "token");
      return new Response(null, { status: 204 });
    }
    return clean.clone();
  };
  return { fetchImpl, paths };
}

function observingFetch(paths: string[]): FetchLike {
  return async (input, init) => {
    paths.push(new URL(String(input)).pathname);
    return fetch(input, init);
  };
}

async function readJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json() as Promise<unknown>;
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
