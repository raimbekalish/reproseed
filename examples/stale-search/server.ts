import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

export type SearchPage = "buggy" | "fixed-generation";

export type SearchServerOptions = {
  host?: string;
  port?: number;
  appId?: string;
  resetAuthorization?: string;
  /**
   * `buggy` applies every search response, including one for an older query.
   * `fixed-generation` is test-only: it ignores a response that is no longer current.
   */
  page?: SearchPage;
};

export type SearchServer = {
  origin: string;
  appId: string | undefined;
  searches: () => string[];
  postCount: () => number;
  close: () => Promise<void>;
};

type StoredRecord = {
  id: string;
  email: string;
  note: string;
  createdAt: number;
};

const BODY_LIMIT = 64 * 1024;
const PAGE_HTML = readFileSync(fileURLToPath(new URL("./public/index.html", import.meta.url)), "utf8");

function pageHtml(page: SearchPage | undefined): string {
  if (page === undefined || page === "buggy") {
    return PAGE_HTML;
  }
  if (page === "fixed-generation") {
    return withGenerationGuard(PAGE_HTML);
  }
  throw new Error("search page must be buggy or fixed-generation");
}

/**
 * Test-only fix. The default page writes every response into `#results`.
 * This variant remembers the latest click and ignores a response from an older click.
 */
function withGenerationGuard(html: string): string {
  let next = applyOnce(
    html,
    "    searchButton.addEventListener(\"click\", () => {\n",
    "    let generation = 0;\n    searchButton.addEventListener(\"click\", () => {\n",
    "generation counter",
  );
  next = applyOnce(
    next,
    "      const query = queryInput.value;\n",
    "      const query = queryInput.value;\n      const requestGeneration = ++generation;\n",
    "request generation",
  );
  next = applyOnce(
    next,
    "        const body = await response.json();\n",
    "        const body = await response.json();\n        if (requestGeneration !== generation) {\n          return;\n        }\n",
    "stale response check",
  );
  if (!next.includes("requestGeneration !== generation") || !next.includes("let generation = 0;")) {
    throw new Error("fixed-generation page did not install the response guard");
  }
  if (next.includes("innerHTML")) {
    throw new Error("fixed-generation page must keep using textContent");
  }
  return next;
}

function applyOnce(html: string, from: string, to: string, label: string): string {
  const first = html.indexOf(from);
  if (first === -1 || html.indexOf(from, first + from.length) !== -1) {
    throw new Error(`fixed-generation page could not apply ${label}`);
  }
  return html.slice(0, first) + to + html.slice(first + from.length);
}

export async function startSearchServer(options: SearchServerOptions = {}): Promise<SearchServer> {
  const host = bindAddress(options.host ?? "127.0.0.1");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  const state: AppState = {
    records: [],
    searches: [],
    posts: 0,
    appId: blankToUndefined(options.appId),
    resetAuthorization: blankToUndefined(options.resetAuthorization),
    html: pageHtml(options.page),
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, state).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 400, { error: "bad request" });
      } else {
        response.destroy();
      }
    });
  });
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen(port, host, () => {
      server.removeListener("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("search server did not bind a TCP port"));
        return;
      }
      if (!isLoopbackAddress(address.address)) {
        fail(new Error(`search server refuses non-loopback address ${address.address}`));
        return;
      }
      resolve({
        origin: `http://${formatHost(address.address)}:${address.port}`,
        appId: state.appId,
        searches: () => [...state.searches],
        postCount: () => state.posts,
        close: () => closeServer(server),
      });
    });
  });
}

function bindAddress(host: string): string {
  if (host === "127.0.0.1" || host === "localhost") {
    return "127.0.0.1";
  }
  if (host === "::1") {
    return "::1";
  }
  throw new Error(`search server refuses non-loopback host ${host}`);
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

function formatHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

type AppState = {
  records: StoredRecord[];
  searches: string[];
  posts: number;
  appId: string | undefined;
  resetAuthorization: string | undefined;
  html: string;
};

async function handleRequest(request: IncomingMessage, response: ServerResponse, state: AppState): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/") {
    sendHtml(response, state.html);
    return;
  }
  if (method === "GET" && url.pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    if (query.length > 200) {
      sendJson(response, 400, { error: "query is too long" });
      return;
    }
    state.searches.push(query);
    sendJson(response, 200, { query, text: `Results for ${query}` });
    return;
  }
  if (method === "GET" && url.pathname === "/api/records") {
    sendJson(response, 200, state.records);
    return;
  }
  if (method === "POST" && url.pathname === "/api/records") {
    await createRecord(request, response, state);
    return;
  }
  if (method === "GET" && url.pathname === "/__reproseed/identity") {
    if (state.appId === undefined) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    sendJson(response, 200, { appId: state.appId });
    return;
  }
  if (method === "POST" && url.pathname === "/__reproseed/reset") {
    resetState(request, response, state);
    return;
  }
  sendJson(response, 404, { error: "not found" });
}

async function createRecord(request: IncomingMessage, response: ServerResponse, state: AppState): Promise<void> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.startsWith("application/json")) {
    sendJson(response, 415, { error: "content type must be application/json" });
    return;
  }
  const record = parseRecord(await readBody(request, BODY_LIMIT));
  if (record === undefined) {
    sendJson(response, 400, { error: "email is required" });
    return;
  }
  state.records.push({
    id: randomUUID(),
    email: record.email,
    note: record.note,
    createdAt: Date.now(),
  });
  state.posts += 1;
  sendJson(response, 201, { ok: true });
}

function resetState(request: IncomingMessage, response: ServerResponse, state: AppState): void {
  if (state.appId === undefined || state.resetAuthorization === undefined) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  const presentedAppId = singleHeader(request.headers["x-reproseed-app-id"]);
  const presentedAuthorization = singleHeader(request.headers["x-reproseed-reset-authorization"]);
  const appMatches = presentedAppId !== undefined && tokensMatch(state.appId, presentedAppId);
  const authMatches =
    presentedAuthorization !== undefined && tokensMatch(state.resetAuthorization, presentedAuthorization);
  if (!appMatches || !authMatches) {
    sendJson(response, 403, { error: "reset refused" });
    return;
  }
  state.records.splice(0, state.records.length);
  state.searches.splice(0, state.searches.length);
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function parseRecord(body: string): { email: string; note: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as { email?: unknown; note?: unknown };
  if (typeof candidate.email !== "string" || candidate.email.trim() === "" || candidate.email.length > 320) {
    return undefined;
  }
  if (candidate.note !== undefined && (typeof candidate.note !== "string" || candidate.note.length > 2_000)) {
    return undefined;
  }
  return { email: candidate.email.trim(), note: typeof candidate.note === "string" ? candidate.note : "" };
}

function tokensMatch(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | undefined, body?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error !== undefined) {
        request.destroy();
        reject(error);
        return;
      }
      resolve(body ?? "");
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
    request.on("error", (error) => finish(error));
  });
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

function cliPort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 4020;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer from 0 through 65535");
  }
  return port;
}

if (runningAsCli()) {
  const appId = process.env.REPROSEED_APP_ID;
  const resetAuthorization = process.env.REPROSEED_RESET_AUTHORIZATION;
  const demo = await startSearchServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: cliPort(process.env.PORT),
    ...(appId !== undefined ? { appId } : {}),
    ...(resetAuthorization !== undefined ? { resetAuthorization } : {}),
  });
  console.log(`stale-search demo listening on ${demo.origin}`);
  if (demo.appId === undefined || blankToUndefined(resetAuthorization) === undefined) {
    console.log("reset is disabled until REPROSEED_APP_ID and REPROSEED_RESET_AUTHORIZATION are set");
  }
}
